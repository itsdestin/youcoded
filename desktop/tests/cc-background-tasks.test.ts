// Claude Code background helpers and commands (2026-09-24, Destin: "background
// agents often get immediately marked as complete"). Every CC Agent call now
// runs in the background: its tool result is only a launch receipt, and the
// real end arrives later as a <task-notification>. Line shapes below are
// copied from real transcripts (trimmed), not invented.
import { describe, it, expect } from 'vitest';
import { parseTranscriptLine } from '../src/main/transcript-watcher';
import { SubagentIndex } from '../src/main/subagent-index';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { pageEventToAction } from '../src/renderer/state/transcript-page-actions';
import type { ChatState, ChatAction } from '../src/renderer/state/chat-types';
import type { TranscriptEvent } from '../src/shared/types';

const agentReceipt = JSON.stringify({
  type: 'user', uuid: 'r1', timestamp: '2026-08-06T07:10:00.000Z', promptId: 'p1',
  message: { role: 'user', content: [{ tool_use_id: 'toolu_A', type: 'tool_result', content: [{ type: 'text', text: 'Async agent launched successfully. (This tool result is internal metadata — never quote …)\nagentId: a3ecf (internal ID - do not mention to user.)' }] }] },
  toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a3ecf', description: 'Fetch guidance' },
});
const bashReceipt = JSON.stringify({
  type: 'user', uuid: 'r2', timestamp: '2026-08-06T07:10:00.000Z',
  message: { role: 'user', content: [{ tool_use_id: 'toolu_B', type: 'tool_result', content: 'Command running in background with ID: bt1v7. Output is being written to: /tmp/x.output.', is_error: false }] },
  toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bt1v7' },
});
const notice = (body: string) => `<task-notification>\n${body}\n</task-notification>`;
const agentDone = notice('<task-id>a3ecf</task-id>\n<tool-use-id>toolu_A</tool-use-id>\n<output-file>/tmp/a.output</output-file>\n<status>completed</status>\n<summary>Agent "Fetch guidance" finished</summary>\n<note>…</note>\n<result>All sources fetched.\n\nA) FETCHED <b>ok</b></result>\n<usage><subagent_tokens>1</subagent_tokens></usage>');
const noticeLine = (content: string, uuid = 'n1') => JSON.stringify({
  type: 'user', uuid, promptId: 'p2', origin: { kind: 'task-notification' }, message: { role: 'user', content },
});

describe('parseTranscriptLine — background launch receipts', () => {
  it('an Agent receipt carries the helper id', () => {
    const [ev] = parseTranscriptLine(agentReceipt, 's');
    expect(ev.type).toBe('tool-result');
    expect(ev.data.backgroundTaskId).toBe('a3ecf');
  });
  it('a background Bash receipt carries its task id', () => {
    expect(parseTranscriptLine(bashReceipt, 's')[0].data.backgroundTaskId).toBe('bt1v7');
  });
  it('an ordinary result carries none', () => {
    const line = JSON.stringify({ type: 'user', uuid: 'r3', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }, toolUseResult: { stdout: 'ok' } });
    expect(parseTranscriptLine(line, 's')[0].data.backgroundTaskId).toBeUndefined();
  });
});

describe('parseTranscriptLine — task notifications', () => {
  it('a notice user line becomes one background-task event and no chat bubble', () => {
    const evs = parseTranscriptLine(noticeLine(agentDone), 's');
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: 'background-task', uuid: 'n1',
      data: { toolUseId: 'toolu_A', backgroundTask: { taskIds: ['a3ecf'], status: 'completed', summary: 'Agent "Fetch guidance" finished', result: 'All sources fetched.\n\nA) FETCHED <b>ok</b>' } },
    });
  });
  it('a notice queued mid-turn (attachment) is read too — it has no user line', () => {
    const line = JSON.stringify({ type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: agentDone } });
    const evs = parseTranscriptLine(line, 's');
    expect(evs.map(e => e.type)).toEqual(['background-task']);
  });
  it('killed reads stopped; failed stays failed', () => {
    const k = parseTranscriptLine(noticeLine(notice('<task-id>b1</task-id>\n<tool-use-id>toolu_K</tool-use-id>\n<status>killed</status>\n<summary>Background command "x" was stopped</summary>')), 's');
    expect(k[0].data.backgroundTask?.status).toBe('stopped');
    const f = parseTranscriptLine(noticeLine(notice('<task-id>b2</task-id>\n<tool-use-id>toolu_F</tool-use-id>\n<status>failed</status>\n<summary>failed with exit code 144</summary>')), 's');
    expect(f[0].data.backgroundTask?.status).toBe('failed');
  });
  it("the resume orphan summary lists several tasks and drops Claude Code's scan marker", () => {
    const evs = parseTranscriptLine(noticeLine(notice('<task-id>b2a</task-id>\n<task-id>b6u</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>…</summary>')), 's');
    expect(evs[0].data.toolUseId).toBeUndefined();
    expect(evs[0].data.backgroundTask?.taskIds).toEqual(['b2a', 'b6u']);
  });
  it('a Monitor event (no status) changes no card', () => {
    expect(parseTranscriptLine(noticeLine(notice('<task-id>bf3</task-id>\n<summary>Monitor event: "x"</summary>\n<event>DONE</event>')), 's')).toEqual([]);
  });
  it('two notices in one line get distinct uuids', () => {
    const two = agentDone + '\n' + notice('<task-id>b9</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n<status>completed</status>');
    expect(parseTranscriptLine(noticeLine(two), 's').map(e => e.uuid)).toEqual(['n1', 'n1:1']);
  });
});

describe('SubagentIndex — exact parent from the meta file', () => {
  it('binds by toolUseId even when descriptions collide', () => {
    const idx = new SubagentIndex();
    idx.recordParentAgentToolUse('toolu_1', 'Review', 'general-purpose');
    idx.recordParentAgentToolUse('toolu_2', 'Review', 'general-purpose');
    expect(idx.bindSubagent('a2', { description: 'Review', agentType: 'general-purpose', toolUseId: 'toolu_2' })).toBe('toolu_2');
    expect(idx.bindSubagent('a1', { description: 'Review', agentType: 'general-purpose', toolUseId: 'toolu_1' })).toBe('toolu_1');
  });
  it("a nested helper (parent not in this transcript) binds to nothing instead of a same-named card", () => {
    const idx = new SubagentIndex();
    idx.recordParentAgentToolUse('toolu_1', 'Review', 'general-purpose');
    expect(idx.bindSubagent('n1', { description: 'Review', agentType: 'general-purpose', toolUseId: 'toolu_inner' })).toBeNull();
  });
  it('without a toolUseId, a call that omitted subagent_type still matches its general-purpose helper', () => {
    const idx = new SubagentIndex();
    idx.recordParentAgentToolUse('toolu_1', 'Look around', '');
    expect(idx.bindSubagent('a1', { description: 'Look around', agentType: 'general-purpose' })).toBe('toolu_1');
  });
  it('buffered events flush to the exact parent once it is recorded', () => {
    const idx = new SubagentIndex();
    idx.bufferPendingEvent('a1', { description: 'X', agentType: 'Explore', toolUseId: 'toolu_1' }, 'ev');
    idx.recordParentAgentToolUse('toolu_0', 'X', 'Explore');
    idx.recordParentAgentToolUse('toolu_1', 'X', 'Explore');
    expect(idx.tryFlushPending('a1')).toEqual({ parentToolUseId: 'toolu_1', events: ['ev'] });
  });
});

// ── Reducer ──────────────────────────────────────────────────────────────────
const S = 'sess';
const d = (s: ChatState, a: ChatAction) => chatReducer(s, a);
const init = (): ChatState => d(new Map(), { type: 'SESSION_INIT', sessionId: S } as ChatAction);
const card = (s: ChatState, id = 'toolu_A') => s.get(S)!.toolCalls.get(id)!;
const toAction = (e: TranscriptEvent) => pageEventToAction(e)!;
const ev = (line: string) => parseTranscriptLine(line, S);
function launchAgent(s: ChatState): ChatState {
  s = d(s, { type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'u1', toolUseId: 'toolu_A', toolName: 'Agent', toolInput: { description: 'Fetch guidance', prompt: 'go' } } as ChatAction);
  return d(s, toAction(ev(agentReceipt)[0]));
}

describe('chatReducer — Claude Code background runs', () => {
  it('the receipt leaves the helper RUNNING (the bug: it read done at once)', () => {
    const s = launchAgent(init());
    expect(card(s).status).toBe('complete');            // the call returned…
    expect(card(s).ccBackground).toEqual({ taskId: 'a3ecf', status: 'running' }); // …the work did not
    expect(card(s).agentId).toBe('a3ecf');
  });
  it('the end notice settles it and carries the report', () => {
    const s = d(launchAgent(init()), toAction(ev(noticeLine(agentDone))[0]));
    expect(card(s).ccBackground).toMatchObject({ status: 'completed', result: expect.stringContaining('All sources fetched') });
  });
  it('a notice without a tool-use id finds the card by task id', () => {
    const s = d(launchAgent(init()), { type: 'TRANSCRIPT_BACKGROUND_TASK', sessionId: S, uuid: 'x', taskIds: ['a3ecf'], status: 'failed' } as ChatAction);
    expect(card(s).ccBackground?.status).toBe('failed');
  });
  it('a repeated receipt after the notice never revives the run', () => {
    let s = d(launchAgent(init()), toAction(ev(noticeLine(agentDone))[0]));
    s = d(s, toAction(ev(agentReceipt)[0]));
    expect(card(s).ccBackground?.status).toBe('completed');
  });
  it('the Claude Code process exiting stops what is still running', () => {
    const s = d(launchAgent(init()), { type: 'SESSION_PROCESS_EXITED', sessionId: S, exitCode: 0 } as ChatAction);
    expect(card(s).ccBackground?.status).toBe('stopped');
  });
  it('an older history page settles its card from a notice a NEWER page already delivered', () => {
    // Newest page first: only the notice is on screen.
    let s = d(init(), toAction(ev(noticeLine(agentDone))[0]));
    const older: TranscriptEvent[] = [
      { type: 'tool-use', sessionId: S, uuid: 'u1', timestamp: 1, data: { toolUseId: 'toolu_A', toolName: 'Agent', toolInput: { description: 'Fetch guidance' } } },
      ...ev(agentReceipt),
    ];
    s = d(s, { type: 'HISTORY_PAGE_LOADED', sessionId: S, events: older, cursor: null, hasMore: false } as ChatAction);
    expect(card(s).ccBackground?.status).toBe('completed');
  });
  it('a page from before this process started reads its unfinished helper as stopped', () => {
    const older: TranscriptEvent[] = [
      { type: 'tool-use', sessionId: S, uuid: 'u1', timestamp: 1, data: { toolUseId: 'toolu_A', toolName: 'Agent', toolInput: { description: 'Fetch guidance' } } },
      ...ev(agentReceipt),
    ];
    const s = d(init(), { type: 'HISTORY_PAGE_LOADED', sessionId: S, events: older, cursor: null, hasMore: false, reconcileInterruptedToolIds: ['toolu_A'] } as ChatAction);
    expect(card(s).ccBackground?.status).toBe('stopped');
  });
  it("a helper's own background notice (stamped) changes nothing at the top level", () => {
    const s = launchAgent(init());
    const after = d(s, { type: 'TRANSCRIPT_BACKGROUND_TASK', sessionId: S, uuid: 'x', toolUseId: 'toolu_A', taskIds: ['a3ecf'], status: 'completed', parentAgentToolUseId: 'toolu_A' } as ChatAction);
    expect(after).toBe(s);
  });
});
