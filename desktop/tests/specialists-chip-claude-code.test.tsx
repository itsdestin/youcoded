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
 *  5. CC helpers never reach 'needs-you': Claude Code does not say which
 *     subagent raised a permission prompt, so the amber state stays native-only
 *     rather than pinning an ask on a guessed helper.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { ccRunFromCard } from '../src/renderer/hooks/useSpecialists';
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
  type: 'TRANSCRIPT_TOOL_USE', sessionId: 's1', uuid: `u-${toolUseId}`, toolUseId, toolName, toolInput,
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
