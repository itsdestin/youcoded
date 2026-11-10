// Pins the ONE rule for "does terminal view use the phone layout?" (renderer/device.ts, 2026-11-09).
// WHY: the rule was copied into four places, and a fifth place (sizing a hidden terminal) forgot it, so a phone fix
// started resizing sessions on the computer app. A copy that drifts is exactly how that happened.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { phoneTerminalLayout, inPhoneApp, markTerminalLayout } from '../src/renderer/device';

const SRC = join(__dirname, '..', 'src', 'renderer');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const files = (dir: string): string[] => readdirSync(dir).flatMap(n => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});

describe('terminal layout by device', () => {
  afterEach(() => { delete (globalThis as any).window; });
  const on = (platform: string | undefined) => { (globalThis as any).window = { __PLATFORM__: platform }; };

  it('phone app and touch browser get the phone layout; computer app and a mouse laptop\'s browser get the computer terminal', () => {
    on('electron'); expect(phoneTerminalLayout()).toBe(false);
    on('android'); expect(phoneTerminalLayout()).toBe(true); expect(inPhoneApp()).toBe(true);
    on('browser'); expect(phoneTerminalLayout()).toBe(true); expect(inPhoneApp()).toBe(false);
    // What a computer tells a mouse laptop's browser (remote-server.ts authOkMessage). Destin, 2026-11-10: computer terminal.
    on('desktop'); expect(phoneTerminalLayout()).toBe(false);
  });

  it('the style sheets are told the same answer, and again after a browser learns what it is', () => {
    const html = { dataset: {} as Record<string, string> };
    (globalThis as any).document = { documentElement: html };
    try {
      on(undefined); markTerminalLayout(); expect(html.dataset.termLayout).toBe('computer');   // browser, before the handshake
      on('browser'); markTerminalLayout(); expect(html.dataset.termLayout).toBe('phone');
      on('desktop'); markTerminalLayout(); expect(html.dataset.termLayout).toBe('computer');
    } finally { delete (globalThis as any).document; }
    expect(read('remote-shim.ts')).toMatch(/__PLATFORM__ = platform;\s*markTerminalLayout\(\);/);
  });

  it('no script but device.ts spells the rule out for itself', () => {
    const copies = files(SRC)
      .filter(p => !p.endsWith(join('renderer', 'device.ts')) && !p.includes(join('dev', 'workbench')))
      .filter(p => /getPlatform\(\)\s*!==\s*'electron'/.test(readFileSync(p, 'utf8')));
    expect(copies).toEqual([]);
    expect(read('components/TerminalView.tsx')).not.toMatch(/=\s*isTouchDevice\(\)/);
  });

  it('every terminal style rule keys on the layout label, never on the app kind', () => {
    const css = ['keyboard.css', 'globals.css', 'frame-outline.css', 'float-chrome.css'].map(f => read('styles/' + f)).join('\n');
    expect(css).toContain('html[data-term-layout="phone"] [data-term-lift]');
    expect(css).toContain('html[data-term-layout="phone"] {');
    // WHY: data-platform is written once at load, so a rule keyed on it cannot follow a browser's handshake.
    expect(css).not.toMatch(/data-platform="electron"\]/);
  });

  it('a hidden terminal is sized only under the phone layout, so the computer app does nothing while hidden', () => {
    expect(read('components/TerminalView.tsx')).toMatch(/clientHeight === 0\) \{ if \(holdRowsOnTouch\) proposeHidden\(el\); return; \}/);
    expect(read('components/TerminalView.tsx')).toContain('const holdRowsOnTouch = phoneTerminalLayout();');
  });

  it('nothing sets the unused keyboard marker any more', () => {
    expect(files(SRC).filter(p => /dataset\.ime\b|data-ime/.test(readFileSync(p, 'utf8')))).toEqual([]);
  });
});
