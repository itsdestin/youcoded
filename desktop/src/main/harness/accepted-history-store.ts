import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { ModelMessage } from 'ai';
import type { TranscriptEvent } from '../../shared/types';
import { restoreContinuationSizing, durableContinuationSizing } from './openai-continuation';

const VERSION = 1;
export const ACCEPTED_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

type FailureReason = 'ineligible' | 'malformed' | 'oversized' | 'missing-transcript'
  | 'transcript-advanced' | 'binding-mismatch' | 'assembly-mismatch' | 'image-mismatch';

type ContentDescriptor =
  | { kind: 'literal'; value: unknown }
  | { kind: 'event'; uuid: string; field: 'user-text' | 'assistant-text' | 'reasoning-text' | 'tool-call' | 'tool-result'; metadata?: unknown }
  | { kind: 'parts'; parts: PartDescriptor[] };

type PartDescriptor =
  | { kind: 'event'; uuid: string; field: 'user-text' | 'assistant-text' | 'reasoning-text' | 'tool-call' | 'tool-result'; metadata?: unknown }
  | { kind: 'image'; path: string; mediaType: string; digest: string; filename?: string; wrapped?: boolean }
  | { kind: 'literal'; value: unknown };

interface MessageDescriptor {
  role: ModelMessage['role'];
  content: ContentDescriptor;
  sizing?: { reasoningTokens?: number; reasoningEstimateIncomplete: boolean };
}

interface Manifest {
  v: 1;
  sessionId: string;
  transcriptPath: string;
  transcript: { bytes: number; digest: string };
  binding: string;
  assemblyDigest: string;
  revision: number;
  acceptedEventUuids: string[];
  messages: MessageDescriptor[];
  transformation?: AcceptedHistoryProposal['transformation'];
}

interface Eligibility { v: 1; sessionId: string; revision: number; eligible: boolean; reason: string }

export interface AcceptedHistoryProposal {
  sessionId: string;
  transcriptPath: string;
  binding: string;
  assemblyDigest: string;
  revision: number;
  acceptedEventUuids: string[];
  messages: ModelMessage[];
  transformation?: {
    kind: 'append-only' | 'pruned' | 'summary';
    prunedToolResultUuids?: string[];
    summaryEventUuid?: string;
    retainedEventUuids?: string[];
  };
}

export interface AcceptedHistoryStoreHooks {
  beforeRename?: () => void | Promise<void>;
  unlink?: (file: string) => void | Promise<void>;
}

function digest(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function record(value: unknown): Record<string, any> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
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

function eventValue(event: TranscriptEvent, field: PartDescriptor extends infer _ ? string : never): unknown {
  switch (field) {
    case 'user-text': return String(event.data?.text ?? '');
    case 'assistant-text':
    case 'reasoning-text': return String(event.data?.text ?? '');
    case 'tool-call': return { type: 'tool-call', toolCallId: String(event.data?.toolUseId ?? ''), toolName: String(event.data?.toolName ?? ''), input: event.data?.toolInput ?? {} };
    case 'tool-result': return { type: 'tool-result', toolCallId: String(event.data?.toolUseId ?? ''), toolName: String(event.data?.toolName ?? ''), output: { type: 'text', value: String(event.data?.toolResult ?? '') } };
    default: return undefined;
  }
}

function metadataWithoutContent(part: any): unknown {
  if (!record(part)) return undefined;
  const { text: _text, data: _data, ...metadata } = part;
  return Object.keys(metadata).length ? metadata : undefined;
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

  manifestPathForTest(sessionId: string): string { return path.join(this.dir, `${encodeURIComponent(sessionId)}.manifest.json`); }
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
      const raw = rawTranscript(proposal.transcriptPath);
      if (!raw) return { ok: false, reason: 'unreferenced-history' } as const;
      const accepted = new Set(proposal.acceptedEventUuids);
      const messages = this.describeMessages(proposal.messages, raw.events, accepted);
      if (!messages) return { ok: false, reason: 'unreferenced-history' } as const;
      const manifest: Manifest = {
        v: VERSION, sessionId: proposal.sessionId, transcriptPath: proposal.transcriptPath,
        transcript: { bytes: raw.bytes, digest: raw.digest }, binding: proposal.binding,
        assemblyDigest: proposal.assemblyDigest, revision: proposal.revision,
        acceptedEventUuids: [...proposal.acceptedEventUuids], messages,
        ...(proposal.transformation ? { transformation: proposal.transformation } : {}),
      };
      const json = JSON.stringify(manifest);
      if (Buffer.byteLength(json) > ACCEPTED_HISTORY_MAX_BYTES) return { ok: false, reason: 'oversized' } as const;
      try {
        await this.atomicWrite(this.manifestPathForTest(proposal.sessionId), json);
        // Recheck after writing the immutable proposal and immediately before eligibility publication.
        if (proposal.revision !== this.currentRevision(proposal.sessionId)) return { ok: false, reason: 'stale-generation' } as const;
        await this.atomicWrite(this.eligibilityPath(proposal.sessionId), JSON.stringify({ v: VERSION, sessionId: proposal.sessionId, revision: proposal.revision, eligible: true, reason: 'published' } satisfies Eligibility));
        return { ok: true } as const;
      } catch {
        return { ok: false, reason: 'write-failed' } as const;
      }
    });
  }

  restore(input: { sessionId: string; transcriptPath: string; binding: string; assemblyDigest: string }): { ok: true; messages: ModelMessage[] } | { ok: false; reason: FailureReason } {
    const eligibility = this.readBoundedJson(this.eligibilityPath(input.sessionId)) as Eligibility | null;
    if (!eligibility || eligibility.v !== VERSION || eligibility.sessionId !== input.sessionId || !eligibility.eligible) return { ok: false, reason: 'ineligible' };
    const file = this.manifestPathForTest(input.sessionId);
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return { ok: false, reason: 'ineligible' }; }
    if (stat.size > ACCEPTED_HISTORY_MAX_BYTES) return { ok: false, reason: 'oversized' };
    const manifest = this.readBoundedJson(file) as Manifest | null;
    if (!manifest || manifest.v !== VERSION || manifest.sessionId !== input.sessionId || manifest.revision !== eligibility.revision || !Array.isArray(manifest.messages)) return { ok: false, reason: 'malformed' };
    if (manifest.binding !== input.binding) return { ok: false, reason: 'binding-mismatch' };
    if (manifest.assemblyDigest !== input.assemblyDigest) return { ok: false, reason: 'assembly-mismatch' };
    if (path.resolve(manifest.transcriptPath) !== path.resolve(input.transcriptPath)) return { ok: false, reason: 'missing-transcript' };
    const raw = rawTranscript(input.transcriptPath);
    if (!raw) { void this.remove(input.sessionId); return { ok: false, reason: 'missing-transcript' }; }
    if (raw.bytes !== manifest.transcript.bytes || raw.digest !== manifest.transcript.digest) return { ok: false, reason: 'transcript-advanced' };
    const accepted = new Set(manifest.acceptedEventUuids);
    const messages: ModelMessage[] = [];
    for (const descriptor of manifest.messages) {
      const content = this.restoreContent(descriptor.content, raw.events, accepted);
      if (content === undefined) return { ok: false, reason: 'image-mismatch' };
      const message = { role: descriptor.role, content } as ModelMessage;
      if (descriptor.sizing) restoreContinuationSizing(message, descriptor.sizing);
      messages.push(message);
    }
    return { ok: true, messages };
  }

  async remove(sessionId: string): Promise<{ ok: true } | { ok: false; reason: 'unlink-failed' }> {
    await this.invalidate(sessionId, 'deleted');
    try {
      const unlink = this.hooks.unlink ?? ((file: string) => fs.promises.unlink(file));
      await unlink(this.manifestPathForTest(sessionId));
      return { ok: true };
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { ok: true };
      return { ok: false, reason: 'unlink-failed' };
    }
  }

  async cleanupOrphans(): Promise<void> {
    let files: string[];
    try { files = fs.readdirSync(this.dir); } catch { return; }
    for (const name of files.filter(name => name.endsWith('.manifest.json'))) {
      const manifest = this.readBoundedJson(path.join(this.dir, name)) as Manifest | null;
      if (!manifest || !fs.existsSync(manifest.transcriptPath)) {
        const encoded = name.slice(0, -'.manifest.json'.length);
        await this.remove(decodeURIComponent(encoded));
      }
    }
  }

  private describeMessages(messages: ModelMessage[], events: Map<string, TranscriptEvent>, accepted: Set<string>): MessageDescriptor[] | null {
    const unused = [...accepted].map(uuid => events.get(uuid)).filter((e): e is TranscriptEvent => !!e);
    const claim = (predicate: (event: TranscriptEvent) => boolean): TranscriptEvent | undefined => {
      const index = unused.findIndex(predicate);
      return index < 0 ? undefined : unused.splice(index, 1)[0];
    };
    const out: MessageDescriptor[] = [];
    for (const message of messages) {
      const sizing = durableContinuationSizing(message);
      if (typeof message.content === 'string') {
        const event = claim(e => (e.type === 'user-message' || e.type === 'skill-invoked' || e.type === 'compact-summary') && String(e.data?.text ?? e.data?.body ?? e.data?.summary ?? '') === message.content);
        if (event) out.push({ role: message.role, content: { kind: 'event', uuid: event.uuid!, field: 'user-text' }, ...(sizing ? { sizing } : {}) });
        else if (message.role === 'user') out.push({ role: message.role, content: { kind: 'literal', value: message.content }, ...(sizing ? { sizing } : {}) });
        else return null;
        continue;
      }
      if (!Array.isArray(message.content)) return null;
      const parts: PartDescriptor[] = [];
      for (const part of message.content as any[]) {
        if (part?.type === 'file' && Buffer.isBuffer(part.data)) {
          // WHY: one user event owns both its text and every attachment. Text may
          // already have claimed that UUID, so images search all accepted anchors.
          const event = [...events.values()].find(e => accepted.has(e.uuid!) && Array.isArray(e.data?.attachments) && (e.data.attachments as string[]).some(p => {
            try { return fs.readFileSync(p).equals(part.data); } catch { return false; }
          }));
          const imagePath = event && (event.data!.attachments as string[]).find(p => { try { return fs.readFileSync(p).equals(part.data); } catch { return false; } });
          if (!imagePath) return null;
          parts.push({ kind: 'image', path: imagePath, mediaType: part.mediaType, digest: digest(part.data) });
          continue;
        }
        const field = part?.type === 'text'
          ? (message.role === 'user' ? 'user-text' : 'assistant-text')
          : part?.type === 'reasoning' ? 'reasoning-text' : part?.type === 'tool-call' ? 'tool-call' : part?.type === 'tool-result' ? 'tool-result' : null;
        if (!field) { parts.push({ kind: 'literal', value: part }); continue; }
        const event = claim(e => accepted.has(e.uuid!) && ((field === 'user-text' && e.type === 'user-message' && e.data?.text === part.text)
          || (field === 'assistant-text' && e.type === 'assistant-text' && e.data?.text === part.text)
          || (field === 'reasoning-text' && e.type === 'assistant-thinking' && e.data?.text === part.text)
          || (field === 'tool-call' && e.type === 'tool-use' && e.data?.toolUseId === part.toolCallId)
          || (field === 'tool-result' && e.type === 'tool-result' && e.data?.toolUseId === part.toolCallId)));
        if (!event) return null;
        parts.push({ kind: 'event', uuid: event.uuid!, field, metadata: metadataWithoutContent(part) });
      }
      out.push({ role: message.role, content: { kind: 'parts', parts }, ...(sizing ? { sizing } : {}) });
    }
    return out;
  }

  private restoreContent(descriptor: ContentDescriptor, events: Map<string, TranscriptEvent>, accepted: Set<string>): any | undefined {
    if (descriptor.kind === 'literal') return descriptor.value;
    if (descriptor.kind === 'event') {
      const event = accepted.has(descriptor.uuid) ? events.get(descriptor.uuid) : undefined;
      if (!event) return undefined;
      return eventValue(event, descriptor.field);
    }
    const parts: any[] = [];
    for (const part of descriptor.parts) {
      if (part.kind === 'literal') { parts.push(part.value); continue; }
      if (part.kind === 'image') {
        let data: Buffer;
        try { data = fs.readFileSync(part.path); } catch { return undefined; }
        if (digest(data) !== part.digest) return undefined;
        parts.push({ type: 'file', mediaType: part.mediaType, data, ...(part.filename ? { filename: part.filename } : {}) });
        continue;
      }
      const event = accepted.has(part.uuid) ? events.get(part.uuid) : undefined;
      if (!event) return undefined;
      const value = eventValue(event, part.field) as any;
      if (part.field === 'user-text' || part.field === 'assistant-text' || part.field === 'reasoning-text') {
        parts.push({ ...(record(part.metadata) ?? {}), text: value });
      } else {
        parts.push({ ...value, ...(record(part.metadata) ?? {}) });
      }
    }
    return parts;
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
