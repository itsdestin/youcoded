// Pins final review F1 (blocker), the computer's half: the YouCoded default theme reaches NEW installs
// only. main.ts records, once and before any window reads the appearance file, which default this install
// is on; appearance:get waits for that answer, and a recorded answer never changes on a later launch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { appearanceChannels, settleThemeDefault } from '../src/main/ipc/appearance';
import { IPC } from '../src/shared/backend-contract';
import { decideThemeDefault, defaultCycleFor, defaultThemeFor, guessThemeDefault } from '../src/shared/theme-default';

let home: string;
const file = () => path.join(home, '.claude', 'youcoded-appearance.json');
const get = () => (appearanceChannels.find((c) => c.name === IPC.APPEARANCE_GET) as any).handler(undefined, {});
const set = (prefs: unknown) => (appearanceChannels.find((c) => c.name === IPC.APPEARANCE_SET) as any).handler(prefs, {});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ycd-theme-default-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

describe('the host records which default this install is on', () => {
  it('an install already in use (setup finished) with no saved theme is recorded as Midnight, keeping its settings', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ reducedEffects: true }));
    void settleThemeDefault(false);
    expect(await get()).toEqual({ reducedEffects: true, defaultTheme: 'midnight' });
  });

  it('an install with no appearance file at all and setup finished is Midnight too', async () => {
    void settleThemeDefault(false);
    expect((await get()).defaultTheme).toBe('midnight');
  });

  it('a new install (setup wizard not finished) is recorded as YouCoded, and a later launch keeps it', async () => {
    await settleThemeDefault(true);
    // Next launch: the wizard has finished, so main reports "not a first run" — the first answer must win.
    void settleThemeDefault(false);
    expect((await get()).defaultTheme).toBe('youcoded');
  });

  it('appearance:set waits for the answer, so a write at startup cannot drop it', async () => {
    void settleThemeDefault(false);
    await set({ theme: 'creme' });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ defaultTheme: 'midnight', theme: 'creme' });
  });
});

describe('the defaults each kind of install gets', () => {
  it('existing installs keep Midnight and the old cycle; new installs get the YouCoded pair by light/dark', () => {
    expect(decideThemeDefault(false)).toBe('midnight');
    expect(defaultThemeFor('midnight', true)).toBe('midnight');
    expect(defaultThemeFor('midnight', false)).toBe('midnight');
    expect(defaultCycleFor('midnight')).toEqual(['midnight', 'dark']);
    expect(decideThemeDefault(true)).toBe('youcoded');
    expect(defaultThemeFor('youcoded', false)).toBe('youcoded');
    expect(defaultThemeFor('youcoded', true)).toBe('youcoded-night');
    expect(defaultCycleFor('youcoded')).toEqual(['youcoded', 'youcoded-night']);
  });

  it("the renderer's first-paint guess: the mirrored answer, else any of the app's keys means an existing install", () => {
    const storage = (entries: Record<string, string>) => ({
      getItem: (k: string) => entries[k] ?? null, key: (i: number) => Object.keys(entries)[i] ?? null,
      get length() { return Object.keys(entries).length; },
    });
    expect(guessThemeDefault(storage({}))).toBe('youcoded');
    expect(guessThemeDefault(storage({ 'youcoded-show-timestamps': '1' }))).toBe('midnight');
    expect(guessThemeDefault(storage({ 'youcoded-show-timestamps': '1', 'youcoded-theme-default': 'youcoded' }))).toBe('youcoded');
    expect(guessThemeDefault(storage({ 'other-app': 'x' }))).toBe('youcoded');
    expect(guessThemeDefault(null)).toBe('youcoded');
  });
});
