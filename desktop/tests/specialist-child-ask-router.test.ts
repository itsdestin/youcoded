// Child ask routing (plan 1b, Task 8). Replaces child-ask-policy.ts's
// deny-everything stub: a child's ask now rides the SAME broker a root
// session's ask does, re-registered under the PARENT's sessionId so the
// existing permission card renders it (with the specialist labelled) — the
// child has no window of its own to raise a card under.
//
// Scope of THIS file: the router + broker contract only (no HarnessSession,
// no NativeSessionHost). Since 2026-09-16 a routed ask waits for the person
// with no time limit, exactly like a root session's own ask — pinned below.
import { describe, it, expect, vi } from 'vitest';
import { childAskRouter, BUDGET_ASK_TOOL_NAMES } from '../src/main/harness/specialists/child-ask-router';
import { PermissionBroker } from '../src/main/harness/permission-broker';

function firstPayload(emitted: any[]) {
  return emitted[0].payload;
}

describe('childAskRouter', () => {
  it('treats doom_loop, but not max_steps, as a non-rememberable budget ask', () => {
    expect(BUDGET_ASK_TOOL_NAMES).toContain('doom_loop');
    expect(BUDGET_ASK_TOOL_NAMES).not.toContain('max_steps');
  });

  it('carries the parent Full Auto mode on specialist safety stops', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const router = childAskRouter({
      broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'W',
      parentToolCallId: 'tc-1', permissionMode: () => 'full-auto',
    });
    const pending = router({ sessionId: 'child-1', toolName: 'Bash', toolInput: { command: 'git push origin main' }, denyListed: true });
    expect(firstPayload(emitted).permissionMode).toBe('full-auto');
    broker.respond(firstPayload(emitted)._requestId, { behavior: 'deny' });
    await pending;
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

  // PINNING TEST (2026-09-16 decision): a helper's ask used to be answered
  // FOR it after five minutes ("still pending, carry on without it"). It must
  // now wait for the person exactly like the main assistant's own ask — no
  // timeout options reach the broker, and the router's promise stays open
  // far past the old deadline until a real answer arrives.
  it('a routed ask stays pending long past the old 5-minute mark and resolves only when answered', async () => {
    vi.useFakeTimers();
    try {
      const broker = new PermissionBroker();
      const askSpy = vi.spyOn(broker, 'ask');
      const emitted: any[] = [];
      broker.on('hook-event', (e) => emitted.push(e));
      const router = childAskRouter({
        broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'W',
        parentToolCallId: 'tc-1',
      });
      let settled = false;
      const p = router({ sessionId: 'child-1', toolName: 'Bash', toolInput: {}, denyListed: true })
        .then((d) => { settled = true; return d; });
      // Exactly one argument: no { timeoutMs, onTimeout } options object.
      expect(askSpy).toHaveBeenCalledTimes(1);
      expect(askSpy.mock.calls[0]).toHaveLength(1);
      // An hour of simulated time — twelve times the old hold.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(settled).toBe(false);
      // Nothing but the original ask and its heartbeats went out — no
      // expiry, no resolution.
      expect(new Set(emitted.map((e) => e.type))).toEqual(new Set(['PermissionRequest']));
      const requestId = firstPayload(emitted)._requestId as string;
      expect(broker.respond(requestId, { behavior: 'allow' })).toBe(true);
      await expect(p).resolves.toMatchObject({ behavior: 'allow' });
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a real user deny carries no message — the plain declined copy stands', async () => {
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

    it('a removal the floor always asks about reaches the person, and an "always" answer stores nothing', async () => {
      const broker = new PermissionBroker();
      const emitted: any[] = [];
      broker.on('hook-event', (e) => emitted.push(e));
      const remember = vi.fn();
      const router = childAskRouter({
        broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'W', parentToolCallId: 'tc-1', remember,
      });
      const p = router({
        sessionId: 'child-1', toolName: 'Bash', toolInput: { command: 'rm -rf build/../..' },
        denyListed: true, floorStop: 'removal', subject: 'rm -rf build/../..',
      });
      const payload = firstPayload(emitted);
      expect(payload.floorStop).toBe('removal'); // routed to the card, not refused like an external ask
      expect(broker.respond(payload._requestId as string, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Bash' }] })).toBe(true);
      expect((await p).behavior).toBe('allow');
      expect(remember).not.toHaveBeenCalled();
    });

    it('a helper command that names a secret file also reaches the person, not an automatic refusal', async () => {
      const broker = new PermissionBroker();
      const emitted: any[] = [];
      broker.on('hook-event', (e) => emitted.push(e));
      const router = childAskRouter({
        broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'W', parentToolCallId: 'tc-1', remember: vi.fn(),
      });
      void router({
        sessionId: 'child-1', toolName: 'Bash', toolInput: { command: 'cat .env' },
        denyListed: true, floorStop: 'secret-path', subject: 'cat .env',
      });
      expect(firstPayload(emitted).floorStop).toBe('secret-path');
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
