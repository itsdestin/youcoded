// Plan 2b Task 8 — pins the holder-side takeover sequence (createHolderTakeover).
// When another device requests a session THIS device holds, the holder must:
//   interrupt (ESC to PTY) -> flush local->space -> pushMoved -> destroy -> release
// The ORDER is load-bearing: MIRROR-BEFORE-RELEASE (the requester pulls on seeing
// the release, so the final turn must already be in the space) and
// STOP-BEFORE-RELEASE (no writer survives handoff). All
// collaborators are injected fakes — this tests ONLY the sequence, not the IO.
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { createHolderTakeover } from '../src/main/conversations/takeover';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

// A slow trickling stream so a native turn is genuinely mid-flight when the
// takeover lands — the exact window quiesce() has to close (mirrors the
// delayedFactory in native-session-host.test.ts).
const CHUNKS = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'p1' },
  { type: 'text-delta', id: 'p1', delta: 'Working' },
  { type: 'text-end', id: 'p1' },
  { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } } },
];
function delayedStream(chunks: any[], delayMs: number): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      try {
        for (const c of chunks) { await new Promise((r) => setTimeout(r, delayMs)); controller.enqueue(c); }
        controller.close();
      } catch { /* cancelled mid-emit — expected on abort */ }
    },
  });
}
const delayedFactory = async () => new MockLanguageModelV4({ doStream: async () => ({ stream: delayedStream(CHUNKS, 15) }) }) as any;

// Build a deps bundle whose every fake pushes a label into a shared order log, so
// tests can assert both WHICH steps ran and in WHAT order.
function makeDeps(opts?: { liveDesktopIds?: string[]; flushRejects?: boolean; providers?: Record<string, string> }) {
  const order: string[] = [];
  const live = new Set(opts?.liveDesktopIds ?? []);
  const providers = new Map<string, string>(Object.entries(opts?.providers ?? {}));
  const sessionIdMap = new Map<string, string>();
  const deps = {
    order,
    sessionIdMap,
    // Provider lookup wired in production to sessionManager.getSession(id)?.provider.
    // Drives step 3's branch: native holders quiesce the HarnessSession, CC holders
    // get the ESC byte. Undefined (unmapped) reads as a CC/PTY holder — the default.
    getProvider: (id: string) => providers.get(id),
    // Native quiesce (nativeHost.quiesce) — clears the queue, aborts, and waits the
    // in-flight turn out, so no append lands past the flush. In the fake bundle so
    // its absence can't go green on a native holder that was never quiesced (#177).
    quiesceNative: vi.fn(async (id: string) => { order.push(`quiesce:${id}`); }),
    sessionManager: {
      // A desktop id is "live" only if it's in the live set.
      getSession: (id: string) => (live.has(id) ? { id } : undefined),
      // Provider-aware, mirroring production: a native session has NO PTY, so an ESC
      // byte write is a no-op there (returns false, records nothing). This is what
      // forces step 3 to BRANCH — the old unconditional ESC path certified a no-op
      // for native holders (2026-07-18 #177 trap). CC/undefined holders record the
      // ESC interrupt as before.
      sendInput: vi.fn((id: string, text: string) => {
        if (providers.get(id) === 'native') return false;
        order.push(`interrupt:${id}:${JSON.stringify(text)}`);
        return true;
      }),
      destroySession: vi.fn((id: string) => { order.push(`destroy:${id}`); return true; }),
    },
    leaseClient: {
      release: vi.fn(async (sid: string) => { order.push(`release:${sid}`); }),
    },
    flushSessionToSpace: vi.fn(async (cid: string) => {
      order.push(`flush:${cid}`);
      if (opts?.flushRejects) throw new Error('flush blew up');
    }),
    pushMoved: vi.fn((did: string, device?: string) => { order.push(`push:${did}:${device ?? ''}`); }),
    // Native teardown. In production this is nativeHost.destroy — idempotent and a
    // no-op for non-native ids. It MUST be in the fake bundle: every step in the
    // handler is individually try/caught, so an absent dep throws into a
    // best-effort catch and the suite goes green on a teardown that never ran
    // (the same "the suite certifies the bug" trap that hid the missing native
    // interrupt — 2026-07-18 review).
    destroyNative: vi.fn(async (did: string) => { order.push(`destroyNative:${did}`); }),
    // Welcome back (design 2026-09-24 §2): a takeover means the conversation
    // moved to another device, so it must stop being "open here" — every test
    // that destroys a live holder below checks this ran; the review 1 D1
    // pairing test ("leaves open while a crash-exit id stays") is completed by
    // ipc-handlers.test.ts, which pins the OTHER half (an ordinary
    // destroySession call, outside a takeover, must NOT untrack).
    untrackWelcomeBack: vi.fn((did: string) => { order.push(`untrackWelcomeBack:${did}`); }),
  };
  return deps;
}

describe('createHolderTakeover', () => {
  it('holds a source pin until proven PTY exit and publishes only matching nonce-bound evidence', async () => {
    const d = makeDeps({ liveDesktopIds: ['cc'] }); d.sessionIdMap.set('cc', 'c1');
    let exit!: (result: { status: 'stopped' | 'unknown' }) => void;
    const stop = new Promise<{ status: 'stopped' | 'unknown' }>((resolve) => { exit = resolve; });
    let pinned = true; let ended = false;
    const publish = vi.fn(async (_context, _writer, stopped: () => boolean, current: () => boolean) => {
      expect(stopped()).toBe(true); expect(current()).toBe(true); expect(pinned).toBe(true);
      d.order.push('publish'); return { status: 'published' as const, receipt: {} as any };
    });
    const deps = { ...d, senderDeviceId: 'sender', pinSnapshot: () => ({ active: () => pinned, release: () => { pinned = false; } }),
      captureWriter: () => ({ provider: 'claude' as const, sessionId: 'c1', transcriptPath: '/tmp/c1.jsonl', persisted: () => ended, current: () => true }),
      publishSnapshot: publish, syncPublished: vi.fn(async () => {}),
      sessionManager: { ...d.sessionManager, getSession: (id: string) => ended ? undefined : d.sessionManager.getSession(id),
        stopSessionForHandoff: vi.fn(async () => { const result = await stop; ended = true; return result; }) } };
    const transfer = createHolderTakeover(deps as any)('c1', { deviceId: 'requester', device: 'Other' }, '88e7c065-15db-43d5-8576-00d13b145c8a');
    await vi.waitFor(() => expect(deps.sessionManager.stopSessionForHandoff).toHaveBeenCalled());
    expect(publish).not.toHaveBeenCalled(); expect(d.leaseClient.release).not.toHaveBeenCalled();
    exit({ status: 'stopped' }); await transfer;
    expect(publish).toHaveBeenCalledTimes(1); expect(pinned).toBe(false);
    expect(d.order.indexOf('publish')).toBeLessThan(d.order.indexOf('release:c1'));
  });

  it('treats a failing Personal push as delivery unknown, not as a failed stop', async () => {
    const d = makeDeps({ liveDesktopIds: ['native'], providers: { native: 'native' } }); d.sessionIdMap.set('native', 'c1');
    let stopped = false;
    const sync = vi.fn(async () => { throw new Error('offline'); });
    const publish = vi.fn(async () => ({ status: 'published' as const, receipt: {} as any }));
    await createHolderTakeover({ ...d, senderDeviceId: 'sender',
      pinSnapshot: () => ({ active: () => true, release: vi.fn() }),
      captureWriter: () => ({ provider: 'native', sessionId: 'c1', transcriptPath: '/tmp/c1.jsonl',
        persisted: () => stopped, current: () => true }),
      destroyNative: async () => { stopped = true; },
      sessionManager: { ...d.sessionManager, getSession: () => stopped ? undefined : { id: 'native' } },
      publishSnapshot: publish, syncPublished: sync,
    } as any)('c1', { deviceId: 'requester', device: 'Other' }, '88e7c065-15db-43d5-8576-00d13b145c8a');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(d.leaseClient.release).toHaveBeenCalledWith('c1');
  });

  it('refuses receipt when a mapped writer rotates or a competing writer opens during stop', async () => {
    for (const change of ['rotate', 'competitor']) {
      const d = makeDeps({ liveDesktopIds: ['cc'] }); d.sessionIdMap.set('cc', 'c1');
      let stop!: () => void;
      const held = new Promise<void>((resolve) => { stop = resolve; });
      let rotated = false;
      const publish = vi.fn();
      const deps = { ...d, senderDeviceId: 'sender', pinSnapshot: () => ({ active: () => true, release: vi.fn() }),
        captureWriter: () => ({ provider: 'claude', sessionId: 'c1', transcriptPath: '/tmp/c1.jsonl',
          persisted: () => true, current: () => change === 'competitor' || !rotated }), publishSnapshot: publish,
        sessionManager: { ...d.sessionManager, getSession: (id: string) => {
          if (id === 'cc' && rotated) return undefined;
          if (id === 'new' && change === 'competitor' && rotated) return { id: 'new' };
          return d.sessionManager.getSession(id);
        }, stopSessionForHandoff: async () => { await held; return { status: 'stopped' as const }; } } };
      const task = createHolderTakeover(deps as any)('c1', { deviceId: 'requester', device: 'Other' }, '88e7c065-15db-43d5-8576-00d13b145c8a');
      await vi.waitFor(() => expect(d.pushMoved).toHaveBeenCalled());
      if (change === 'competitor') d.sessionIdMap.set('new', 'c1');
      else d.sessionIdMap.delete('cc');
      rotated = true; stop(); await task;
      expect(publish).not.toHaveBeenCalled();
    }
  });

  it('keeps unsafe authority and emits no receipt for unknown PTY exit', async () => {
    const d = makeDeps({ liveDesktopIds: ['cc'] }); d.sessionIdMap.set('cc', 'c1');
    const protect = vi.fn(); const publish = vi.fn();
    await createHolderTakeover({ ...d, senderDeviceId: 'sender', protectUnsafe: protect,
      pinSnapshot: () => ({ active: () => true, release: vi.fn() }),
      captureWriter: () => ({ provider: 'claude', sessionId: 'c1', transcriptPath: '/tmp/c1.jsonl', persisted: () => false, current: () => true }),
      publishSnapshot: publish,
      sessionManager: { ...d.sessionManager, stopSessionForHandoff: async () => ({ status: 'unknown' as const }) },
    } as any)('c1', { deviceId: 'requester', device: 'Other' }, '88e7c065-15db-43d5-8576-00d13b145c8a');
    expect(protect).toHaveBeenCalledWith('c1'); expect(publish).not.toHaveBeenCalled();
    expect(d.leaseClient.release).not.toHaveBeenCalled();
  });
  it('runs interrupt -> flush -> release -> pushMoved -> destroy for a live held session', async () => {
    const deps = makeDeps({ liveDesktopIds: ['desktop-1'] });
    // desktop-1 holds claude-abc; a stray other mapping must be ignored.
    deps.sessionIdMap.set('desktop-1', 'claude-abc');
    deps.sessionIdMap.set('desktop-2', 'claude-other');
    const handler = createHolderTakeover(deps as any);

    await handler('claude-abc', { deviceId: 'dev-b', device: 'Laptop-B' });

    expect(deps.order).toEqual([
      'interrupt:desktop-1:"\\u001b"', // single ESC byte to the PTY
      'flush:claude-abc',
      'push:desktop-1:Laptop-B',       // desktopId reverse-mapped, from.device forwarded
      'destroyNative:desktop-1',       // native teardown BEFORE destroySession...
      'destroy:desktop-1',             // ...matching the sanctioned SESSION_DESTROY order
      // Welcome back (design §2): untracked right alongside the local destroy,
      // since this device no longer holds the conversation from this point on.
      'untrackWelcomeBack:desktop-1',
      'release:claude-abc',            // after the writer has stopped
    ]);
    // The reverse-map picked the correct desktop id, not desktop-2.
    expect(deps.sessionManager.sendInput).toHaveBeenCalledWith('desktop-1', '\x1b');
    expect(deps.pushMoved).toHaveBeenCalledWith('desktop-1', 'Laptop-B');
  });

  // Design 2026-09-24 §2 (review 1 D1): a takeover-destroyed id must leave
  // `open` — this pins that half; ipc-handlers.test.ts pins the other half (an
  // ordinary destroySession/session-exit, with NO takeover, must NOT untrack).
  it('does not touch Welcome back when there is no live holder to take over', async () => {
    const deps = makeDeps({ liveDesktopIds: [] });
    const handler = createHolderTakeover(deps as any);
    await handler('claude-abc');
    expect(deps.untrackWelcomeBack).not.toHaveBeenCalled();
  });

  // Task 9: a NATIVE holder has no PTY, so the ESC byte is a no-op. Step 3 must
  // BRANCH — quiesce the HarnessSession instead. Without the branch, the old code
  // called sendInput('\x1b') (which the provider-aware fake refuses for native,
  // recording nothing), so nothing quiesced the turn before the flush — the exact
  // #177 no-op the fake now exposes. This test FAILS against the pre-branch code.
  it('quiesces a NATIVE holder (no ESC byte) before the flush, then moves + tears it down', async () => {
    const deps = makeDeps({ liveDesktopIds: ['native-1'], providers: { 'native-1': 'native' } });
    deps.sessionIdMap.set('native-1', 'claude-nat');
    const handler = createHolderTakeover(deps as any);

    await handler('claude-nat', { deviceId: 'dev-b', device: 'Laptop-B' });

    expect(deps.order).toEqual([
      'quiesce:native-1',        // native quiesce replaces the ESC byte
      'flush:claude-nat',        // ...and lands BEFORE the flush (turn already settled)
      'push:native-1:Laptop-B',
      'destroyNative:native-1',
      'destroy:native-1',
      'untrackWelcomeBack:native-1',
      'release:claude-nat',
    ]);
    expect(deps.quiesceNative).toHaveBeenCalledWith('native-1');
    // No ESC byte was written to a PTY-less native session.
    expect(deps.sessionManager.sendInput).not.toHaveBeenCalled();
  });

  it('branches per holder: quiesces the native one, ESCs the CC one, ALL before the single flush', async () => {
    // A native + a CC holder both mapped to one claude id (a create+resume pair
    // across runtimes). Each must be quiesced/interrupted by its OWN mechanism,
    // and every one before the claude-id-keyed flush.
    const deps = makeDeps({ liveDesktopIds: ['nat', 'cc'], providers: { nat: 'native' } });
    deps.sessionIdMap.set('nat', 'c1');
    deps.sessionIdMap.set('cc', 'c1');
    const handler = createHolderTakeover(deps as any);
    await handler('c1', { deviceId: 'x', device: 'X' });

    expect(deps.quiesceNative).toHaveBeenCalledWith('nat');
    expect(deps.sessionManager.sendInput).toHaveBeenCalledWith('cc', '\x1b');
    expect(deps.sessionManager.sendInput).not.toHaveBeenCalledWith('nat', '\x1b');
    const iFlush = deps.order.indexOf('flush:c1');
    expect(deps.order.indexOf('quiesce:nat')).toBeLessThan(iFlush);
    expect(deps.order.indexOf('interrupt:cc:"\\u001b"')).toBeLessThan(iFlush);
  });

  it('still flushes + tears down even when the native quiesce rejects', async () => {
    const deps = makeDeps({ liveDesktopIds: ['native-1'], providers: { 'native-1': 'native' } });
    deps.sessionIdMap.set('native-1', 'claude-nat');
    (deps.quiesceNative as any) = vi.fn(async () => { throw new Error('quiesce blew up'); });
    const handler = createHolderTakeover(deps as any);
    await expect(handler('claude-nat', { deviceId: 'x', device: 'X' })).resolves.toBeUndefined();
    // A live writer cannot hand away authority when quiesce fails.
    expect(deps.flushSessionToSpace).not.toHaveBeenCalled();
    expect(deps.leaseClient.release).not.toHaveBeenCalled();
    expect(deps.sessionManager.destroySession).not.toHaveBeenCalled();
  });

  it('mirror-before-release AND release-before-destroy hold', async () => {
    const deps = makeDeps({ liveDesktopIds: ['d1'] });
    deps.sessionIdMap.set('d1', 'c1');
    const handler = createHolderTakeover(deps as any);
    await handler('c1', { deviceId: 'x', device: 'X' });
    const iFlush = deps.order.indexOf('flush:c1');
    const iRelease = deps.order.indexOf('release:c1');
    const iDestroy = deps.order.indexOf('destroy:d1');
    expect(iFlush).toBeGreaterThanOrEqual(0);
    expect(iRelease).toBeGreaterThan(iFlush);   // MIRROR (flush) before RELEASE
    expect(iRelease).toBeGreaterThan(iDestroy); // stop writer BEFORE RELEASE
  });

  it('with NO mapping for the claude id, only releases the lease (no interrupt/flush/push/destroy)', async () => {
    const deps = makeDeps({ liveDesktopIds: [] }); // empty map
    const handler = createHolderTakeover(deps as any);
    await handler('claude-ghost', { deviceId: 'x', device: 'X' });
    expect(deps.order).toEqual(['release:claude-ghost']);
    expect(deps.sessionManager.sendInput).not.toHaveBeenCalled();
    expect(deps.flushSessionToSpace).not.toHaveBeenCalled();
    expect(deps.pushMoved).not.toHaveBeenCalled();
    expect(deps.sessionManager.destroySession).not.toHaveBeenCalled();
  });

  it('does not mint a receipt from peer bytes on a repeated request without a live writer', async () => {
    const d = makeDeps({ liveDesktopIds: [] });
    const publish = vi.fn();
    await createHolderTakeover({ ...d, senderDeviceId: 'sender', publishSnapshot: publish,
      pinSnapshot: vi.fn(), captureWriter: vi.fn() } as any)('c1',
      { deviceId: 'requester', device: 'Other' }, '88e7c065-15db-43d5-8576-00d13b145c8a');
    expect(publish).not.toHaveBeenCalled();
    expect(d.leaseClient.release).toHaveBeenCalledWith('c1');
  });

  it('with a mapping but the session no longer live (getSession undefined), only releases', async () => {
    // Mapping exists but the desktop id is not in the live set → not actually held.
    const deps = makeDeps({ liveDesktopIds: [] });
    deps.sessionIdMap.set('d-dead', 'claude-dead');
    const handler = createHolderTakeover(deps as any);
    await handler('claude-dead');
    expect(deps.order).toEqual(['release:claude-dead']);
  });

  it('never throws and runs release/push/destroy even when flush rejects', async () => {
    const deps = makeDeps({ liveDesktopIds: ['d1'], flushRejects: true });
    deps.sessionIdMap.set('d1', 'c1');
    const handler = createHolderTakeover(deps as any);
    // Must resolve (not reject) despite the flush rejection.
    await expect(handler('c1', { deviceId: 'x', device: 'X' })).resolves.toBeUndefined();
    // Each step is independently try/caught, so a flush reject does NOT abort the
    // rest — release/push/destroy still run.
    expect(deps.order).toEqual(['interrupt:d1:"\\u001b"', 'flush:c1']);
    expect(deps.leaseClient.release).not.toHaveBeenCalled();
  });

  it('never throws when pushMoved throws AND still runs destroy (step 8)', async () => {
    const deps = makeDeps({ liveDesktopIds: ['d1'] });
    deps.sessionIdMap.set('d1', 'c1');
    // pushMoved can throw synchronously (remoteServer.broadcast -> ws.send on a
    // socket mid-teardown). The handler must swallow it AND still destroy.
    (deps.pushMoved as any) = vi.fn((did: string) => { deps.order.push(`push:${did}`); throw new Error('ws send failed'); });
    const handler = createHolderTakeover(deps as any);
    await expect(handler('c1', { deviceId: 'x', device: 'X' })).resolves.toBeUndefined();
    // Step 8 still runs after the guarded push throw — no half-done handoff.
    expect(deps.sessionManager.destroySession).toHaveBeenCalledWith('d1');
    expect(deps.order).toEqual(['interrupt:d1:"\\u001b"', 'flush:c1', 'push:d1', 'destroyNative:d1', 'destroy:d1', 'untrackWelcomeBack:d1', 'release:c1']);
  });

  // 2026-07-18 (investigation Break 4). destroySession alone tears down the PTY
  // half only. For a NATIVE session that left the in-process HarnessSession alive
  // with its transcript-event listener still attached — an un-aborted stream, a
  // leaked model ref-count, and a second writer on the transcript JSONL.
  it('awaits the native teardown before destroySession, for every live holder', async () => {
    const deps = makeDeps({ liveDesktopIds: ['d1', 'd2'] });
    // A create+resume pair maps TWO desktop ids to one claude id — both must be
    // torn down natively, not just the first.
    deps.sessionIdMap.set('d1', 'c1');
    deps.sessionIdMap.set('d2', 'c1');
    // Make the native teardown genuinely async so an un-awaited call would let
    // destroySession land first and reorder the log.
    (deps.destroyNative as any) = vi.fn(async (did: string) => {
      await new Promise((r) => setTimeout(r, 5));
      deps.order.push(`destroyNative:${did}`);
    });
    const handler = createHolderTakeover(deps as any);
    await handler('c1', { deviceId: 'x', device: 'X' });

    expect(deps.destroyNative).toHaveBeenCalledWith('d1');
    expect(deps.destroyNative).toHaveBeenCalledWith('d2');
    for (const id of ['d1', 'd2']) {
      const iNative = deps.order.indexOf(`destroyNative:${id}`);
      const iDestroy = deps.order.indexOf(`destroy:${id}`);
      expect(iNative).toBeGreaterThanOrEqual(0);
      expect(iDestroy).toBeGreaterThan(iNative); // stop the appending source FIRST
    }
  });

  it('still destroys the session when the native teardown rejects', async () => {
    const deps = makeDeps({ liveDesktopIds: ['d1'] });
    deps.sessionIdMap.set('d1', 'c1');
    (deps.destroyNative as any) = vi.fn(async () => { throw new Error('harness teardown blew up'); });
    const handler = createHolderTakeover(deps as any);
    await expect(handler('c1', { deviceId: 'x', device: 'X' })).resolves.toBeUndefined();
    // If the harness may still append, keep authority and refuse the handoff.
    expect(deps.sessionManager.destroySession).not.toHaveBeenCalled();
    expect(deps.leaseClient.release).not.toHaveBeenCalled();
  });

  it('never throws even when the lease release rejects', async () => {
    const deps = makeDeps({ liveDesktopIds: ['d1'] });
    deps.sessionIdMap.set('d1', 'c1');
    (deps.leaseClient.release as any) = vi.fn(async () => { throw new Error('release failed'); });
    const handler = createHolderTakeover(deps as any);
    await expect(handler('c1', { deviceId: 'x', device: 'X' })).resolves.toBeUndefined();
    // push + destroy still run after a rejected release.
    expect(deps.pushMoved).toHaveBeenCalledWith('d1', 'X');
    expect(deps.sessionManager.destroySession).toHaveBeenCalledWith('d1');
  });

  it('interrupts + destroys EVERY live holder when two desktop ids map to one claude id', async () => {
    // A create+resume pair can leave TWO live desktop ids on one claude id. The old
    // pick-first behavior interrupted only the first and left the other running as a
    // silent second writer. Now both must be interrupted, moved, and destroyed; the
    // claude-id-keyed flush + release run once.
    const deps = makeDeps({ liveDesktopIds: ['d1', 'd2'] });
    deps.sessionIdMap.set('d1', 'c1');
    deps.sessionIdMap.set('d2', 'c1');
    const handler = createHolderTakeover(deps as any);
    await handler('c1', { deviceId: 'dev-b', device: 'Laptop-B' });

    // Both holders interrupted, both moved, both destroyed.
    expect(deps.sessionManager.sendInput).toHaveBeenCalledWith('d1', '\x1b');
    expect(deps.sessionManager.sendInput).toHaveBeenCalledWith('d2', '\x1b');
    expect(deps.pushMoved).toHaveBeenCalledWith('d1', 'Laptop-B');
    expect(deps.pushMoved).toHaveBeenCalledWith('d2', 'Laptop-B');
    expect(deps.sessionManager.destroySession).toHaveBeenCalledWith('d1');
    expect(deps.sessionManager.destroySession).toHaveBeenCalledWith('d2');
    // Flush + release are claude-id-keyed: exactly once each, not per-holder.
    expect(deps.flushSessionToSpace).toHaveBeenCalledTimes(1);
    expect(deps.leaseClient.release).toHaveBeenCalledTimes(1);
    // Every interrupt happens before the single flush (both turns quiesce before push).
    const iFlush = deps.order.indexOf('flush:c1');
    expect(deps.order.indexOf('interrupt:d1:"\\u001b"')).toBeLessThan(iFlush);
    expect(deps.order.indexOf('interrupt:d2:"\\u001b"')).toBeLessThan(iFlush);
  });

  // Task 9 — the REAL native holder path end-to-end: a live NativeSessionHost over
  // a real on-disk store, a genuinely mid-stream turn with a SECOND message queued
  // behind it, and quiesceNative wired to host.quiesce. Pins the invariant the fake
  // tests can only approximate: appends STOP before the flush is invoked, the
  // queued message NEVER runs, and nothing appends after the handoff.
  it('real native holder: appends stop before flush, the queued turn never runs, nothing appends after', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-holder-'));
    const store = new SessionStore(new NativeHome(root));
    const appends: string[] = [];
    const realAppend = store.append.bind(store);
    vi.spyOn(store, 'append').mockImplementation(async (cwd, event) => {
      appends.push(event.type);
      return realAppend(cwd, event);
    });
    const host = new NativeSessionHost(store, delayedFactory, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null);
    const nativeId = 'nat-real';
    await host.create({ sessionId: nativeId, cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    // Turn 1 in flight (delayedFactory trickles), turn 2 FIFO'd behind it.
    const gotDelta = new Promise<void>((res) => {
      host.on('transcript-event', (e) => { if (e.type === 'assistant-text') res(); });
    });
    host.send(nativeId, 'first');
    host.send(nativeId, 'queued-survivor');
    await gotDelta; // genuinely mid-stream now

    let typesAtFlush: string[] = [];
    const deps = makeDeps({ liveDesktopIds: [nativeId], providers: { [nativeId]: 'native' } });
    deps.sessionIdMap.set(nativeId, nativeId); // native identity mapping (production)
    (deps.quiesceNative as any) = (id: string) => host.quiesce(id);
    (deps.destroyNative as any) = (id: string) => host.destroy(id);
    // Capture the on-disk transcript AT FLUSH TIME — this is the load-bearing check:
    // quiesce must have fully settled the interrupted turn (user-interrupt on disk)
    // BEFORE the flush runs, so the space receives the final bytes. Without quiesce
    // the turn is still mid-stream here and user-interrupt is absent → this fails.
    (deps.flushSessionToSpace as any) = vi.fn(async () => {
      typesAtFlush = store.readEvents(nativeId, root).map((e) => e.type);
    });

    const handler = createHolderTakeover(deps as any);
    await handler(nativeId, { deviceId: 'dev-b', device: 'Laptop-B' });

    // The turn was quiesced (interrupted + drained) before the flush was invoked.
    expect(typesAtFlush).toContain('user-message');
    expect(typesAtFlush).toContain('user-interrupt');
    expect(typesAtFlush).not.toContain('turn-complete'); // aborted mid-turn, not completed

    // Nothing appends after the handoff (the queue was cleared, the stream aborted).
    const afterHandoff = appends.length;
    await new Promise((r) => setTimeout(r, 120)); // room for any stray stream chunk
    expect(appends.length).toBe(afterHandoff);

    // The queued survivor never produced a turn — no second user-message on disk.
    const survivor = store.readEvents(nativeId, root)
      .filter((e) => e.type === 'user-message' && e.data.text === 'queued-survivor');
    expect(survivor).toHaveLength(0);

    await host.destroyAll();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  // Review F3: quiesce() used to lift its send refusal when it returned, but the
  // handoff still has the flush and the lease release to go — a message sent
  // then ran a whole turn on this device. The refusal now lasts until destroy.
  it('real native holder: a send during the flush is refused and runs no turn', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-holder-'));
    const store = new SessionStore(new NativeHome(root));
    const host = new NativeSessionHost(store, delayedFactory, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null);
    const nativeId = 'nat-flush';
    await host.create({ sessionId: nativeId, cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const deps = makeDeps({ liveDesktopIds: [nativeId], providers: { [nativeId]: 'native' } });
    deps.sessionIdMap.set(nativeId, nativeId);
    (deps.quiesceNative as any) = (id: string) => host.quiesce(id);
    (deps.destroyNative as any) = (id: string) => host.destroy(id);
    (deps as any).endQuiesceNative = vi.fn((id: string) => host.endQuiesce(id));
    let sentDuringFlush: unknown;
    let sentDuringRelease: unknown;
    (deps.flushSessionToSpace as any) = vi.fn(async () => { sentDuringFlush = host.send(nativeId, 'mid-flush'); });
    (deps.leaseClient.release as any) = vi.fn(async () => { sentDuringRelease = host.send(nativeId, 'mid-release'); });

    await createHolderTakeover(deps as any)(nativeId, { deviceId: 'dev-b', device: 'Laptop-B' });

    expect(sentDuringFlush).toEqual({ status: 'failed', reason: 'not-live' });
    expect(sentDuringRelease).toEqual({ status: 'failed', reason: 'not-live' });
    expect(store.readEvents(nativeId, root).some((e) => e.type === 'user-message')).toBe(false);
    expect((deps as any).endQuiesceNative).not.toHaveBeenCalled(); // destroyed, nothing to lift
    await host.destroyAll();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  // Review N12: once the lease is released another device holds the
  // conversation, so no refusal may be lifted after a release.
  // WHY rewritten (combined branch): master's handoff now destroys BEFORE it
  // releases and keeps the lease when a destroy fails, so the N12 case (destroy
  // fails after the release) can no longer arise. A failed destroy leaves the
  // session this device's: the lease is kept and its sends come back.
  it('a quiesced holder that fails to destroy keeps the lease and gets its sends back', async () => {
    const deps = makeDeps({ liveDesktopIds: ['nat-stuck'], providers: { 'nat-stuck': 'native' } });
    deps.sessionIdMap.set('nat-stuck', 'claude-stuck');
    (deps.destroyNative as any) = vi.fn(async () => { throw new Error('destroy failed'); });
    (deps as any).endQuiesceNative = vi.fn();
    await createHolderTakeover(deps as any)('claude-stuck');
    expect(deps.leaseClient.release).not.toHaveBeenCalled();
    expect((deps as any).endQuiesceNative).toHaveBeenCalledWith('nat-stuck');
  });

  // Pins dropQuiesced's indexOf guard: splice(-1, 1) on a Claude Code holder's
  // id (never in the quiesced list) would silently drop the LAST native id, and
  // that native session would then keep refusing sends after the handoff failed.
  it('a Claude Code holder that fails to destroy first does not cost the native holder its sends', async () => {
    const deps = makeDeps({ liveDesktopIds: ['cc-first', 'nat-second'], providers: { 'nat-second': 'native' } });
    deps.sessionIdMap.set('cc-first', 'claude-mixed');
    deps.sessionIdMap.set('nat-second', 'claude-mixed');
    (deps.sessionManager.destroySession as any) = vi.fn((id: string) => id !== 'cc-first');
    (deps as any).endQuiesceNative = vi.fn();
    await createHolderTakeover(deps as any)('claude-mixed');
    expect(deps.leaseClient.release).not.toHaveBeenCalled();
    expect((deps as any).endQuiesceNative).toHaveBeenCalledWith('nat-second');
  });

  it('a handoff that stops before releasing the lease gives the quiesced holder its sends back', async () => {
    const deps = makeDeps({ liveDesktopIds: ['nat-early'], providers: { 'nat-early': 'native' } });
    deps.sessionIdMap.set('nat-early', 'claude-early');
    (deps as any).endQuiesceNative = vi.fn();
    // An unexpected escape between the quiesce and the release (here: the
    // progress log line throws) must not leave the session refusing forever.
    const log = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      if (String(msg).includes('flushing to space')) throw new Error('boom');
    });
    try {
      await createHolderTakeover(deps as any)('claude-early');
    } finally {
      log.mockRestore();
    }
    expect(deps.leaseClient.release).not.toHaveBeenCalled();
    expect((deps as any).endQuiesceNative).toHaveBeenCalledWith('nat-early');
  });

  // WHY (combined branch): bugfix-native's refusal lift was written for the old
  // flow; master's pinned-snapshot handoff path quiesces too and retains the
  // lease when a native destroy fails. That session is still this device's, so
  // it must get its sends back there as well — and a completed handoff lifts none.
  it('pinned-snapshot path: a native writer the handoff could not destroy gets its sends back, lease kept', async () => {
    const d = makeDeps({ liveDesktopIds: ['nat'], providers: { nat: 'native' } }); d.sessionIdMap.set('nat', 'c1');
    const endQuiesceNative = vi.fn();
    const protectUnsafe = vi.fn();
    await createHolderTakeover({ ...d, senderDeviceId: 'sender', endQuiesceNative, protectUnsafe,
      pinSnapshot: () => ({ active: () => true, release: vi.fn() }),
      captureWriter: () => ({ provider: 'native', sessionId: 'c1', transcriptPath: '/tmp/c1.jsonl', projectCwd: '/tmp',
        persisted: () => false, current: () => true }),
      destroyNative: async () => { throw new Error('destroy failed'); },
    } as any)('c1', { deviceId: 'requester', device: 'Other' });
    expect(d.quiesceNative).toHaveBeenCalledWith('nat');
    expect(protectUnsafe).toHaveBeenCalledWith('c1');
    expect(d.leaseClient.release).not.toHaveBeenCalled();
    expect(endQuiesceNative).toHaveBeenCalledWith('nat');
  });

  it('pinned-snapshot path: a completed handoff lifts no refusal', async () => {
    const d = makeDeps({ liveDesktopIds: ['nat'], providers: { nat: 'native' } }); d.sessionIdMap.set('nat', 'c1');
    const endQuiesceNative = vi.fn();
    let stopped = false;
    await createHolderTakeover({ ...d, senderDeviceId: 'sender', endQuiesceNative,
      pinSnapshot: () => ({ active: () => true, release: vi.fn() }),
      captureWriter: () => ({ provider: 'native', sessionId: 'c1', transcriptPath: '/tmp/c1.jsonl', projectCwd: '/tmp',
        persisted: () => stopped, current: () => true }),
      destroyNative: async () => { stopped = true; },
      sessionManager: { ...d.sessionManager, getSession: () => stopped ? undefined : { id: 'nat' } },
    } as any)('c1', { deviceId: 'requester', device: 'Other' });
    expect(d.leaseClient.release).toHaveBeenCalledWith('c1');
    expect(endQuiesceNative).not.toHaveBeenCalled();
  });

  // Design 2026-09-24 §2 — the OTHER destroySession call site (captureWriter's
  // pinned-snapshot path, distinct from the plain quiesce/interrupt path tested
  // above) must also untrack, not just the more common branch.
  it('pinned-snapshot path: untracks Welcome back once the native writer is torn down', async () => {
    const d = makeDeps({ liveDesktopIds: ['nat'], providers: { nat: 'native' } }); d.sessionIdMap.set('nat', 'c1');
    await createHolderTakeover({ ...d, senderDeviceId: 'sender',
      pinSnapshot: () => ({ active: () => true, release: vi.fn() }),
      captureWriter: () => ({ provider: 'native', sessionId: 'c1', transcriptPath: '/tmp/c1.jsonl', projectCwd: '/tmp',
        persisted: () => true, current: () => true }),
    } as any)('c1', { deviceId: 'requester', device: 'Other' });
    expect(d.untrackWelcomeBack).toHaveBeenCalledWith('nat');
  });

  // F1 (code review 2026-09-24): the pinned-snapshot path's 'claude' branch
  // (stopSessionForHandoff, the `else` beside the native destroy above) fell
  // through with NO untrackWelcomeBack call at all — only the native sibling
  // had one. A Claude Code session handed off through this verified-receipt
  // path stayed marked "open" on this device forever and got wrongly
  // re-offered by the next Welcome back screen. Proven stopped AND merely
  // attempted-but-unproven ('unknown') both must untrack: like the native
  // branch's destroySession() call above, calling stopSessionForHandoff is
  // this device's own act of giving up the writer — independent of whether
  // the stop is later provable (which only gates `proven`/publish, not
  // whether this device still holds the conversation).
  it("pinned-snapshot path: untracks Welcome back for a Claude Code writer once stop is proven", async () => {
    const d = makeDeps({ liveDesktopIds: ['cc'], providers: { cc: 'claude' } }); d.sessionIdMap.set('cc', 'c1');
    await createHolderTakeover({ ...d, senderDeviceId: 'sender',
      pinSnapshot: () => ({ active: () => true, release: vi.fn() }),
      captureWriter: () => ({ provider: 'claude', sessionId: 'c1', transcriptPath: '/tmp/c1.jsonl', projectCwd: '/tmp',
        persisted: () => true, current: () => true }),
      sessionManager: { ...d.sessionManager, stopSessionForHandoff: vi.fn(async () => ({ status: 'stopped' as const })) },
    } as any)('c1', { deviceId: 'requester', device: 'Other' });
    expect(d.untrackWelcomeBack).toHaveBeenCalledWith('cc');
  });

  it("pinned-snapshot path: untracks Welcome back for a Claude Code writer even when the stop is unproven", async () => {
    const d = makeDeps({ liveDesktopIds: ['cc'], providers: { cc: 'claude' } }); d.sessionIdMap.set('cc', 'c1');
    const protectUnsafe = vi.fn();
    await createHolderTakeover({ ...d, senderDeviceId: 'sender', protectUnsafe,
      pinSnapshot: () => ({ active: () => true, release: vi.fn() }),
      captureWriter: () => ({ provider: 'claude', sessionId: 'c1', transcriptPath: '/tmp/c1.jsonl', projectCwd: '/tmp',
        persisted: () => true, current: () => true }),
      sessionManager: { ...d.sessionManager, stopSessionForHandoff: vi.fn(async () => ({ status: 'unknown' as const })) },
    } as any)('c1', { deviceId: 'requester', device: 'Other' });
    expect(protectUnsafe).toHaveBeenCalledWith('c1'); // unproven still refuses the handoff...
    expect(d.untrackWelcomeBack).toHaveBeenCalledWith('cc'); // ...but this device already gave up the writer
  });
});
