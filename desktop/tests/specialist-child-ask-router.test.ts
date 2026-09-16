// Child ask routing (plan 1b, Task 8). Replaces child-ask-policy.ts's
// deny-everything stub: a child's ask now rides the SAME broker a root
// session's ask does, re-registered under the PARENT's sessionId so the
// existing permission card renders it (with the specialist labelled) — the
// child has no window of its own to raise a card under.
//
// Scope of THIS file: the router + broker contract only (no HarnessSession,
// no NativeSessionHost). The "child still running" vs "child already ended"
// branch of a late answer is HOST state (this.live), not something the
// router or the broker can know — those two cases are pinned instead in
// native-session-host.test.ts, against the real host.
import { describe, it, expect, vi } from 'vitest';
import { childAskRouter, ASK_REDIRECT_MESSAGE, BUDGET_ASK_TOOL_NAMES } from '../src/main/harness/specialists/child-ask-router';
import { PermissionBroker } from '../src/main/harness/permission-broker';
import { SPECIALIST_ASK_HOLD_MS } from '../src/main/harness/specialists/limits';

function firstPayload(emitted: any[]) {
  return emitted[0].payload;
}

describe('childAskRouter', () => {
  it('treats doom_loop, but not max_steps, as a non-rememberable budget ask', () => {
    expect(BUDGET_ASK_TOOL_NAMES).toContain('doom_loop');
    expect(BUDGET_ASK_TOOL_NAMES).not.toContain('max_steps');
  });

  it('a routed ask reaches the broker under the PARENT sessionId with the specialist payload', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const router = childAskRouter({
      broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'Wanda the Worker',
      parentToolCallId: 'tc-1',
    });
    const p = router({ sessionId: 'child-1', toolName: 'Bash', toolInput: { command: 'rm -rf /' }, denyListed: true });
    expect(emitted[0].sessionId).toBe('parent-1');
    expect(firstPayload(emitted).tool_name).toBe('Bash');
    expect(firstPayload(emitted).specialist).toEqual({
      childId: 'child-1', agentType: 'worker', title: 'Wanda the Worker', parentToolCallId: 'tc-1',
    });
    const requestId = firstPayload(emitted)._requestId as string;
    expect(broker.respond(requestId, { behavior: 'allow' })).toBe(true);
    await expect(p).resolves.toMatchObject({ behavior: 'allow' });
  });

  // Task 6 (1c): the renderer nests the routed ask row under the specialist
  // card by matching parentToolCallId — without it the ask would render, but
  // unattached to any card.
  it('the routed ask carries parentToolCallId on specialist', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const router = childAskRouter({
      broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'W',
      parentToolCallId: 'tc-42',
    });
    void router({ sessionId: 'child-1', toolName: 'Bash', toolInput: {}, denyListed: true });
    expect(firstPayload(emitted).specialist.parentToolCallId).toBe('tc-42');
  });

  it('after SPECIALIST_ASK_HOLD_MS the child receives the redirect deny and the entry stays answerable', async () => {
    vi.useFakeTimers();
    try {
      const broker = new PermissionBroker();
      const emitted: any[] = [];
      broker.on('hook-event', (e) => emitted.push(e));
      const router = childAskRouter({
        broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'W',
        parentToolCallId: 'tc-1',
      });
      const p = router({ sessionId: 'child-1', toolName: 'Bash', toolInput: {}, denyListed: true });
      await vi.advanceTimersByTimeAsync(SPECIALIST_ASK_HOLD_MS);
      const d = await p;
      expect(d.behavior).toBe('deny');
      expect(d.message).toBe(ASK_REDIRECT_MESSAGE);
      // Stays answerable: the id is still known to the broker after the timeout fired.
      const requestId = firstPayload(emitted)._requestId as string;
      expect(broker.respond(requestId, { behavior: 'allow' })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the redirect wording contains both load-bearing clauses', () => {
    expect(ASK_REDIRECT_MESSAGE).toMatch(/Do NOT attempt the blocked action by any other means/);
    expect(ASK_REDIRECT_MESSAGE).toMatch(/Do NOT build further work on the assumption/);
  });

  it('a real user deny inside the window carries no redirect — the plain declined copy stands', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const router = childAskRouter({
      broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'W', parentToolCallId: 'tc-1',
    });
    const p = router({ sessionId: 'child-1', toolName: 'Bash', toolInput: {}, denyListed: true });
    const requestId = firstPayload(emitted)._requestId as string;
    broker.respond(requestId, { behavior: 'deny' });
    const d = await p;
    expect(d.behavior).toBe('deny');
    expect(d.message).toBeUndefined(); // harness-session.ts falls back to the plain "user declined" copy
  });

  it('interactive asks still deny instantly with factual copy', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const router = childAskRouter({
      broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'W', parentToolCallId: 'tc-1',
    });
    const d = await router({ sessionId: 'child-1', toolName: 'AskUserQuestion', toolInput: { questions: [] }, denyListed: false });
    expect(d.behavior).toBe('deny');
    expect(d.message).toMatch(/AskUserQuestion/);
    expect(d.message).not.toMatch(/user declined/i); // never blame a user who was never asked
    expect(emitted).toEqual([]); // never reaches the broker/card at all

    const d2 = await router({ sessionId: 'child-1', toolName: 'Read', toolInput: { file_path: '/outside' }, denyListed: false, external: true });
    expect(d2.behavior).toBe('deny');
    expect(d2.message).toMatch(/work directory/i);
    expect(d2.message).not.toMatch(/user declined/i);
    expect(emitted).toEqual([]);
  });

  // Fix (Important 6, final review): the router used to hand-build
  // `{tool, pattern: subject, action:'allow', specialist}` itself instead of
  // calling the shared rememberedRuleFor() builder (harness-session.ts) — the
  // SAME function a root session's own ask uses. Two consequences of that
  // divergence, both pinned here:
  //  1. The grant WIDTH the user picked (grantScope: 'wide') was discarded —
  //     an exact-match rule was stored regardless, so the specialist would
  //     re-ask on the next call the wide grant should have covered, and
  //     Settings would show a row that doesn't say what the user approved.
  //  2. The builder's "never rememberable" cases weren't enforced — a bare
  //     `git push` (whose target isn't in the command and changes underneath
  //     the grant) would get remembered anyway, exactly the hole
  //     rememberedRuleFor's own Bash branch exists to close.
  describe('"Always allow" routes through the shared rememberedRuleFor builder', () => {
    it('a WIDE grant persists the DERIVED wide rule, not the raw exact command', async () => {
      const broker = new PermissionBroker();
      const emitted: any[] = [];
      broker.on('hook-event', (e) => emitted.push(e));
      const remember = vi.fn();
      const router = childAskRouter({
        broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'W', parentToolCallId: 'tc-1', remember,
      });
      const p = router({
        sessionId: 'child-1', toolName: 'Bash', toolInput: { command: 'git push origin feat/x' },
        denyListed: false, subject: 'git push origin feat/x',
      });
      const requestId = firstPayload(emitted)._requestId as string;
      expect(broker.respond(requestId, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Bash' }], grantScope: 'wide' })).toBe(true);
      await p;
      expect(remember).toHaveBeenCalledWith({
        tool: 'Bash', pattern: 'git push*origin feat/x', action: 'allow', match: 'glob', specialist: 'worker',
      });
    });

    it('a command with NO safe grant width is never remembered at all — the router used to remember it anyway', async () => {
      const broker = new PermissionBroker();
      const emitted: any[] = [];
      broker.on('hook-event', (e) => emitted.push(e));
      const remember = vi.fn();
      const router = childAskRouter({
        broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'W', parentToolCallId: 'tc-1', remember,
      });
      // Bare `git push` — its target isn't in the command and changes
      // underneath the grant (same case rememberedRuleFor's own test suite
      // pins for the root-session path).
      const p = router({
        sessionId: 'child-1', toolName: 'Bash', toolInput: { command: 'git push' },
        denyListed: false, subject: 'git push',
      });
      const requestId = firstPayload(emitted)._requestId as string;
      expect(broker.respond(requestId, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Bash' }] })).toBe(true);
      const d = await p;
      expect(d.behavior).toBe('allow'); // the one-time approval still happens
      expect(remember).not.toHaveBeenCalled(); // …but nothing is ever persisted
    });
  });
});
