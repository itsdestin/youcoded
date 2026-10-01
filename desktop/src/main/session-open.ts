// session-open.ts — the ONE way a screen is filled (one-core R5-2, seam S5).
//
// WHY (2026-10-01 one-core R5-2): a phone, a torn-off window and a reconnecting phone each caught up through different
// machinery — a snapshot of one window's chat state (chat-snapshot.ts), a page plus a live-state replay
// (claimPending / replayLiveState / transcript:replay-from-start), and a 10,000-event hook replay — and the three could
// disagree about the same session. This replaces all of them. A screen asks `session:open` for one session and is
// answered from the computer's record of it (session-record.ts):
//
//   Ask:    { sessionId, have?: { epoch, seq }, pty?: { epoch, units }, locator hints }
//   Answer: { epoch, headSeq, resume, before, page, after, facts, pty? }
//
//   resume 'events'  the screen already holds this session up to `have` (same epoch, and the next event is still in the
//                    ring): `after` is exactly the events it missed, in order, and nothing else is sent.
//   resume 'page'    a first open, a changed epoch (the session was recreated or the computer restarted) or a gap the ring
//                    no longer covers: `before` is the record's recent past (a streaming answer's deltas merged), `page`
//                    is the newest page of history read from disk to the end of the file, and `after` is what only memory
//                    holds (asks still waiting, a helper's run, the turn's progress, the idle marker).
//
// The screen applies `before`, then the page, then `after` through the SAME handlers a live push uses, so there is no
// second set of rules for "how to draw a filled session". The page prepends below anything already applied and skips
// what it already holds (the reducer's uuid check), which is why `before` may overlap the page.
//
// ORDER (no gap, no double): `headSeq` is read BEFORE the page is, so anything that happens during the read has a number
// above it. The door holds the pushes it would deliver to this screen for this session from the moment the ask arrives
// until the answer has been sent (audience-fill.ts), then delivers them: the screen sees the answer first, then every
// event above `headSeq`, in order.
//
// Electron-free: the page read, the session check and the native host's facts are injected, so a test drives it with a
// record and no window or socket.
import type { SessionRecords } from './session-record';
import type { HookEvent, SpecialistRunView, ShellRunView, TranscriptEvent, TranscriptPageResult } from '../shared/types';
import type { Push, OpenRequest, OpenReply } from '../shared/session-open-types';

export type { Push, OpenRequest, OpenReply } from '../shared/session-open-types';

/** What only a native session's host knows (null for any other session). */
export interface NativeLive {
  askEvents(): HookEvent[];
  specialistRuns(): SpecialistRunView[];
  shellRuns(): ShellRunView[];
  usageProgress(): TranscriptEvent | null;
  sessionContext(): unknown | null;
  /** True only when the host can affirm nothing is in flight (never guessed). */
  idle(): boolean;
}

export interface OpenDeps {
  records: SessionRecords;
  /** Is this a session the computer runs? An id it does not know gets "gone", never a made-up empty record. */
  knows(sessionId: string): boolean;
  /** The newest page of history, read to the END of the file (a screen that opens missed the live stream). */
  page(req: { sessionId: string; claudeSessionId?: string; projectSlug?: string }): Promise<TranscriptPageResult>;
  native(sessionId: string): NativeLive | null;
}

const idOf = (e: unknown): string | undefined => {
  const p = (e as { payload?: { _requestId?: unknown } } | null)?.payload;
  return typeof p?._requestId === 'string' ? p._requestId : undefined;
};

/** Drop an ask the same replay also closes: it was raised and answered while the screen was away, so drawing its card
 *  only to clear it would flash a question nobody can answer. The closure itself stays (a no-op on a card that is not there). */
function withoutAsksClosedLater(events: Push[]): Push[] {
  const closedAt = new Map<string, number>();
  events.forEach((p, i) => {
    if (p.type !== 'hook:event') return;
    const e = p.payload as { type?: string; payload?: { _reason?: string } };
    // A Claude Code ask whose hook closed is KEPT on screen (its own menu may still wait): not a closure.
    const closes = e?.type === 'PermissionResolved' || (e?.type === 'PermissionExpired' && e.payload?._reason !== 'hook-closed');
    const id = idOf(p.payload);
    if (closes && id) closedAt.set(id, i);
  });
  return events.filter((p, i) => {
    if (p.type !== 'hook:event' || (p.payload as { type?: string })?.type !== 'PermissionRequest') return true;
    const id = idOf(p.payload);
    return !(id && (closedAt.get(id) ?? -1) > i);
  });
}

export async function openSession(deps: OpenDeps, req: OpenRequest, opts: { remote?: boolean } = {}): Promise<OpenReply> {
  const sessionId = req?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'No conversation was named.' };
  if (!deps.knows(sessionId) || !deps.records.open(sessionId)) return { ok: false, error: 'That conversation is not open on this computer.', gone: true };
  const { records } = deps;
  const native = deps.native(sessionId);

  // 1. SAMPLE: the rule and the head are read in one synchronous step, before anything is awaited.
  const decision = records.resume(sessionId, req.fresh ? null : req.have)!;
  const facts = records.facts(sessionId)!;
  const base = { epoch: decision.epoch, headSeq: decision.headSeq, facts: { working: facts.working, attention: facts.attention } };
  // The terminal rides the same answer (a phone only). WHY its cut is NOT taken here (review fix): the phone drops live terminal frames until
  // this answer arrives, so a frame published while the page is being read would be in neither the answer nor the live stream. The cut is
  // taken right before the answer is built, after the page read, with nothing awaited between the cut and the return.
  const cutPty = () => (req.pty ? records.ptyFrom(sessionId, req.pty) ?? undefined : undefined);

  // Asks still waiting: the host's own answer for a native session (its broker), the record's for anything else.
  // A password ask is never replayed to a phone (the hook buffer's old rule: a rolling log must not hold a password ask's
  // command line); its 3-second heartbeat already reaches a phone that watches the session.
  const askEvents = (): Push[] => {
    const evs = native ? native.askEvents() : (records.asksForFill(sessionId) as HookEvent[]);
    return evs.filter((e) => !(opts.remote && e.type === 'PasswordRequest')).map((e) => ({ type: 'hook:event', payload: e }));
  };
  const pendingIds = (): string[] => askEvents().map((p) => idOf(p.payload)).filter((x): x is string => !!x);

  if (decision.resume === 'events') {
    const missed: Push[] = decision.events.map((e) => ({ type: e.type, payload: e.payload }));
    const after = withoutAsksClosedLater(missed);
    // The consent rule: every card still awaiting that is not named here was answered while the screen was away.
    after.push({ type: 'hook:replay-complete', payload: { sessionId, pendingRequestIds: pendingIds() } });
    const pty = cutPty();
    return { ok: true, ...base, resume: 'events', before: [], page: null, after, ...(pty ? { pty } : {}) };
  }

  // 2. A fresh page: the recent past first (captured now, so it is exactly what `headSeq` counts), then the disk.
  const before = records.fillTail(sessionId);
  const asks = askEvents();
  const page = await deps.page({ sessionId, claudeSessionId: req.claudeSessionId, projectSlug: req.projectSlug });

  // A non-empty page means the conversation has messages: the summary must say so, or a phone reads a resumed conversation as empty (gray, not blue).
  if (page?.events?.length) records.noteHistory(sessionId);
  const after: Push[] = [...asks];
  if (native) {
    for (const run of native.specialistRuns()) after.push({ type: 'specialists:event', payload: { kind: 'run', sessionId, run } });
    for (const run of native.shellRuns()) after.push({ type: 'native:shell-event', payload: { sessionId, run } });
    // Progress never entered the transcript, so only the host can restore it (sent after history, before the marker).
    const progress = native.usageProgress();
    if (progress) after.push({ type: 'transcript:event', payload: progress });
    const context = native.sessionContext();
    if (context) after.push({ type: 'native:session-context', payload: { sessionId, context } });
  }
  // The idle marker reaps tool cards the history left 'running'. Only a native host can affirm idleness; a Claude Code
  // session reports false and keeps today's behaviour rather than risk failing a tool that really is running.
  after.push({
    type: 'transcript:event',
    payload: { type: 'replay-complete', sessionId, uuid: `replay-complete-${sessionId}`, timestamp: Date.now(), data: { sessionIdle: !!native && native.idle() } },
  });
  after.push({ type: 'hook:replay-complete', payload: { sessionId, pendingRequestIds: asks.map((p) => idOf(p.payload)).filter((x): x is string => !!x) } });
  const pty = cutPty();   // after the page read: see cutPty
  return { ok: true, ...base, resume: 'page', before, page, after, ...(pty ? { pty } : {}) };
}
