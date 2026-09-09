// desktop/src/main/conversations/service.ts
// Composition root for the Conversation Store (design §1–§2). Module singleton
// like sync-spaces/service.ts. Owns: the store instance, live transcript-event
// intake (debounced activity upserts; prompt mirror+push on turn-complete),
// title/flag write-through, the startup + periodic reconciler, and the
// materialize-on-synced subscription.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConversationStore, ConversationStore } from './conversation-store';
import { createNamingStore, NamingStore } from './naming-store';
import { NamingRecord, effectiveName, isManuallyNamed, normalizeManualName } from './naming-core';
import { log } from '../logger';
import { NativeHome } from '../native-home';
import type { ConversationRecord, PortableModelRef } from './store-core';
import { mirrorIn, materializeOut } from './transcript-mirror';
import { reconcile } from './reconciler';
// Fix (fork hold): read from the leaf module, NOT from ./slug-repair — that
// module imports getConversationStore from THIS file, so importing it back
// here would be a cycle. See heldForkIds' WHY in slug-repair-state.ts.
import { heldForkIds } from './slug-repair-state';
import { laneMatches } from './lane-guards';
import { ccProjectSlug, nativeStoreSlug } from '../slug-encoding';
import { onSyncSpacesEvent, syncSpacesSyncNow, syncSpacesSyncNowAwaited, getManagedRoots } from '../sync-spaces/service';
import { readFolders } from '../saved-folders';
import { resolveLocalProject } from './resolve-local-project';
import type { TranscriptEvent, SessionProvider } from '../../shared/types';
import type { SpaceSyncEvent } from '../sync-spaces/types';

const ACTIVITY_DEBOUNCE_MS = 5_000;
const RECONCILE_INTERVAL_MS = 30 * 60_000; // slow tick; the startup scan is the load-bearing one
// Bug 2 Part 2 (Plan 2b): session-exit fires BEFORE the PTY worker actually dies,
// so CC may still be flushing its final turn to the local transcript. Before the
// targeted materialize copies a peer's version over the local file, wait for the
// local file to stop growing — two equal-size stats this far apart = CC done.
const QUIESCE_PROBE_MS = 750;   // gap between size probes
export const QUIESCE_MAX_MS = 6_000;   // give up waiting; skip this round (reconciler/startup sweep catch up)
// Handoff sync budget: how long flushSessionToSpace waits for the final turn's push
// to actually land before giving up (and letting the push continue in the background).
// COUPLED to the requester's takeover poll budget (MAX_MS in takeover.ts): that budget
// must exceed QUIESCE_MAX_MS + HANDOFF_SYNC_TIMEOUT_MS or a healthy handoff trips the
// force dialog. Keep all three constants in sync if you change one.
export const HANDOFF_SYNC_TIMEOUT_MS = 15_000;

interface SessionCtx {
  cwd: string;
  // The session-runtime axis (design §4.0 — NOT model-provider, which
  // native-session-host.ts already calls `provider`; hence `sessionProvider`
  // everywhere in this module to avoid entrenching that name collision).
  provider: SessionProvider;
  // Stashed by noteModelUsed when no record exists yet to attach it to
  // directly; folded into the NEXT transcript-event upsert (see
  // noteTranscriptEvent). Never used to seed a record on its own.
  pendingModelRef?: PortableModelRef;
}

let store: ConversationStore | null = null;
// Session name OWNERSHIP (who chose the name). Deliberately a SECOND store:
// see naming-store.ts for why it cannot be fields on ConversationRecord.
// It shares the conversation store's lifecycle but not its record shape,
// its healer or its activity-ranked merge.
let namingStore: NamingStore | null = null;
// WHY: IPC meta handlers go live (main.ts:745) before the store starts
// (main.ts:1701, fire-and-forget), so a tag/flag/note set in that boot window
// used to vanish while the store?. chains silently no-op'd — the IPC handler
// still answered ok:true (the 2026-07-19 incident class, for the
// store-availability dimension). metaWrite buffers a write made while
// 'starting', flushes buffered writes in arrival order once the store settles
// into 'ready' or 'unavailable', and answers honestly either way.
export type MetaWriteResult = { ok: boolean };
let storePhase: 'starting' | 'ready' | 'unavailable' = 'starting';
const pendingMetaWrites: Array<{ run: () => Promise<void>; resolve: (r: MetaWriteResult) => void }> = [];

async function metaWrite(run: () => Promise<void>): Promise<MetaWriteResult> {
  if (storePhase === 'ready') {
    try { await run(); return { ok: true }; } catch { return { ok: false }; }
  }
  if (storePhase === 'unavailable') return { ok: false };
  return new Promise((resolve) => pendingMetaWrites.push({ run, resolve }));
}

// Drains whatever is currently queued, resolving each in ARRIVAL order. Called
// once the store settles (ready or unavailable) so boot-window writes get an
// honest answer instead of hanging forever. Items that arrive AFTER this call
// starts (rare — nothing awaits mid-drain except the store call itself) simply
// queue for the next settle.
async function settlePendingMetaWrites(): Promise<void> {
  const drained = pendingMetaWrites.splice(0);
  for (const w of drained) {
    if (storePhase !== 'ready') { w.resolve({ ok: false }); continue; }
    try { await w.run(); w.resolve({ ok: true }); } catch { w.resolve({ ok: false }); }
  }
}
let projectsDir = '';
let topicsDir = '';
// Test-overridable ~/.youcoded parent root (see startConversationStore's
// nativeHomeRoot opt) — localJsonlPath's native branch needs the SAME override
// pruneNativePhantomRecords already accepts, so tests can point both at one
// tmp dir instead of the real home directory.
let nativeHomeRootOpt: string | undefined;
let device = '';
let unsubscribe: (() => void) | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
// Fix: the slug repair (spec §6) must not race the sweeps — see the WHY at the
// pauseSweeps export. While paused, any trigger (startup kick, the 30-min tick,
// a Personal 'synced' event) records a pending request instead of running.
// pauseDepth is a COUNTER, not a flag (review fix, MINOR): a second pauser
// calling pauseSweeps() while the first pause is still active must not have
// its resumeSweeps() lift the gate out from under the first caller — only
// the pauser that brings the depth back to 0 actually resumes.
let pauseDepth = 0;
let reconcilePending = false;
let materializePending = false;
// Fix: called by main.ts around the one-shot slug repair, BEFORE it runs.
// WHY: the reconciler snapshots every record at its start (reconciler.ts
// list() preload) and then walks directories for seconds; if the repair
// rewrites records / moves files mid-walk, that stale snapshot mirrors files
// back into buckets the repair just retired, and a concurrent materialize
// sweep re-creates a quarantined local copy from the pre-repair space record.
// Observed 2026-08-15 on real data: 8 space files + 1 local file resurrected
// this way. Pausing turns those triggers into one deferred run AFTER the
// repair, so the sweeps operate on repaired records instead of stale ones.
export function pauseSweeps(): void { pauseDepth++; }
export function resumeSweeps(): void {
  if (pauseDepth > 0) pauseDepth--;
  if (pauseDepth > 0) return; // still paused by another caller
  if (reconcilePending) { reconcilePending = false; runReconcile(); }
  if (materializePending) { materializePending = false; void materializeSweep(); }
}
// Desktop hook wiring resolves the CLAUDE session id before calling in, so the
// map is keyed by claude id (matches the store's record id). cwd is learned via
// noteSessionStarted; events for never-announced sessions still upsert (the live
// path corrects projectName/originalPath the next time the session runs here).
const sessions = new Map<string, SessionCtx>();
const pendingActivity = new Map<string, NodeJS.Timeout>();

export function getConversationStore(): ConversationStore | null { return store; }

// In-main notification that a conversation's user-visible metadata changed
// (flag, tag, or note). SESSION_META_CHANGED is a webContents.send to the
// RENDERER only — nothing in main could react to it, which the chatsearch index
// needs so a tag applied in-app is visible to the CLI before the next launch.
// Same Set-based shape as onSyncSpacesEvent.
const metaChangedListeners = new Set<() => void>();

export function onConversationMetaChanged(cb: () => void): () => void {
  metaChangedListeners.add(cb);
  return () => { metaChangedListeners.delete(cb); };
}

export function emitConversationMetaChanged(): void {
  for (const cb of metaChangedListeners) {
    // One bad listener must never break a metadata write.
    try { cb(); } catch { /* listener errors are not the writer's problem */ }
  }
}

export async function startConversationStore(opts?: {
  conversationsRoot?: string; namesRoot?: string; projectsDir?: string; topicsDir?: string; device?: string;
  nativeHomeRoot?: string;  // tests only — production reads ~/.youcoded
  // Fix: main.ts passes true so the startup reconcile/materialize kicks below
  // land as PENDING instead of running, giving the one-shot slug repair a
  // clean window before the sweeps see any records. Default false/absent
  // keeps every existing caller's behavior unchanged.
  pauseSweeps?: boolean;
}): Promise<void> {
  // Idempotent start (review fix 4): a second start without a stop would leak
  // the first onSyncSpacesEvent subscription (duplicate materialize sweeps
  // forever) and the first periodic interval. Tearing down first keeps the
  // module a true singleton regardless of how callers sequence start/stop.
  stopConversationStore();
  const personalRoot = getManagedRoots()?.personalRoot;
  const root = opts?.conversationsRoot
    ?? (personalRoot ? path.join(personalRoot, 'Conversations') : null);
  if (!root) {
    // Managed roots unavailable — the store stays off this launch. Any writes
    // buffered while phase was 'starting' get an honest ok:false rather than
    // hanging forever waiting for a store that will never come up.
    storePhase = 'unavailable';
    await settlePendingMetaWrites();
    return;
  }
  projectsDir = opts?.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');
  topicsDir = opts?.topicsDir ?? path.join(os.homedir(), '.claude', 'topics');
  nativeHomeRootOpt = opts?.nativeHomeRoot;
  device = opts?.device ?? os.hostname();
  store = createConversationStore(root);
  // Sibling of Conversations, never inside it — older clients scan and
  // rewrite that directory and would drop what they do not recognise.
  namingStore = createNamingStore(
    opts?.namesRoot ?? (personalRoot ? path.join(personalRoot, 'ConversationNames') : path.join(root, '..', 'ConversationNames')),
  );
  storePhase = 'ready';
  await settlePendingMetaWrites();

  // Carry-forward 3: subscribe ONCE and hold the unsubscribe. The listener Set
  // dedups identical fn refs, but a fresh closure each start would still leak.
  unsubscribe = onSyncSpacesEvent((e: SpaceSyncEvent) => {
    // Personal-space updates carry new/updated transcripts — sweep them out to
    // the CC projects dir so a session that ran on another device is resumable
    // here. Non-personal / non-updated events are ignored (the 'hub' sentinel
    // and project spaces never materialize conversations).
    if (e.type === 'synced' && e.spaceId === 'personal' && e.updated) void materializeSweep();
  });

  // Fix: pause BEFORE the detached kicks below, so the caller's post-repair
  // resumeSweeps() sees this run's startup reconcile/materialize as pending
  // work rather than having already fired against pre-repair records.
  if (opts?.pauseSweeps) pauseSweeps();

  // Carry-forward 2: kick the reconciler DETACHED. The first-ever run mirrors
  // potentially GBs of transcripts (serial copies); awaiting it here would block
  // app startup. runReconcile swallows its own failures.
  runReconcile();

  // Catch-up materialize on startup (2026-07-13 two-device dogfood fix, Part 1).
  // The space->local sweep is otherwise ONLY triggered by a fresh Personal
  // 'synced+updated' event (see the subscription above). So a PEER device's
  // transcript that already landed in this device's local space during a PREVIOUS
  // run — either while its session was still guarded, or before this store was
  // watching — was never written into the local Claude Code projects dir the app
  // resumes from. Result: the conversation looked permanently stale on this
  // device (the continuation sat in the space, unseen). Running one sweep at
  // startup applies any already-synced peer version on launch. Detached +
  // never-throws, exactly like runReconcile above.
  //
  // Scope: this is the INBOUND-on-startup catch-up ONLY. Releasing the live guard
  // and re-sweeping the moment a session CLOSES (so a peer version applies without
  // needing a restart) is deferred to Plan 2b — it needs leases to be safe (see
  // the guard comment inside materializeSweep for why materializing over a live
  // transcript is dangerous without single-writer guarantees).
  void materializeSweep();

  // One-shot cleanup of the PR #176 phantom records (see the function's comment).
  // Detached + never-throws, same as the two sweeps above — it must not delay
  // startup, and finding nothing (the steady state after the first run) is cheap.
  void pruneNativePhantomRecords({ nativeHomeRoot: opts?.nativeHomeRoot })
    .then((n) => { if (n > 0) log('INFO', 'ConversationStore', 'phantom native record cleanup complete', { pruned: n }); })
    .catch(() => { /* best-effort — never block startup */ });

  reconcileTimer = setInterval(() => { runReconcile(); }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();
}

export function stopConversationStore(): void {
  unsubscribe?.(); unsubscribe = null;
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
  for (const t of pendingActivity.values()) clearTimeout(t);
  pendingActivity.clear();
  sessions.clear();
  // Fix (review, MINOR): this module is a true singleton (idempotent restart
  // calls this first — see startConversationStore's comment) — a pause left
  // dangling from a PRIOR store's slug-repair run (or a caller that paused
  // and never resumed) must not silently carry into the next start and stick
  // every future sweep trigger in "pending" forever.
  namingStore = null;
  pauseDepth = 0;
  reconcilePending = false;
  materializePending = false;
  // WHY: only settle pending meta writes when a store was ACTUALLY running.
  // startConversationStore calls this unconditionally first (idempotent
  // teardown) even on the very first-ever start, when writes may already be
  // buffered waiting for THAT SAME call to bring the store up — settling them
  // ok:false here would fail them moments before they'd have succeeded. A real
  // stop of a RUNNING store (app quit, or an explicit restart) is different:
  // nothing is coming to flush the queue on its own, so anything still pending
  // must not hang its caller forever.
  const hadStore = store !== null;
  store = null;
  storePhase = 'starting';
  if (hadStore) void settlePendingMetaWrites();
}

export function noteSessionStarted(claudeSessionId: string, cwd: string, sessionProvider: SessionProvider): void {
  sessions.set(claudeSessionId, { cwd, provider: sessionProvider });
}

/**
 * One-shot cleanup for the phantom records PR #176 caused (2026-07-18).
 *
 * Flagging or noting a NATIVE session seeded a record under `claude/` with a
 * hardcoded provider — blank projectName / originalPath / transcriptRef, EPOCH
 * lastActive — which synced everywhere and was never pruned (flagged records are
 * deliberately kept). The write path is gated at its source now (ipc-handlers'
 * canWriteStoreRecord), but records already on disk need clearing, or they stay
 * forever AND collide with the real `native/` record once the parity work lands:
 * two Resume Browser rows for one conversation, one of them unopenable.
 *
 * DELIBERATELY CONSERVATIVE. Every condition must hold before anything is
 * deleted — this is the store's only destructive caller, and a false positive
 * would delete a real conversation record on every synced device:
 *   1. transcriptRef is blank — a real CC record always points at a transcript, AND
 *   2. projectName AND originalPath are blank, AND
 *   3. lastActive is EPOCH — the record never saw a single turn, AND
 *   4. a persisted ~/.youcoded/sessions file exists for the id, so the id is
 *      confirmed native rather than merely shaped like a phantom.
 * A phantom whose native session file was since deleted therefore survives. That
 * is the intended trade: leaving one stale row beats deleting a real one.
 *
 * Idempotent (a second run finds nothing) and best-effort — a failure here must
 * never block store startup.
 */
// Exported for tests (conversations-service.test.ts imports the module namespace
// and calls this directly); production callers use the in-scope reference above.
export async function pruneNativePhantomRecords(opts?: { nativeHomeRoot?: string }): Promise<number> {
  const s = store;
  if (!s) return 0;
  let records: ConversationRecord[];
  // WHY hardcoded 'claude' (not threaded): this cleanup targets records
  // mislabeled UNDER the 'claude' bucket by definition (PR #176's bug wrote
  // native sessions there with a hardcoded provider) — it is never called for
  // any other bucket, so there is no sessionProvider to thread here.
  try { records = await s.list('claude'); } catch { return 0; }
  // Cheap shape filter FIRST, so the sessions-dir listing below is only paid for
  // when a candidate actually exists (the common case is zero candidates).
  const candidates = records.filter(
    (r) => !r.transcriptRef && !r.projectName && !r.originalPath && Date.parse(r.lastActive) === 0,
  );
  if (candidates.length === 0) return 0;
  // Read-only listing (readdir + stat, no file contents) of every persisted
  // native session id on this device.
  let nativeIds: Set<string>;
  try {
    const home = new NativeHome(opts?.nativeHomeRoot);
    nativeIds = new Set(home.listSessionFiles().map((f) => f.sessionId));
  } catch { return 0; } // can't confirm nativeness → delete nothing
  let pruned = 0;
  for (const rec of candidates) {
    if (!nativeIds.has(rec.id)) continue;
    try {
      // Same WHY as the list() call above — this ONLY ever removes from the
      // 'claude' bucket, by definition of what a phantom-prune target is.
      if (await s.remove('claude', rec.id)) {
        pruned++;
        log('INFO', 'ConversationStore', 'pruned a phantom native record mislabeled as claude', { id: rec.id });
      }
    } catch { /* per-record isolation — one failure must not abort the pass */ }
  }
  return pruned;
}

// <root>/<sessionProvider>/transcripts/<projectKey>/<id>.jsonl — the durable
// space copy. projectKey is the portable project name (basename of cwd),
// matching the reconciler's transcriptRef convention (NOT the CC slug).
// sessionProvider is now a REQUIRED param (design D3) so every call site names
// its lane explicitly — 'claude' and 'native' transcripts live in disjoint
// lanes under the space root (design §4.1 item 2 / §4.2 in the M2 plan).
function spaceTranscriptPath(projectKey: string, sessionId: string, sessionProvider: SessionProvider): string {
  return path.join(store!.root(), sessionProvider, 'transcripts', projectKey, `${sessionId}.jsonl`);
}
// SECURITY: transcriptRef arrives from synced peer records (and is reachable over
// remote WS). Joining it unchecked would let a crafted record read/write outside
// the space root. Same refuse-on-escape stance as providerDir/recordPath in
// conversation-store.ts. Exported for tests.
export function containedTranscriptPath(root: string, ref: string): string | null {
  if (!ref || path.isAbsolute(ref)) return null;
  const resolvedRoot = path.resolve(root);
  const joined = path.resolve(resolvedRoot, ref);
  return joined.startsWith(resolvedRoot + path.sep) ? joined : null;
}
// The on-disk transcript path for this session, on THIS device.
// 'claude' -> ~/.claude/projects/<ccProjectSlug(cwd)>/<id>.jsonl (CC's own convention).
// 'native' -> ~/.youcoded/sessions/<nativeStoreSlug(cwd)>/<id>.jsonl — mirrors
// NativeHome's private sessionPath() exactly (the FROZEN app-private rule —
// raw slug, NOT ccProjectSlug's drive-letter uppercasing — see
// harness/session-store.ts's slug-divergence comment for why the two
// deliberately diverge).
function localJsonlPath(cwd: string, sessionId: string, sessionProvider: SessionProvider): string {
  if (sessionProvider === 'native') {
    const home = new NativeHome(nativeHomeRootOpt);
    return path.join(home.root, 'sessions', nativeStoreSlug(cwd), `${sessionId}.jsonl`);
  }
  return path.join(projectsDir, ccProjectSlug(cwd), `${sessionId}.jsonl`);
}

// ConversationRecord.provider is typed SessionProvider | string (string-open
// for future providers, store-core.ts) — narrow it defensively for path
// building so a foreign/corrupt provider string can't reach fs.join with an
// unexpected segment. Defaults to 'claude' (today's only real bucket besides
// 'native').
function asSessionProvider(provider: string): SessionProvider {
  return provider === 'native' ? 'native' : 'claude';
}

// Fire-and-forget store write with carry-forward 1 baked in: upsert can reject
// on lock timeout, and an uncaught rejection in Electron main is fatal-ish noise.
// The reconciler catches up whatever a dropped write missed.
function safeUpsert(input: Parameters<ConversationStore['upsert']>[0]): void {
  store?.upsert(input).catch(() => { /* lock contention — reconciler catches up */ });
}

export function noteTranscriptEvent(claudeSessionId: string, ev: TranscriptEvent, sessionProvider: SessionProvider): void {
  if (!store) return;
  const ctx = sessions.get(claudeSessionId);
  const upsertNow = () => {
    // Carry-forward 4: clear any pending debounce for this session before the
    // immediate write, so a stale timer can't fire a redundant older upsert 5s
    // later.
    const t = pendingActivity.get(claudeSessionId);
    if (t) { clearTimeout(t); pendingActivity.delete(claudeSessionId); }
    safeUpsert({
      id: claudeSessionId,
      provider: sessionProvider,
      // Metadata fields are LOCAL TRUTH in the store's merge; omit them (leave
      // undefined) when no cwd is known so we never overwrite a real value with ''.
      projectName: ctx ? path.basename(ctx.cwd) : undefined,
      originalPath: ctx?.cwd,
      // ev.timestamp is a Date.now() ms number stamped by the watcher (NOT the
      // JSONL time), so new Date(...) is safe.
      lastActive: new Date(ev.timestamp).toISOString(),
      device,
      transcriptRef: ctx
        ? `${sessionProvider}/transcripts/${path.basename(ctx.cwd)}/${claudeSessionId}.jsonl`
        : undefined,
      // Fold-in (design note): a model noted via noteModelUsed before this
      // session had a record to attach to rides here instead of being lost —
      // never sent as a standalone write (see noteModelUsed's own comment for
      // why a model-only upsert would be the §3.2 phantom shape).
      lastUsedModel: ctx?.pendingModelRef,
    });
  };

  if (ev.type === 'turn-complete') {
    upsertNow();
    if (ctx) {
      const key = path.basename(ctx.cwd);
      try {
        // Mirror the fresh local transcript into the durable space copy so it
        // rides the personal-space sync. Best-effort — the reconciler re-mirrors.
        mirrorIn({
          localJsonlPath: localJsonlPath(ctx.cwd, claudeSessionId, sessionProvider),
          spaceTranscriptPath: spaceTranscriptPath(key, claudeSessionId, sessionProvider),
        });
      } catch { /* best-effort; the reconciler catches up */ }
      // Prompt push (design §2): conversations move faster than the engine's
      // quiet-window debounce, so nudge a sync now. syncSpace is single-flight —
      // bursts coalesce. Wrapped in Promise.resolve so a sync/throwing stub
      // can't produce an unhandled rejection either.
      Promise.resolve(syncSpacesSyncNow('personal')).catch(() => { /* the poll covers a miss */ });
    }
    return;
  }

  // Chatty events (assistant-text / tool-use / thinking / …) debounce to one
  // activity upsert per quiet window — a turn can emit dozens.
  if (!pendingActivity.has(claudeSessionId)) {
    const t = setTimeout(upsertNow, ACTIVITY_DEBOUNCE_MS);
    t.unref?.();
    pendingActivity.set(claudeSessionId, t);
  }
}

// The raw title writer. setTitle is timestamp-less — it never fabricates
// activity. Two callers: setManualSessionName below, projecting a name the
// user typed so every existing reader (Resume Browser, chatsearch, remote,
// older clients on other devices) shows it; and noteAutomaticTitle, which
// adds the ownership gate. Generated titles must use THAT one.
export function noteTitleChanged(claudeSessionId: string, title: string, sessionProvider: SessionProvider): Promise<MetaWriteResult> {
  return metaWrite(() => store!.setTitle(sessionProvider, claudeSessionId, title));
}

/**
 * The AUTOMATIC title write. Identical to noteTitleChanged except that it
 * refuses when the user has named this conversation by hand — which is the
 * "a name you chose is never replaced" promise, enforced at the disk write so
 * a future automatic writer cannot forget it. Every generated-title path must
 * use this; noteTitleChanged stays the raw writer for the manual projection.
 *
 * A caller that ALSO paints the live pill must check ownership itself before
 * broadcasting: this refuses the write, it cannot un-send a broadcast.
 */
export async function noteAutomaticTitle(
  claudeSessionId: string, title: string, sessionProvider: SessionProvider,
): Promise<MetaWriteResult> {
  if (await isSessionNameOwned(sessionProvider, claudeSessionId)) return { ok: true };
  // Remember it as THE automatic name as well as writing the projection: it is
  // what Use automatic name puts back, immediately, instead of leaving the row
  // on the manual name until the next review comes round.
  await mutateNamingRecord(sessionProvider, claudeSessionId, (cur) => (
    cur.manual ? cur : { ...cur, auto: title, autoAt: new Date().toISOString() }
  )).catch(() => null);
  return noteTitleChanged(claudeSessionId, title, sessionProvider);
}

/* ── Session name ownership ──────────────────────────────────────────────
 * The naming sidecar is the authority on WHO chose a conversation's name;
 * ConversationRecord.title is kept as the compatibility projection so every
 * existing reader (Resume Browser, chatsearch, remote, older clients on other
 * devices) shows the right text without knowing this store exists.
 */

/** The ownership record, or null when there is none / the store is off. */
export async function getNamingRecord(
  sessionProvider: SessionProvider, sessionId: string,
): Promise<NamingRecord | null> {
  if (!namingStore) return null;
  try { return await namingStore.get(sessionProvider, sessionId); } catch { return null; }
}

/** Read-modify-write the ownership record under its cross-process lock. */
export async function mutateNamingRecord(
  sessionProvider: string, sessionId: string, fn: (cur: NamingRecord) => NamingRecord,
): Promise<NamingRecord | null> {
  if (!namingStore) return null;
  return namingStore.mutate(sessionProvider, sessionId, fn);
}

/** True when the user has chosen this conversation's name by hand. */
export async function isSessionNameOwned(
  sessionProvider: SessionProvider, sessionId: string,
): Promise<boolean> {
  return isManuallyNamed(await getNamingRecord(sessionProvider, sessionId));
}

/**
 * The name to show, given whatever the caller already had. Manual name wins,
 * then the stored automatic name, then the caller's fallback — so a session
 * with no ownership record looks exactly as it did before this store existed.
 */
export async function resolveSessionName(
  sessionProvider: SessionProvider, sessionId: string, fallback: string,
): Promise<{ name: string; manual: boolean }> {
  return effectiveName(await getNamingRecord(sessionProvider, sessionId), fallback);
}

/**
 * Save a name the user typed. Refuses blank input: clearing is a separate,
 * explicitly-chosen action, so an accidental Save on an empty box must not
 * silently hand the conversation back to automatic naming.
 *
 * Saving the SAME text still establishes ownership — that is the point of the
 * button for someone who likes the generated name and wants it to stop moving.
 */
export async function setManualSessionName(
  sessionProvider: SessionProvider, sessionId: string, raw: string,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const name = normalizeManualName(raw);
  if (!name) return { ok: false, error: 'Enter a name.' };
  if (!namingStore) {
    return { ok: false, error: 'Could not save — conversation storage is not available on this device.' };
  }
  const at = new Date().toISOString();
  try {
    await namingStore.mutate(sessionProvider, sessionId, (cur) => ({ ...cur, manual: name, manualAt: at }));
  } catch {
    return { ok: false, error: 'Could not save — conversation storage is not available on this device.' };
  }
  // Project into the record AFTER ownership is durable, so a crash between the
  // two leaves the user owning the name rather than owning nothing.
  await metaWrite(() => store!.setTitle(sessionProvider, sessionId, name));
  return { ok: true, name };
}


// C1: resolve which store bucket a meta write lands in. `knownNative` is the
// caller's SYNCHRONOUS isNativeSessionId(id) result — true only when the record
// is live now or on-disk here. When false the bucket is decided by probing the
// store's native bucket: a store-only native browse row (record synced, its
// transcript not yet materialized on this device — Task 5) is STILL native, but
// isNativeSessionId can't see it (session-store.ts has() is live/on-disk only).
// Without this probe, tagging/noting such a row wrote provider 'claude', seeding
// a phantom claude/<id>.json (blank transcriptRef, EPOCH lastActive) that syncs
// out, gets pruned on the origin device (the user's tag silently lost), shadows
// the real native record in materializeOne, and litters browse with a ghost row.
//
// Probed INSIDE the metaWrite thunk (which runs only once storePhase==='ready',
// so `store` is non-null) rather than at handler entry. That closes the boot
// window: a write made before startConversationStore finishes is buffered while
// the store is still null; deriving the provider up front would default to
// 'claude' and flush a native id into the wrong bucket at settle time. Deferring
// the probe to flush time re-derives it correctly against the now-live store.
async function providerForWrite(id: string, knownNative: boolean): Promise<SessionProvider> {
  if (knownNative) return 'native';
  try { return (await store!.get('native', id)) ? 'native' : 'claude'; }
  catch { return 'claude'; }
}

export function noteFlagChanged(claudeSessionId: string, flag: string, value: boolean, knownNative: boolean): Promise<MetaWriteResult> {
  return metaWrite(async () => {
    const provider = await providerForWrite(claudeSessionId, knownNative);
    await store!.setFlag(provider, claudeSessionId, flag, value);
  });
}

export function noteSessionNote(claudeSessionId: string, note: string, knownNative: boolean): Promise<MetaWriteResult> {
  return metaWrite(async () => {
    const provider = await providerForWrite(claudeSessionId, knownNative);
    await store!.setNote(provider, claudeSessionId, note);
  });
}

/**
 * Stash the model a session just used on its ctx, and — if a record for this
 * id ALREADY exists — upsert lastUsedModel right away so the resume selector
 * shows it without waiting for the next transcript event. When no ctx exists
 * (the session never announced itself via noteSessionStarted) there is
 * nowhere safe to stash the ref or a provider to write under, so this is a
 * no-op — a session that's actually running will have announced by now.
 *
 * NEVER seeds a record on its own: an upsert carrying only `lastUsedModel`
 * (no lastActive) on a session with no existing record would be exactly the
 * §3.2 phantom shape (blank transcriptRef, EPOCH lastActive, synced
 * everywhere) that pruneNativePhantomRecords exists to clean up. When no
 * record exists yet, the ref rides the NEXT transcript-event upsert instead
 * (see noteTranscriptEvent's ctx.pendingModelRef fold-in).
 */
export function noteModelUsed(sessionId: string, ref: PortableModelRef): void {
  const ctx = sessions.get(sessionId);
  if (!ctx) return;
  ctx.pendingModelRef = ref;
  const s = store;
  if (!s) return;
  void s.get(ctx.provider, sessionId)
    .then((rec) => {
      if (!rec) return; // no record yet — rides the next transcript upsert instead
      return s.upsert({ id: sessionId, provider: ctx.provider, lastUsedModel: ref });
    })
    .catch(() => { /* best-effort; the next transcript upsert folds it in anyway */ });
}

// resolveLocalProject (originalPath → managed-by-name → saved-by-basename) lives
// in ./resolve-local-project so the Resume Browser can reuse the IDENTICAL logic
// — see buildLocalProjectResolver below and session-browser.ts. The managed/saved
// lookups are HOISTED by callers (review fix 2): on a secondary device where
// originalPath never exists, per-record readdir + JSON reads made the sweep
// O(records × disk-reads) on EVERY remote turn.

/**
 * Build a resolver bound to THIS device's managed projects + saved folders, so
 * a caller (the Resume Browser) resolves a synced record to the SAME local
 * folder the materialize sweep does. Built ONCE per browse — the managed/saved
 * reads are cheap but not per-record. Cross-OS safe: a foreign-OS originalPath
 * that doesn't exist here is skipped in favor of the name/basename fallbacks.
 */
export function buildLocalProjectResolver(): (rec: { projectName: string; originalPath: string }) => string | null {
  const managed = new Map<string, string>(
    (getManagedRoots()?.listProjects() ?? []).map((p) => [p.name, p.path]),
  );
  let saved: Array<{ path: string }> = [];
  try { saved = readFolders(); } catch { /* saved folders unreadable */ }
  return (rec) => resolveLocalProject(rec, managed, saved);
}

// Task 8: list BOTH provider buckets so the sweep covers native/ records too.
// Per-provider try/catch (not one try around both calls) so a hiccup listing
// one bucket (e.g. a corrupt file in claude/) can't starve the other — same
// per-record isolation philosophy as the materializeOut try/catch below, one
// level up.
async function listAllProviders(s: ConversationStore): Promise<ConversationRecord[]> {
  const out: ConversationRecord[] = [];
  for (const p of ['claude', 'native'] as const) {
    try { out.push(...(await s.list(p))); } catch { /* isolated per bucket */ }
  }
  return out;
}

async function materializeSweep(): Promise<void> {
  // Fix: quiesced for the slug repair — see pauseSweeps' WHY. Return before
  // any I/O; resumeSweeps() re-fires this exact call once the pause lifts.
  if (pauseDepth > 0) { materializePending = true; return; }
  // Capture the store (review fix 3): stop() mid-sweep nulls the module field,
  // and every use below an await would otherwise become a swallowed TypeError.
  const s = store;
  if (!s) return;
  const records = await listAllProviders(s);
  // Hoist the project lookups once per sweep (review fix 2) — see
  // resolveLocalProject's comment for why per-record IO was a real cost.
  const managed = new Map<string, string>(
    (getManagedRoots()?.listProjects() ?? []).map((p) => [p.name, p.path]),
  );
  let saved: Array<{ path: string }> = [];
  try { saved = readFolders(); } catch { /* saved folders unreadable */ }
  // Fix (fork hold): read ONCE per sweep, not per record — a surfaced fork
  // (slug-repair.ts §6.0 Case C) must be frozen out of this direction until a
  // human resolves it; see heldForkIds' WHY in slug-repair-state.ts.
  const heldForks = heldForkIds();
  for (const rec of records) {
    if (!rec.transcriptRef) continue; // no durable copy to materialize from
    if (heldForks.has(rec.id)) continue; // fork hold — frozen until resolved
    // The record IS the truth for provider (not a param) — see
    // asSessionProvider's comment.
    const sessionProvider = asSessionProvider(rec.provider);
    // Lane assertion (D5, never cross-materialize): a record's transcriptRef
    // must live under ITS OWN provider's lane. Checked before the containment
    // guard below — it's a pure string check on the record's own fields (no
    // IO either way), so a mislabeled-but-otherwise-well-formed ref is caught
    // here first; containment still runs unconditionally after for whatever
    // survives, since matching the lane prefix alone doesn't rule out
    // traversal inside it.
    if (!laneMatches(sessionProvider, rec.transcriptRef)) {
      console.warn('[conversations] refused transcriptRef lane mismatch', rec.id);
      continue;
    }
    // SECURITY: refuse before any other work — see containedTranscriptPath.
    const src = containedTranscriptPath(s.root(), rec.transcriptRef);
    if (!src) { console.warn('[conversations] refused transcriptRef escaping space root', rec.id); continue; }
    // Review fix 1: NEVER materialize over a LIVE session's transcript.
    // For CLAUDE, without leases (Plan 2b) a same-conversation-on-two-devices
    // pull would replace the JSONL Claude Code is actively appending to —
    // Windows EPERM containment is unreliable (libuv opens with
    // FILE_SHARE_DELETE), and on POSIX the rename always succeeds: CC keeps
    // appending to the unlinked inode, the TranscriptWatcher's path-read never
    // grows, chat view freezes, and local turns are lost when the handle
    // closes.
    // For NATIVE, the SAME guard is kept for a DIFFERENT reason (design §5):
    // there is no long-lived fd — appendSessionLine (native-home.ts) opens the
    // file by path on every call — so the CC inode-detach failure mode above
    // does not apply. Instead, a mid-session materializeOut here would
    // silently REDIRECT the native session's subsequent appends onto the
    // freshly-materialized (space) file, interleaving space content with live
    // local appends. Same guard, different failure mode.
    // Accepted caveat: nothing removes entries from `sessions` on session
    // exit, so an ended session stays guarded until restart — fine for 2a
    // because mirrorIn keeps the space current from the fresher local side; a
    // noteSessionEnded refinement lands with leases in 2b.
    if (sessions.has(rec.id)) continue;
    const local = resolveLocalProject(rec, managed, saved);
    if (!local) continue;
    try {
      materializeOut({
        spaceTranscriptPath: src,
        localJsonlPath: localJsonlPath(local, rec.id, sessionProvider),
      });
    } catch { /* per-record isolation — one bad copy must not abort the sweep */ }
  }
}

// Bug 2 Part 2 (Plan 2b Task 7): called from the session-exit IPC handler when a
// CLAUDE session ends. Releases the per-session materialize guard `sessions` sets
// (so the record stops being skipped by materializeSweep) AND applies any peer
// version immediately — no app restart needed, which was the Bug-2 symptom. The
// companion lease release lands in Task 8.
export function noteSessionEnded(claudeSessionId: string): void {
  const ctx = sessions.get(claudeSessionId);
  sessions.delete(claudeSessionId); // release the materialize guard FIRST — even if the rest bails
  if (!store) return;
  // The targeted materialize is gated on the local transcript being quiescent
  // (CC may still be flushing) and never full-scans — see materializeOne.
  void materializeOne(claudeSessionId, ctx?.cwd).catch(() => { /* never reject in main */ });
}

// Targeted equivalent of materializeSweep for ONE session: resolve its local
// project, wait for the local transcript to go quiescent, then pull a larger peer
// version over it (grow-only, same as the sweep). Isolated so an ended session
// applies a peer edit without waiting for the 30-min reconcile tick.
//
// Plan 2b Task 9: EXPORTED and renamed from materializeEndedSession because the
// REQUESTER-side takeover flow reuses it — after a holder releases a lease, the
// requester pulls the peer's final turn into the local CC transcript with this.
// For the requester there's no live local session (sessions.has(id) is false and
// the local file is stale/absent), so it quiesces immediately; cwd is undefined
// so it resolves the project via resolveLocalProject.
export async function materializeOne(id: string, cwd?: string): Promise<void> {
  const s = store; if (!s) return;
  // Fix (fork hold): a surfaced fork must be frozen out of this direction
  // until a human resolves it — see heldForkIds' WHY in slug-repair-state.ts.
  // Checked before any I/O (quiescence wait, project resolution) below.
  if (heldForkIds().has(id)) {
    // Fix (review, MINOR): a takeover attempt silently doing nothing against
    // a held session was undiagnosable — this line makes it visible that the
    // no-op was the hold, not a bug.
    log('INFO', 'ConversationStore', 'materialize skipped: fork held', { id });
    return;
  }
  // Task 8: try 'claude' first, then 'native' — a UUID can't legitimately
  // exist in both buckets, so the first hit IS the record (no need to read
  // both on the common path). Each lookup is isolated: a rejecting get() on
  // one bucket doesn't stop us from trying the other.
  let rec: ConversationRecord | null = null;
  try { rec = await s.get('claude', id); } catch { rec = null; }
  if (!rec) {
    try { rec = await s.get('native', id); } catch { rec = null; }
  }
  // C1: a claude-bucket record with an EMPTY transcriptRef for an id that ALSO
  // exists in the native bucket is a phantom shadowing the real native record
  // (the C1 misroute seeds exactly this shape). The claude-first lookup above
  // would find the phantom, hit the `!rec.transcriptRef` early-return below, and
  // silently no-op the requester's targeted pull. Prefer the native record when
  // it's the one carrying a transcript.
  if (rec && !rec.transcriptRef && asSessionProvider(rec.provider) === 'claude') {
    let nativeRec: ConversationRecord | null = null;
    try { nativeRec = await s.get('native', id); } catch { nativeRec = null; }
    if (nativeRec?.transcriptRef) {
      console.warn('[conversations] native record shadowed by empty claude phantom — using native', id);
      rec = nativeRec;
    }
  }
  if (!rec?.transcriptRef) return;
  // The record IS the truth for provider (not a param) — see
  // asSessionProvider's comment.
  const sessionProvider = asSessionProvider(rec.provider);
  // Lane assertion (D5, never cross-materialize) — see the identical check +
  // WHY in materializeSweep. Runs before the containment guard for the same
  // reason: pure field check, no IO, catches a mislabeled ref first.
  if (!laneMatches(sessionProvider, rec.transcriptRef)) {
    console.warn('[conversations] refused transcriptRef lane mismatch', rec.id);
    return;
  }
  // SECURITY: refuse before any other work (quiescence wait, local resolution)
  // — see containedTranscriptPath.
  const src = containedTranscriptPath(s.root(), rec.transcriptRef);
  if (!src) { console.warn('[conversations] refused transcriptRef escaping space root', rec.id); return; }
  // Resolve the local project. On the common path cwd is known (learned via
  // noteSessionStarted), so only pay for the managed/saved-folder reads on the
  // cwd miss (a session that ended without ever being announced here).
  let local = cwd;
  if (!local) {
    const managed = new Map<string, string>((getManagedRoots()?.listProjects() ?? []).map((p) => [p.name, p.path]));
    let saved: Array<{ path: string }> = [];
    try { saved = readFolders(); } catch { /* saved folders unreadable */ }
    local = resolveLocalProject(rec, managed, saved) ?? undefined;
  }
  if (!local) return;
  const localPath = localJsonlPath(local, id, sessionProvider);
  // Quiescence: if it never stabilizes before QUIESCE_MAX_MS, CC is still
  // flushing — SKIP this round (never rename over a transcript CC still has open:
  // POSIX detaches the inode and CC keeps appending to it → chat freeze + lost
  // turns). The reconciler/startup sweep catch up once the local file is quiet.
  if (!(await waitForQuiescence(localPath))) return; // timed out still growing — skip, do NOT materialize
  // Re-opened during the wait — the live guard wins; do NOT touch the transcript
  // CC is now appending to (the sweep's live-session invariant).
  if (sessions.has(id)) return;
  try {
    materializeOut({ spaceTranscriptPath: src, localJsonlPath: localPath });
  } catch { /* grow-only copy failed — startup sweep catches up */ }
}

// Poll the local transcript size until it holds steady across one probe interval.
// Returns true if it went quiescent, false on timeout (still growing at
// QUIESCE_MAX_MS). Shared by materializeOne (space->local direction:
// skip on timeout) and flushSessionToSpace (local->space direction: push anyway).
async function waitForQuiescence(localPath: string): Promise<boolean> {
  const started = Date.now();
  let prev = -1;
  while (Date.now() - started < QUIESCE_MAX_MS) {
    let size = 0;
    try { size = fs.statSync(localPath).size; } catch { size = 0; } // absent local is quiescent (size 0 stable)
    if (size === prev) return true;
    prev = size;
    await new Promise((r) => setTimeout(r, QUIESCE_PROBE_MS));
  }
  return false;
}

// Holder-side takeover step 4-5 (Plan 2b Task 8): after the holder interrupts,
// wait for CC to finish flushing the interrupted turn, then push the local
// transcript into the space so the REQUESTER pulls the FINAL turn. mirrorIn
// (local->space) is grow-only and never touches CC's open local file, so pushing
// even on a quiescence TIMEOUT is safe (unlike materializeOne's
// space->local direction, which must skip on timeout to avoid clobbering the file
// CC still has open).
export async function flushSessionToSpace(claudeSessionId: string): Promise<void> {
  const s = store; if (!s) return;
  const ctx = sessions.get(claudeSessionId);
  if (!ctx) return; // no cwd known — can't locate the transcript
  const key = path.basename(ctx.cwd);
  const localPath = localJsonlPath(ctx.cwd, claudeSessionId, ctx.provider);
  await waitForQuiescence(localPath); // best-effort wait; push regardless of the result
  try { mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spaceTranscriptPath(key, claudeSessionId, ctx.provider) }); }
  catch { /* best-effort; the reconciler re-mirrors */ }
  // MIRROR-BEFORE-RELEASE is load-bearing: genuinely AWAIT the push so the final
  // turn is in the space before the requester pulls. syncSpacesSyncNow would be
  // fire-and-forget here (resolves before git runs) — the awaitable variant is what
  // makes the barrier real. Bounded by HANDOFF_SYNC_TIMEOUT_MS so a slow network
  // can't wedge the handoff.
  try { await syncSpacesSyncNowAwaited('personal', HANDOFF_SYNC_TIMEOUT_MS); } catch { /* the poll covers a miss */ }
}

function runReconcile(): void {
  // Fix: quiesced for the slug repair — see pauseSweeps' WHY. resumeSweeps()
  // re-fires this exact call once the pause lifts.
  if (pauseDepth > 0) { reconcilePending = true; return; }
  if (!store) return;
  const s = store;
  // Known folders let the reconciler recover the EXACT project name for a CC slug
  // instead of the lossy last-segment truncation, so a bare-`claude` session in a
  // hyphenated folder ('youcoded-dev') gets the same projectKey the live path
  // uses — no orphan duplicate transcript, no cross-device materialize gap. Built
  // fresh per run (one readdir + one JSON read every 30 min — cheap).
  const knownFolders: string[] = [
    ...(getManagedRoots()?.listProjects() ?? []).map((p) => p.path),
  ];
  try { knownFolders.push(...readFolders().map((f) => f.path)); }
  catch { /* saved folders unreadable — managed projects still cover most cases */ }
  // Fix (fork hold): read ONCE per reconcile run, not per mirror() call — a
  // surfaced fork must be frozen out of the local->space direction too; see
  // heldForkIds' WHY in slug-repair-state.ts.
  const heldForks = heldForkIds();
  reconcile({
    projectsDir, topicsDir, store: s, device, knownFolders,
    // Production mirror closure: the reconciler stays free of transcript-mirror
    // + the Conversations root. Best-effort — a throw here must not abort the scan.
    mirror: (localPath: string, projectKey: string, sessionId: string) => {
      if (heldForks.has(sessionId)) return; // fork hold — frozen until resolved
      try {
        // WHY hardcoded 'claude': the reconciler scans ~/.claude/projects only
        // — it is CC-only by definition, not a stopgap (reconciler.ts:115,182,188
        // are the same call, kept for the same reason).
        mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spaceTranscriptPath(projectKey, sessionId, 'claude') });
      } catch { /* best-effort */ }
    },
  }).catch(() => { /* reconciler failure must never break startup (carry-forward 2) */ });
}
