// U11 — switching a native chat to a model it no longer fits.
//
// Destin (2026-09-23): "fine if we block, but it should be a popup with a
// 'summarize and switch' button or an x/esc button." These pin the backend half:
// a fitting chat switches exactly as before; an overfull one changes NOTHING
// until the user chooses Summarize and switch; that summary runs on the CURRENT
// model but is sized for the new one; every failure stays on the current model.
import { describe, it, expect, vi } from 'vitest';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { makeSession, scriptModel } from './helpers/harness-fakes';

describe('HarnessSession.fitForWindow', () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => ([
    { role: 'user', content: `question ${i} ${'x'.repeat(2_000)}` },
    { role: 'assistant', content: `answer ${i} ${'y'.repeat(2_000)}` },
  ])).flat();

  it('a chat well inside the new window fits', () => {
    const s = makeSession({ contextLength: 200_000 });
    (s as any).history = long(2);
    expect(s.fitForWindow(128_000)).toBe('fits');
  });

  it('a chat past the new window\'s trigger needs a summary first', () => {
    const s = makeSession({ contextLength: 200_000 });
    (s as any).history = long(40);   // ~40k tokens
    expect(s.fitForWindow(32_768)).toBe('needs-summary');
  });

  it('a window too small for the fixed prompt and a reply is not offered a summary', () => {
    const s = makeSession({ contextLength: 200_000 });
    expect(s.fitForWindow(64)).toBe('too-small');
  });

  it('an unknown window never blocks (it would otherwise be guessed as 32k)', () => {
    const s = makeSession({ contextLength: 200_000 });
    (s as any).history = long(40);
    expect(s.fitForWindow(null)).toBe('fits');
  });

  it('compactNow(target) sizes the kept tail for the new model and fits it', async () => {
    const s = makeSession({ contextLength: 200_000, model: scriptModel([{ text: 'Goal: keep going.' }]) });
    s.seedHistory(long(40) as any);
    expect(s.fitForWindow(32_768)).toBe('needs-summary');
    expect(await s.compactNow(undefined, 32_768)).toEqual({ ok: true });
    expect(s.fitForWindow(32_768)).toBe('fits');
  });
});

/** A host with only the pieces switchModel touches. */
function fakeHost(fit: 'fits' | 'needs-summary' | 'too-small', compactResult: any = { ok: true }) {
  const entry = { session: { fitForWindow: vi.fn(() => fit) } };
  const host: any = {
    live: new Map([['s', entry]]),
    resolveContextAndProfile: vi.fn(async () => ({ contextLength: 32_768 })),
    compact: vi.fn(async () => compactResult),
    setBinding: vi.fn(async () => true),
  };
  const call = (summarize?: boolean) =>
    NativeSessionHost.prototype.switchModel.call(host, 's', { providerId: 'p', modelId: 'small' }, summarize);
  return { host, call };
}

describe('NativeSessionHost.switchModel', () => {
  it('fits → switches like setBinding, no summary', async () => {
    const { host, call } = fakeHost('fits');
    expect(await call()).toEqual({ status: 'switched' });
    expect(host.compact).not.toHaveBeenCalled();
    expect(host.setBinding).toHaveBeenCalledOnce();
  });

  it('overfull → asks first and changes nothing', async () => {
    const { host, call } = fakeHost('needs-summary');
    expect(await call()).toEqual({ status: 'needs-summary' });
    expect(host.compact).not.toHaveBeenCalled();
    expect(host.setBinding).not.toHaveBeenCalled();
  });

  it('Summarize and switch → summary sized for the new window, then the switch', async () => {
    const { host, call } = fakeHost('needs-summary');
    expect(await call(true)).toEqual({ status: 'switched', summarized: true });
    expect(host.compact).toHaveBeenCalledWith('s', undefined, 32_768);
    expect(host.compact.mock.invocationCallOrder[0]).toBeLessThan(host.setBinding.mock.invocationCallOrder[0]);
  });

  it.each(['interrupted', 'summary-failed', 'cannot-fit', 'turn-in-flight'])(
    'a %s summary stays on the current model', async (reason) => {
      const { host, call } = fakeHost('needs-summary', { ok: false, reason });
      expect(await call(true)).toEqual({ status: 'failed', reason });
      expect(host.setBinding).not.toHaveBeenCalled();
    });

  it('too small even for the fixed prompt → honest failure, no popup, no summary', async () => {
    const { host, call } = fakeHost('too-small');
    expect(await call(true)).toEqual({ status: 'failed', reason: 'too-small' });
    expect(host.compact).not.toHaveBeenCalled();
    expect(host.setBinding).not.toHaveBeenCalled();
  });

  it('a session that ended mid-check is reported, not switched', async () => {
    const { host, call } = fakeHost('fits');
    host.resolveContextAndProfile = vi.fn(async () => { host.live.delete('s'); return { contextLength: 1 }; });
    expect(await call()).toEqual({ status: 'failed', reason: 'not-live' });
    expect(host.setBinding).not.toHaveBeenCalled();
  });
});
