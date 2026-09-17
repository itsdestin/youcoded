import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionBroker, ASK_REANNOUNCE_MS } from '../src/main/harness/permission-broker';

// The emitted payload uses CC's snake_case field names because hook-dispatcher
// reads payload._requestId / tool_name / tool_input (verified in Task 8 Step 1).
describe('PermissionBroker', () => {
  it('emits a hook-shaped request and resolves on respond()', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: { command: 'npm test' }, denyListed: false });
    expect(emitted[0].type).toBe('PermissionRequest');
    expect(emitted[0].sessionId).toBe('s1');
    expect(emitted[0].payload.tool_name).toBe('Bash');
    const requestId = emitted[0].payload._requestId as string;
    expect(requestId).toMatch(/^native-/); // MUST NOT collide with CC hook ids
    expect(broker.respond(requestId, { behavior: 'allow' })).toBe(true);
    await expect(p).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('unwraps the real ToolCard decision shape and flags Always-allow', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: true });
    const requestId = emitted[0].payload._requestId as string;
    // ToolCard sends { decision: { behavior }, updatedPermissions? }.
    expect(broker.respond(requestId, { decision: { behavior: 'allow' }, updatedPermissions: ['Bash(npm test)'] })).toBe(true);
    await expect(p).resolves.toMatchObject({ behavior: 'allow', always: true });
  });

  it('rides permissionMode along the PermissionRequest payload (full-auto safety stop keys on it)', () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    void broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: { command: 'git push' }, denyListed: true, permissionMode: 'full-auto' });
    expect(emitted[0].payload.permissionMode).toBe('full-auto');
  });

  it('omits permissionMode when the caller did not supply one (CC-path payload shape unchanged)', () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    void broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: false });
    expect('permissionMode' in emitted[0].payload).toBe(false);
  });

  it('does NOT flag always when behavior is deny (guards against persisting an allow rule for a denied tool)', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: false });
    const requestId = emitted[0].payload._requestId as string;
    expect(broker.respond(requestId, { decision: { behavior: 'deny' }, updatedPermissions: ['Bash(rm)'] })).toBe(true);
    const d = await p;
    expect(d.behavior).toBe('deny');
    expect(d.always).toBeFalsy();
  });

  it('stamps `dismissed` on a human deny — and ONLY on a deny', async () => {
    // respond() is the only path a person's answer travels, so it is the only
    // place that can honestly say "a human said no". The driver ends the turn on
    // a dismissed AskUserQuestion; a POLICY askUser (childAskPolicy, the harness
    // evaluator's jail) constructs its own decision, never sets this, and keeps
    // the old carry-on semantics. Guard: harness-session-loop's POLICY-deny test.
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));

    // Filter to PermissionRequest — fix pass (Task 9 review): respond() now also
    // emits a PermissionResolved per answer, so raw array indices no longer line
    // up with "the Nth ask()".
    const requests = () => emitted.filter((e) => e.type === 'PermissionRequest');

    const denied = broker.ask({ sessionId: 's1', toolName: 'AskUserQuestion', toolInput: {}, denyListed: false });
    expect(broker.respond(requests()[0].payload._requestId as string, { decision: { behavior: 'deny' } })).toBe(true);
    expect((await denied).dismissed).toBe(true);

    const allowed = broker.ask({ sessionId: 's1', toolName: 'AskUserQuestion', toolInput: {}, denyListed: false });
    expect(broker.respond(requests()[1].payload._requestId as string, { decision: { behavior: 'allow' } })).toBe(true);
    expect((await allowed).dismissed).toBeFalsy();
  });

  it('a canceled ask carries no `dismissed` (an interrupt is not a dismissal)', async () => {
    // cancelSession resolves pending asks as 'canceled'; the driver unwinds that
    // as an interrupt. It must not look like the user closed the card.
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's1', toolName: 'AskUserQuestion', toolInput: {}, denyListed: false });
    broker.cancelSession('s1');
    const d = await p;
    expect(d.behavior).toBe('canceled');
    expect(d.dismissed).toBeFalsy();
  });

  it('passes decision.updatedInput through to the resolver (AskUserQuestion answers)', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's1', toolName: 'AskUserQuestion', toolInput: { questions: [] }, denyListed: false });
    const requestId = emitted[0].payload._requestId as string;
    broker.respond(requestId, { decision: { behavior: 'allow', updatedInput: { questions: [], answers: { 'Q?': 'Blue' } } } });
    const d = await p;
    expect(d.behavior).toBe('allow');
    expect(d.updatedInput).toEqual({ questions: [], answers: { 'Q?': 'Blue' } });
    expect(d.always).toBe(false); // updatedInput must NOT be mistaken for updatedPermissions/always
  });

  it('respond() returns false for unknown ids (lets ipc-handlers fall through to hookRelay)', () => {
    expect(new PermissionBroker().respond('hook-123', { behavior: 'allow' })).toBe(false);
  });

  it('cancelAll() resolves every pending ask across sessions as canceled and expires each card', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p1 = broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: false });
    const p2 = broker.ask({ sessionId: 's2', toolName: 'Edit', toolInput: {}, denyListed: false });
    broker.cancelAll();
    await expect(p1).resolves.toMatchObject({ behavior: 'canceled' });
    await expect(p2).resolves.toMatchObject({ behavior: 'canceled' });
    const expired = emitted.filter((e) => e.type === 'PermissionExpired');
    expect(expired.map((e) => e.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('cancel() resolves pending asks as canceled and emits PermissionExpired', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's1', toolName: 'Edit', toolInput: {}, denyListed: false });
    broker.cancelSession('s1');
    await expect(p).resolves.toMatchObject({ behavior: 'canceled' });
    expect(emitted.some((e) => e.type === 'PermissionExpired')).toBe(true); // clears the card
  });

  // --- Task 8: raisedBy cancellation (a routed specialist ask) ---
  // Since 2026-09-16 there is no timeout, "held" state or late-answer route:
  // an entry is pending until answered or canceled, and nothing else.

  // A helper waiting on the person must not read as "may be stuck" (the host's
  // staleness check and the Task list text both ask this question).
  it('isWaitingOnUser is true only while the child has an open routed ask', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    expect(broker.isWaitingOnUser('child-1')).toBe(false);
    const p = broker.ask({ sessionId: 'parent-1', toolName: 'Bash', toolInput: {}, denyListed: true, raisedBy: 'child-1' });
    expect(broker.isWaitingOnUser('child-1')).toBe(true);
    expect(broker.isWaitingOnUser('child-2')).toBe(false);
    expect(broker.isWaitingOnUser('parent-1')).toBe(false);
    broker.respond(emitted[0].payload._requestId as string, { behavior: 'allow' });
    await p;
    expect(broker.isWaitingOnUser('child-1')).toBe(false);
  });

  // Stop leaves background helpers running; their waiting asks must survive it.
  it('cancelSession(parent, ownOnly) keeps routed asks; the child\'s own id still cancels them', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    let childDone = false;
    const child = broker.ask({ sessionId: 'parent-1', toolName: 'Bash', toolInput: {}, denyListed: true, raisedBy: 'child-1' });
    void child.then(() => { childDone = true; });
    const own = broker.ask({ sessionId: 'parent-1', toolName: 'Write', toolInput: {}, denyListed: false });
    broker.cancelSession('parent-1', { ownOnly: true });
    await expect(own).resolves.toMatchObject({ behavior: 'canceled' });
    await Promise.resolve();
    expect(childDone).toBe(false);
    expect(broker.isWaitingOnUser('child-1')).toBe(true);
    broker.cancelSession('child-1', { ownOnly: true }); // a foreground child's interrupt
    await expect(child).resolves.toMatchObject({ behavior: 'canceled' });
  });

  it('cancelSession(childId) cancels a routed ask (raisedBy match)', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 'parent-1', toolName: 'Bash', toolInput: {}, denyListed: true, raisedBy: 'child-1' });
    broker.cancelSession('child-1'); // the CHILD's id, not the parent's — this is the routed-ask case
    await expect(p).resolves.toMatchObject({ behavior: 'canceled' });
    expect(emitted.some((e) => e.type === 'PermissionExpired')).toBe(true);
  });

  it("cancelSession(parentId) cancels a routed ask too — the parent's own teardown always wins", async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 'parent-1', toolName: 'Bash', toolInput: {}, denyListed: true, raisedBy: 'child-1' });
    broker.cancelSession('parent-1');
    await expect(p).resolves.toMatchObject({ behavior: 'canceled' });
    const requestId = emitted[0].payload._requestId as string;
    expect(broker.respond(requestId, { behavior: 'allow' })).toBe(false); // gone — parent teardown removed it
  });

  it('cancelSession() of an unrelated session leaves a routed ask open', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 'parent-1', toolName: 'Bash', toolInput: {}, denyListed: true, raisedBy: 'child-1' });
    broker.cancelSession('someone-else');
    const requestId = emitted[0].payload._requestId as string;
    expect(broker.respond(requestId, { behavior: 'allow' })).toBe(true);
    await expect(p).resolves.toMatchObject({ behavior: 'allow' });
  });
});

describe('PermissionBroker — grantScope', () => {
  /** ask() + the id it emitted, so each case reads as one call. */
  const askOnce = (broker: PermissionBroker) => {
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's', toolName: 'Bash', toolInput: { command: 'npm run build' }, denyListed: false });
    return { p, id: emitted[0].payload._requestId as string };
  };

  it('passes a valid selector through', async () => {
    const broker = new PermissionBroker();
    const { p, id } = askOnce(broker);
    broker.respond(id, { decision: { behavior: 'allow' }, updatedPermissions: ['x'], grantScope: 'wide' });
    await expect(p).resolves.toMatchObject({ behavior: 'allow', always: true, grantScope: 'wide' });
  });

  it('fails NARROW on anything that is not the literal "wide"', async () => {
    // This value is persisted, so it is validated here AND re-derived at the
    // session. A renderer that could widen its own grant by sending junk would
    // be writing the top precedence layer.
    for (const bad of [undefined, 'WIDE', 'tool-wide', 42, { scope: 'wide' }, null]) {
      const broker = new PermissionBroker();
      const { p, id } = askOnce(broker);
      broker.respond(id, { decision: { behavior: 'allow' }, updatedPermissions: ['x'], grantScope: bad });
      await expect(p).resolves.toMatchObject({ grantScope: 'exact' });
    }
  });
});

// 2026-08-16 stuck-session investigation. A root ask has NO timeout — the turn
// awaits it forever — so any delivery failure (a card the renderer never
// rendered, one a later event overwrote, one lost to a transcript replay) is a
// permanently hung turn with no error and no way to tell it from a slow model.
// The heartbeat makes every such failure self-correcting: main keeps saying
// "this ask is still open" until someone answers it. The renderer side is
// idempotent-on-repeat (chat-reducer.test.ts → "re-delivered by the heartbeat").
describe('PermissionBroker — pending-ask heartbeat', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function emitterFor(broker: PermissionBroker) {
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    return emitted;
  }

  it('re-announces a still-pending ask, identical except the timestamp', async () => {
    const broker = new PermissionBroker();
    const emitted = emitterFor(broker);
    const p = broker.ask({ sessionId: 's1', toolName: 'Read', toolInput: { file_path: '/x' }, denyListed: false, external: true });
    expect(emitted).toHaveLength(1);

    vi.advanceTimersByTime(ASK_REANNOUNCE_MS);
    expect(emitted).toHaveLength(2);
    // Byte-identical payload — same _requestId is what lets the renderer treat
    // a healthy repeat as a no-op instead of a second card.
    expect(emitted[1].type).toBe('PermissionRequest');
    expect(emitted[1].payload).toEqual(emitted[0].payload);
    expect(emitted[1].sessionId).toBe(emitted[0].sessionId);

    broker.respond(emitted[0].payload._requestId, { behavior: 'allow' });
    await expect(p).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('keeps re-announcing until answered, then stops', async () => {
    const broker = new PermissionBroker();
    const emitted = emitterFor(broker);
    const p = broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: false });
    vi.advanceTimersByTime(ASK_REANNOUNCE_MS * 3);
    expect(emitted).toHaveLength(4); // original + 3

    broker.respond(emitted[0].payload._requestId, { behavior: 'allow' });
    await expect(p).resolves.toMatchObject({ behavior: 'allow' });
    const settled = emitted.length;
    vi.advanceTimersByTime(ASK_REANNOUNCE_MS * 5);
    expect(emitted).toHaveLength(settled);
  });

  it('stops on cancel (interrupt / session teardown)', async () => {
    const broker = new PermissionBroker();
    const emitted = emitterFor(broker);
    const p = broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: false });
    broker.cancelSession('s1');
    await expect(p).resolves.toMatchObject({ behavior: 'canceled' });
    const settled = emitted.length;
    vi.advanceTimersByTime(ASK_REANNOUNCE_MS * 5);
    expect(emitted).toHaveLength(settled);
  });

  it('re-announces every open ask, across sessions', () => {
    const broker = new PermissionBroker();
    const emitted = emitterFor(broker);
    void broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: false });
    void broker.ask({ sessionId: 's2', toolName: 'Read', toolInput: {}, denyListed: false });
    emitted.length = 0;
    vi.advanceTimersByTime(ASK_REANNOUNCE_MS);
    expect(emitted.map((e) => e.sessionId).sort()).toEqual(['s1', 's2']);
  });

});

// Task 0 (2026-08-16 ROADMAP #permissions): TRANSCRIPT_REPLAY rebuilds cards
// from the on-disk JSONL, but an open ask lives only in `pending` — nothing
// re-sent the PermissionRequest, so a reloaded window's card came back with
// no buttons and the turn hung forever (a root ask has no timeout). This is
// the SAME idempotent-repeat mechanism the heartbeat above already proved
// safe, just triggered by a replay instead of a timer.
describe('PermissionBroker — pendingEventsFor', () => {
  // Local — the heartbeat describe block above scopes its own `emitterFor` to
  // itself; this block needs the identical "record every hook-event" helper.
  function emitterFor(broker: PermissionBroker) {
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    return emitted;
  }

  it('re-emits every open ask for the session with the original requestId and payload', () => {
    const broker = new PermissionBroker();
    const emitted = emitterFor(broker);
    void broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: { command: 'npm test' }, denyListed: false });
    void broker.ask({ sessionId: 's1', toolName: 'Write', toolInput: { file_path: 'a.txt' }, denyListed: true });
    void broker.ask({ sessionId: 's2', toolName: 'Read', toolInput: { file_path: 'b.txt' }, denyListed: false });
    expect(emitted).toHaveLength(3);

    const events = broker.pendingEventsFor('s1');
    expect(events).toHaveLength(2); // s2's ask must not leak in
    const ids = events.map((e) => e.payload._requestId).sort();
    const expectedIds = [emitted[0].payload._requestId, emitted[1].payload._requestId].sort();
    expect(ids).toEqual(expectedIds);
    for (const e of events) {
      expect(e.type).toBe('PermissionRequest');
      expect(e.sessionId).toBe('s1');
      const original = emitted.find((o) => o.payload._requestId === e.payload._requestId)!;
      expect(e.payload).toEqual(original.payload); // byte-identical payload shape
    }
  });

  it('returns an empty array for a session with no open asks', () => {
    const broker = new PermissionBroker();
    expect(broker.pendingEventsFor('nobody')).toEqual([]);
  });
});

// Fix pass (2026-08-16 review, "the catch-up replays asks that were already
// answered"): every route that removes an entry from `pending` must emit a
// signal RemoteServer can use to purge that request's buffered
// PermissionRequest — otherwise a reconnecting phone is
// replayed a dead question with live-looking buttons. `PermissionResolved`
// is that signal; these tests pin it at EVERY removal route enumerated in
// permission-broker.ts (every route goes through removeEntry: respond() and
// cancelOne()).
describe('PermissionBroker — PermissionResolved (fix pass)', () => {
  function emitterFor(broker: PermissionBroker) {
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    return emitted;
  }

  it('an in-time respond() emits PermissionResolved with the requestId, after the PermissionRequest', async () => {
    const broker = new PermissionBroker();
    const emitted = emitterFor(broker);
    const p = broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: false });
    const requestId = emitted[0].payload._requestId as string;
    broker.respond(requestId, { behavior: 'allow' });
    await p;
    const resolved = emitted.filter((e) => e.type === 'PermissionResolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].sessionId).toBe('s1');
    expect(resolved[0].payload).toEqual({ _requestId: requestId });
  });

  it('cancelSession() emits PermissionResolved for the canceled ask (in addition to PermissionExpired)', async () => {
    const broker = new PermissionBroker();
    const emitted = emitterFor(broker);
    const p = broker.ask({ sessionId: 's1', toolName: 'Edit', toolInput: {}, denyListed: false });
    const requestId = emitted[0].payload._requestId as string;
    broker.cancelSession('s1');
    await p;
    const resolved = emitted.filter((e) => e.type === 'PermissionResolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].payload).toEqual({ _requestId: requestId });
    // Order matters for RemoteServer's buffer purge: PermissionResolved must
    // land BEFORE PermissionExpired, or purging-by-requestId would also
    // scrub the terminal Expired event this same cancel just buffered.
    const types = emitted.map((e) => e.type);
    expect(types.indexOf('PermissionResolved')).toBeLessThan(types.indexOf('PermissionExpired'));
  });

  it('cancelAll() emits PermissionResolved for every canceled ask across sessions', async () => {
    const broker = new PermissionBroker();
    const emitted = emitterFor(broker);
    const p1 = broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: false });
    const p2 = broker.ask({ sessionId: 's2', toolName: 'Edit', toolInput: {}, denyListed: false });
    broker.cancelAll();
    await Promise.all([p1, p2]);
    const resolved = emitted.filter((e) => e.type === 'PermissionResolved');
    expect(resolved.map((e) => e.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('does NOT emit PermissionResolved for an unknown id (nothing was actually removed)', () => {
    const broker = new PermissionBroker();
    const emitted = emitterFor(broker);
    expect(broker.respond('hook-unknown', { behavior: 'allow' })).toBe(false);
    expect(emitted.some((e) => e.type === 'PermissionResolved')).toBe(false);
  });
});
