// Pins the ONE rule for "does terminal view use the phone layout?" (renderer/device.ts, 2026-11-09).
// WHY: the rule was copied into four places, and a fifth place (sizing a hidden terminal) forgot it, so a phone fix
// started resizing sessions on the computer app. A copy that drifts is exactly how that happened.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { phoneTerminalLayout, inPhoneApp } from '../src/renderer/device';

const SRC = join(__dirname, '..', 'src', 'renderer');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const files = (dir: string): string[] => readdirSync(dir).flatMap(n => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});

describe('terminal layout by device', () => {
  afterEach(() => { delete (globalThis as any).window; });
  const on = (platform: string | undefined) => { (globalThis as any).window = { __PLATFORM__: platform }; };

  it('the computer app gets the computer terminal; every other screen gets the phone layout', () => {
    on('electron'); expect(phoneTerminalLayout()).toBe(false);
    on('android'); expect(phoneTerminalLayout()).toBe(true); expect(inPhoneApp()).toBe(true);
    on('browser'); expect(phoneTerminalLayout()).toBe(true); expect(inPhoneApp()).toBe(false);
    // What a computer tells a mouse laptop's browser (remote-server.ts authOkMessage). Destin's open decision.
    on('desktop'); expect(phoneTerminalLayout()).toBe(true);
  });

  it('no script but device.ts spells the rule out for itself', () => {
    const copies = files(SRC)
      .filter(p => !p.endsWith(join('renderer', 'device.ts')) && !p.includes(join('dev', 'workbench')))
      .filter(p => /getPlatform\(\)\s*!==\s*'electron'/.test(readFileSync(p, 'utf8')));
    expect(copies).toEqual([]);
  });

  it('the two style rules that must agree with it are still keyed the same way', () => {
    expect(read('styles/keyboard.css')).toContain('html:not([data-platform="electron"]) [data-term-lift]');
    expect(read('styles/globals.css')).toContain('html:not([data-platform="electron"]) {');
  });

  it('a hidden terminal is sized only under the phone layout, so the computer app does nothing while hidden', () => {
    expect(read('components/TerminalView.tsx')).toMatch(/clientHeight === 0\) \{ if \(holdRowsOnTouch\) proposeHidden\(el\); return; \}/);
    expect(read('components/TerminalView.tsx')).toContain('const holdRowsOnTouch = phoneTerminalLayout();');
  });

  it('nothing sets the unused keyboard marker any more', () => {
    expect(files(SRC).filter(p => /dataset\.ime\b|data-ime/.test(readFileSync(p, 'utf8')))).toEqual([]);
  });
});
