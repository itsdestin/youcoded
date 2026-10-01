// Shadow compare: the facts the computer's session record folds from a session's events equal the facts the renderer's
// chat reducer derives from the SAME events (one-core R5-1).
//
// WHY this exists: R5-3 will draw a phone's session dots from the record's summary instead of from every session's own
// events. That is only safe if the record reaches the reducer's answer. Each scripted session below feeds one event at a
// time to BOTH — the record through `note` (what publish does) and the reducer through the same translators the screens
// use (eventToAction, hookEventToAction) — and compares after EVERY step, not just at the end.
//
// Compared facts: working (= isThinking), attention (= attentionState), asks waiting (= cards awaiting an answer,
// nested helper asks included), hasHistory (= the timeline is not empty).
//
// Deliberately NOT mirrored (each is a renderer-only input the record cannot see in R5-1; listed so the gap is on record):
//  - USER_PROMPT: the sending screen marks itself "working" a beat before the transcript echoes the message.
//  - SESSION_PROCESS_EXITED ('session-died') and the stuck check: they come from the window, not from events (the record
//    holds the relayed value separately, `reportedAttention`; R5-4 moves the check itself).
//  - COMPACTION_PENDING: a flag only the screen that typed /compact sets. It must not change any compared fact, and the
//    compaction cases below pin exactly that.
//  - A kept Claude Code ask settled by Dismiss or the menu leaving the terminal (PERMISSION_CARD_RESOLVED).
import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { createSessionChatState, type ChatState, type SessionChatState, type ChatAction } from '../src/renderer/state/chat-types';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { hookEventToAction } from '../src/renderer/state/hook-dispatcher';
import { SessionRecords } from '../src/main/session-record';
import { ev } from './helpers/transcript-events';
import type { HookEvent, TranscriptEvent } from '../src/shared/types';

const S = 's1';

type Step =
  | { label: string; t: TranscriptEvent }
  | { label: string; hook: HookEvent }
  | { label: string; local: ChatAction }; // a renderer-only action the record never sees

const hook = (type: string, id: string, extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}): HookEvent =>
  ({ type, sessionId: S, payload: { _requestId: id, ...extra }, timestamp: 1, ...over } as unknown as HookEvent);

function awaitingCards(c: SessionChatState): number {
  let n = 0;
  for (const tool of c.toolCalls.values()) {
    if (tool.status === 'awaiting-approval') n++;
    for (const seg of tool.subagentSegments ?? []) if (seg.type === 'tool' && seg.status === 'awaiting-approval') n++;
  }
  return n;
}

function runBoth(script: Step[]) {
  let state: ChatState = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: S });
  const records = new SessionRecords();
  records.begin(S);
  const rows: string[] = [];
  for (const step of script) {
    if ('t' in step) {
      records.note(S, 'transcript:event', step.t);
      for (const a of eventToAction(step.t, { live: true })) state = chatReducer(state, a);
    } else if ('hook' in step) {
      records.note(S, 'hook:event', step.hook);
      const a = hookEventToAction(step.hook);
      if (a) state = chatReducer(state, a);
    } else {
      state = chatReducer(state, step.local);
    }
    const c = state.get(S)!;
    const f = records.facts(S)!;
    const renderer = { working: c.isThinking, attention: c.attentionState, awaiting: awaitingCards(c), hasHistory: c.timeline.length > 0 };
    const record = { working: f.working, attention: f.attention, awaiting: f.awaitingCount, hasHistory: f.hasHistory };
    rows.push(`${step.label}: renderer=${JSON.stringify(renderer)} record=${JSON.stringify(record)}`);
    expect(record, `after "${step.label}"`).toEqual(renderer);
  }
  return { rows, records, state };
}

let n = 0;
const u = () => `u${++n}`;
const at = (ts: number) => ({ timestamp: ts, uuid: u(), sessionId: S });

const nativeScript = (): Step[] => [
  { label: 'user sends', t: ev('user-message', { text: 'fix the bug' }, at(1000)) },
  { label: 'text streams (part 1)', t: ev('assistant-text', { text: 'Let me ', partId: 'text-0', model: 'm1' }, at(1001)) },
  { label: 'text streams (part 2)', t: ev('assistant-text', { text: 'look', partId: 'text-0' }, at(1002)) },
  { label: 'plain heartbeat', t: ev('assistant-thinking', {}, at(1003)) },
  { label: 'stall warning', t: ev('assistant-thinking', { stallWarning: { retryInMs: 5000, willRetry: true } }, at(1004)) },
  { label: 'stalled', t: ev('assistant-thinking', { stalled: true }, at(1005)) },
  // The retry: the abandoned half-answer is dropped, then the answer is written again.
  { label: 'dropPart (retry)', t: ev('assistant-thinking', { dropPart: { partIds: ['text-0'] } }, at(1006)) },
  { label: 'replacement text', t: ev('assistant-text', { text: 'Looking now', partId: 'text-0' }, at(1007)) },
  { label: 'usage progress', t: ev('assistant-thinking', { usageProgress: { inputTokens: 5, outputTokens: 1, contextUsedTokens: 10 } as never }, at(1008)) },
  { label: 'tool starts', t: ev('tool-use', { toolUseId: 'tool-1', toolName: 'Bash', toolInput: { command: 'ls' } }, at(1009)) },
  { label: 'ask raised', hook: hook('PermissionRequest', 'native-r1', { tool_name: 'Bash', tool_input: { command: 'ls' } }) },
  { label: 'ask answered', hook: hook('PermissionResolved', 'native-r1') },
  { label: 'tool result', t: ev('tool-result', { toolUseId: 'tool-1', toolResult: 'ok' }, at(1010)) },
  { label: 'second ask raised', hook: hook('PermissionRequest', 'native-r2', { tool_name: 'Bash', tool_input: { command: 'rm x' } }) },
  { label: 'second ask times out', hook: hook('PermissionExpired', 'native-r2', { _reason: 'app-timeout' }) },
  { label: 'third ask raised', hook: hook('PermissionRequest', 'native-r3', { tool_name: 'Write', tool_input: { path: 'a' } }) },
  { label: 'third ask cancelled (no reason)', hook: hook('PermissionExpired', 'native-r3') },
  { label: 'a helper tool (stamped) changes nothing', t: ev('tool-use', { toolUseId: 'sub-1', toolName: 'Read', toolInput: {}, parentAgentToolUseId: 'tool-1' }, at(1011)) },
  { label: 'turn completes', t: ev('turn-complete', { stopReason: 'end_turn', model: 'm1' }, at(1012)) },
  // Compaction: the screen that typed /compact sets a flag; the summary event then lands everywhere.
  { label: 'next user message', t: ev('user-message', { text: 'compact please' }, at(1013)) },
  { label: '/compact typed on this screen only', local: { type: 'COMPACTION_PENDING', sessionId: S, cardId: 'c1', beforeContextTokens: 100 } as ChatAction },
  { label: 'compaction summary lands', t: ev('compact-summary', { summary: 's', contextUsedBefore: 100, contextUsedAfter: 10, autoCompaction: true }, at(1014)) },
  { label: 'turn completes after compaction', t: ev('turn-complete', { stopReason: 'end_turn' }, at(1015)) },
  { label: 'a failing turn', t: ev('user-message', { text: 'again' }, at(1016)) },
  { label: 'provider error', t: ev('session-error', { text: 'boom' }, at(1017)) },
  { label: 'user retries (new message clears the error)', t: ev('user-message', { text: 'retry' }, at(1018)) },
  { label: 'user presses stop', t: ev('user-interrupt', {}, at(1019)) },
  { label: 'a clear barrier', t: ev('context-clear', {}, at(1020)) },
];

const claudeCodeScript = (): Step[] => [
  { label: 'user sends', t: ev('user-message', { text: 'hello' }, at(2000)) },
  { label: 'text', t: ev('assistant-text', { text: 'hi there' }, at(2001)) },
  { label: 'a slash command starts no turn', t: ev('user-message', { text: '/model sonnet', slashCommand: true }, at(2002)) },
  { label: 'tool starts', t: ev('tool-use', { toolUseId: 't1', toolName: 'Bash', toolInput: { command: 'ls' } }, at(2003)) },
  { label: 'ask raised (before the tool line? no: after)', hook: hook('PermissionRequest', 'cc-r1', { tool_name: 'Bash', tool_input: { command: 'ls' } }) },
  { label: 'hook closes first: Claude Code\'s own menu may still wait, so the ask stays', hook: hook('PermissionExpired', 'cc-r1', { _reason: 'hook-closed' }) },
  { label: 'turn completes and the kept ask fails with it', t: ev('turn-complete', { stopReason: 'end_turn' }, at(2004)) },
  { label: 'a skill starts a turn', t: ev('skill-invoked', { skillId: 'brainstorm', body: 'x' } as never, at(2005)) },
  { label: 'a replayed copy of the same skill line changes nothing', t: ev('skill-invoked', { skillId: 'brainstorm', body: 'x' } as never, { timestamp: 2005, uuid: 'dup-skill', sessionId: S }) },
  { label: 'interrupt', t: ev('user-interrupt', { kind: 'esc' } as never, at(2006)) },
  { label: 'password ask counts as waiting', hook: hook('PasswordRequest', 'pw1', { toolUseId: 't1', command: 'sudo ls' }) },
  { label: 'password resolved', hook: hook('PasswordResolved', 'pw1') },
];

describe('the session record and the chat reducer agree after every event', () => {
  it('a native session: streaming, stall, retry (dropPart), asks, compaction, errors, stop and clear', () => {
    const { rows } = runBoth(nativeScript());
    expect(rows.length).toBe(nativeScript().length); // every step compared
  });

  it('a Claude Code session: slash command, hook-closed ask, replayed skill line, password ask', () => {
    runBoth(claudeCodeScript());
  });

  it('the compared facts really move (the agreement is not two constants)', () => {
    const { rows } = runBoth(nativeScript());
    const seen = (key: string) => new Set(rows.map((r) => /record=(\{.*\})/.exec(r)![1]).map((j) => JSON.parse(j)[key]));
    expect(seen('working')).toEqual(new Set([true, false]));
    expect(seen('attention')).toEqual(new Set(['ok', 'stuck', 'stalled', 'error']));
    expect(seen('awaiting')).toEqual(new Set([0, 1]));
  });
});

describe('what the record keeps beyond the facts', () => {
  it('an ask raised and not yet answered is among the open asks, and leaves when answered', () => {
    const records = new SessionRecords();
    records.begin(S);
    records.note(S, 'hook:event', hook('PermissionRequest', 'r1', { tool_name: 'Bash' }));
    expect(records.openAsks(S)).toHaveLength(1);
    records.note(S, 'hook:event', hook('PermissionResolved', 'r1'));
    expect(records.openAsks(S)).toHaveLength(0);
    expect(records.facts(S)!.awaitingCount).toBe(0);
  });
});
