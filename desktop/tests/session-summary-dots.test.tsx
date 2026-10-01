// @vitest-environment jsdom
// The dot a phone draws for a conversation it does NOT watch (from the computer's summary) equals the dot the computer draws for it
// (from the conversation's own events), after every step of a scripted session (one-core R5-3).
//
// WHY this is the gate: a phone that watches three conversations draws the other dots from `session:summary` alone. That is only safe
// if the summary reaches the SAME colour the computer's chat state reaches, in every state the strip can show: red (a question waiting,
// a parked turn, an error), amber (may be stuck, may need input), green (working), blue (finished while you were elsewhere), gray.
// The computer side here is the REAL `useSessionAttention` over the REAL chat reducer; the phone side is the REAL session record's
// summary through `statusFromSummary`. Neither is told the answer.
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { makeStoreWrapper } from './helpers/chat-store-harness';
import { useSessionAttention, statusFromSummary, mergeSummaryStatuses, viewedAfterSummaries } from '../src/renderer/hooks/useSessionAttention';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { hookEventToAction } from '../src/renderer/state/hook-dispatcher';
import { SessionRecords } from '../src/main/session-record';
import { ev } from './helpers/transcript-events';
import type { ChatAction } from '../src/renderer/state/chat-types';
import type { HookEvent, TranscriptEvent } from '../src/shared/types';
import type { SessionStatusColor } from '../src/renderer/components/StatusDot';

const S = 's1';
let n = 0;
const at = (ts: number) => ({ timestamp: ts, uuid: `d${++n}`, sessionId: S });
const hook = (type: string, id: string, extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}): HookEvent =>
  ({ type, sessionId: S, payload: { _requestId: id, ...extra }, timestamp: 1, ...over } as unknown as HookEvent);

type Step =
  | { label: string; t: TranscriptEvent }
  | { label: string; hook: HookEvent }
  /** The computer's attention classifier changed its mind: the window dispatches it AND relays it (remote:attention-changed). */
  | { label: string; relay: string }
  /** The process exited: the window dispatches it and relays it. */
  | { label: string; died: true };

const script: Step[] = [
  { label: 'user sends', t: ev('user-message', { text: 'go' }, at(1)) },
  { label: 'text streams', t: ev('assistant-text', { text: 'ok', partId: 'p', model: 'm' }, at(2)) },
  { label: 'stall warning', t: ev('assistant-thinking', { stallWarning: { retryInMs: 5000, willRetry: true } }, at(3)) },
  { label: 'stalled', t: ev('assistant-thinking', { stalled: true }, at(4)) },
  { label: 'activity resumes', t: ev('assistant-thinking', {}, at(5)) },
  { label: 'tool starts', t: ev('tool-use', { toolUseId: 't1', toolName: 'Bash', toolInput: { command: 'ls' } }, at(6)) },
  { label: 'ask raised', hook: hook('PermissionRequest', 'r1', { tool_name: 'Bash', tool_input: { command: 'ls' } }) },
  { label: 'ask answered', hook: hook('PermissionResolved', 'r1') },
  { label: 'a second ask raised', hook: hook('PermissionRequest', 'r2', { tool_name: 'Bash', tool_input: { command: 'rm x' } }) },
  { label: 'a second ask timed out', hook: hook('PermissionExpired', 'r2', { _reason: 'app-timeout' }) },
  { label: 'classifier: waiting for input', relay: 'awaiting-input' },
  { label: 'classifier: shell idle', relay: 'shell-idle' },
  { label: 'classifier: stuck', relay: 'stuck' },
  { label: 'classifier: ok again', relay: 'ok' },
  { label: 'tool result', t: ev('tool-result', { toolUseId: 't1', toolResult: 'ok', isError: false }, at(7)) },
  { label: 'turn completes', t: ev('turn-complete', { stopReason: 'end_turn' }, at(8)) },
  { label: 'a new turn', t: ev('user-message', { text: 'again' }, at(9)) },
  { label: 'provider error', t: ev('session-error', { text: 'boom' }, at(10)) },
  { label: 'user retries', t: ev('user-message', { text: 'retry' }, at(11)) },
  { label: 'user presses stop', t: ev('user-interrupt', {}, at(12)) },
  { label: 'a third turn', t: ev('user-message', { text: 'once more' }, at(13)) },
  { label: 'process dies mid-turn', died: true },
];

describe('the dot a phone draws from the summary equals the dot the computer draws from the events', () => {
  for (const mode of ['an unseen conversation (blue when it finishes)', 'a conversation already viewed (gray when it finishes)'] as const) {
    it(`${mode}: after every step`, () => {
      const unseen = mode.startsWith('an unseen');
      const { wrapper, store } = makeStoreWrapper([S]);
      const viewed = new Set<string>(unseen ? [] : [S]);
      // The computer's own window, with the conversation owned by it but another one on screen.
      const { result } = renderHook(() => useSessionAttention([{ id: S }, { id: 'other' }], viewed, 'other'), { wrapper });
      const records = new SessionRecords();
      records.begin(S);
      const rows: string[] = [];
      const colours = new Set<SessionStatusColor>();

      const check = (label: string) => {
        const computer = result.current.get(S)!.status;
        const summary = records.summary(S)!;
        const phone = statusFromSummary(summary, unseen);
        rows.push(`${label}: computer=${computer} phone=${phone}`);
        colours.add(computer);
        expect(phone, `after "${label}"`).toBe(computer);
      };

      check('before anything');
      for (const step of script) {
        if ('t' in step) {
          records.note(S, 'transcript:event', step.t);
          act(() => { for (const a of eventToAction(step.t, { live: true })) store.dispatch(a); });
        } else if ('hook' in step) {
          records.note(S, 'hook:event', step.hook);
          const a = hookEventToAction(step.hook);
          if (a) act(() => store.dispatch(a));
        } else if ('relay' in step) {
          act(() => store.dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId: S, state: step.relay } as ChatAction));
          records.noteReportedAttention(S, step.relay);
        } else {
          act(() => store.dispatch({ type: 'SESSION_PROCESS_EXITED', sessionId: S, exitCode: 1 } as ChatAction));
          records.noteReportedAttention(S, 'session-died');
        }
        check(step.label);
      }
      // The agreement is not two constants: every colour the strip can show was reached on the way.
      for (const c of ['red', 'amber', 'green', 'gray'] as const) expect(colours.has(c), `never reached ${c}:\n${rows.join('\n')}`).toBe(true);
      if (unseen) expect(colours.has('blue'), `never reached blue:\n${rows.join('\n')}`).toBe(true);
    });
  }

  it('a conversation the phone never received a single event for still gets its colour, and blue stays this screen\'s own', () => {
    const records = new SessionRecords();
    records.begin('far');
    records.note('far', 'transcript:event', ev('user-message', { text: 'go' }, { sessionId: 'far', timestamp: 1, uuid: 'f1' }));
    const summaries = records.summaries();
    const sessionIds = ['near', 'far'];
    const base = new Map<string, SessionStatusColor>([['near', 'gray'], ['far', 'gray']]);
    // working: green whatever this screen has looked at
    expect(mergeSummaryStatuses({ base, sessionIds, summaries, viewedSessions: new Set(), activeSessionId: 'near' }).get('far')).toBe('green');
    records.note('far', 'transcript:event', ev('turn-complete', { stopReason: 'end_turn' }, { sessionId: 'far', timestamp: 2, uuid: 'f2' }));
    const done = records.summaries();
    expect(mergeSummaryStatuses({ base, sessionIds, summaries: done, viewedSessions: new Set(), activeSessionId: 'near' }).get('far')).toBe('blue');
    expect(mergeSummaryStatuses({ base, sessionIds, summaries: done, viewedSessions: new Set(['far']), activeSessionId: 'near' }).get('far')).toBe('gray');
    // a conversation the summary does not mention keeps what this screen derived for it; and with no summaries at all nothing changes
    expect(mergeSummaryStatuses({ base: new Map([['near', 'amber']]), sessionIds, summaries: done, viewedSessions: new Set(), activeSessionId: 'x' }).get('near')).toBe('amber');
    expect(mergeSummaryStatuses({ base, sessionIds, summaries: null, viewedSessions: new Set(), activeSessionId: null })).toBe(base);
  });
});

describe('a conversation that starts working is no longer viewed (so it turns blue when it finishes elsewhere)', () => {
  const base = { awaitingCount: 0, attention: 'ok', hasHistory: true, queuedCount: 0, permissionMode: null, model: null };
  it('drops only the working ones from the viewed set', () => {
    const viewed = new Set(['a', 'b']);
    expect([...viewedAfterSummaries(viewed, { a: { ...base, working: true }, b: { ...base, working: false } })]).toEqual(['b']);
  });
  it('hands back the same set when nothing changed, so React does not re-render', () => {
    const viewed = new Set(['a']);
    expect(viewedAfterSummaries(viewed, { a: { ...base, working: false }, z: { ...base, working: true } })).toBe(viewed);
  });
});
