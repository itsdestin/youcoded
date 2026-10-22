// @vitest-environment jsdom
/**
 * The status-bar helpers chip in a CLAUDE CODE session (2026-09-05).
 *
 * The chip used to count exactly one thing — `tool.specialistRun`, a ledger
 * record only the app's own native engine writes — so a Claude Code
 * conversation running three subagents showed nothing at all, even though the
 * app was already tailing every one of their logs onto its Agent card.
 * `ccRunFromCard` derives the same shape from that card. What this pins:
 *
 *  1. A started CC Agent card becomes a helper; a non-Agent card and an Agent
 *     call still AWAITING the user's yes do not (nothing is running yet, so
 *     counting it as "working" would be a false statement on the bar).
 *  2. The chip says "subagents" in a CC session and "specialists" in a native
 *     one (Destin, 2026-09-05) — one chip, one meaning, the word each engine
 *     uses for its own helpers.
 *  3. No fabricated clock: an Agent card with no timestamped segment yet
 *     reports elapsedUnknown, and the status line omits the figure rather than
 *     rendering `Date.now() - 0` as a 56-year runtime.
 *  4. A finished CC helper carries an END time, so "Finished in 4m" is fixed
 *     instead of climbing on every re-render.
 *  5. (Superseded 2026-10-22 by agent_id attribution, see the A4 block at the end.) CC helpers never reach needs-you: Claude Code does not say which
 *     subagent raised a permission prompt, so the amber state stays native-only
 *     rather than pinning an ask on a guessed helper.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { ccRunFromCard } from '../src/renderer/hooks/useSpecialists';
import { hookEventToAction } from '../src/renderer/state/hook-dispatcher';
import SpecialistsChip from '../src/renderer/components/SpecialistsChip';
import { RunStatusLine } from '../src/renderer/components/specialists/RunStatusLine';
import { ChatProvider, useChatDispatch } from '../src/renderer/state/chat-context';
import type { ChatAction } from '../src/renderer/state/chat-types';
import type { ToolCallState, SpecialistRunView, SubagentSegment } from '../src/shared/types';

afterEach(cleanup);

const agentCard = (over: Partial<ToolCallState> = {}): ToolCallState => ({
  toolUseId: 'tu-1',
  toolName: 'Agent',
  input: { description: 'Find the chip code', subagent_type: 'Explore', prompt: 'go' },
  status: 'running',
  ...over,
});

const seg = (over: Partial<Extract<SubagentSegment, { type: 'tool' }>> = {}): SubagentSegment => ({
  type: 'tool',
  id: 's1',
  toolUseId: 'st-1',
  toolName: 'Read',
  input: {},
  status: 'complete',
  ...over,
});

describe('ccRunFromCard — a Claude Code subagent in the popup’s shape', () => {
  it('only synthesizes for a STARTED Agent card', () => {
    expect(ccRunFromCard('tu-1', agentCard())).toBeDefined();
    // The native harness's own tool is named 'Task' and brings a real record.
    expect(ccRunFromCard('tu-1', agentCard({ toolName: 'Task' }))).toBeUndefined();
    // Not hired yet — the user has not answered the consent card.
    expect(ccRunFromCard('tu-1', agentCard({ status: 'awaiting-approval' }))).toBeUndefined();
    // Arguments still streaming; nothing has run.
    expect(ccRunFromCard('tu-1', agentCard({ preparing: true }))).toBeUndefined();
    expect(ccRunFromCard('tu-1', agentCard({ toolName: 'Bash' }))).toBeUndefined();
  });

  it('names the helper by its job and keeps the type as the secondary label', () => {
    const out = ccRunFromCard('tu-1', agentCard())!;
    // Two `general-purpose` helpers are indistinguishable by type, so the
    // per-launch description is the name.
    expect(out.run.title).toBe('Find the chip code');
    expect(out.agentTypeLabel).toBe('Explore');
    // Falls back to the type when Claude Code sent no description.
    const bare = ccRunFromCard('tu-1', agentCard({ input: { subagent_type: 'Plan' } }))!;
    expect(bare.run.title).toBe('Plan');
    // …and then does not repeat itself as a description underneath.
    expect(bare.run.description).toBeUndefined();
  });

  it('maps the card status onto the run status', () => {
    expect(ccRunFromCard('tu-1', agentCard({ status: 'running' }))!.run.status).toBe('running');
    expect(ccRunFromCard('tu-1', agentCard({ status: 'complete' }))!.run.status).toBe('completed');
    expect(ccRunFromCard('tu-1', agentCard({ status: 'failed' }))!.run.status).toBe('failed');
  });

  it('reports no clock instead of a zero start time', () => {
    const none = ccRunFromCard('tu-1', agentCard())!;
    expect(none.elapsedUnknown).toBe(true);
    expect(none.run.endedAt).toBeUndefined();

    const timed = ccRunFromCard('tu-1', agentCard({
      subagentSegments: [seg({ id: 'a', timestamp: 1_000 }), seg({ id: 'b', timestamp: 5_000 })],
    }))!;
    expect(timed.elapsedUnknown).toBe(false);
    expect(timed.run.startedAt).toBe(1_000);
    expect(timed.run.steps).toBe(2);
    // Still running → no end time; the line ticks against the clock.
    expect(timed.run.endedAt).toBeUndefined();
  });

  it('gives a finished helper a fixed end time', () => {
    const done = ccRunFromCard('tu-1', agentCard({
      status: 'complete',
      subagentSegments: [seg({ id: 'a', timestamp: 1_000 }), seg({ id: 'b', timestamp: 61_000 })],
    }))!;
    // Without this, RunStatusLine measures against Date.now() and "Finished in"
    // grows every re-render.
    expect(done.run.endedAt).toBe(61_000);
  });

  it('keys on the log-file agent id once bound, else the card', () => {
    expect(ccRunFromCard('tu-1', agentCard())!.run.childId).toBe('tu-1');
    expect(ccRunFromCard('tu-1', agentCard({ agentId: 'ag-9' }))!.run.childId).toBe('ag-9');
  });
});

describe('RunStatusLine without a clock', () => {
  const run = (over: Partial<SpecialistRunView> = {}): SpecialistRunView => ({
    childId: 'c', parentToolCallId: 'p', agentType: 'Explore', title: 'x',
    background: false, status: 'running', startedAt: 0, ...over,
  });

  it('omits the elapsed figure rather than inventing one', () => {
    render(<RunStatusLine run={run()} elapsedUnknown />);
    expect(screen.getByTestId('specialist-status-line').textContent).toBe('Working');
    cleanup();
    render(<RunStatusLine run={run({ status: 'completed', steps: 3 })} elapsedUnknown />);
    expect(screen.getByTestId('specialist-status-line').textContent).toBe('Finished · 3 steps');
    cleanup();
    render(<RunStatusLine run={run({ status: 'failed' })} elapsedUnknown />);
    expect(screen.getByTestId('specialist-status-line').textContent).toBe('Failed');
  });

  it('still states elapsed when there IS a clock', () => {
    render(<RunStatusLine run={run({ status: 'completed', startedAt: 0, endedAt: 61_000, steps: 2 })} />);
    expect(screen.getByTestId('specialist-status-line').textContent).toBe('Finished in 1m 1s · 2 steps');
  });
});

/** Seeds a session by dispatching real reducer actions, then renders the chip. */
function Harness({ actions }: { actions: ChatAction[] }) {
  const dispatch = useChatDispatch();
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => { actions.forEach(dispatch); setReady(true); }, []);
  return ready ? <SpecialistsChip sessionId="s1" /> : null;
}

function renderChip(actions: ChatAction[]) {
  // SESSION_INIT first: every transcript action bails when the session is not
  // in the map yet, exactly as it does in the app.
  const init: ChatAction = { type: 'SESSION_INIT', sessionId: 's1' };
  return render(<ChatProvider><Harness actions={[init, ...actions]} /></ChatProvider>);
}

const toolUse = (toolUseId: string, toolName: string, toolInput: Record<string, unknown>): ChatAction => ({
  type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: 's1', uuid: `u-${toolUseId}`, toolUseId, toolName, toolInput,
});

/** The chip's words, without the leading braille spinner frame the icon draws. */
function chipLabel(): string {
  return screen.getByTestId('specialists-chip').textContent!.replace(/^[\u2800-\u28ff]+/, '');
}

describe('the chip in a Claude Code session', () => {
  it('counts started subagents and says "subagents"', () => {
    renderChip([
      toolUse('a1', 'Agent', { description: 'Sweep the rules', subagent_type: 'Explore' }),
      toolUse('a2', 'Agent', { description: 'Draft the plan', subagent_type: 'Plan' }),
    ]);
    expect(chipLabel()).toBe('2 subagents');
  });

  it('says the singular for one', () => {
    renderChip([toolUse('a1', 'Agent', { description: 'Sweep', subagent_type: 'Explore' })]);
    expect(chipLabel()).toBe('1 subagent');
  });

  it('draws nothing when the session has no subagents', () => {
    renderChip([toolUse('b1', 'Bash', { command: 'ls' })]);
    expect(screen.queryByTestId('specialists-chip')).toBeNull();
  });

  it('still says "specialists" for the app’s own hires', () => {
    // The other half of the wording rule: the noun follows the ENGINE that
    // hired the helper, so this must not have been changed globally.
    renderChip([
      toolUse('t1', 'Task', { description: 'Sweep', agent: 'explorer' }),
      {
        type: 'SPECIALIST_RUN_CHANGED', sessionId: 's1',
        run: {
          childId: 'c1', parentToolCallId: 't1', agentType: 'explorer',
          title: 'Nadia the Rambling Researcher', background: false,
          status: 'running', startedAt: Date.now(),
        },
      },
    ]);
    expect(chipLabel()).toBe('1 specialist');
  });

  it('never turns amber for a Claude Code session', () => {
    // A CC subagent's permission prompt arrives with no parent attached, so it
    // becomes a TOP-LEVEL card — it must not be read as this helper's ask.
    renderChip([
      toolUse('a1', 'Agent', { description: 'Sweep', subagent_type: 'Explore' }),
      { type: 'PERMISSION_REQUEST', sessionId: 's1', toolName: 'Bash', input: { command: 'rm x' }, requestId: 'r-1' },
    ]);
    expect(chipLabel()).not.toContain('needs you');
    expect(chipLabel()).toBe('1 subagent');
  });
});

// ── 2026-10-22 audit A1 / B4 / B6 ────────────────────────────────────────────
// The chip must read the work's REAL state (ccBackground / the run record), and a
// failure must never be summarised as "N finished" with a check.
describe('ccRunFromCard reads the background record (A1)', () => {
  const launched = (bg: NonNullable<ToolCallState['ccBackground']>) => agentCard({ status: 'complete', ccBackground: bg });
  it('a helper whose launch receipt landed is still WORKING until its notice', () => {
    const out = ccRunFromCard('tu-1', launched({ taskId: 'a1', status: 'running' }))!;
    expect(out.run.status).toBe('running');
    // …and a working helper has no end time, so its clock keeps ticking.
    expect(out.run.endedAt).toBeUndefined();
  });
  it('failed / stopped / completed map onto the run statuses the popup knows', () => {
    expect(ccRunFromCard('tu-1', launched({ taskId: 'a1', status: 'failed' }))!.run.status).toBe('failed');
    expect(ccRunFromCard('tu-1', launched({ taskId: 'a1', status: 'stopped' }))!.run.status).toBe('interrupted');
    expect(ccRunFromCard('tu-1', launched({ taskId: 'a1', status: 'completed' }))!.run.status).toBe('completed');
  });
});

describe('the chip tells failures from finishes (B4) and tracks ccBackground (A1)', () => {
  const launchAgent = (id = 'a1'): ChatAction[] => [
    toolUse(id, 'Agent', { description: `Job ${id}`, subagent_type: 'Explore' }),
    { type: 'TRANSCRIPT_TOOL_RESULT', sessionId: 's1', uuid: `r-${id}`, toolUseId: id, result: 'Async agent launched', isError: false, backgroundTaskId: `task-${id}` } as ChatAction,
  ];
  const end = (id: string, status: 'completed' | 'failed' | 'stopped'): ChatAction =>
    ({ type: 'TRANSCRIPT_BACKGROUND_TASK', sessionId: 's1', uuid: `n-${id}`, toolUseId: id, taskIds: [`task-${id}`], status } as ChatAction);

  it('a helper still working after its launch receipt reads as working', () => {
    renderChip(launchAgent());
    expect(chipLabel()).toBe('1 subagent');
  });
  it('a failed helper says failed, with no check', () => {
    renderChip([...launchAgent(), end('a1', 'failed')]);
    expect(chipLabel()).toBe('1 failed');
  });
  it('a stopped helper says stopped', () => {
    renderChip([...launchAgent(), end('a1', 'stopped')]);
    expect(chipLabel()).toBe('1 stopped');
  });
  it('a clean finish still says finished', () => {
    renderChip([...launchAgent(), end('a1', 'completed')]);
    expect(chipLabel()).toBe('1 finished');
  });
  it('mixed outcomes list each, failures first', () => {
    renderChip([...launchAgent('a1'), ...launchAgent('a2'), end('a1', 'completed'), end('a2', 'failed')]);
    expect(chipLabel()).toBe('1 failed · 1 finished');
  });
  it('redraws when the notice lands AFTER the chip first rendered', () => {
    let dispatch!: (a: ChatAction) => void;
    function Grab() { dispatch = useChatDispatch(); return null; }
    render(<ChatProvider><Grab /><Harness actions={[{ type: 'SESSION_INIT', sessionId: 's1' }, ...launchAgent()]} /></ChatProvider>);
    expect(chipLabel()).toBe('1 subagent');
    React.act(() => dispatch(end('a1', 'failed')));
    expect(chipLabel()).toBe('1 failed');
  });
  it('a failed native specialist says failed too', () => {
    renderChip([
      toolUse('t1', 'Task', { description: 'Sweep', agent: 'explorer' }),
      { type: 'SPECIALIST_RUN_CHANGED', sessionId: 's1', run: { childId: 'c1', parentToolCallId: 't1', agentType: 'explorer', title: 'Nadia', background: false, status: 'failed', startedAt: 1, endedAt: 2 } },
    ]);
    expect(chipLabel()).toBe('1 failed');
  });
  it('counts a run whose card is not loaded yet (B6)', () => {
    renderChip([
      { type: 'SPECIALIST_RUN_CHANGED', sessionId: 's1', run: { childId: 'c9', parentToolCallId: 'unloaded', agentType: 'explorer', title: 'Nadia', background: true, status: 'running', startedAt: 1 } },
    ]);
    expect(chipLabel()).toBe('1 specialist');
  });
});

// ── A4 (2026-10-22): a Claude Code subagent's permission ask names its helper ──
// Claude Code stamps `agent_id` on a hook payload ONLY when the hook fires inside a subagent
// (its own schema: "Present only when the hook fires from within a subagent… Absent for the main
// thread"), and that id is the helper's task id — the Agent card's agentId / receipt id.
describe('a Claude Code subagent’s ask (agent_id on the hook payload)', () => {
  const hook = (payload: Record<string, unknown>) => hookEventToAction({
    type: 'PermissionRequest', sessionId: 's1', timestamp: 1,
    payload: { tool_name: 'Bash', tool_input: { command: 'rm x' }, _requestId: 'r-1', ...payload },
  })!;
  const launched: ChatAction[] = [
    toolUse('a1', 'Agent', { description: 'Sweep the rules', subagent_type: 'Explore' }),
    { type: 'TRANSCRIPT_TOOL_RESULT', sessionId: 's1', uuid: 'r-a1', toolUseId: 'a1', result: 'launched', isError: false, backgroundTaskId: 'ag-7' } as ChatAction,
  ];
  it('the dispatcher carries the helper id (and ignores a main-thread ask)', () => {
    expect(hook({ agent_id: 'ag-7', agent_type: 'Explore' })).toMatchObject({ specialist: { childId: 'ag-7', agentType: 'Explore' } });
    expect((hook({}) as any).specialist).toBeUndefined();
  });
  it('turns the chip amber and lists the ask on that helper', () => {
    renderChip([...launched, hook({ agent_id: 'ag-7', agent_type: 'Explore' })]);
    expect(chipLabel()).toBe('1 needs you');
  });
  it('an ask from an unknown agent id stays a plain top-level ask (the chip does not guess)', () => {
    renderChip([...launched, hook({ agent_id: 'someone-else' })]);
    expect(chipLabel()).toBe('1 subagent');
  });
});
