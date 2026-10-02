// session-record.ts — the computer's own record of each session (one-core R5-1, seam S5).
//
// WHY (2026-10-01 one-core R5-1): main used to forward every session event to the windows and
// phones and keep nothing, so what a screen "knew" about a session (is it working, is a
// question waiting, what came after event N) lived only in whichever window's chat reducer had
// seen the events. This is the one copy the computer keeps. R5-1 made it; R5-2 (this file's
// tail and terminal stream, session-open.ts) fills every screen from it: a phone, a torn-off
// window and a reconnecting phone all ask `session:open` and get a page, this record's recent
// past, and what is still waiting. R5-3 will filter delivery by it.
//
// Per session:
//   - an EPOCH: random, new when the record is created, never bumped by /clear or /compact
//     (transcript:shrink is itself a numbered event, so a client inside the ring range replays
//     it and a client outside the range gets a fresh page instead);
//   - a numbered event RING: at most RING_MAX_EVENTS events or RING_MAX_BYTES, whichever is
//     reached first. It only has to cover a reconnect gap; history comes from the page;
//   - a TAIL: the same recent transcript events with a streaming answer's per-word deltas merged into
//     one entry per part, so a screen that opens mid-answer gets the whole answer so far (the part of
//     it still only in memory) however long the answer is. Used to FILL a screen; the ring is used to
//     RESUME one;
//   - OPEN ASKS, kept OUTSIDE the ring so trimming can never lose a waiting question;
//   - LIVE FACTS: working, attention, how many asks wait, mode, model, queue;
//   - the TERMINAL STREAM: the session's output bytes with their own epoch and offset, so a phone's
//     terminal resumes exactly where it left off (moved here from RemoteServer.ptyBuffers).
//
// Electron-free on purpose: tests/create-runtime.test.ts proves nothing reachable from
// create-runtime imports Electron, and the record is built there.
import { randomBytes } from 'crypto';
import type { SessionSummary } from '../shared/session-summary-types';
import type { SessionLive } from '../shared/session-live-types';
import type { InputBlock } from '../shared/cc-input-focus';
import { isSendId, type SendOutcome } from '../shared/send-outcome-types';

export const RING_MAX_EVENTS = 2000;
export const RING_MAX_BYTES = 2 * 1024 * 1024;
/** The fill tail's bounds: merged entries are few, so the byte bound is what matters. */
export const TAIL_MAX_ENTRIES = 4000;
const TAIL_MAX_BYTES = 2 * 1024 * 1024;
/** The terminal stream, in UTF-16 units (JavaScript string length): the same 4M the old per-session buffer held. */
export const PTY_STREAM_UNITS = 4 * 1024 * 1024;
/** While the newest terminal chunk is this small, append INTO it instead of pushing another entry (one-keystroke chunks). */
const PTY_CHUNK_COALESCE_BELOW = 4096;
/** Prompt cards held open per session: a card is a menu on a terminal screen, so more than a handful at once is a runaway. */
const OPEN_PROMPTS_MAX = 20;
/** A session cannot hold more open asks than this (a runaway producer must not grow it without bound). */
const OPEN_ASKS_MAX = 200;
/** Recently seen event uuids, so a replayed event does not start a turn twice (the renderer's seenUuids). */
const SEEN_UUIDS_MAX = 512;
/** Send ids a session's record remembers (the lost-send check, R5-4b). Past this the oldest are let go, and an id not found can no longer be called "not received". */
const SENDS_MAX = 500;
/** Ids of sessions that ended, so a late event cannot resurrect a dead session's record. */
const TOMBSTONES_MAX = 256;

/** The session-scoped pushes `publish` carries. tests/session-publish-coverage.test.ts pins that
 *  every one of these is sent through publish (or is listed in SPLIT_DELIVERY below with its reason). */
export const SESSION_SCOPED_PUSHES = [
  'transcript:event', 'transcript:shrink', 'hook:event', 'specialists:event',
  'native:shell-event', 'native:session-context', 'native:permission-mode', 'native:model-state',
  'session:meta-changed',
  // One-core R5-4a: the shared lines and live facts (queue, model, dividers, compaction spinner, prompt cards), and the permission mode a
  // Claude Code session's host now reads from its terminal.
  'session:live', 'session:permission-mode',
] as const;

/** Session-scoped pushes whose DELIVERY is not a `publish` call, with the reason each is not. (Claude Code's hook relay used to be
 *  here, delivered by main.ts to the windows and by RemoteServer to the phones; R5-2 publishes it from main.ts.) */
export const SPLIT_DELIVERY: Record<string, string> = {
  // Terminal bytes are not events: they are numbered by their own stream position (notePty), relayed to every phone by RemoteServer.
  'pty:output': 'bytes, not events: appended to the record\'s terminal stream and relayed by RemoteServer, each chunk with its epoch and offset',
};

/**
 * A cheap size for the ring's byte bound, WITHOUT serialising the event.
 * WHY (R5-1 review): note() used to JSON.stringify every published event. RemoteServer.broadcast deliberately skips its
 * own stringify when no phone is connected, so that was a new per-event cost, tens of ms for a multi-MB tool result.
 * A string's .length is O(1), so this walks the object counting string lengths plus a small per-key/per-node overhead,
 * and gives up after SIZE_WALK_NODES nodes (the rest is charged at the average so far). It tracks JSON length closely.
 * The unit is UTF-16 code units: V8 holds a string at 1 or 2 bytes per unit, so the held memory is between 1x and 2x
 * this number (about 2x for non-Latin text) and the on-the-wire UTF-8 size can be up to 1.5x for it. The 2 MB bound is
 * therefore "2 M units", a memory ceiling of about 2-4 MB per session, not exact bytes.
 */
const SIZE_WALK_NODES = 2000;
export function estimateSize(payload: unknown): number {
  let size = 0, nodes = 0;
  const stack: unknown[] = [payload];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') { size += v.length + 2; continue; }
    if (v === null || typeof v !== 'object') { size += 5; continue; }
    if (++nodes > SIZE_WALK_NODES) { size += Math.round(size / SIZE_WALK_NODES) * stack.length; break; }
    if (Array.isArray(v)) {
      // Push at most a budget's worth of elements (a 200k-element array must not cost 200k pushes); charge the rest flat.
      const take = Math.min(v.length, SIZE_WALK_NODES);
      size += 2 + v.length + (v.length - take) * 8;
      for (let i = 0; i < take; i++) stack.push(v[i]);
      continue;
    }
    let keys = 0;
    for (const k in v as object) { if (++keys > SIZE_WALK_NODES) { size += 16; break; } size += k.length + 4; stack.push((v as Record<string, unknown>)[k]); }
  }
  return size;
}

export interface RecordedEvent {
  seq: number;
  type: string;
  /** Main's clock when it was recorded (ms). */
  at: number;
  /** Size counted against the ring's byte bound (estimateSize: about the JSON length, in UTF-16 units). */
  bytes: number;
  payload: unknown;
}

export interface SessionFacts {
  /** A turn is in flight (what the renderer calls isThinking). */
  working: boolean;
  /** What the events themselves say: ok, stuck (stall warning), stalled, error. */
  attention: string;
  /** The last state a window relayed, or the computer's own "stuck" reading when it said one (R5-4b: the stuck check runs in main, which is the only writer of it). */
  reportedAttention: string | null;
  /** Asks waiting for an answer, including password asks (counted, never stored). */
  awaitingCount: number;
  hasHistory: boolean;
  /** Main's clock at the last event. Not part of the summary push: it changes constantly. */
  lastActivityAt: number;
  /** Native sessions: from the host. Others: from the last permission-mode push, else null. */
  permissionMode: string | null;
  /** The model of the last assistant message. */
  model: string | null;
  /** Native sessions: the bound model's residency, from the last model-state push. */
  modelState: { state: string; modelId: string | null } | null;
  /** Native sessions: ids of messages waiting behind the running turn (text is never copied here). */
  queued: string[];
}

export type { SessionSummary } from '../shared/session-summary-types';

/** Facts only the host (not an event) can answer. Supplied by create-runtime for native sessions. */
export type LiveFactsSource = (sessionId: string) => Partial<Pick<SessionFacts, 'queued' | 'permissionMode'>> | null;

export type ResumeDecision =
  | { resume: 'events'; epoch: string; headSeq: number; events: RecordedEvent[] }
  | { resume: 'page'; epoch: string; headSeq: number };

/** An open prompt card, as the `session:live` event that raised it (so a screen that opens later is handed the same event). */
type OpenPrompt = Extract<SessionLive, { kind: 'prompt-show' }>;

interface OpenAsk { event: unknown; /** Claude Code closed its hook but its own menu may still wait. */ expired: boolean }

/** One entry of the fill tail: a recent push, with a streaming part's deltas merged. */
interface TailEntry { type: string; payload: unknown; bytes: number; /** true once `payload` is this file's own clone (safe to grow). */ owned: boolean }

/** The terminal's output as a window onto a monotonic stream (moved here from RemoteServer.ptyBuffers, remote access batch 2 design §7):
 *  `epoch` names the stream (random per record, so a restart or a recreated session gets a new one); `base` is how many
 *  units were trimmed off the head, so a chunk's stream position is `base + length` when appended. */
interface PtyStream { chunks: string[]; length: number; base: number }

interface Rec {
  epoch: string;
  headSeq: number;
  ring: RecordedEvent[];
  ringBytes: number;
  tail: TailEntry[];
  tailBytes: number;
  pty: PtyStream;
  /** Events too large to hold at all (counted so a gap is explainable). */
  oversize: number;
  asks: Map<string, OpenAsk>;
  /** Password asks: only their ids are kept, never the command (hook buffer rule, remote-server.ts). */
  passwordAsks: Set<string>;
  /** Cards for a question Claude Code is asking in its terminal, still open (one-core R5-4a). Outside the ring, like asks. */
  prompts: Map<string, OpenPrompt>;
  /** When each open card was raised (main's clock), so activity that is older than a card cannot dismiss it. */
  promptAt: Map<string, number>;
  /** The mode the host last read off a Claude Code session's terminal (R5-4a); null until it has seen one. */
  terminalMode: string | null;
  /** A compaction is in progress: the spinner a screen that opens now must draw (R5-4a; restores what a phone lost in R5-2). */
  compacting: { id: string } | null;
  /** Tool calls of the running turn that have started and not finished (the reducer's `running` tools; one-core R5-4b: the stuck check is off while one runs). */
  runningTools: Set<string>;
  /** Claude Code has run a hook for this session: its startup dialogs are behind it (the screens' "initialized" gate). */
  started: boolean;
  /** The computer's own "may be stuck" reading for this turn (R5-4b), as last published; the summary and a late screen read it. */
  stuck: boolean;
  /** What holds the keyboard of this session's terminal, as the computer last read it off the screen (null = Claude Code's message box). `inputBlockSeen`
   *  is false until the first reading: a screen that opens later is told the current value either way once there has been one, so a stale "blocked"
   *  on a screen that missed the "free" event is cleared. */
  inputBlock: InputBlock | null;
  inputBlockSeen: boolean;
  facts: Omit<SessionFacts, 'awaitingCount' | 'queued'>;
  /** Highest host timestamp a progress/terminal event has fenced (mirrors the reducer's usageProgressAt). */
  progressAt: number;
  seen: Set<string>;
  /** The summary fields as of the last announcement (see `onSummaryChange`): a cheap string compare says "did a dot just change?". */
  summaryKey: string;
  /** `screenNeedKey` as of the last announcement. */
  needKey: string;
  /** Ids of the sends the computer received for this session, oldest first (R5-4b). */
  sends: Set<string>;
  /** True once an old id was let go: an id that is NOT in `sends` may then be one of those. */
  sendsLetGo: boolean;
}

const asObject = (v: unknown): Record<string, any> => (v && typeof v === 'object' ? (v as Record<string, any>) : {});

export class SessionRecords {
  private records = new Map<string, Rec>();
  private gone = new Set<string>();
  private liveSource: LiveFactsSource | null = null;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private summaryListener: ((sessionId: string) => void) | null = null;
  private needListener: ((sessionId: string) => void) | null = null;

  constructor(opts: { maxEvents?: number; maxBytes?: number; now?: () => number } = {}) {
    this.maxEvents = opts.maxEvents ?? RING_MAX_EVENTS;
    this.maxBytes = opts.maxBytes ?? RING_MAX_BYTES;
    this.now = opts.now ?? Date.now;
  }

  setLiveSource(source: LiveFactsSource | null): void { this.liveSource = source; }

  /**
   * Tell `listener` the moment a session's SUMMARY (what a dot is drawn from) changes: a turn starts or ends, an ask opens or closes, the
   * attention state flips, the first message arrives, a session begins or ends. WHY (one-core R5-3): the summary used to ride a 10 s
   * timer, which is far too slow for a dot a phone now draws from it alone; the attention sound would also play ten seconds late.
   * It fires on a CHANGE, not on every event (a streamed answer is thousands of events and no summary changes), so it is cheap.
   */
  onSummaryChange(listener: ((sessionId: string) => void) | null): void { this.summaryListener = listener; }

  /** The fields a summary push is built from, as one string: equal strings mean no dot can have changed. */
  private summaryKeyOf(sessionId: string, rec: Rec): string {
    const f = rec.facts;
    const reported = f.reportedAttention && f.reportedAttention !== 'ok' ? f.reportedAttention : null;
    // queue length and the HOST's permission mode are read through the live source (they are not events), so a change to them is only
    // seen when something asks; they are in the key so that when a push IS built they count, and R5-4 can read them from the summary.
    const live = this.safeLive(sessionId);
    return `${f.working ? 1 : 0}|${rec.asks.size + rec.passwordAsks.size}|${reported ?? this.attentionOf(rec)}|${f.hasHistory ? 1 : 0}|${rec.started ? 1 : 0}|${live?.permissionMode ?? f.permissionMode ?? ''}|${f.model ?? ''}|${live?.queued?.length ?? 0}`;
  }

  /** What the summary shows for attention: another writer's state wins; the computer's "stuck" shows when nothing else is wrong. */
  private attentionOf(rec: Rec): string { return rec.facts.attention !== 'ok' ? rec.facts.attention : rec.stuck ? 'stuck' : 'ok'; }

  private safeLive(sessionId: string): ReturnType<LiveFactsSource> {
    try { return this.liveSource?.(sessionId) ?? null; } catch { return null; }
  }

  /** After anything that may have moved a summary field: announce it if it did. */
  private announceIfChanged(sessionId: string, rec: Rec): void {
    const key = this.summaryKeyOf(sessionId, rec);
    if (key !== rec.summaryKey) {
      rec.summaryKey = key;
      try { this.summaryListener?.(sessionId); } catch (err) { console.warn('[session-record] summary listener failed:', String(err)); }
    }
    // The screen-reading module (main/session-screens.ts) wants to know when what it reads FOR changes: a turn began or ended, a tool started or
    // finished, an ask opened or closed, Claude Code started. Same cheap string compare, so a streamed answer (thousands of events, no change) costs nothing.
    if (this.needListener) {
      const need = this.screenNeedKey(rec);
      if (need !== rec.needKey) {
        rec.needKey = need;
        try { this.needListener(sessionId); } catch (err) { console.warn('[session-record] screen-need listener failed:', String(err)); }
      }
    }
  }

  private screenNeedKey(rec: Rec): string {
    return `${rec.facts.working ? 1 : 0}|${rec.runningTools.size > 0 ? 1 : 0}|${this.liveAskCount(rec)}|${rec.started ? 1 : 0}|${rec.prompts.size}|${rec.asks.size > 0 ? 1 : 0}`;
  }

  /** Asks that are really waiting on the person: a kept ask (Claude Code closed its hook) is not, the card the screen draws is a separate matter. */
  private liveAskCount(rec: Rec): number {
    let n = rec.passwordAsks.size;
    for (const a of rec.asks.values()) if (!a.expired) n++;
    return n;
  }

  /**
   * What the computer reads a session's screen FOR (one-core R5-4b), as plain facts:
   *  - `working`: a turn is in flight (the reducer's isThinking);
   *  - `toolRunning`: a tool call of this turn has started and not finished;
   *  - `asking`: an ask is waiting on the person (permission or password);
   *  - `started`: Claude Code has run a hook, so its startup dialogs are over;
   *  - `cards`: prompt cards open;
   *  - `permissionCard`: a permission/question/plan ask is open for this turn, LIVE OR KEPT (Claude Code closed its hook but its menu may still wait). A
   *    pop-up nobody named gets a generic card only when this is false: the menu on screen belongs to the permission card (master's popups rule).
   * The stuck check runs only while `working && !toolRunning && !asking` — the same gate the renderer's hook used.
   */
  screenNeed(sessionId: string): { working: boolean; toolRunning: boolean; asking: boolean; started: boolean; cards: number; permissionCard: boolean } | null {
    const rec = this.records.get(sessionId);
    if (!rec) return null;
    return { working: rec.facts.working, toolRunning: rec.runningTools.size > 0, asking: this.liveAskCount(rec) > 0, started: rec.started, cards: rec.prompts.size, permissionCard: rec.asks.size > 0 };
  }

  /** Called whenever what `screenNeed` reports changes for a session (and once when the session is dropped). One listener: main/session-screens.ts. */
  onScreenNeedChange(listener: ((sessionId: string) => void) | null): void { this.needListener = listener; }

  /** Create this session's record if it has none (idempotent). A destroyed session's id stays closed. */
  open(sessionId: string): boolean {
    if (typeof sessionId !== 'string' || !sessionId || this.gone.has(sessionId)) return false;
    if (this.records.has(sessionId)) return true;
    this.records.set(sessionId, {
      epoch: randomBytes(8).toString('hex'),
      headSeq: 0, ring: [], ringBytes: 0, tail: [], tailBytes: 0, pty: { chunks: [], length: 0, base: 0 }, oversize: 0,
      asks: new Map(), passwordAsks: new Set(), prompts: new Map(), promptAt: new Map(), terminalMode: null, compacting: null,
      runningTools: new Set(), started: false, stuck: false, inputBlock: null, inputBlockSeen: false,
      facts: {
        working: false, attention: 'ok', reportedAttention: null, hasHistory: false,
        lastActivityAt: this.now(), permissionMode: null, model: null, modelState: null,
      },
      progressAt: 0, seen: new Set(), summaryKey: '', needKey: '', sends: new Set(), sendsLetGo: false,
    });
    // A session appearing is a summary change (the strip learns it exists as "idle, no history").
    this.announceIfChanged(sessionId, this.records.get(sessionId)!);
    return true;
  }

  /** A session was created (or resumed): a brand-new record with a new epoch. Reopens an id that had ended. */
  begin(sessionId: string): void {
    this.gone.delete(sessionId);
    this.open(sessionId);
  }

  has(sessionId: string): boolean { return this.records.has(sessionId); }

  /** The session ended: its record is gone, and a late event cannot bring it back. */
  drop(sessionId: string): void {
    const existed = this.records.delete(sessionId);
    if (existed) {
      try { this.summaryListener?.(sessionId); } catch (err) { console.warn('[session-record] summary listener failed:', String(err)); }
      try { this.needListener?.(sessionId); } catch (err) { console.warn('[session-record] screen-need listener failed:', String(err)); }
    }
    this.gone.add(sessionId);
    if (this.gone.size > TOMBSTONES_MAX) {
      const oldest = this.gone.values().next().value;
      if (oldest !== undefined) this.gone.delete(oldest);
    }
  }

  /** Quit teardown. */
  clear(): void { this.records.clear(); this.gone.clear(); }

  /**
   * Record one session-scoped push: number it, put it in the ring and fold it into the live facts.
   * Returns its sequence number, or null when the session has ended (nothing is recorded).
   */
  note(sessionId: string, type: string, payload: unknown): number | null {
    if (!this.open(sessionId)) return null;
    const rec = this.records.get(sessionId)!;
    const seq = ++rec.headSeq;
    const at = this.now();
    rec.facts.lastActivityAt = at;
    this.fold(rec, type, payload);
    this.announceIfChanged(sessionId, rec);
    // A password ask is announced and re-announced by the broker; the ring never holds its command line.
    if (type === 'hook:event' && asObject(payload).type === 'PasswordRequest') return seq;
    const bytes = estimateSize(payload);
    if (bytes > this.maxBytes) { rec.oversize++; return seq; }
    this.noteTail(rec, type, payload, bytes);
    rec.ring.push({ seq, type, at, bytes, payload });
    rec.ringBytes += bytes;
    // Drop the oldest until both bounds hold. WHY shift in a loop and not slice: the ring is trimmed one
    // event at a time in steady state, so this is O(1) amortised (the old hook buffer's splice note).
    let drop = 0;
    while (drop < rec.ring.length && (rec.ring.length - drop > this.maxEvents || rec.ringBytes > this.maxBytes)) {
      rec.ringBytes -= rec.ring[drop].bytes;
      drop++;
    }
    if (drop > 0) rec.ring.splice(0, drop);
    return seq;
  }

  /**
   * Keep a transcript push in the fill tail, merging a streaming part's deltas into ONE entry.
   * WHY (R5-2): a native answer streams as thousands of tiny deltas, and only the part that has FINISHED is on disk
   * (session-store.ts flushes a part when the next one starts), so the text of the part still streaming exists only
   * in memory. A screen that opens mid-answer gets the page from disk plus this tail; the ring alone could not hold
   * a long answer (2,000 events), while the merged entry is one string. The merged entry keeps the FIRST delta's
   * uuid, which is also the uuid the disk's coalesced copy of that part carries, so the page's copy of a part the
   * tail already holds is skipped by the reducer's uuid check instead of drawn twice.
   */
  private noteTail(rec: Rec, type: string, payload: unknown, bytes: number): void {
    if (type !== 'transcript:event' && type !== 'transcript:shrink') return;
    const e = asObject(payload);
    const d = asObject(e.data);
    const last = rec.tail[rec.tail.length - 1];
    const mergeable = type === 'transcript:event' && typeof d.text === 'string' && d.partId && !d.parentAgentToolUseId
      && (e.type === 'assistant-text' || (e.type === 'assistant-thinking'));
    if (mergeable && last && last.type === type) {
      const l = asObject(last.payload);
      const ld = asObject(l.data);
      if (l.type === e.type && l.sessionId === e.sessionId && ld.partId === d.partId && typeof ld.text === 'string' && !ld.parentAgentToolUseId) {
        // Clone once (the object is the very one the windows and phones were handed), then grow the clone.
        if (!last.owned) { last.payload = { ...l, data: { ...ld } }; last.owned = true; }
        const grown = asObject(asObject(last.payload).data);
        grown.text = ld.text + d.text;
        last.bytes += d.text.length;
        rec.tailBytes += d.text.length;
        this.trimTail(rec);
        return;
      }
    }
    rec.tail.push({ type, payload, bytes, owned: false });
    rec.tailBytes += bytes;
    this.trimTail(rec);
  }

  /** Keep the tail inside its bounds by dropping from the FRONT up to the next user message, so it starts at a turn. */
  private trimTail(rec: Rec): void {
    while (rec.tail.length > 1 && (rec.tail.length > TAIL_MAX_ENTRIES || rec.tailBytes > TAIL_MAX_BYTES)) {
      let cut = 1;
      for (let i = 1; i < rec.tail.length; i++) {
        const t = rec.tail[i];
        if (t.type === 'transcript:event' && asObject(t.payload).type === 'user-message') { cut = i; break; }
      }
      for (let i = 0; i < cut; i++) rec.tailBytes -= rec.tail[i].bytes;
      rec.tail.splice(0, cut);
    }
  }

  /**
   * The conversation's transcript FILE changed under the session (a Claude Code /clear or an in-session /resume rotates onto a new file):
   * everything before is no longer part of what a screen shows, so the fill tail starts over. WHY (R5-2 review): a Claude Code /clear is
   * a screen-local action, not an event the record sees, so without this a screen that opened afterwards replayed the pre-clear
   * messages from the tail and then the new file's page. The ring is untouched (a screen that is already filled is cleared by its own
   * /clear, and a resume still replays only what it missed).
   */
  startNewTranscript(sessionId: string): void {
    const rec = this.records.get(sessionId);
    if (!rec) return;
    rec.tail = [];
    rec.tailBytes = 0;
  }

  /** The recent transcript, merged, in order: what a screen that opens now applies first, as live events (R5-2). */
  fillTail(sessionId: string): Array<{ type: string; payload: unknown }> {
    return (this.records.get(sessionId)?.tail ?? []).map((t) => ({ type: t.type, payload: t.payload }));
  }

  /**
   * Append terminal output to the session's stream and answer where it sits: the stream's `epoch` and the chunk's
   * `offset` (the position of its first unit), which ride the live push so a phone can say how far it has drawn.
   * Perf: a list of chunks, not one big string, so an append costs O(chunk) instead of O(whole buffer) (the old
   * RemoteServer.ptyBuffers note: re-copying ~4 MB on every chunk once a busy session filled the cap).
   */
  notePty(sessionId: string, data: string): { epoch: string; offset: number } | null {
    if (!this.open(sessionId)) return null;
    const rec = this.records.get(sessionId)!;
    const pty = rec.pty;
    const offset = pty.base + pty.length;
    // An empty chunk adds nothing to a replay but WOULD add an array entry; the live push still goes out unchanged.
    if (data.length > 0) {
      const last = pty.chunks.length - 1;
      if (last >= 0 && pty.chunks[last].length < PTY_CHUNK_COALESCE_BELOW) pty.chunks[last] += data;
      else pty.chunks.push(data);
      pty.length += data.length;
      // Trim WHOLE chunks off the head back under the cap; the cut lands on a chunk boundary, so the window can hold
      // slightly less than the cap, and a replay is less likely to start mid-escape-sequence.
      while (pty.length > PTY_STREAM_UNITS && pty.chunks.length > 1) {
        const dropped = pty.chunks.shift()!.length;
        pty.length -= dropped;
        pty.base += dropped;
      }
      // One chunk bigger than the whole cap cannot be dropped without losing everything: trim its tail instead.
      if (pty.length > PTY_STREAM_UNITS) {
        const only = pty.chunks[0];
        pty.base += only.length - PTY_STREAM_UNITS;
        pty.chunks[0] = only.slice(only.length - PTY_STREAM_UNITS);
        pty.length = pty.chunks[0].length;
      }
    }
    return { epoch: rec.epoch, offset };
  }

  /**
   * The terminal bytes a phone is missing. `have` is what it says it has drawn ({epoch, units}). A matching epoch and a
   * position still inside the window gets exactly the units past it; anything else (a new stream, a position trimmed away)
   * gets the whole window and `reset: true` when it had drawn something it cannot continue, so it clears its screen first.
   */
  ptyFrom(sessionId: string, have?: { epoch?: string; units?: number } | null): { epoch: string; offset: number; data: string; reset: boolean } | null {
    const rec = this.records.get(sessionId);
    if (!rec) return null;
    const { pty } = rec;
    const total = pty.base + pty.length;
    let from = pty.base;
    let reset = false;
    if (have && have.epoch === rec.epoch && typeof have.units === 'number' && have.units >= pty.base && have.units <= total) from = have.units;
    else reset = !!have && typeof have.epoch === 'string';
    let skip = from - pty.base;
    const parts: string[] = [];
    for (const chunk of pty.chunks) {
      if (skip >= chunk.length) { skip -= chunk.length; continue; }
      parts.push(skip > 0 ? chunk.slice(skip) : chunk);
      skip = 0;
    }
    return { epoch: rec.epoch, offset: from, data: parts.join(''), reset };
  }

  /**
   * The computer received a message for this session that carried this id (R5-4b): a native session's host accepted it, or a Claude Code session's
   * terminal write was accepted. Answers a phone that lost the connection mid-send and asks "did you get it?" (sendOutcomes).
   */
  noteSend(sessionId: string, sendId: unknown): void {
    if (!isSendId(sendId)) return;
    const rec = this.records.get(sessionId);
    if (!rec) return;
    rec.sends.add(sendId);
    if (rec.sends.size > SENDS_MAX) {
      const oldest = rec.sends.values().next().value;
      if (oldest !== undefined) rec.sends.delete(oldest);
      rec.sendsLetGo = true;
    }
  }

  /**
   * What the record can say about sends a phone has no echo for. `epoch` is the one the phone last filled this session at: the record is in memory,
   * so a different epoch means the computer restarted (or the session was recreated) and everything before is unknown, not "not received".
   */
  sendOutcomes(sessionId: string, ids: readonly unknown[], epoch?: unknown): { epoch: string | null; outcomes: Record<string, SendOutcome> } {
    const rec = this.records.get(sessionId);
    const outcomes: Record<string, SendOutcome> = {};
    const known = !!rec && typeof epoch === 'string' && epoch === rec.epoch;
    for (const id of ids) {
      if (!isSendId(id)) continue;
      outcomes[id] = !rec || !known ? 'unknown' : rec.sends.has(id) ? 'received' : rec.sendsLetGo ? 'unknown' : 'not-received';
    }
    return { epoch: rec?.epoch ?? null, outcomes };
  }

  /** A window relayed this session's attention state (remote:attention-changed). */
  noteReportedAttention(sessionId: string, state: string): void {
    if (!this.open(sessionId)) return;
    const rec = this.records.get(sessionId)!;
    rec.facts.reportedAttention = state;
    this.announceIfChanged(sessionId, rec);
  }

  /**
   * The conversation already has messages on disk (a resume, or a screen that opened it and read a non-empty page). WHY (one-core R5-3
   * review): `hasHistory` otherwise counts only events seen live, so a conversation resumed from disk read "no history" on a phone (gray)
   * while the computer's own chat, which loaded the page, showed it unseen (blue).
   */
  noteHistory(sessionId: string): void {
    const rec = this.records.get(sessionId);
    if (!rec || rec.facts.hasHistory) return;
    rec.facts.hasHistory = true;
    this.announceIfChanged(sessionId, rec);
  }

  epochOf(sessionId: string): string | null { return this.records.get(sessionId)?.epoch ?? null; }
  headSeq(sessionId: string): number { return this.records.get(sessionId)?.headSeq ?? 0; }
  /** Sequence number of the oldest event still held, or null when the ring is empty. */
  oldestSeq(sessionId: string): number | null { return this.records.get(sessionId)?.ring[0]?.seq ?? null; }
  events(sessionId: string): readonly RecordedEvent[] { return this.records.get(sessionId)?.ring ?? []; }

  /**
   * Can a client that last saw `{epoch, seq}` simply be sent what it missed? (R5-2 uses this; the rule is
   * here so it is tested beside the ring.) Same epoch and the next event still held: send the events after
   * seq. A different epoch, a seq older than the ring reaches, or a seq from the future: a fresh page.
   */
  resume(sessionId: string, have: { epoch?: string; seq?: number } | null | undefined): ResumeDecision | null {
    const rec = this.records.get(sessionId);
    if (!rec) return null;
    const base = { epoch: rec.epoch, headSeq: rec.headSeq };
    if (!have || have.epoch !== rec.epoch || typeof have.seq !== 'number' || !Number.isFinite(have.seq)) return { resume: 'page', ...base };
    if (have.seq > rec.headSeq) return { resume: 'page', ...base };
    if (have.seq === rec.headSeq) return { resume: 'events', ...base, events: [] };
    const oldest = rec.ring[0]?.seq;
    // Everything after have.seq must still be held: have.seq + 1 >= oldest. (An oversize event leaves a gap.)
    if (oldest === undefined || have.seq + 1 < oldest) return { resume: 'page', ...base };
    const events = rec.ring.filter((e) => e.seq > have.seq!);
    // WHY the count, not only the first number (R5-2, found by the reconnect gate test): an event too large to hold is numbered but not kept, so
    // a hole can sit in the MIDDLE of what is held. Everything after have.seq must be there, which is exactly headSeq - have.seq events.
    if (events[0]?.seq !== have.seq + 1 || events.length !== rec.headSeq - have.seq) return { resume: 'page', ...base };
    return { resume: 'events', ...base, events };
  }

  /** Every ask still waiting, as the full events (cards can be drawn from them). */
  openAsks(sessionId: string): unknown[] {
    const rec = this.records.get(sessionId);
    return rec ? [...rec.asks.values()].map((a) => a.event) : [];
  }

  /**
   * The asks as events a screen can replay: each ask's request, and for one Claude Code closed its hook on (its own menu
   * may still wait) the same 'hook-closed' expiry the screen heard live, so the card comes back "kept" rather than live.
   */
  asksForFill(sessionId: string): unknown[] {
    const rec = this.records.get(sessionId);
    if (!rec) return [];
    const out: unknown[] = [];
    for (const [id, ask] of rec.asks) {
      out.push(ask.event);
      if (ask.expired) out.push({ type: 'PermissionExpired', sessionId, payload: { _requestId: id, _reason: 'hook-closed' }, timestamp: this.now() });
    }
    return out;
  }

  /** A compaction is waiting for its summary line (the host watches that it does not wait forever). */
  isCompacting(sessionId: string): boolean { return !!this.records.get(sessionId)?.compacting; }

  /** The cards open now, with when each was raised: what the host checks against the terminal and against later activity. */
  openPrompts(sessionId: string): Array<{ promptId: string; title: string; at: number }> {
    const rec = this.records.get(sessionId);
    return rec ? [...rec.prompts.values()].map((p) => ({ promptId: p.promptId, title: p.title, at: rec.promptAt.get(p.promptId) ?? 0 })) : [];
  }

  /** Is this card already open? (The host publishes a card once however many screens report it.) */
  hasPrompt(sessionId: string, promptId: string): boolean { return !!this.records.get(sessionId)?.prompts.has(promptId); }

  /**
   * The live facts a screen that opens NOW must be handed, as the events it would have received (R5-4a): the compaction spinner, the open
   * prompt cards and the model label. The queue and a native session's mode are read from the host (session-open.ts). A screen that only
   * missed some events is sent the ring instead, which carries the same facts as events.
   * WHY here and not in the ring: a fill's `before` is the transcript's recent past; none of these are transcript lines, and the ring
   * is trimmed, so a spinner raised an hour ago would be gone from it while still true.
   */
  liveFill(sessionId: string): Array<{ type: string; payload: unknown }> {
    const rec = this.records.get(sessionId);
    if (!rec) return [];
    const out: Array<{ type: string; payload: unknown }> = [];
    if (rec.facts.model) out.push({ type: 'session:live', payload: { sessionId, kind: 'model', model: rec.facts.model } });
    if (rec.terminalMode) out.push({ type: 'session:permission-mode', payload: { sessionId, mode: rec.terminalMode } });
    for (const p of rec.prompts.values()) out.push({ type: 'session:live', payload: p });
    if (rec.compacting) out.push({ type: 'session:live', payload: { sessionId, kind: 'compact-start', id: rec.compacting.id } });
    // A screen that opens while the computer thinks the turn may be stuck is told so (a phone opened after the banner would have shown none).
    if (rec.stuck) out.push({ type: 'session:live', payload: { sessionId, kind: 'attention', state: 'stuck' } });
    // What holds the keyboard now (a phone opened while a "Switch model?" confirmation is up must refuse a send; one opened after it closed must not).
    if (rec.inputBlockSeen) out.push({ type: 'session:live', payload: { sessionId, kind: 'input-block', block: rec.inputBlock } });
    return out;
  }

  facts(sessionId: string): SessionFacts | null {
    const rec = this.records.get(sessionId);
    if (!rec) return null;
    let host: ReturnType<LiveFactsSource> = null;
    try { host = this.liveSource?.(sessionId) ?? null; } catch { host = null; }
    return {
      ...rec.facts,
      permissionMode: host?.permissionMode ?? rec.facts.permissionMode,
      awaitingCount: rec.asks.size + rec.passwordAsks.size,
      queued: host?.queued ?? [],
    };
  }

  summary(sessionId: string): SessionSummary | null {
    const f = this.facts(sessionId);
    if (!f) return null;
    const reported = f.reportedAttention && f.reportedAttention !== 'ok' ? f.reportedAttention : null;
    const rec = this.records.get(sessionId)!;
    return {
      working: f.working, awaitingCount: f.awaitingCount, attention: reported ?? this.attentionOf(rec),
      hasHistory: f.hasHistory, queuedCount: f.queued.length, started: rec.started, permissionMode: f.permissionMode, model: f.model,
    };
  }

  summaries(): Record<string, SessionSummary> {
    const out: Record<string, SessionSummary> = {};
    for (const id of this.records.keys()) {
      const s = this.summary(id);
      if (s) out[id] = s;
    }
    return out;
  }

  /** What the record holds right now (the memory measurement and the inspection tests read this). */
  stats(): { sessions: number; events: number; ringBytes: number; openAsks: number; tailEntries: number; tailBytes: number; ptyUnits: number } {
    let events = 0, ringBytes = 0, openAsks = 0, tailEntries = 0, tailBytes = 0, ptyUnits = 0;
    for (const r of this.records.values()) {
      events += r.ring.length; ringBytes += r.ringBytes; openAsks += r.asks.size;
      tailEntries += r.tail.length; tailBytes += r.tailBytes; ptyUnits += r.pty.length;
    }
    return { sessions: this.records.size, events, ringBytes, openAsks, tailEntries, tailBytes, ptyUnits };
  }

  // --- folding events into live facts ---------------------------------------------------------
  // WHY a fold here at all: R5-3 will draw the session strip's dots from a summary instead of from every
  // session's own events, so the record must reach the same answer the renderer's chat reducer reaches.
  // tests/session-record-shadow.test.ts runs both over scripted sessions and compares. Each rule below names
  // the reducer case it mirrors. What is deliberately NOT mirrored is listed in that test's header.

  private endTurn(rec: Rec, terminalTimestamp?: number): void {
    // chat-reducer endTurn(): turn over, attention back to ok, orphaned asks failed.
    rec.facts.working = false;
    rec.facts.attention = 'ok';
    rec.runningTools.clear();
    // "May be stuck" cannot outlive its turn, whoever said it (the computer's reading, or a window's relay of it).
    rec.stuck = false;
    if (rec.facts.reportedAttention === 'stuck') rec.facts.reportedAttention = null;
    rec.asks.clear();
    rec.passwordAsks.clear();
    if (typeof terminalTimestamp === 'number') rec.progressAt = Math.max(rec.progressAt, terminalTimestamp);
  }

  private firstTime(rec: Rec, uuid: unknown): boolean {
    // chat-reducer seenUuids: a replayed event is applied once.
    if (typeof uuid !== 'string' || !uuid) return true;
    if (rec.seen.has(uuid)) return false;
    rec.seen.add(uuid);
    if (rec.seen.size > SEEN_UUIDS_MAX) {
      const oldest = rec.seen.values().next().value;
      if (oldest !== undefined) rec.seen.delete(oldest);
    }
    return true;
  }

  private fold(rec: Rec, type: string, payload: unknown): void {
    const f = rec.facts;
    if (type === 'native:permission-mode') {
      const mode = asObject(payload).mode;
      if (typeof mode === 'string') f.permissionMode = mode;
      return;
    }
    if (type === 'native:model-state') {
      const p = asObject(payload);
      f.modelState = { state: String(p.state ?? ''), modelId: typeof p.modelId === 'string' ? p.modelId : null };
      return;
    }
    if (type === 'hook:event') { rec.started = true; this.foldHook(rec, asObject(payload)); return; }
    // A Claude Code session's mode, read from its terminal by the host (R5-4a): the same fact a native host pushes as native:permission-mode.
    if (type === 'session:permission-mode') {
      const mode = asObject(payload).mode;
      if (typeof mode === 'string') { f.permissionMode = mode; rec.terminalMode = mode; }
      return;
    }
    if (type === 'session:live') { this.foldLive(rec, asObject(payload) as Record<string, any>); return; }
    // The transcript file shrank: a compaction (or a clear) is over, so a spinner that is still up has nothing left to wait for.
    if (type === 'transcript:shrink') { rec.compacting = null; return; }
    if (type !== 'transcript:event') return;

    const ev = asObject(payload);
    const d = asObject(ev.data);
    const stamped = !!d.parentAgentToolUseId;
    switch (ev.type) {
      case 'user-message':
        if (!d.text || stamped || !this.firstTime(rec, ev.uuid)) return;
        f.hasHistory = true;
        if (d.slashCommand) return; // a slash command starts no turn (reducer)
        f.working = true;
        f.attention = 'ok';
        return;
      case 'skill-invoked':
        if (!this.firstTime(rec, ev.uuid)) return;
        f.hasHistory = true; f.working = true; f.attention = 'ok';
        return;
      case 'assistant-text':
        if (stamped) return;
        if (!this.firstTime(rec, ev.uuid)) return;
        f.hasHistory = true;
        f.attention = 'ok';
        if (typeof d.model === 'string' && d.model && d.model !== '<synthetic>') f.model = d.model;
        return;
      case 'assistant-thinking': {
        if (d.text) { f.hasHistory = true; f.attention = 'ok'; return; }
        if (d.toolPreparing) f.attention = 'ok';
        // A textless event is a lifecycle heartbeat (the reducer's TRANSCRIPT_THINKING_HEARTBEAT).
        if (d.usageProgress) {
          // A progress reading older than what a heartbeat or turn end already fenced changes nothing.
          if (typeof ev.timestamp !== 'number' || ev.timestamp <= rec.progressAt) return;
        }
        if (typeof ev.timestamp === 'number' && ev.timestamp > rec.progressAt) rec.progressAt = ev.timestamp;
        f.attention = d.stalled ? 'stalled' : d.stallWarning ? 'stuck' : 'ok';
        return;
      }
      case 'tool-use':
      case 'tool-result':
        if (stamped) return;
        f.hasHistory = true;
        f.attention = 'ok';
        // A started tool is "running" until its result lands (the reducer's tool status), which switches the stuck check off (R5-4b).
        if (typeof d.toolUseId === 'string' && d.toolUseId) {
          if (ev.type === 'tool-use') { if (rec.runningTools.size < OPEN_ASKS_MAX) rec.runningTools.add(d.toolUseId); }
          else rec.runningTools.delete(d.toolUseId);
        }
        return;
      case 'turn-complete':
        if (stamped) return;
        this.endTurn(rec, ev.timestamp);
        return;
      case 'user-interrupt':
      case 'context-clear':
        this.endTurn(rec, ev.type === 'user-interrupt' ? ev.timestamp : undefined);
        return;
      case 'session-error':
        this.endTurn(rec, ev.timestamp);
        f.attention = 'error';
        return;
      case 'replay-complete':
        if (d.sessionIdle === true) this.endTurn(rec);
        return;
      // The compaction's own line ends the spinner (the "Compacted" note is drawn from it).
      case 'compact-summary':
        rec.compacting = null;
        return;
      default:
        return;
    }
  }

  /** The shared lines and live facts (R5-4a). Only what a screen that opens LATER still needs is kept; a divider is just a numbered event. */
  private foldLive(rec: Rec, live: Record<string, any>): void {
    switch (live.kind) {
      case 'model':
        if (typeof live.model === 'string' && live.model) rec.facts.model = live.model;
        return;
      case 'compact-start':
        if (typeof live.id === 'string') rec.compacting = { id: live.id };
        return;
      case 'compact-end':
        rec.compacting = null;
        return;
      case 'prompt-show':
        if (typeof live.promptId !== 'string' || !live.promptId) return;
        if (rec.prompts.size >= OPEN_PROMPTS_MAX && !rec.prompts.has(live.promptId)) return;
        rec.prompts.set(live.promptId, live as OpenPrompt);
        rec.promptAt.set(live.promptId, this.now());
        return;
      case 'prompt-dismiss':
        if (typeof live.promptId === 'string') { rec.prompts.delete(live.promptId); rec.promptAt.delete(live.promptId); }
        return;
      case 'attention':
        // The computer's own reading wins over a window's last relayed value for this one state (a closed window can no longer clear it).
        rec.stuck = live.state === 'stuck';
        rec.facts.reportedAttention = live.state === 'stuck' ? 'stuck' : null;
        return;
      case 'input-block':
        rec.inputBlock = live.block && typeof live.block === 'object' ? (live.block as InputBlock) : null;
        rec.inputBlockSeen = true;
        return;
      default:
        return;
    }
  }

  private foldHook(rec: Rec, ev: Record<string, any>): void {
    const id = asObject(ev.payload)._requestId;
    if (typeof id !== 'string' || !id) return;
    switch (ev.type) {
      case 'PermissionRequest':
        if (rec.asks.size >= OPEN_ASKS_MAX && !rec.asks.has(id)) return;
        rec.asks.set(id, { event: ev, expired: false });
        rec.facts.attention = 'ok'; // the reducer's PERMISSION_REQUEST writes ok
        return;
      case 'PasswordRequest':
        if (rec.passwordAsks.size < OPEN_ASKS_MAX) rec.passwordAsks.add(id);
        return;
      case 'PermissionResolved': rec.asks.delete(id); return;
      case 'PasswordResolved': rec.passwordAsks.delete(id); return;
      case 'PermissionExpired': {
        // A Claude Code ask whose hook closed is KEPT by the renderer (its own menu may still wait), so the dot
        // stays "needs you"; every other expiry resolves it (chat-reducer PERMISSION_EXPIRED).
        const reason = asObject(ev.payload)._reason;
        const ask = rec.asks.get(id);
        if (ask && reason === 'hook-closed') ask.expired = true;
        else rec.asks.delete(id);
        return;
      }
      default: return;
    }
  }
}
