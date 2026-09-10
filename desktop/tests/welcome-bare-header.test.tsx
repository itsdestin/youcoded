// @vitest-environment jsdom
//
// Pins P-6 (Destin, 2026-08-27): the welcome screen ("No Active Session")
// wears the app's BARE frame — the same header bar as a session, holding only
// what works without a session: the Settings gear, the Projects button and the
// window controls. Nothing session-scoped (session strip, chat/terminal
// toggle, Session Files, Games, the ||| overflow menu) may appear there.
//
// The gear must be byte-identical to the session header's, so it lives in ONE
// component in HeaderBar.tsx — the source assertion below fails if a second
// gear is ever hand-copied.
import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { BareHeaderBar } from '../src/renderer/components/HeaderBar';
import { ArtifactContext } from '../src/renderer/state/ArtifactContext';

const RENDERER = join(__dirname, '..', 'src', 'renderer');

// jsdom has no matchMedia; useNarrowViewport (via the header's children) reads
// it. `matches` is the narrow/wide switch for the tests below.
function stubViewport(narrow: boolean) {
  (window as any).matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: narrow,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function renderBare(props: Partial<React.ComponentProps<typeof BareHeaderBar>> = {}, dispatch = vi.fn()) {
  const value = { state: { sessionArtifacts: {}, drawerOpenBySession: {} } as any, dispatch };
  return {
    dispatch,
    ...render(
      <ArtifactContext.Provider value={value as any}>
        <BareHeaderBar settingsOpen={false} onToggleSettings={vi.fn()} {...props} />
      </ArtifactContext.Provider>,
    ),
  };
}

describe('BareHeaderBar (welcome screen frame)', () => {
  beforeEach(() => { cleanup(); stubViewport(false); });
  afterEach(() => { delete (window as any).claude; });

  it('renders the Settings gear and the Projects button', () => {
    renderBare();
    expect(screen.getByLabelText('Settings')).toBeTruthy();
    expect(screen.getByLabelText('Open Projects')).toBeTruthy();
  });

  it('renders nothing session-scoped: no session strip, view toggle, files, game or ||| menu', () => {
    const { container } = renderBare();
    expect(container.querySelector('.session-strip')).toBeNull();
    expect(screen.queryByLabelText('Chat')).toBeNull();
    expect(screen.queryByLabelText('Terminal')).toBeNull();
    expect(screen.queryByLabelText('Session Files')).toBeNull();
    // Renamed from 'Connect 4' with the arcade (§4.1) — the button now opens a
    // four-game pane, so it names the pane.
    expect(screen.queryByLabelText('Games')).toBeNull();
    expect(screen.queryByLabelText('Open menu')).toBeNull();
  });

  it('keeps the header-bar class so the window stays draggable and the CSS no-drag rules apply', () => {
    const { container } = renderBare();
    const bar = container.querySelector('.header-bar');
    expect(bar).toBeTruthy();
    // Only buttons inside .header-bar are excluded from the drag region by
    // globals.css — every control here must therefore be a <button>.
    const controls = bar!.querySelectorAll('button');
    expect(controls.length).toBeGreaterThanOrEqual(2);
  });

  it('wires the gear to onToggleSettings and Projects to PROJECT_VIEW_OPENED', () => {
    const onToggleSettings = vi.fn();
    const { dispatch } = renderBare({ onToggleSettings });
    fireEvent.click(screen.getByLabelText('Settings'));
    expect(onToggleSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Open Projects'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'PROJECT_VIEW_OPENED' });
  });

  it('shows the settings badges exactly like the session header (danger beats info)', () => {
    const { container, rerender } = renderBare({ settingsBadge: true });
    expect(container.querySelector('.bg-blue-500')).toBeTruthy();
    const value = { state: { sessionArtifacts: {}, drawerOpenBySession: {} } as any, dispatch: vi.fn() };
    rerender(
      <ArtifactContext.Provider value={value as any}>
        <BareHeaderBar settingsOpen={false} onToggleSettings={vi.fn()} settingsBadge settingsDangerBadge />
      </ArtifactContext.Provider>,
    );
    expect(container.querySelector('.bg-red-500')).toBeTruthy();
    expect(container.querySelector('.bg-blue-500')).toBeNull();
  });

  it('on a narrow viewport still shows gear + Projects directly (no session-scoped ||| menu)', () => {
    stubViewport(true);
    renderBare();
    expect(screen.getByLabelText('Settings')).toBeTruthy();
    expect(screen.getByLabelText('Open Projects')).toBeTruthy();
    expect(screen.queryByLabelText('Open menu')).toBeNull();
  });

  it('renders minimize / maximize / close when the window bridge exists (Windows/Linux)', () => {
    // showCaptionButtons is "desktop and not macOS" — jsdom's navigator.platform
    // is not Mac and __PLATFORM__ is unset (electron), so the gate is open; the
    // buttons themselves only render when window.claude.window is present.
    const win = { minimize: vi.fn(), maximize: vi.fn(), close: vi.fn() };
    (window as any).claude = { window: win };
    renderBare();
    fireEvent.click(screen.getByLabelText('Minimize'));
    fireEvent.click(screen.getByLabelText('Maximize'));
    fireEvent.click(screen.getByLabelText('Close'));
    expect(win.minimize).toHaveBeenCalledTimes(1);
    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('renders NO caption buttons on Android even when the bridge exposes window (workbench ?platform=android)', () => {
    // Pins the render-time isAndroid() gate in CaptionButtons: the import-time
    // showCaptionButtons is already true here (jsdom, __PLATFORM__ unset at import),
    // so without that gate the buttons would paint on a phone whose bridge
    // happens to carry window.* (the workbench's does — window.getId).
    (window as any).__PLATFORM__ = 'android';
    (window as any).claude = { window: { minimize: vi.fn(), maximize: vi.fn(), close: vi.fn() } };
    try {
      renderBare();
      expect(screen.queryByLabelText('Minimize')).toBeNull();
      expect(screen.queryByLabelText('Close')).toBeNull();
    } finally { delete (window as any).__PLATFORM__; }
  });
});

describe('welcome screen wiring (source)', () => {
  const app = readFileSync(join(RENDERER, 'App.tsx'), 'utf8');
  const header = readFileSync(join(RENDERER, 'components', 'HeaderBar.tsx'), 'utf8');

  it('App renders BareHeaderBar once, in the welcome branch (after the session HeaderBar, before "No Active Session")', () => {
    expect(app.match(/<BareHeaderBar\b/g)?.length).toBe(1);
    // `<HeaderBar` followed by any whitespace — NOT indexOf('<HeaderBar\n'), which
    // found nothing on a Windows checkout (CRLF), failed this case on every CI run
    // since P-6 shipped, and would have gone on reading as a real regression.
    const session = app.search(/<HeaderBar[\s>]/);
    const bare = app.indexOf('<BareHeaderBar');
    const welcome = app.indexOf('No Active Session');
    expect(session).toBeGreaterThan(-1);
    expect(bare).toBeGreaterThan(session);
    expect(welcome).toBeGreaterThan(bare);
  });

  it('the welcome branch paints the same chrome-glass + headerRef chrome-wrapper as a session', () => {
    const bare = app.indexOf('<BareHeaderBar');
    const before = app.slice(bare - 1500, bare);
    expect(before).toContain('className="chrome-glass chrome-glass--bare"');
    expect(before).toContain('<div ref={headerRef} className="chrome-wrapper bg-canvas">');
  });

  it('the Settings gear is defined exactly once in HeaderBar.tsx (shared by both headers)', () => {
    expect(header.match(/<Tooltip text="Settings"/g)?.length).toBe(1);
    expect(header.match(/<SettingsGearButton\b/g)?.length).toBe(2);
  });
});
