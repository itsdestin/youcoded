// @vitest-environment jsdom
// After the user switches session in chat view the message box takes focus (owner, 2026-10-05).
// Lab finding: focus stayed on the pill button in 16/16 tries, so typing right after a switch went
// nowhere. These pin when it must happen and every case where it must NOT.
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, renderHook } from '@testing-library/react';

vi.mock('@xterm/xterm', async () => (await import('./helpers/busy-app-probes')).fakeXtermModule());
vi.mock('@xterm/addon-fit', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('FitAddon'));
vi.mock('@xterm/addon-unicode11', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('Unicode11Addon'));
vi.mock('@xterm/addon-webgl', async () => (await import('./helpers/busy-app-probes')).fakeAddonModule('WebglAddon'));
vi.mock('../src/renderer/components/ChatView', async (importOriginal) => {
  const real = await importOriginal<any>();
  return { ...real, default: (await import('./helpers/busy-app-probes')).probe(real.default, 'chat') };
});
vi.mock('../src/renderer/components/TerminalView', async (importOriginal) => {
  const real = await importOriginal<any>();
  return { ...real, default: (await import('./helpers/busy-app-probes')).probe(real.default, 'terminal') };
});

import { mountBusyApp, FAKE_TIMERS, type BusyApp } from './helpers/busy-app';
import { useFocusComposerAfterSwitch } from '../src/renderer/hooks/use-focus-composer-after-switch';

beforeAll(async () => { await import('../src/renderer/App'); }, 120_000);

describe('the composer after a user switch (whole app)', () => {
  let app: BusyApp;
  const composer = () => document.querySelector<HTMLTextAreaElement>('#root textarea.input-bar-textarea')!;
  const realMatchMedia = (window as any).matchMedia;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    app = await mountBusyApp({ sessions: 3 });
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
  afterEach(() => {
    (window as any).matchMedia = realMatchMedia;
    document.querySelectorAll('[data-test-extra]').forEach((n) => n.remove());
    vi.useRealTimers();
  });

  it('picking a session from the strip puts the cursor in the message box', async () => {
    await app.switchTo(app.sessionIds[1]);
    expect(document.activeElement).toBe(composer());
  });

  it('does nothing after a finger or pen press (it would raise the on-screen keyboard)', async () => {
    const down = new Event('pointerdown', { bubbles: true }); Object.defineProperty(down, 'pointerType', { value: 'touch' });
    await act(async () => { document.body.dispatchEvent(down); });
    await app.switchTo(app.sessionIds[1]);
    expect(document.activeElement).not.toBe(composer());
  });

  it('does nothing on a narrow screen', async () => {
    (window as any).matchMedia = (q: string) => ({ matches: q.includes('max-width: 639'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    await app.switchTo(app.sessionIds[1]);
    expect(document.activeElement).not.toBe(composer());
  });

  it('does nothing while a dialog is open', async () => {
    const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.setAttribute('data-test-extra', ''); document.body.appendChild(d);
    await app.switchTo(app.sessionIds[1]);
    expect(document.activeElement).not.toBe(composer());
  });

  it('leaves focus alone when the user is in another text field', async () => {
    const other = document.createElement('input'); other.setAttribute('data-test-extra', ''); document.body.appendChild(other); other.focus();
    await app.switchTo(app.sessionIds[1]);
    expect(document.activeElement).toBe(other);
  });
});

describe('useFocusComposerAfterSwitch', () => {
  const setup = (view: 'chat' | 'terminal') => {
    const focus = vi.fn();
    const h = renderHook(({ id, v }: { id: string; v: 'chat' | 'terminal' }) => useFocusComposerAfterSwitch(id, v, focus), { initialProps: { id: 'a', v: view } });
    return { focus, ...h };
  };
  beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });
  const frame = () => act(async () => { await vi.advanceTimersByTimeAsync(20); });

  it('focuses once, after the user\'s own switch', async () => {
    const { focus, result, rerender } = setup('chat');
    result.current('b'); rerender({ id: 'b', v: 'chat' }); await frame();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('never focuses for a switch nobody asked for (a session opened or closed elsewhere)', async () => {
    const { focus, rerender } = setup('chat');
    rerender({ id: 'b', v: 'chat' }); await frame();
    expect(focus).not.toHaveBeenCalled();
  });

  it('never focuses in terminal view (the terminal takes its own focus)', async () => {
    const { focus, result, rerender } = setup('terminal');
    result.current('b'); rerender({ id: 'b', v: 'terminal' }); await frame();
    expect(focus).not.toHaveBeenCalled();
  });

  it('a stale request does not turn a later automatic switch into a focus', async () => {
    const { focus, result, rerender } = setup('chat');
    result.current('b'); await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    rerender({ id: 'b', v: 'chat' }); await frame();
    expect(focus).not.toHaveBeenCalled();
  });
});
