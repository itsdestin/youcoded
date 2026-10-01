// Drives the NEW fill path (one-core R5-2) over a scripted session, with the real record, the real session-open and the real reducer.
//
// What is real: SessionRecords (fed exactly as publish feeds it), openSession, applyOpenReply, the chat reducer and the live translators.
// What is stood in for: the disk page (read from the scenario's real file / real SessionStore, through the same reader the host uses),
// the native host's facts, and the listeners a played push reaches (mapped to the reducer the way App's handlers map them).
import { chatReducer } from '../../src/renderer/state/chat-reducer';
import type { ChatAction, ChatState } from '../../src/renderer/state/chat-types';
import { eventToAction } from '../../src/renderer/state/transcript-event-actions';
import { hookEventToAction } from '../../src/renderer/state/hook-dispatcher';
import { applyOpenReply, type OpenOk } from '../../src/renderer/state/session-fill';
import { SessionRecords } from '../../src/main/session-record';
import { openSession, type NativeLive, type OpenDeps, type OpenReply, type Push } from '../../src/main/session-open';
import { readTranscriptPage } from '../../src/main/transcript-page';
import type { HookEvent, TranscriptEvent, TranscriptPageResult } from '../../src/shared/types';
import { SID, newState, openAsksOf, type Run, type Scenario } from './fill-scenarios';

/** Feed the record the way publish does: every transcript and hook push, in order. */
export function feedRecord(records: SessionRecords, run: Run, upTo = run.pushes.length): void {
  records.begin(SID);
  for (const p of run.pushes.slice(0, upTo)) {
    if (p.type === 'transcript:event') records.note(SID, 'transcript:event', p.payload);
    else if (p.type === 'hook:event') records.note(SID, 'hook:event', p.payload);
  }
}

/** The page the host's one transcript-page body would answer: to the end of the file, with the resume reconcile for Claude Code. */
export async function pageFor(sc: Scenario, run: Run, idle: boolean): Promise<TranscriptPageResult> {
  if (sc.kind === 'native') return { events: run.nativeDisk!, cursor: null, hasMore: false, reconcileInterrupted: idle };
  const page = await readTranscriptPage({ jsonlPath: run.diskPath!, sessionId: SID, endOffset: null });
  if (run.resumeOffset == null) return page;
  const old = await readTranscriptPage({ jsonlPath: run.diskPath!, sessionId: SID, endOffset: run.resumeOffset });
  return { ...page, reconcileInterrupted: false, reconcileInterruptedToolIds: [...new Set(old.events.filter((e) => e.type === 'tool-use').map((e) => e.data.toolUseId as string))] };
}

export function nativeLive(run: Run, records: SessionRecords): NativeLive {
  return {
    askEvents: () => openAsksOf(run),
    specialistRuns: () => [], shellRuns: () => [], usageProgress: () => null, sessionContext: () => null,
    idle: () => !records.facts(SID)!.working,
  };
}

export function depsFor(sc: Scenario, run: Run, records: SessionRecords): OpenDeps {
  return {
    records,
    knows: () => true,
    page: () => pageFor(sc, run, !records.facts(SID)!.working),
    native: () => (sc.kind === 'native' ? nativeLive(run, records) : null),
  };
}

/** A played push reaches the reducer the way the live handler for it does (App.tsx). */
export function playInto(state: { value: ChatState }, pushes: Push[]): void {
  for (const p of pushes) {
    if (p.type === 'transcript:event') for (const a of eventToAction(p.payload as TranscriptEvent, { live: true })) state.value = chatReducer(state.value, a);
    else if (p.type === 'hook:event') { const a = hookEventToAction(p.payload as HookEvent); if (a) state.value = chatReducer(state.value, a); }
    else if (p.type === 'hook:replay-complete') {
      const pl = p.payload as { sessionId: string; pendingRequestIds: string[] };
      state.value = chatReducer(state.value, { type: 'PERMISSION_REPLAY_COMPLETE', sessionId: pl.sessionId, pendingRequestIds: pl.pendingRequestIds });
    }
  }
}

/** Fill a blank screen (a phone's first connect, a torn-off window) from the record. Returns what it shows and the answer it was given. */
export async function fillNew(sc: Scenario, run: Run, opts: { upTo?: number } = {}): Promise<{ state: ChatState; reply: OpenReply }> {
  const records = new SessionRecords();
  feedRecord(records, run, opts.upTo);
  const reply = await openSession(depsFor(sc, run, records), { sessionId: SID, fresh: true });
  const state = { value: newState() };
  if (reply.ok) {
    applyOpenReply(
      { dispatch: (a: ChatAction) => { state.value = chatReducer(state.value, a); }, flush: () => {}, play: (pushes) => playInto(state, pushes) },
      SID, reply as OpenOk, { acceptPage: true },
    );
  }
  return { state: state.value, reply };
}

/** The note that an ask was answered while the screen watched is a property of WHEN the screen connected, not of what the session is. */
export function norm<T extends { timeline: string[]; awaiting: string[] } | null>(screen: T): T {
  if (!screen) return screen;
  return { ...screen, timeline: screen.timeline.map((l) => l.replace(/\*elsewhere/g, '')) } as T;
}
