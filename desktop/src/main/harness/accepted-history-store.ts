import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { ModelMessage } from 'ai';
import type { TranscriptEvent } from '../../shared/types';
import type { PersistedEventReference } from './session-store';
import { imageCollapsedToolResultText, prunedToolResultText } from './compaction';
import { restoreContinuationSizing, durableContinuationSizing } from './openai-continuation';

const VERSION = 1;
export const ACCEPTED_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
/** Rules, steers and status snapshots are app-authored strings with no transcript
 *  anchor, so they are the ONLY content the manifest copies. The cap keeps a
 *  runaway injection from turning the private sidecar into a second transcript. */
const LITERAL_MAX_BYTES = 64 * 1024;
const SUMMARY_PREFIX = '[Earlier conversation summary]\n';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

type FailureReason = 'ineligible' | 'malformed' | 'oversized' | 'missing-transcript'
  | 'transcript-advanced' | 'binding-mismatch' | 'assembly-mismatch' | 'image-mismatch';

/** Which persisted event type owns each referenceable field, and how its text is
 *  derived. One table so publish and restore can never disagree about an anchor. */
const FIELD_EVENT_TYPE = {
  'user-text': 'user-message',
  'skill-text': 'skill-invoked',
  'summary-text': 'compact-summary',
  'assistant-text': 'assistant-text',
  'reasoning-text': 'assistant-thinking',
  'tool-call': 'tool-use',
  'tool-result': 'tool-result',
} as const;

type Field = keyof typeof FIELD_EVENT_TYPE;
type TextField = 'user-text' | 'skill-text' | 'summary-text' | 'assistant-text' | 'reasoning-text';

const TEXT_FIELDS: readonly string[] = ['user-text', 'skill-text', 'summary-text', 'assistant-text', 'reasoning-text'];
const ROLES: readonly string[] = ['user', 'assistant', 'tool', 'system'];

/** The keys of OpenAI's parallel-tool-call wrapper. `input` is the ONE documented
 *  exemption to "never copy tool input": it is the wrapper's raw argument string,
 *  which @ai-sdk/openai re-emits verbatim as the wrapper call's arguments. The
 *  transcript stores only each child call's parsed input, so this string cannot be
 *  re-derived byte-exactly; dropping it would make every parallel-call turn
 *  unrestorable. It stays inside the same private 0600 sidecar as the reasoning
 *  ciphertext and nowhere else. Per-call input, tool output, text and image bytes
 *  are still never copied. See the architecture doc, "Store proposal and restore". */
const PARALLEL_TOOL_CALL: KeySpec = { itemId: true, toolCallId: true, toolName: true, input: true, index: true, count: true };

type KeySpec = true | { [key: string]: KeySpec };

/** Exactly which provider metadata each part kind may carry into the manifest.
 *  Anything else — another key under `openai`, or another provider entirely —
 *  fails the publish rather than being copied or silently dropped. */
const PROVIDER_OPTIONS_ALLOWLIST: Record<'text' | 'reasoning' | 'tool-call' | 'tool-result', KeySpec> = {
  text: { openai: { itemId: true, phase: true } },
  reasoning: { openai: { itemId: true, reasoningEncryptedContent: true } },
  'tool-call': { openai: { itemId: true, parallelToolCall: PARALLEL_TOOL_CALL } },
  'tool-result': { openai: { parallelToolCall: PARALLEL_TOOL_CALL } },
};

/** Delta types SessionStore coalesces into one persisted part; their references
 *  carry a partId and must tile the whole persisted text. */
const COALESCED_TYPES = new Set(['assistant-text', 'assistant-thinking']);

type PrunedDescriptor = { keepChars: number } | { imageCollapsed: true };
interface ImageDescriptor { path: string; mediaType: string; digest: string; filename?: string }

type PartDescriptor =
  | { kind: 'event'; uuid: string; field: Field; providerOptions?: unknown; images?: ImageDescriptor[]; pruned?: PrunedDescriptor }
  | { kind: 'concat'; uuids: string[]; field: 'assistant-text' | 'reasoning-text'; providerOptions?: unknown }
  /** The ONE descriptor that cites no transcript content, because there is none to
   *  cite: an encrypted reasoning item whose summary never produced a single token.
   *  Restricted to reasoning — an empty part of any other kind still fails the publish. */
  | { kind: 'empty'; field: 'reasoning-text'; providerOptions?: unknown }
  | { kind: 'image'; path: string; mediaType: string; digest: string };

type ContentDescriptor =
  | { kind: 'literal'; value: string }
  | { kind: 'event'; uuid: string; field: TextField }
  | { kind: 'concat'; uuids: string[]; field: 'assistant-text' }
  | { kind: 'parts'; parts: PartDescriptor[] };

interface MessageDescriptor {
  role: ModelMessage['role'];
  content: ContentDescriptor;
  sizing?: { reasoningTokens?: number; reasoningEstimateIncomplete: boolean };
}

type Transformation = { kind: 'pruned' } | { kind: 'summary'; summaryEventUuid: string };

interface Manifest {
  v: 1;
  sessionId: string;
  transcriptPath: string;
  transcript: { bytes: number; digest: string };
  binding: string;
  assemblyDigest: string;
  revision: number;
  eventUuids: string[];
  messages: MessageDescriptor[];
  transformation?: Transformation;
}

interface Eligibility { v: 1; sessionId: string; revision: number; eligible: boolean; reason: string }

/** The transformation is handed back to the harness as history provenance, so only
 *  the two shapes it knows may survive a restore. */
function validTransformation(value: unknown): boolean {
  if (value === undefined) return true;
  const transformation = record(value);
  if (!transformation) return false;
  if (transformation.kind === 'pruned') return Object.keys(transformation).length === 1;
  return transformation.kind === 'summary' && typeof transformation.summaryEventUuid === 'string'
    && Object.keys(transformation).length === 2;
}

export interface AcceptedHistoryProposal {
  sessionId: string;
  transcriptPath: string;
  binding: string;
  assemblyDigest: string;
  revision: number;
  /** Delta-level references in emit order, straight from SessionStore.flushReferences. */
  references: PersistedEventReference[];
  messages: ModelMessage[];
  transformation?: Transformation;
}

export interface AcceptedHistoryStoreHooks {
  beforeRename?: () => void | Promise<void>;
  unlink?: (file: string) => void | Promise<void>;
}

export type AcceptedHistoryRestore =
  | { ok: true; messages: ModelMessage[]; eventUuids: string[]; revision: number; transformation?: Transformation }
  | { ok: false; reason: FailureReason };

function digest(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function record(value: unknown): Record<string, any> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

/** Key-order-independent value equality, used only for tool-call input, which
 *  crosses a JSON round-trip on its way to the transcript. */
function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** True when `part` carries no key outside `allowed`. A part we cannot fully
 *  describe must fail the publish rather than restore as an approximation. */
function onlyKeys(part: Record<string, any>, allowed: string[]): boolean {
  return Object.keys(part).every(key => allowed.includes(key));
}

/** True when every key of `value`, recursively, is named by `spec`. A `true` leaf
 *  accepts whatever value sits there; an object leaf must itself be an object. */
function withinSpec(value: unknown, spec: KeySpec): boolean {
  if (spec === true) return true;
  const object = record(value);
  if (!object) return false;
  return Object.keys(object).every(key =>
    Object.prototype.hasOwnProperty.call(spec, key) && withinSpec(object[key], spec[key]));
}

/** The `providerOptions` tail for a descriptor, or null when the part carries
 *  metadata outside its kind's allowlist — which must fail the publish, so the
 *  session falls back to a rebuilt history instead of restoring an approximation. */
function providerOptionsFor(value: unknown, kind: keyof typeof PROVIDER_OPTIONS_ALLOWLIST): { providerOptions?: unknown } | null {
  if (value === undefined) return {};
  return withinSpec(value, PROVIDER_OPTIONS_ALLOWLIST[kind]) ? { providerOptions: value } : null;
}

function readDigest(file: string): string | null {
  try { return digest(fs.readFileSync(file)); } catch { return null; }
}

/** Path digests memoised for the life of ONE publish, keyed by identity+mtime+size.
 *  WHY: without it a turn carrying N image parts re-hashes every attachment of every
 *  accepted user message N times; a single stat per lookup keeps that to one read. */
function createDigestCache(): (file: string) => string | null {
  const cache = new Map<string, string | null>();
  return (file: string) => {
    let key: string;
    try {
      const stat = fs.statSync(file);
      key = `${stat.mtimeMs}:${stat.size}:${file}`;
    } catch { return null; }
    const hit = cache.get(key);
    if (hit !== undefined || cache.has(key)) return hit ?? null;
    const value = readDigest(file);
    cache.set(key, value);
    return value;
  };
}

function rawTranscript(file: string): { bytes: number; digest: string; events: Map<string, TranscriptEvent> } | null {
  let data: Buffer;
  try { data = fs.readFileSync(file); } catch { return null; }
  const events = new Map<string, TranscriptEvent>();
  for (const line of data.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as TranscriptEvent;
      if (value && typeof value.type === 'string' && typeof value.uuid === 'string') {
        // WHY: duplicate UUIDs are ambiguous persistence anchors, never a basis for faithful restore.
        if (events.has(value.uuid)) return null;
        events.set(value.uuid, value);
      }
    } catch { /* Raw digest still fences torn/junk lines; they are not referenceable. */ }
  }
  return { bytes: data.length, digest: digest(data), events };
}

/** The exact model-facing text an accepted event contributes for `field`, or null
 *  when the event is not the type that field names. */
function eventText(event: TranscriptEvent, field: TextField): string | null {
  if (event.type !== FIELD_EVENT_TYPE[field]) return null;
  switch (field) {
    case 'skill-text': {
      // Mirrors history-rebuild: a body-less skill event never entered history.
      const body = event.data?.body;
      if (!body) return null;
      return event.data?.args ? `${String(body)}\n\n${String(event.data.args)}` : String(body);
    }
    case 'summary-text': return `${SUMMARY_PREFIX}${String(event.data?.summary ?? '')}`;
    default: return String(event.data?.text ?? '');
  }
}

/**
 * The accepted anchor set, in first-appearance order, with per-field cursors so a
 * message can only claim anchors forward of the ones already spent. Skipping
 * ahead is allowed (a summary or a context clear drops older accepted anchors
 * from history while they stay in the accepted set); going backwards is not.
 */
class AnchorSet {
  readonly uuids: string[] = [];
  /** WHY: one cache per AnchorSet means one cache per publish — attachment and
   *  tool-image lookups within a turn hash each file once, and nothing outlives it. */
  readonly digestOf = createDigestCache();
  private byField = new Map<Field, Array<{ uuid: string; event: TranscriptEvent }>>();
  private cursor = new Map<Field, number>();

  constructor(uuids: string[], private events: Map<string, TranscriptEvent>) {
    for (const uuid of uuids) {
      // WHY: acceptedAnchors() already proved every accepted uuid resolves to an event.
      const event = events.get(uuid)!;
      this.uuids.push(uuid);
      for (const field of Object.keys(FIELD_EVENT_TYPE) as Field[]) {
        if (FIELD_EVENT_TYPE[field] !== event.type) continue;
        const list = this.byField.get(field) ?? [];
        list.push({ uuid, event });
        this.byField.set(field, list);
      }
    }
  }

  /** N consecutive unspent anchors of `field` whose texts concatenate to `target`,
   *  N bounded by `maxAnchors`. The cursor advances ONLY for a run this returns —
   *  a caller that can accept single anchors only must say so here, because a run it
   *  rejects afterwards would otherwise have spent anchors a later message needs. */
  matchText(field: TextField, target: string, maxAnchors = Number.MAX_SAFE_INTEGER): string[] | null {
    const run = this.findRun(field, target, maxAnchors);
    if (run) this.cursor.set(field, run.end + 1);
    return run?.uuids ?? null;
  }

  /** Whether any run of unspent anchors reproduces `target`, spending nothing. */
  hasTextMatch(field: TextField, target: string): boolean {
    return this.findRun(field, target, Number.MAX_SAFE_INTEGER) !== null;
  }

  private findRun(field: TextField, target: string, maxAnchors: number): { uuids: string[]; end: number } | null {
    const list = this.byField.get(field) ?? [];
    for (let start = this.cursor.get(field) ?? 0; start < list.length; start++) {
      let accumulated = '';
      const uuids: string[] = [];
      for (let end = start; end < list.length && uuids.length < maxAnchors; end++) {
        const text = eventText(list[end].event, field);
        if (text === null) break;
        accumulated += text;
        uuids.push(list[end].uuid);
        if (accumulated === target) return { uuids, end };
        if (accumulated.length >= target.length) break;
      }
    }
    return null;
  }

  /** The next unspent anchor of `field` satisfying `predicate`. */
  matchEvent(field: Field, predicate: (event: TranscriptEvent) => boolean): { uuid: string; event: TranscriptEvent } | null {
    const list = this.byField.get(field) ?? [];
    for (let i = this.cursor.get(field) ?? 0; i < list.length; i++) {
      if (!predicate(list[i].event)) continue;
      this.cursor.set(field, i + 1);
      return list[i];
    }
    return null;
  }

  /** An accepted user-message whose attachments include a file with these bytes.
   *  Attachments are not claimed: the message's text part already claimed the event. */
  findAttachment(wanted: string): string | null {
    for (const uuid of this.uuids) {
      const event = this.events.get(uuid);
      if (event?.type !== 'user-message' || !Array.isArray(event.data?.attachments)) continue;
      for (const candidate of event.data.attachments as string[]) {
        if (this.digestOf(candidate) === wanted) return candidate;
      }
    }
    return null;
  }
}

/**
 * Collapse delta-level references onto persisted anchors. A coalesced part must be
 * tiled by its references — contiguous, gapless, ending exactly at the persisted
 * text length — or some of the part's text was never accepted and the whole
 * proposal is unreferenceable. Every other event carries exactly one reference.
 */
function acceptedAnchors(references: PersistedEventReference[], events: Map<string, TranscriptEvent>): string[] | null {
  const order: string[] = [];
  const groups = new Map<string, PersistedEventReference[]>();
  for (const reference of references) {
    if (!reference || typeof reference.anchorUuid !== 'string') return null;
    const event = events.get(reference.anchorUuid);
    if (!event || event.type !== reference.type) return null;
    const group = groups.get(reference.anchorUuid);
    if (group) group.push(reference);
    else { groups.set(reference.anchorUuid, [reference]); order.push(reference.anchorUuid); }
  }
  for (const uuid of order) {
    const group = groups.get(uuid)!;
    const event = events.get(uuid)!;
    const coalesced = group.length > 1 || (COALESCED_TYPES.has(event.type) && group[0].partId !== undefined);
    if (!coalesced) { if (group.length !== 1) return null; continue; }
    if (!COALESCED_TYPES.has(event.type)) return null;
    const length = String(event.data?.text ?? '').length;
    const sorted = [...group].sort((a, b) => a.start - b.start);
    let at = 0;
    for (const reference of sorted) {
      if (reference.start !== at || reference.end < reference.start) return null;
      at = reference.end;
    }
    if (at !== length) return null;
  }
  return order;
}

export class AcceptedHistoryStore {
  private readonly dir: string;
  private chains = new Map<string, Promise<unknown>>();
  private revisions = new Map<string, number>();
  private disabled = new Set<string>();

  constructor(userDataRoot: string, private hooks: AcceptedHistoryStoreHooks = {}) {
    // WHY: continuation is profile-private Electron state, never the syncable NativeHome tree.
    this.dir = path.join(userDataRoot, 'private-continuation');
  }

  manifestPath(sessionId: string): string { return path.join(this.dir, `${encodeURIComponent(sessionId)}.manifest.json`); }
  private eligibilityPath(sessionId: string): string { return path.join(this.dir, `${encodeURIComponent(sessionId)}.eligibility.json`); }

  currentRevision(sessionId: string): number {
    const memory = this.revisions.get(sessionId);
    if (memory !== undefined) return memory;
    const value = this.readBoundedJson(this.eligibilityPath(sessionId)) as Eligibility | null;
    const revision = value?.v === VERSION && value.sessionId === sessionId && Number.isSafeInteger(value.revision) ? value.revision : 0;
    this.revisions.set(sessionId, revision);
    return revision;
  }

  async invalidate(sessionId: string, reason: string): Promise<number> {
    const revision = this.currentRevision(sessionId) + 1;
    // Fence synchronously in memory before the first await so late publishers lose immediately.
    this.revisions.set(sessionId, revision);
    try {
      await this.enqueue(sessionId, () => this.atomicWrite(this.eligibilityPath(sessionId), JSON.stringify({ v: VERSION, sessionId, revision, eligible: false, reason } satisfies Eligibility)));
    } catch {
      // Total storage failure cannot be called durable. Disable publication for this activation.
      this.disabled.add(sessionId);
    }
    return revision;
  }

  async publish(proposal: AcceptedHistoryProposal): Promise<{ ok: true } | { ok: false; reason: 'stale-generation' | 'oversized' | 'write-failed' | 'unreferenced-history' }> {
    return this.enqueue(proposal.sessionId, async () => {
      if (this.disabled.has(proposal.sessionId) || proposal.revision !== this.currentRevision(proposal.sessionId)) return { ok: false, reason: 'stale-generation' } as const;
      let json: string;
      try {
        const raw = rawTranscript(proposal.transcriptPath);
        if (!raw) return { ok: false, reason: 'unreferenced-history' } as const;
        const eventUuids = acceptedAnchors(proposal.references, raw.events);
        if (!eventUuids) return { ok: false, reason: 'unreferenced-history' } as const;
        const messages = describeMessages(proposal.messages, new AnchorSet(eventUuids, raw.events));
        if (!messages) return { ok: false, reason: 'unreferenced-history' } as const;
        const manifest: Manifest = {
          v: VERSION, sessionId: proposal.sessionId, transcriptPath: proposal.transcriptPath,
          transcript: { bytes: raw.bytes, digest: raw.digest }, binding: proposal.binding,
          assemblyDigest: proposal.assemblyDigest, revision: proposal.revision,
          eventUuids, messages,
          ...(proposal.transformation ? { transformation: proposal.transformation } : {}),
        };
        json = JSON.stringify(manifest);
      } catch {
        // WHY: publish runs on the session's append chain, so a rejection here would
        // poison unrelated session work. An unexpected message shape is exactly the
        // "cannot describe this history" case, and reports as that.
        return { ok: false, reason: 'unreferenced-history' } as const;
      }
      if (Buffer.byteLength(json) > ACCEPTED_HISTORY_MAX_BYTES) return { ok: false, reason: 'oversized' } as const;
      try {
        await this.atomicWrite(this.manifestPath(proposal.sessionId), json);
        // Recheck after writing the immutable proposal and immediately before eligibility publication.
        if (proposal.revision !== this.currentRevision(proposal.sessionId)) return { ok: false, reason: 'stale-generation' } as const;
        await this.atomicWrite(this.eligibilityPath(proposal.sessionId), JSON.stringify({ v: VERSION, sessionId: proposal.sessionId, revision: proposal.revision, eligible: true, reason: 'published' } satisfies Eligibility));
        return { ok: true } as const;
      } catch {
        return { ok: false, reason: 'write-failed' } as const;
      }
    });
  }

  restore(input: { sessionId: string; transcriptPath: string; binding: string; assemblyDigest: string }): AcceptedHistoryRestore {
    const eligibility = this.readBoundedJson(this.eligibilityPath(input.sessionId)) as Eligibility | null;
    if (!eligibility || eligibility.v !== VERSION || eligibility.sessionId !== input.sessionId || !eligibility.eligible) return { ok: false, reason: 'ineligible' };
    const file = this.manifestPath(input.sessionId);
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return { ok: false, reason: 'ineligible' }; }
    if (stat.size > ACCEPTED_HISTORY_MAX_BYTES) return { ok: false, reason: 'oversized' };
    const manifest = this.readBoundedJson(file) as Manifest | null;
    if (!manifest || manifest.v !== VERSION || manifest.sessionId !== input.sessionId || manifest.revision !== eligibility.revision
      || !Array.isArray(manifest.messages) || !Array.isArray(manifest.eventUuids)
      || !validTransformation(manifest.transformation)) return { ok: false, reason: 'malformed' };
    if (manifest.binding !== input.binding) return { ok: false, reason: 'binding-mismatch' };
    if (manifest.assemblyDigest !== input.assemblyDigest) return { ok: false, reason: 'assembly-mismatch' };
    if (path.resolve(manifest.transcriptPath) !== path.resolve(input.transcriptPath)) return { ok: false, reason: 'missing-transcript' };
    const raw = rawTranscript(input.transcriptPath);
    if (!raw) { void this.remove(input.sessionId); return { ok: false, reason: 'missing-transcript' }; }
    if (raw.bytes !== manifest.transcript.bytes || raw.digest !== manifest.transcript.digest) return { ok: false, reason: 'transcript-advanced' };
    const accepted = new Set(manifest.eventUuids);
    const messages: ModelMessage[] = [];
    for (const descriptor of manifest.messages) {
      // WHY: the role goes straight into a ModelMessage the provider will send, so an
      // unrecognised one is a corrupt manifest, not something to pass through.
      if (!record(descriptor) || !ROLES.includes(descriptor.role)) return { ok: false, reason: 'malformed' };
      const content = restoreContent(descriptor?.content, raw.events, accepted);
      if ('reason' in content) return { ok: false, reason: content.reason };
      const message = { role: descriptor.role, content: content.value } as ModelMessage;
      if (descriptor.sizing) restoreContinuationSizing(message, descriptor.sizing);
      messages.push(message);
    }
    return {
      ok: true, messages, eventUuids: [...manifest.eventUuids], revision: manifest.revision,
      ...(manifest.transformation ? { transformation: manifest.transformation } : {}),
    };
  }

  async remove(sessionId: string): Promise<{ ok: true } | { ok: false; reason: 'unlink-failed' }> {
    await this.invalidate(sessionId, 'deleted');
    const unlink = this.hooks.unlink ?? ((file: string) => fs.promises.unlink(file));
    const drop = async (file: string): Promise<boolean> => {
      try { await unlink(file); return true; }
      catch (error: any) { return error?.code === 'ENOENT'; }
    };
    // WHY: the fence outlives the checkpoint it fenced otherwise. invalidate() just
    // rewrote it, so leaving it behind strands a file for a session that no longer has
    // one — and cleanupOrphans would have to sweep what remove() should never leave.
    // Manifest first: an eligibility file without a manifest is refused on restore,
    // whereas a manifest without a fence is what a torn removal must never leave.
    const manifest = await drop(this.manifestPath(sessionId));
    const eligibility = await drop(this.eligibilityPath(sessionId));
    return manifest && eligibility ? { ok: true } : { ok: false, reason: 'unlink-failed' };
  }

  async cleanupOrphans(): Promise<void> {
    let files: string[];
    try { files = fs.readdirSync(this.dir); } catch { return; }
    // WHY: a name this store did not write (or a torn temp file) makes
    // decodeURIComponent THROW, and one such entry used to abandon the whole sweep at
    // whatever position readdir handed it — every orphan after it survived forever.
    const sessionIdOf = (name: string, suffix: string): string | null => {
      try { return decodeURIComponent(name.slice(0, -suffix.length)); } catch { return null; }
    };
    for (const name of files.filter(name => name.endsWith('.manifest.json'))) {
      const manifest = this.readBoundedJson(path.join(this.dir, name)) as Manifest | null;
      if (manifest && typeof manifest.transcriptPath === 'string' && fs.existsSync(manifest.transcriptPath)) continue;
      const sessionId = sessionIdOf(name, '.manifest.json');
      if (sessionId !== null) await this.remove(sessionId);
    }
    // WHY: a crash between the fence and the manifest write leaves an eligibility file
    // with nothing to make eligible. Restore already refuses it, but nothing ever
    // deleted it, so the private directory grew one dead fence per lost checkpoint.
    for (const name of files.filter(name => name.endsWith('.eligibility.json'))) {
      const sessionId = sessionIdOf(name, '.eligibility.json');
      if (sessionId === null || fs.existsSync(this.manifestPath(sessionId))) continue;
      await this.remove(sessionId);
    }
  }

  private readBoundedJson(file: string): unknown | null {
    try {
      const stat = fs.statSync(file);
      if (stat.size > ACCEPTED_HISTORY_MAX_BYTES) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return null; }
  }

  private enqueue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    this.chains.set(sessionId, next);
    // WHY: cleanup must not create a second rejected promise when the work itself
    // fails; callers observe the original `next`, while this branch is swallowed.
    void next.then(
      () => { if (this.chains.get(sessionId) === next) this.chains.delete(sessionId); },
      () => { if (this.chains.get(sessionId) === next) this.chains.delete(sessionId); },
    );
    return next;
  }

  private async atomicWrite(file: string, text: string): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true, mode: DIRECTORY_MODE });
    fs.chmodSync(this.dir, DIRECTORY_MODE);
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.promises.writeFile(temp, text, { encoding: 'utf8', mode: FILE_MODE });
    await this.hooks.beforeRename?.();
    await fs.promises.rename(temp, file);
    await fs.promises.chmod(file, FILE_MODE);
  }
}

// ---------------------------------------------------------------------------
// Publish side: ModelMessage[] -> descriptors that cite accepted anchors only.
// ---------------------------------------------------------------------------

/** `event` for a single anchor, `concat` for a run of them. */
function textDescriptor(uuids: string[], field: 'assistant-text' | 'reasoning-text', options: { providerOptions?: unknown }): PartDescriptor {
  return uuids.length === 1
    ? { kind: 'event', uuid: uuids[0], field, ...options }
    : { kind: 'concat', uuids, field, ...options };
}

/** How a live tool-result part relates to its persisted event text: unchanged,
 *  pruned, image-collapsed, or image-bearing. Null when it is none of those, in
 *  which case the part cannot be rebuilt exactly and the publish must fail. */
function describeToolResult(part: Record<string, any>, event: TranscriptEvent, digestOf: (file: string) => string | null): { images?: ImageDescriptor[]; pruned?: PrunedDescriptor } | null {
  const text = String(event.data?.toolResult ?? '');
  const paths = Array.isArray(event.data?.images) ? (event.data.images as string[]) : [];
  const output = record(part.output);
  if (!output) return null;

  if (output.type === 'text' && typeof output.value === 'string' && onlyKeys(output, ['type', 'value'])) {
    if (output.value === text) return {};
    const keepChars = prunedKeepChars(text, output.value);
    if (keepChars !== null) return { pruned: { keepChars } };
    if (output.value === imageCollapsedToolResultText(text, part.toolName)) return { pruned: { imageCollapsed: true } };
    return null;
  }

  if (output.type !== 'content' || !Array.isArray(output.value) || !onlyKeys(output, ['type', 'value'])) return null;
  const [first, ...files] = output.value as any[];
  if (!record(first) || first.type !== 'text' || first.text !== text || !onlyKeys(first, ['type', 'text'])) return null;
  const images: ImageDescriptor[] = [];
  let scan = 0;
  for (const file of files) {
    if (!record(file) || file.type !== 'file' || typeof file.mediaType !== 'string'
      || !onlyKeys(file, ['type', 'mediaType', 'data', 'filename'])) return null;
    const payload = record(file.data);
    if (!payload || payload.type !== 'data' || !Buffer.isBuffer(payload.data) || !onlyKeys(payload, ['type', 'data'])) return null;
    // WHY: the manifest stores the digest of the bytes the model actually saw, so a
    // file edited between publish and restore is refused rather than smuggled in.
    const wanted = digest(payload.data);
    let found: string | null = null;
    while (scan < paths.length) {
      const candidate = paths[scan++];
      if (digestOf(candidate) === wanted) { found = candidate; break; }
    }
    if (!found) return null;
    images.push({ path: found, mediaType: file.mediaType, digest: wanted, ...(file.filename !== undefined ? { filename: String(file.filename) } : {}) });
  }
  return images.length ? { images } : null;
}

/** Recover the prune keep-length from a trailer'd value, verified by recomputation.
 *  The trailer's own length depends on the digit count of the elided char count, so
 *  each plausible digit count is tried rather than parsing the sentence. */
function prunedKeepChars(text: string, value: string): number | null {
  const trailerBase = prunedToolResultText('', 0).length - 1;   // trailer length minus the '0'
  for (let digits = 1; digits <= 12; digits++) {
    const keepChars = value.length - (trailerBase + digits);
    if (keepChars < 0 || keepChars > text.length) continue;
    if (String(text.length - keepChars).length !== digits) continue;
    if (prunedToolResultText(text, keepChars) === value) return keepChars;
  }
  return null;
}

function describeParts(message: ModelMessage, anchors: AnchorSet): PartDescriptor[] | null {
  const parts: PartDescriptor[] = [];
  for (const raw of message.content as any[]) {
    const part = record(raw);
    if (!part) return null;

    if (part.type === 'text' || part.type === 'reasoning') {
      if (typeof part.text !== 'string' || !onlyKeys(part, ['type', 'text', 'providerOptions'])) return null;
      const options = providerOptionsFor(part.providerOptions, part.type);
      if (!options) return null;
      const field: TextField = part.type === 'reasoning' ? 'reasoning-text' : message.role === 'user' ? 'user-text' : 'assistant-text';
      if (part.type === 'reasoning' && part.text === '') {
        // WHY: @ai-sdk/openai opens a reasoning part for an encrypted item even when no
        // summary token ever arrives, and `ai` keeps that text:'' part in the response
        // message. No run of anchors can reproduce an empty target, so without this the
        // whole turn — ciphertext included — is unpublishable forever. Nothing is copied:
        // the descriptor carries only the allowlisted provider metadata.
        parts.push({ kind: 'empty', field: 'reasoning-text', ...options });
        continue;
      }
      if (field === 'user-text') {
        // WHY: user text has no concat descriptor, so only a single-anchor run may be
        // claimed — asking for one keeps a rejected longer run from spending anchors.
        const uuids = anchors.matchText(field, part.text, 1);
        if (!uuids) return null;
        parts.push({ kind: 'event', uuid: uuids[0], field, ...options });
      } else {
        const uuids = anchors.matchText(field, part.text);
        if (!uuids) return null;
        parts.push(textDescriptor(uuids, field, options));
      }
      continue;
    }

    if (part.type === 'tool-call') {
      if (!onlyKeys(part, ['type', 'toolCallId', 'toolName', 'input', 'providerOptions'])) return null;
      const options = providerOptionsFor(part.providerOptions, 'tool-call');
      if (!options) return null;
      const match = anchors.matchEvent('tool-call', event => String(event.data?.toolUseId ?? '') === part.toolCallId
        && String(event.data?.toolName ?? '') === part.toolName
        && canonical(event.data?.toolInput ?? {}) === canonical(part.input ?? {}));
      if (!match) return null;
      parts.push({ kind: 'event', uuid: match.uuid, field: 'tool-call', ...options });
      continue;
    }

    if (part.type === 'tool-result') {
      if (typeof part.toolName !== 'string' || !onlyKeys(part, ['type', 'toolCallId', 'toolName', 'output', 'providerOptions'])) return null;
      const options = providerOptionsFor(part.providerOptions, 'tool-result');
      if (!options) return null;
      let described: { images?: ImageDescriptor[]; pruned?: PrunedDescriptor } | null = null;
      const match = anchors.matchEvent('tool-result', event => {
        // WHY: the shape check IS the match test — a tool-result whose output no
        // longer relates to its event text must not claim that anchor. The result
        // is kept rather than recomputed so images are digested once.
        described = null;
        if (String(event.data?.toolUseId ?? '') !== part.toolCallId || String(event.data?.toolName ?? '') !== part.toolName) return false;
        described = describeToolResult(part, event, anchors.digestOf);
        return described !== null;
      });
      if (!match || !described) return null;
      parts.push({
        kind: 'event', uuid: match.uuid, field: 'tool-result', ...options,
        ...(described as { images?: ImageDescriptor[]; pruned?: PrunedDescriptor }),
      });
      continue;
    }

    // User attachment: bytes live on disk under a path an accepted user-message named.
    if (part.type === 'file' && Buffer.isBuffer(part.data) && typeof part.mediaType === 'string'
      && onlyKeys(part, ['type', 'mediaType', 'data'])) {
      const wanted = digest(part.data);
      const found = anchors.findAttachment(wanted);
      if (!found) return null;
      parts.push({ kind: 'image', path: found, mediaType: part.mediaType, digest: wanted });
      continue;
    }
    return null;
  }
  return parts;
}

function describeMessages(messages: ModelMessage[], anchors: AnchorSet): MessageDescriptor[] | null {
  const out: MessageDescriptor[] = [];
  for (const message of messages) {
    const sizing = durableContinuationSizing(message);
    const tail = sizing ? { sizing } : {};

    if (typeof message.content === 'string') {
      const content = describeString(message, anchors);
      if (!content) return null;
      out.push({ role: message.role, content, ...tail });
      continue;
    }
    if (!Array.isArray(message.content)) return null;
    const parts = describeParts(message, anchors);
    if (!parts) return null;
    out.push({ role: message.role, content: { kind: 'parts', parts }, ...tail });
  }
  return out;
}

function describeString(message: ModelMessage, anchors: AnchorSet): ContentDescriptor | null {
  const text = message.content as string;
  if (message.role === 'assistant') {
    // An interrupted partial. Never a literal: assistant text always has anchors.
    const uuids = anchors.matchText('assistant-text', text);
    if (!uuids) return null;
    return uuids.length === 1 ? { kind: 'event', uuid: uuids[0], field: 'assistant-text' } : { kind: 'concat', uuids, field: 'assistant-text' };
  }
  if (message.role !== 'user') return null;
  for (const field of ['user-text', 'skill-text', 'summary-text'] as const) {
    // Only a single anchor is describable here, and asking for one leaves the cursor
    // untouched when a longer run would have matched.
    const uuids = anchors.matchText(field, text, 1);
    if (uuids) return { kind: 'event', uuid: uuids[0], field };
  }
  // WHY: text that a run of anchors reproduces IS transcript content — copying it as a
  // literal would put real user text in the private sidecar, so it fails the publish.
  for (const field of ['user-text', 'skill-text', 'summary-text'] as const) {
    if (anchors.hasTextMatch(field, text)) return null;
  }
  // WHY: rules, steers and status snapshots are injected by the app and have no
  // transcript anchor to point at, so they are copied — bounded, and user-role only.
  if (Buffer.byteLength(text) > LITERAL_MAX_BYTES) return null;
  return { kind: 'literal', value: text };
}

// ---------------------------------------------------------------------------
// Restore side: descriptors -> the exact ModelMessage content published.
// ---------------------------------------------------------------------------

type Resolved = { value: any } | { reason: FailureReason };

function acceptedEvent(uuid: unknown, events: Map<string, TranscriptEvent>, accepted: Set<string>): TranscriptEvent | null {
  return typeof uuid === 'string' && accepted.has(uuid) ? events.get(uuid) ?? null : null;
}

function isTextField(value: unknown): value is TextField {
  return typeof value === 'string' && TEXT_FIELDS.includes(value);
}

function concatText(uuids: unknown, field: TextField, events: Map<string, TranscriptEvent>, accepted: Set<string>): string | null {
  if (!isTextField(field) || !Array.isArray(uuids) || uuids.length === 0) return null;
  let text = '';
  for (const uuid of uuids) {
    const event = acceptedEvent(uuid, events, accepted);
    const value = event && eventText(event, field);
    if (value === null || value === undefined) return null;
    text += value;
  }
  return text;
}

function restoreImage(image: ImageDescriptor): Buffer | null {
  let data: Buffer;
  try { data = fs.readFileSync(image.path); } catch { return null; }
  return digest(data) === image.digest ? data : null;
}

function restorePart(raw: PartDescriptor, events: Map<string, TranscriptEvent>, accepted: Set<string>): Resolved {
  if (!record(raw)) return { reason: 'malformed' };
  const part = raw as PartDescriptor;
  if (part.kind === 'image') {
    const data = restoreImage(part);
    return data ? { value: { type: 'file', mediaType: part.mediaType, data } } : { reason: 'image-mismatch' };
  }
  if (part.kind === 'concat') {
    const text = concatText(part.uuids, part.field, events, accepted);
    if (text === null) return { reason: 'malformed' };
    return { value: { type: part.field === 'reasoning-text' ? 'reasoning' : 'text', text, ...(part.providerOptions !== undefined ? { providerOptions: part.providerOptions } : {}) } };
  }
  if (part.kind === 'empty') {
    // WHY: only reasoning is publishable with empty text, so only reasoning may restore
    // from an anchorless descriptor — anything else here is a corrupt manifest.
    if (part.field !== 'reasoning-text') return { reason: 'malformed' };
    return { value: { type: 'reasoning', text: '', ...(part.providerOptions !== undefined ? { providerOptions: part.providerOptions } : {}) } };
  }
  if (part.kind !== 'event') return { reason: 'malformed' };
  const event = acceptedEvent(part.uuid, events, accepted);
  if (!event || event.type !== FIELD_EVENT_TYPE[part.field]) return { reason: 'malformed' };
  const providerOptions = part.providerOptions !== undefined ? { providerOptions: part.providerOptions } : {};

  if (part.field === 'tool-call') {
    return { value: { type: 'tool-call', toolCallId: String(event.data?.toolUseId ?? ''), toolName: String(event.data?.toolName ?? ''), input: event.data?.toolInput ?? {}, ...providerOptions } };
  }
  if (part.field === 'tool-result') {
    const toolName = String(event.data?.toolName ?? '');
    const text = String(event.data?.toolResult ?? '');
    let output: any;
    if (part.pruned && 'keepChars' in part.pruned) {
      // WHY: keepChars indexes into the event text; a value the text cannot support
      // would silently produce a DIFFERENT string than the model was sent.
      const keepChars = part.pruned.keepChars;
      if (!Number.isSafeInteger(keepChars) || keepChars < 0 || keepChars > text.length) return { reason: 'malformed' };
      output = { type: 'text', value: prunedToolResultText(text, keepChars) };
    } else if (part.pruned) output = { type: 'text', value: imageCollapsedToolResultText(text, toolName) };
    else if (part.images?.length) {
      const files: any[] = [];
      for (const image of part.images) {
        const data = restoreImage(image);
        if (!data) return { reason: 'image-mismatch' };
        files.push({ type: 'file', mediaType: image.mediaType, data: { type: 'data', data }, ...(image.filename !== undefined ? { filename: image.filename } : {}) });
      }
      output = { type: 'content', value: [{ type: 'text', text }, ...files] };
    } else output = { type: 'text', value: text };
    return { value: { type: 'tool-result', toolCallId: String(event.data?.toolUseId ?? ''), toolName, output, ...providerOptions } };
  }

  const text = eventText(event, part.field);
  if (text === null) return { reason: 'malformed' };
  return { value: { type: part.field === 'reasoning-text' ? 'reasoning' : 'text', text, ...providerOptions } };
}

function restoreContent(raw: ContentDescriptor | undefined, events: Map<string, TranscriptEvent>, accepted: Set<string>): Resolved {
  if (!record(raw)) return { reason: 'malformed' };
  const descriptor = raw as ContentDescriptor;
  if (descriptor.kind === 'literal') return typeof descriptor.value === 'string' ? { value: descriptor.value } : { reason: 'malformed' };
  if (descriptor.kind === 'concat') {
    const text = concatText(descriptor.uuids, descriptor.field, events, accepted);
    return text === null ? { reason: 'malformed' } : { value: text };
  }
  if (descriptor.kind === 'event') {
    // WHY: message-level content is a STRING; a tool-call/tool-result field here would
    // otherwise resolve through the text path and restore as an empty message.
    if (!isTextField(descriptor.field)) return { reason: 'malformed' };
    const event = acceptedEvent(descriptor.uuid, events, accepted);
    const text = event && eventText(event, descriptor.field);
    return text === null || text === undefined ? { reason: 'malformed' } : { value: text };
  }
  if (descriptor.kind !== 'parts' || !Array.isArray(descriptor.parts)) return { reason: 'malformed' };
  const parts: any[] = [];
  for (const part of descriptor.parts) {
    const resolved = restorePart(part, events, accepted);
    if ('reason' in resolved) return resolved;
    parts.push(resolved.value);
  }
  return { value: parts };
}
