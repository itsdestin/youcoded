import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readdirSync, statSync } from 'fs';
import { readStripped, assertPatternMatches } from './helpers/guard-scope';

// The one reader/writer of ~/.claude/settings.json (2026-09-16 audit D5/W4).
// Everything here runs against a temp home: the real file is shared between
// the dev instance and Destin's built app.

const mod = await import('../src/main/claude-settings');
const { readSettings, mutateSettings, getField, setField, settingsPath, __resetSettingsMemo } = mod;

let tmpHome: string;
let origHomedir: typeof os.homedir;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-claude-settings-'));
  origHomedir = os.homedir;
  (os as any).homedir = () => tmpHome;
  __resetSettingsMemo();
});

afterEach(() => {
  (os as any).homedir = origHomedir;
  vi.restoreAllMocks();
  try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3 }); } catch {}
});

function write(content: string) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), content);
}

describe('readSettings', () => {
  it('reads the file once and serves later reads from the memo until it changes', () => {
    write(JSON.stringify({ a: 1 }));
    const readSpy = vi.spyOn(fs, 'readFileSync');
    expect(readSettings()).toEqual({ a: 1 });
    expect(readSettings()).toEqual({ a: 1 });
    expect(readSettings()).toEqual({ a: 1 });
    expect(readSpy).toHaveBeenCalledTimes(1);
    // A change on disk (different size) is seen on the next read.
    write(JSON.stringify({ a: 1, b: 22 }));
    expect(readSettings()).toEqual({ a: 1, b: 22 });
    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it('answers {} for a missing file and for one that does not parse', () => {
    expect(readSettings()).toEqual({});
    write('{ nope');
    expect(readSettings()).toEqual({});
    write('[1, 2]');
    expect(readSettings()).toEqual({});
  });
});

describe('mutateSettings', () => {
  it('creates the file when absent', async () => {
    const r = await mutateSettings((s) => { s.x = 1; });
    expect(r).toEqual({ written: true });
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))).toEqual({ x: 1 });
  });

  it('does not write when the mutator changed nothing — even if the file was formatted differently', async () => {
    write('{"x":1,"y":[1,2]}'); // compact, not the pretty form we would write
    const before = fs.statSync(settingsPath()).mtimeMs;
    const r = await mutateSettings((s) => { s.x = 1; });
    expect(r).toEqual({ written: false });
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{"x":1,"y":[1,2]}');
    expect(fs.statSync(settingsPath()).mtimeMs).toBe(before);
  });

  it('writes atomically: the file is replaced whole and no temp file is left behind', async () => {
    write(JSON.stringify({ keep: true }));
    const r = await mutateSettings((s) => { s.added = 'yes'; });
    expect(r.written).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))).toEqual({ keep: true, added: 'yes' });
    const leftovers = fs.readdirSync(path.dirname(settingsPath())).filter((n) => n !== 'settings.json');
    expect(leftovers).toEqual([]);
    // The read memo saw the write.
    expect(readSettings()).toEqual({ keep: true, added: 'yes' });
  });

  // THE RULE (Destin, 2026-09-17): a corrupt file is moved aside, never lost,
  // and a fresh one is written so the app keeps working.
  it('backs up a file that does not parse beside itself and writes a fresh one', async () => {
    write('{ "hooks": { broken');
    const r = await mutateSettings((s) => { s.x = 1; });
    expect(r.written).toBe(true);
    expect(r.repaired?.backupPath).toMatch(/settings\.json\.corrupt-\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
    expect(fs.readFileSync(r.repaired!.backupPath, 'utf8')).toBe('{ "hooks": { broken');
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))).toEqual({ x: 1 });
  });

  it('a repaired file is written even when the mutator changes nothing, and is not backed up twice', async () => {
    write('[]'); // valid JSON, not a settings object — corrupt for our purposes
    const first = await mutateSettings(() => {});
    expect(first).toMatchObject({ written: true, repaired: { backupPath: expect.any(String) } });
    expect(fs.readFileSync(first.repaired!.backupPath, 'utf8')).toBe('[]');
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{}');
    const second = await mutateSettings((s) => { s.y = 2; });
    expect(second).toEqual({ written: true });
    const backups = fs.readdirSync(path.dirname(settingsPath())).filter((n) => n.includes('.corrupt-'));
    expect(backups).toHaveLength(1);
  });

  it('a READ of a corrupt file answers {} and leaves the file in place — the next write repairs it', () => {
    write('{ nope');
    expect(readSettings()).toEqual({});
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{ nope');
    expect(fs.readdirSync(path.dirname(settingsPath())).filter((n) => n.includes('.corrupt-'))).toEqual([]);
  });

  it('serialises concurrent mutators under the lock so neither update is lost', async () => {
    write(JSON.stringify({ base: true }));
    await Promise.all([
      mutateSettings((s) => { s.first = 1; }),
      mutateSettings((s) => { s.second = 2; }),
      mutateSettings((s) => { s.third = 3; }),
    ]);
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))).toEqual({ base: true, first: 1, second: 2, third: 3 });
  });

  it('breaks a stale lock left by a crashed process and proceeds', async () => {
    write(JSON.stringify({}));
    const lock = `${settingsPath()}.lock`;
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const r = await mutateSettings((s) => { s.after = true; });
    expect(r.written).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))).toEqual({ after: true });
  });

  it('releases the lock when the mutator throws, and writes nothing', async () => {
    write(JSON.stringify({ a: 1 }));
    await expect(mutateSettings(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(fs.existsSync(`${settingsPath()}.lock`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))).toEqual({ a: 1 });
    const r = await mutateSettings((s) => { s.b = 2; });
    expect(r.written).toBe(true);
  });
});

describe('getField / setField', () => {
  it('reads and writes a dot-path field', async () => {
    expect(getField('permissions.defaultMode')).toBeUndefined();
    expect(await setField('permissions.defaultMode', 'plan')).toBe(true);
    expect(getField('permissions.defaultMode')).toBe('plan');
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))).toEqual({ permissions: { defaultMode: 'plan' } });
  });

  it('deletes the leaf on null and reports true when nothing had to change', async () => {
    await setField('editorMode', 'vim');
    expect(await setField('editorMode', null)).toBe(true);
    expect(getField('editorMode')).toBeUndefined();
    expect(await setField('editorMode', null)).toBe(true);
  });

  it('walks INTO an array setting instead of clobbering it', async () => {
    write(JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    expect(await setField('permissions.allow.1', 'Bash(pwd)')).toBe(true);
    expect(getField('permissions.allow')).toEqual(['Bash(ls)', 'Bash(pwd)']);
  });

  it('refuses a prototype-polluting path without touching the file or Object.prototype', async () => {
    write(JSON.stringify({ a: 1 }));
    expect(await setField('__proto__.polluted', true)).toBe(false);
    expect(await setField('constructor.prototype.polluted', true)).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(JSON.stringify({ a: 1 }));
    expect(() => getField('__proto__')).toThrow();
  });

  it('repairs a corrupt file on the way through, keeping the original beside it', async () => {
    write('{ nope');
    expect(await setField('theme', 'dark')).toBe(true);
    expect(getField('theme')).toBe('dark');
    const backups = fs.readdirSync(path.dirname(settingsPath())).filter((n) => n.includes('.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(settingsPath()), backups[0]), 'utf8')).toBe('{ nope');
  });
});

// Source guard: nothing outside claude-settings.ts names the settings file in
// code. The two allowed mentions are reads of the PATH for transport, not of
// the file's content. Comments are blanked first (readStripped), so the WHY
// notes that quote the old readers do not count.
describe('settings.json has one reader and one writer', () => {
  const MAIN = path.join(__dirname, '..', 'src', 'main');
  const ALLOWED: Record<string, string> = {
    'claude-settings.ts': 'the module itself',
    'sync-service.ts': 'copies the file into the sync space by path — never parses or edits it',
    'sync-state.ts': 'checks whether the file exists by path',
  };
  const PATTERN = /settings\.json/;

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== 'eval') out.push(...walk(full)); }
      else if (name.endsWith('.ts') && !name.includes('.test.')) out.push(full);
    }
    return out;
  }

  it('every code mention of settings.json under src/main is claude-settings.ts or an allowed path-only use', () => {
    assertPatternMatches(PATTERN, "path.join(os.homedir(), '.claude', 'settings.json')", 'the settings path');
    const files = walk(MAIN);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((f) => PATTERN.test(readStripped(f)))
      .map((f) => path.relative(MAIN, f))
      .filter((rel) => !(rel in ALLOWED));
    expect(offenders, 'route settings.json access through claude-settings.ts').toEqual([]);
  });
});
