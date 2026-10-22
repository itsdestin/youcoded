// Claude Code background work through the reducer — the 2026-10-22 status audit
// (A2 A5 A7 A8 C1 C2 C4 C5, D1) plus the per-session background-COMMAND list the
// upcoming "Background" chip reads. Line shapes are real (trimmed): see
// cc-background-tasks.test.ts for the parser half.
import { describe, it, expect } from 'vitest';
import { parseTranscriptLine } from '../src/main/transcript-watcher';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { pageEventToActions } from '../src/renderer/state/transcript-page-actions';
import { serializeChatState, deserializeChatState, type ChatState, type ChatAction } from '../src/renderer/state/chat-types';
import { backgroundCommandList, summarizeBackgroundCommands } from '../src/renderer/state/background-commands';
import type { ShellRunView, TranscriptEvent } from '../src/shared/types';

const S = 'sess';
const d = (s: ChatState, a: ChatAction) => chatReducer(s, a);
const init = (): ChatState => d(new Map(), { type: 'SESSION_INIT', sessionId: S } as ChatAction);
const card = (s: ChatState, id: string) => s.get(S)!.toolCalls.get(id)!;
const ev = (line: string) => parseTranscriptLine(line, S);
/** Feeds a raw transcript line through the real parser and translator. */
const feed = (s: ChatState, line: string): ChatState => ev(line).reduce((acc, e) => pageEventToActions(e).reduce(d, acc), s);
const addTool = (s: ChatState, id: string, name: string, input: Record<string, unknown>, extra: Partial<ChatAction> = {}) =>
  d(s, { type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: S, uuid: `u-${id}`, toolUseId: id, toolName: name, toolInput: input, ...extra } as ChatAction);
const notice = (body: string) => `<task-notification>\n${body}\n</task-notification>`;
const noticeLine = (content: string, uuid = 'n1') => JSON.stringify({ type: 'user', uuid, promptId: 'p2', origin: { kind: 'task-notification' }, message: { role: 'user', content } });
const result = (id: string, content: string, toolUseResult: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'user', uuid: `r-${id}`, timestamp: '2026-10-22T10:00:00.000Z', promptId: 'p', ...extra,
  message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content }] }, toolUseResult,
});
const bashBg = (s: ChatState, id = 'toolu_B', task = 'bt1v7', input: Record<string, unknown> = { command: 'npm run dev', description: 'Dev server', run_in_background: true }) =>
  feed(addTool(s, id, 'Bash', input), result(id, `Command running in background with ID: ${task}.`, { stdout: '', backgroundTaskId: task }));
const cmds = (s: ChatState) => backgroundCommandList(s.get(S)!);
const stopResult = (task: string, type = 'local_bash') => result('toolu_S', JSON.stringify({ message: `Successfully stopped task: ${task} (x)`, task_id: task, task_type: type }), { message: `Successfully stopped task: ${task} (x)`, task_id: task, task_type: type, command: 'x' });

describe('A5 / C2: Workflow and Monitor launches start as running', () => {
  it('a Workflow card is running after its receipt', () => {
    const s = feed(addTool(init(), 'toolu_W', 'Workflow', { scriptPath: 'x.js' }), result('toolu_W', 'Workflow launched in background. Task ID: wmvrqe407', { status: 'async_launched', taskId: 'wmvrqe407', taskType: 'local_workflow' }));
    expect(card(s, 'toolu_W').ccBackground).toEqual({ taskId: 'wmvrqe407', status: 'running' });
  });
  it('a Monitor card is running after its receipt', () => {
    const s = feed(addTool(init(), 'toolu_M', 'Monitor', { command: 'tail -f x', description: 'watch' }), result('toolu_M', 'Monitor started (task bt5jyr3nj, timeout 1800000ms).', { taskId: 'bt5jyr3nj', timeoutMs: 1800000, persistent: false }));
    expect(card(s, 'toolu_M').ccBackground).toEqual({ taskId: 'bt5jyr3nj', status: 'running' });
  });
});

describe('C1: TaskStop', () => {
  it('a successful stop marks the command stopped (no notice ever follows)', () => {
    let s = bashBg(init());
    s = feed(addTool(s, 'toolu_S', 'TaskStop', { task_id: 'bt1v7' }), stopResult('bt1v7'));
    expect(card(s, 'toolu_B').ccBackground?.status).toBe('stopped');
    // The TaskStop call itself is an ordinary finished card.
    expect(card(s, 'toolu_S').ccBackground).toBeUndefined();
  });
  it('stops a helper by its agent id', () => {
    let s = feed(addTool(init(), 'toolu_A', 'Agent', { description: 'h' }), result('toolu_A', 'launched', { status: 'async_launched', agentId: 'a3ecf' }));
    s = feed(addTool(s, 'toolu_S', 'TaskStop', { task_id: 'a3ecf' }), stopResult('a3ecf', 'local_agent'));
    expect(card(s, 'toolu_A').ccBackground?.status).toBe('stopped');
  });
  it('never rewrites a command that already finished', () => {
    let s = feed(bashBg(init()), noticeLine(notice('<task-id>bt1v7</task-id>\n<tool-use-id>toolu_B</tool-use-id>\n<status>completed</status>\n<summary>done (exit code 0)</summary>')));
    s = feed(addTool(s, 'toolu_S', 'TaskStop', {}), stopResult('bt1v7'));
    expect(card(s, 'toolu_B').ccBackground?.status).toBe('completed');
  });
  it('a stop read BEFORE its launch (newer page first) settles the older card as stopped', () => {
    let s = feed(addTool(init(), 'toolu_S', 'TaskStop', {}), stopResult('bt1v7'));
    const older: TranscriptEvent[] = [
      { type: 'tool-use', sessionId: S, uuid: 'u1', timestamp: 1, data: { toolUseId: 'toolu_B', toolName: 'Bash', toolInput: { command: 'x', run_in_background: true } } },
      ...ev(result('toolu_B', 'running', { backgroundTaskId: 'bt1v7' })),
    ];
    s = d(s, { type: 'HISTORY_PAGE_LOADED', sessionId: S, events: older, cursor: null, hasMore: false } as ChatAction);
    expect(card(s, 'toolu_B').ccBackground?.status).toBe('stopped');
  });
});

describe('A2: a resume whose launch card is on an unloaded older page', () => {
  const agentUse: TranscriptEvent = { type: 'tool-use', sessionId: S, uuid: 'u1', timestamp: 1, data: { toolUseId: 'toolu_A', toolName: 'Agent', toolInput: { description: 'Fetch guidance' } } };
  const receipt = () => ev(result('toolu_A', 'launched', { status: 'async_launched', agentId: 'a3ecf' }));
  const firstDone = () => ev(noticeLine(notice('<task-id>a3ecf</task-id>\n<tool-use-id>toolu_A</tool-use-id>\n<status>completed</status>\n<result>First</result>')));
  const resumeLive = (s: ChatState) => feed(addTool(s, 'toolu_SM', 'SendMessage', { to: 'a3ecf', message: 'more' }), result('toolu_SM', 'ok', { success: true, resumedAgentId: 'a3ecf' }));
  const load = (s: ChatState) => d(s, { type: 'HISTORY_PAGE_LOADED', sessionId: S, events: [agentUse, ...receipt(), ...firstDone()], cursor: null, hasMore: false } as ChatAction);
  it('shows working once the older page loads (it used to settle on the FIRST run)', () => {
    const s = load(resumeLive(init()));
    expect(card(s, 'toolu_A').ccBackground?.status).toBe('running');
  });
  it('shows the second run’s end when that was already read', () => {
    let s = resumeLive(init());
    s = feed(s, noticeLine(notice('<task-id>a3ecf</task-id>\n<tool-use-id>toolu_SM</tool-use-id>\n<status>failed</status>\n<result>Second</result>'), 'n2'));
    s = load(s);
    expect(card(s, 'toolu_A').ccBackground).toMatchObject({ status: 'failed', result: 'Second' });
  });
  it('shows stopped when the resumed run was stopped before the older page loaded', () => {
    let s = resumeLive(init());
    s = feed(addTool(s, 'toolu_S', 'TaskStop', {}), stopResult('a3ecf'));
    s = load(s);
    expect(card(s, 'toolu_A').ccBackground?.status).toBe('stopped');
  });
});

describe('A7 / C3: a conversation shown with no live Claude Code process', () => {
  const older = (): TranscriptEvent[] => [
    { type: 'tool-use', sessionId: S, uuid: 'u1', timestamp: 1, data: { toolUseId: 'toolu_B', toolName: 'Bash', toolInput: { command: 'x', run_in_background: true } } },
    ...ev(result('toolu_B', 'running', { backgroundTaskId: 'bt1v7' })),
  ];
  it('reads its unreported background work as stopped when the page says no process is attached', () => {
    const s = d(init(), { type: 'HISTORY_PAGE_LOADED', sessionId: S, events: older(), cursor: null, hasMore: false, reconcileBackground: true } as ChatAction);
    expect(card(s, 'toolu_B').ccBackground?.status).toBe('stopped');
    expect(cmds(s)[0].status).toBe('stopped');
  });
  it('leaves a live session’s running work alone (no flag)', () => {
    const s = d(init(), { type: 'HISTORY_PAGE_LOADED', sessionId: S, events: older(), cursor: null, hasMore: false } as ChatAction);
    expect(card(s, 'toolu_B').ccBackground?.status).toBe('running');
  });
  it('does not touch cards the live stream added (only the page’s own)', () => {
    let s = bashBg(init(), 'toolu_LIVE', 'live1');
    s = d(s, { type: 'HISTORY_PAGE_LOADED', sessionId: S, events: older(), cursor: null, hasMore: false, reconcileBackground: true } as ChatAction);
    expect(card(s, 'toolu_LIVE').ccBackground?.status).toBe('running');
  });
});

describe('A8: Esc before the launch receipt', () => {
  it('does not flash a background launch as failed', () => {
    let s = addTool(init(), 'toolu_A', 'Agent', { description: 'h' });
    s = d(s, { type: 'TRANSCRIPT_INTERRUPT', sessionId: S, uuid: 'i1', timestamp: 2 } as ChatAction);
    expect(card(s, 'toolu_A').status).not.toBe('failed');
    s = feed(s, result('toolu_A', 'launched', { status: 'async_launched', agentId: 'a3ecf' }));
    expect(card(s, 'toolu_A').ccBackground).toEqual({ taskId: 'a3ecf', status: 'running' });
  });
  it('still fails an ordinary foreground call the interrupt cut short', () => {
    let s = addTool(init(), 'toolu_R', 'Read', { file_path: '/x' });
    s = d(s, { type: 'TRANSCRIPT_INTERRUPT', sessionId: S, uuid: 'i1', timestamp: 2 } as ChatAction);
    expect(card(s, 'toolu_R').status).toBe('failed');
  });
});

describe('background commands list (C4, C5, command store)', () => {
  it('a background Bash command is listed with its label, command text and start time', () => {
    const s = bashBg(init());
    expect(cmds(s)).toEqual([expect.objectContaining({
      id: 'claude-code:toolu_B', provider: 'claude-code', kind: 'command', toolUseId: 'toolu_B', taskId: 'bt1v7',
      label: 'Dev server', command: 'npm run dev', status: 'running',
    })]);
    expect(cmds(s)[0].startedAt).toBeGreaterThan(0);
  });
  it('without a description the label is the command', () => {
    expect(cmds(bashBg(init(), 'toolu_B', 'b1', { command: 'make build' }))[0].label).toBe('make build');
  });
  it('an auto-backgrounded command (no run_in_background in the call) is listed too', () => {
    expect(cmds(bashBg(init(), 'toolu_B', 'b1', { command: 'sleep 999' }))).toHaveLength(1);
  });
  it('a notice settles it: completed, failed with its exit code, killed → stopped', () => {
    const end = (status: string, summary: string) => feed(bashBg(init()), noticeLine(notice(`<task-id>bt1v7</task-id>\n<tool-use-id>toolu_B</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>`)));
    expect(cmds(end('completed', 'Background command "x" completed (exit code 0)'))[0]).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(cmds(end('failed', 'Background command "x" failed with exit code 144'))[0]).toMatchObject({ status: 'failed', exitCode: 144 });
    expect(cmds(end('killed', 'was stopped'))[0].status).toBe('stopped');
    expect(cmds(end('completed', 'ok'))[0].endedAt).toBeGreaterThan(0);
  });
  it('TaskStop and the process exiting both stop it', () => {
    const stop = feed(addTool(bashBg(init()), 'toolu_S', 'TaskStop', {}), result('toolu_S', 'stopped', { message: 'Successfully stopped task: bt1v7 (x)', task_id: 'bt1v7', task_type: 'local_bash' }));
    expect(cmds(stop)[0].status).toBe('stopped');
    expect(cmds(d(bashBg(init()), { type: 'SESSION_PROCESS_EXITED', sessionId: S, exitCode: 0 } as ChatAction))[0].status).toBe('stopped');
  });
  it('a Monitor is a watcher; a persistent one is marked so (C5)', () => {
    const mon = (persistent: boolean) => feed(addTool(init(), 'toolu_M', 'Monitor', { command: 'tail -f log', description: 'Watch log', persistent }), result('toolu_M', 'Monitor started', { taskId: 'wm1', timeoutMs: 3600000, persistent }));
    expect(cmds(mon(false))[0]).toMatchObject({ kind: 'watcher', label: 'Watch log', status: 'running' });
    expect(cmds(mon(false))[0].persistent).toBeFalsy();
    expect(cmds(mon(true))[0].persistent).toBe(true);
  });
  it("a helper's own background command is listed under its helper, not as a top-level card (C4)", () => {
    let s = feed(addTool(init(), 'toolu_A', 'Agent', { description: 'Builder' }), result('toolu_A', 'launched', { status: 'async_launched', agentId: 'a3ecf' }));
    s = addTool(s, 'toolu_H', 'Bash', { command: 'npm test', description: 'Tests', run_in_background: true }, { parentAgentToolUseId: 'toolu_A', agentId: 'a3ecf' } as Partial<ChatAction>);
    s = d(s, { type: 'TRANSCRIPT_TOOL_RESULT', sessionId: S, uuid: 'rh', toolUseId: 'toolu_H', result: 'running', isError: false, backgroundTaskId: 'bh1', parentAgentToolUseId: 'toolu_A', timestamp: 5 } as ChatAction);
    expect(s.get(S)!.toolCalls.has('toolu_H')).toBe(false);
    expect(cmds(s)).toEqual([expect.objectContaining({ label: 'Tests', status: 'running', ownerHelper: { toolUseId: 'toolu_A', agentId: 'a3ecf' } })]);
    s = d(s, { type: 'TRANSCRIPT_BACKGROUND_TASK', sessionId: S, uuid: 'nh', taskIds: ['bh1'], status: 'completed', parentAgentToolUseId: 'toolu_A', timestamp: 9 } as ChatAction);
    expect(cmds(s)[0].status).toBe('completed');
    // …and the helper card itself is unaffected.
    expect(card(s, 'toolu_A').ccBackground?.status).toBe('running');
  });
  it('an unchanged event returns the same list object (cached selector)', () => {
    const s = bashBg(init());
    expect(backgroundCommandList(s.get(S)!)).toBe(backgroundCommandList(s.get(S)!));
  });
  it('survives serialize → deserialize', () => {
    const s = bashBg(init());
    expect(cmds(deserializeChatState(serializeChatState(s)))).toEqual(cmds(s));
  });
  it('an older page keeps the live list and adds its own commands', () => {
    let s = bashBg(init(), 'toolu_NEW', 'n1');
    const older: TranscriptEvent[] = [
      { type: 'tool-use', sessionId: S, uuid: 'u1', timestamp: 1, data: { toolUseId: 'toolu_OLD', toolName: 'Bash', toolInput: { command: 'old', run_in_background: true } } },
      ...ev(result('toolu_OLD', 'running', { backgroundTaskId: 'o1' })),
      ...ev(noticeLine(notice('<task-id>o1</task-id>\n<tool-use-id>toolu_OLD</tool-use-id>\n<status>completed</status>\n<summary>x</summary>'))),
    ];
    s = d(s, { type: 'HISTORY_PAGE_LOADED', sessionId: S, events: older, cursor: null, hasMore: false } as ChatAction);
    expect(cmds(s).map(c => [c.toolUseId, c.status])).toEqual([['toolu_OLD', 'completed'], ['toolu_NEW', 'running']]);
  });
  it('counts', () => {
    const s = feed(bashBg(init(), 'toolu_1', 'b1'), noticeLine(notice('<task-id>b1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>failed</status>\n<summary>failed with exit code 1</summary>')));
    expect(summarizeBackgroundCommands([...cmds(s), ...cmds(bashBg(init(), 'toolu_2', 'b2'))])).toEqual({ running: 1, completed: 0, failed: 1, stopped: 0, total: 2 });
  });
});

describe('native shells in the command list, and D1 parking', () => {
  const run = (over: Partial<ShellRunView> = {}): ShellRunView => ({ toolUseId: 't1', shellId: 'sh-1', status: 'running', startedAt: 1_000, tail: 'a', logPath: '/log', ...over });
  const runChanged = (s: ChatState, r: ShellRunView) => d(s, { type: 'SHELL_RUN_CHANGED', sessionId: S, run: r } as ChatAction);
  const nativeBash = (s: ChatState) => addTool(s, 't1', 'Bash', { command: 'npm run dev', description: 'Dev server', run_in_background: true });

  it('lists a native shell with its shell id for Stop', () => {
    const s = runChanged(nativeBash(init()), run());
    expect(cmds(s)).toEqual([expect.objectContaining({ id: 'native:t1', provider: 'native', kind: 'command', shellId: 'sh-1', label: 'Dev server', command: 'npm run dev', status: 'running', startedAt: 1_000 })]);
  });
  it('reads exit and stop outcomes', () => {
    expect(cmds(runChanged(nativeBash(init()), run({ status: 'exited', exitCode: 0, endedAt: 2 })))[0]).toMatchObject({ status: 'completed', exitCode: 0, endedAt: 2 });
    expect(cmds(runChanged(nativeBash(init()), run({ status: 'exited', exitCode: 2 })))[0]).toMatchObject({ status: 'failed', exitCode: 2 });
    expect(cmds(runChanged(nativeBash(init()), run({ status: 'stopped', stopReason: 'user' })))[0]).toMatchObject({ status: 'stopped', stopReason: 'user' });
  });
  it('uses the main process’s own command/description when it sends them, without needing the card', () => {
    const r = { ...run(), command: 'make watch', description: 'Watcher' } as ShellRunView;
    expect(cmds(runChanged(init(), r))[0]).toMatchObject({ label: 'Watcher', command: 'make watch' });
  });
  it('a tail-only update changes nothing (same state object)', () => {
    const s = runChanged(nativeBash(init()), run());
    expect(runChanged(s, run({ tail: 'a\nb' })).get(S)!.backgroundCommands).toBe(s.get(S)!.backgroundCommands);
  });
  it('D1: a record for a card that is not loaded is parked, listed, and applied when the card appears', () => {
    let s = runChanged(init(), run());
    expect(cmds(s)[0]).toMatchObject({ status: 'running', shellId: 'sh-1' });
    expect(s.get(S)!.parkedShellRuns?.get('t1')?.shellId).toBe('sh-1');
    s = nativeBash(s);
    expect(card(s, 't1').shellRun?.shellId).toBe('sh-1');
    expect(s.get(S)!.parkedShellRuns?.size ?? 0).toBe(0);
    expect(cmds(s)[0].label).toBe('Dev server');   // card text fills in the label
  });
  it('an app-quit orphan (no live record after replay) shows stopped in the list', () => {
    let s = addTool(init(), 't1', 'Bash', { command: 'x', run_in_background: true });
    s = d(s, { type: 'TRANSCRIPT_TOOL_RESULT', sessionId: S, uuid: 'r', toolUseId: 't1', result: 'Started in the background (shell id sh-9).', isError: false } as ChatAction);
    s = d(s, { type: 'TRANSCRIPT_REPLAY_COMPLETE', sessionId: S, sessionIdle: false } as ChatAction);
    expect(cmds(s)[0]).toMatchObject({ provider: 'native', shellId: 'sh-9', status: 'stopped', stopReason: 'app-quit' });
  });
});
