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
import { useFocusComposerAfterSwitch, markPointerSwitch } from '../src/renderer/hooks/use-focus-composer-after-switch';

(Element.prototype as any).scrollIntoView ??= () => {};
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


  it('Enter on a menu row (keyboard) leaves focus where it is', async () => {
    await app.switchTo(app.sessionIds[1], 'keyboard');
    expect(document.activeElement).not.toBe(composer());
  });




  it('refuses when focus sits in an iframe or an editable element', async () => {
    for (const make of [() => document.createElement('iframe'), () => { const d = document.createElement('div'); d.contentEditable = 'true'; d.tabIndex = 0; return d; }]) {
      const el = make(); el.setAttribute('data-test-extra', ''); document.body.appendChild(el); (el as HTMLElement).focus();
      await app.switchTo(app.sessionIds[1]);
      expect(document.activeElement).toBe(el);
      await app.switchTo(app.sessionIds[0]);
    }
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

  it('focuses once after a pointer switch', async () => {
    const { focus, result, rerender } = setup('chat');
    markPointerSwitch(); result.current('b'); rerender({ id: 'b', v: 'chat' }); await frame();
    expect(focus).toHaveBeenCalledTimes(1);
  });
  it('never for an unmarked switch (keyboard, Shift switcher, automatic)', async () => {
    const { focus, result, rerender } = setup('chat');
    result.current('b'); rerender({ id: 'b', v: 'chat' }); await frame();
    rerender({ id: 'c', v: 'chat' }); await frame();
    expect(focus).not.toHaveBeenCalled();
  });
  it('never in terminal view', async () => {
    const { focus, result, rerender } = setup('terminal');
    markPointerSwitch(); result.current('b'); rerender({ id: 'b', v: 'terminal' }); await frame();
    expect(focus).not.toHaveBeenCalled();
  });
});
