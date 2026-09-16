// Specialists plans, Task 9a — who deals with a pause (pause handoff design
// §1 routing table, §2 allowed actions). One pure function decides; the
// executor uses it at every pause site and Task 9b reuses it for the handoff.
import { describe, it, expect } from 'vitest';
import { routePlanPause, pausedRouting } from '../src/main/harness/plans/pause-routing';
import { nativeToolEffect } from '../src/main/harness/tools';
import { PLAN_PAUSE_KINDS } from '../src/shared/types';

const effect = (tool: string) => ({ toolEffect: nativeToolEffect(tool) });

describe('routing per kind (§1)', () => {
  it.each([
    ['launch-failed', {}],
    ['specialist-error', {}],
    ['invalid-report', { reportOnlyFundable: true }],
    ['unknown-request', {}],
    ['unknown-outcome', { toolEffect: 'read' }],
    ['unknown-outcome', { toolEffect: 'local' }],
  ] as const)('%s %j recovers automatically, once', (kind, ctx) => {
    expect(routePlanPause(kind, ctx)).toEqual({ route: 'auto', actions: [], recoveryCause: kind });
  });

  it('a cut-off Bash call goes to the assistant (Bash reaches outside)', () => {
    expect(routePlanPause('unknown-outcome', effect('Bash'))).toEqual({ route: 'assistant', actions: ['continue', 'stop'] });
  });

  it('a cut-off BashOutput or WebSearch call re-runs by itself; Write/Edit restart with a check', () => {
    for (const tool of ['BashOutput', 'WebSearch', 'Read', 'Write', 'Edit', 'KillShell']) {
      expect(routePlanPause('unknown-outcome', effect(tool)).route, tool).toBe('auto');
    }
  });

  it('an unclassified or MCP tool counts as external, and so does no effect at all', () => {
    for (const tool of ['Frobnicate', 'mcp__mail__send', 'WebFetch', 'AskUserQuestion', 'SendUserFile', 'SendUserLink']) {
      expect(routePlanPause('unknown-outcome', effect(tool)).route, tool).toBe('assistant');
    }
    expect(routePlanPause('unknown-outcome', {}).route).toBe('assistant');
  });

  it('before any automatic restart, an unanswered external call sends it to the assistant', () => {
    for (const kind of ['launch-failed', 'specialist-error', 'invalid-report', 'unknown-request'] as const) {
      expect(routePlanPause(kind, { unansweredExternal: true, reportOnlyFundable: true }), kind)
        .toEqual({ route: 'assistant', actions: ['continue', 'stop'] });
    }
    expect(routePlanPause('unknown-outcome', { toolEffect: 'local', unansweredExternal: true }).route).toBe('assistant');
  });

  it('a second failure after an automatic recovery goes to the assistant', () => {
    for (const kind of ['launch-failed', 'specialist-error', 'invalid-report', 'unknown-request'] as const) {
      expect(routePlanPause(kind, { alreadyRecovered: true, reportOnlyFundable: true }), kind)
        .toEqual({ route: 'assistant', actions: ['continue', 'stop'] });
    }
    expect(routePlanPause('unknown-outcome', { toolEffect: 'read', alreadyRecovered: true }).route).toBe('assistant');
  });

  it('a report-only turn that can not be funded goes to the assistant', () => {
    expect(routePlanPause('invalid-report', { reportOnlyFundable: false }).route).toBe('assistant');
    // Nothing known about funding (no specialist to ask) is not fundable.
    expect(routePlanPause('invalid-report', {}).route).toBe('assistant');
  });

  it('a launch refusal and a drift are never retried, and only Stop is offered', () => {
    expect(routePlanPause('launch-failed', { launchRefused: true })).toEqual({ route: 'assistant', actions: ['stop'] });
    expect(routePlanPause('launch-failed', { drift: true })).toEqual({ route: 'assistant', actions: ['stop'] });
    expect(routePlanPause('specialist-error', { drift: true })).toEqual({ route: 'assistant', actions: ['stop'] });
  });

  it.each([
    ['budget', ['add_budget', 'stop']],
    ['ceiling-shortfall', ['add_budget', 'stop']],
    ['plan-limit', ['stop']],
    ['budget-refused', ['stop']],
    ['iteration-cap', ['stop']],
    ['local-pool', ['stop']],
    ['unexpected-error', ['continue', 'stop']],
  ] as const)('%s goes to the assistant with %j', (kind, actions) => {
    expect(routePlanPause(kind, {})).toEqual({ route: 'assistant', actions });
  });

  it('a user-stopped specialist and an app restart stay with the user', () => {
    expect(routePlanPause('specialist-stopped', {})).toEqual({ route: 'user', actions: ['continue', 'stop'] });
    expect(routePlanPause('interrupted', {})).toEqual({ route: 'user', actions: ['continue', 'stop'] });
  });

  it('every pause kind has a route', () => {
    for (const kind of PLAN_PAUSE_KINDS) expect(['auto', 'assistant', 'user']).toContain(routePlanPause(kind, {}).route);
  });
});

describe('a recorded pause (what 9b reads back)', () => {
  it('is never automatic: a pause that reached the card is the assistant\'s or the user\'s', () => {
    expect(pausedRouting({ kind: 'specialist-error' })).toEqual({ route: 'assistant', actions: ['continue', 'stop'] });
    expect(pausedRouting({ kind: 'invalid-report' }).route).toBe('assistant');
    expect(pausedRouting({})).toEqual({ route: 'assistant', actions: ['continue', 'stop'] });
  });

  it('reads the facts the executor recorded', () => {
    expect(pausedRouting({ kind: 'launch-failed', launch: 'refused' })).toEqual({ route: 'assistant', actions: ['stop'] });
    expect(pausedRouting({ kind: 'launch-failed', launch: 'drift' })).toEqual({ route: 'assistant', actions: ['stop'] });
    expect(pausedRouting({ kind: 'unknown-outcome', tool: 'Bash', toolEffect: 'external' })).toEqual({ route: 'assistant', actions: ['continue', 'stop'] });
    expect(pausedRouting({ kind: 'budget' })).toEqual({ route: 'assistant', actions: ['add_budget', 'stop'] });
    expect(pausedRouting({ kind: 'specialist-stopped' })).toEqual({ route: 'user', actions: ['continue', 'stop'] });
  });
});
