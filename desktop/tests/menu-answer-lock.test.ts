// @vitest-environment jsdom
// Review F4: two devices answering the same dialog at once could mix one's
// arrows with the other's Enter. The host holds one lock per session.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MenuAnswerLock, MENU_ANSWER_LEASE_MS } from '../src/main/menu-answer-lock';
import { sendPromptInput, PROMPT_FAILURE_COPY } from '../src/renderer/state/prompt-input';

describe('MenuAnswerLock (host)', () => {
  it('refuses a second device while the first answers, and admits it after', () => {
    let t = 0;
    const lock = new MenuAnswerLock(() => t);
    expect(lock.handle('s', 'desktop', 'acquire')).toBe(true);
    expect(lock.handle('s', 'phone', 'acquire')).toBe(false);
    expect(lock.handle('other', 'phone', 'acquire')).toBe(true);
    lock.handle('s', 'phone', 'release'); // not the holder
    expect(lock.handle('s', 'phone', 'acquire')).toBe(false);
    lock.handle('s', 'desktop', 'release');
    expect(lock.handle('s', 'phone', 'acquire')).toBe(true);
  });

  it('a holder that vanished loses the lock when its lease runs out', () => {
    let t = 0;
    const lock = new MenuAnswerLock(() => t);
    lock.acquire('s', 'desktop');
    t = MENU_ANSWER_LEASE_MS + 1;
    expect(lock.acquire('s', 'phone')).toBe(true);
  });
});

describe('a verified answer asks the host first', () => {
  let sendInput: ReturnType<typeof vi.fn>;
  beforeEach(() => { sendInput = vi.fn(); });

  it('types NOTHING and says so when another device holds the lock', async () => {
    const lock = new MenuAnswerLock();
    lock.acquire('s1', 'the-other-device');
    (window as any).claude = { session: { sendInput, menuLock: async (sid: string, h: string, a: string) => lock.handle(sid, h, a) } };
    const r = await sendPromptInput('s1', { label: 'Yes, I trust this folder', input: '', pick: { signature: 'x', index: 1 } });
    expect(r).toEqual({ ok: false, reason: 'busy', typed: false });
    expect(sendInput).not.toHaveBeenCalled();
    expect(PROMPT_FAILURE_COPY.busy).toMatch(/Another device is answering this/);
  });

  it('releases the lock when its answer ends, so the next answer can go', async () => {
    const lock = new MenuAnswerLock();
    (window as any).claude = { session: { sendInput, menuLock: async (sid: string, h: string, a: string) => lock.handle(sid, h, a) } };
    await sendPromptInput('s1', { label: 'a', input: '', pick: { signature: 'x', index: 0 } }); // menu not on screen → refused
    expect(lock.acquire('s1', 'someone-else')).toBe(true);
  });
});

describe('the lock ask can fail without leaving the card dead (second review F1)', () => {
  let sendInput: ReturnType<typeof vi.fn>;
  beforeEach(() => { sendInput = vi.fn(); });
  const pickBtn = { label: 'a', input: '', pick: { signature: 'x', index: 0 } };

  it('a lost connection or timeout: resolves "unreachable", types nothing, never throws', async () => {
    (window as any).claude = { session: { sendInput, menuLock: () => Promise.reject(new Error('Request timed out: session:menu-lock')) } };
    await expect(sendPromptInput('s1', pickBtn)).resolves.toEqual({ ok: false, reason: 'unreachable', typed: false });
    expect(sendInput).not.toHaveBeenCalled();
    expect(PROMPT_FAILURE_COPY.unreachable).toMatch(/couldn't reach the computer/);
  });

  it('an older host without the channel ("remote-unsupported"): answers unlocked, as before the lock', async () => {
    const release = vi.fn();
    (window as any).claude = { session: { sendInput, menuLock: (_s: string, _h: string, a: string) =>
      a === 'acquire' ? Promise.reject(new Error('remote-unsupported: session:menu-lock')) : (release(), Promise.resolve(true)) } };
    // Menu not on screen → the driver itself refuses; the point is it RAN (not busy/unreachable).
    await expect(sendPromptInput('s1', pickBtn)).resolves.toEqual({ ok: false, reason: 'menu-gone', typed: false });
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled(); // nothing held, nothing to release
  });

  it('a failing release is swallowed (no unhandled rejection)', async () => {
    (window as any).claude = { session: { sendInput, menuLock: (_s: string, _h: string, a: string) =>
      a === 'acquire' ? Promise.resolve(true) : Promise.reject(new Error('socket closed')) } };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    await sendPromptInput('s1', pickBtn);
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
