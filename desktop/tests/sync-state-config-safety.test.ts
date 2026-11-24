// A damaged settings file must never be read as "no backups" and written back (backup fixes 2026-11-18, D-5).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
vi.mock('../src/main/logger', () => ({ log: vi.fn() }));
import * as state from '../src/main/sync-state';
import { log } from '../src/main/logger';

let home: string;
let cfg: string;
const DAMAGED = '{"storage_backends":[{"id":"drive-1","type":"dr';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-state-cfg-'));
  state.setClaudeDirForTests(home);
  cfg = path.join(home, '.claude', 'toolkit-state', 'config.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

describe('a damaged settings file', () => {
  beforeEach(() => fs.writeFileSync(cfg, DAMAGED));
  const untouched = () => expect(fs.readFileSync(cfg, 'utf8')).toBe(DAMAGED);

  it('reading the status or the config writes nothing', async () => {
    expect((await state.getSyncStatus()).backends).toEqual([]);
    expect((await state.getSyncConfig()).backends).toEqual([]);
    untouched();
  });

  it('adding, updating, removing and saving a backup all refuse, and leave the file as it was', async () => {
    await expect(state.addBackend({ type: 'drive', label: 'x', syncEnabled: true, config: {} })).rejects.toThrow(/couldn't be read/);
    await expect(state.updateBackend('drive-1', { label: 'y' })).rejects.toThrow(/couldn't be read/);
    await expect(state.removeBackend('drive-1')).rejects.toThrow(/couldn't be read/);
    await expect(state.setSyncConfig({ backends: [] })).rejects.toThrow(/couldn't be read/);
    untouched();
  });
});

// Review F3: "empty" means the same thing to every reader of config.json.
describe.each([['zero-byte', ''], ['whitespace-only', '  \n']])('a %s settings file', (_n, content) => {
  it('is the normal first run: it reads as no backups and the first backup can be added', async () => {
    fs.writeFileSync(cfg, content);
    expect((await state.getSyncStatus()).backends).toEqual([]);
    const b = await state.addBackend({ type: 'drive', label: 'My Drive', syncEnabled: true, config: {} });
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8')).storage_backends[0].id).toBe(b.id);
  });
});

// Review M11: a settings file that cannot be READ (not just one that cannot be parsed) is never treated as empty.
describe('a settings file that cannot be read at all (a folder where the file should be)', () => {
  beforeEach(() => { fs.mkdirSync(cfg); });
  it('reads as no backups, and every write refuses with the plain reason', async () => {
    expect((await state.getSyncStatus()).backends).toEqual([]);
    await expect(state.addBackend({ type: 'drive', label: 'x', syncEnabled: true, config: {} })).rejects.toThrow(/couldn't be read/);
    await expect(state.setSyncConfig({ backends: [] })).rejects.toThrow(/couldn't be read/);
    expect(fs.statSync(cfg).isDirectory()).toBe(true);
  });
});

describe('a missing settings file', () => {
  it('is the normal first run: the first backup can be added', async () => {
    const b = await state.addBackend({ type: 'drive', label: 'My Drive', syncEnabled: true, config: {} });
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8')).storage_backends[0].id).toBe(b.id);
  });
});

const entry = (id: string) => ({ id, type: 'drive', label: id, syncEnabled: true, config: {} });
/** Make every write that replaces config.json fail, like a full disk (the write goes through a temp file and a rename). */
const failConfigWrites = () => {
  const real = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation((async (a: any, b: any) => {
    if (String(b) === cfg && String(a).includes('.tmp.')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return real(a, b);
  }) as any);
};

describe('a repair that cannot be saved (F-C)', () => {
  beforeEach(async () => {
    await state.addBackend({ type: 'drive', label: 'My Drive', syncEnabled: true, config: {} });
    fs.writeFileSync(cfg, '{"storage_backends":[{"id":"drive-my-drive","ty');
    failConfigWrites();
  });
  it('shows "couldn\'t be saved" with Try again, never the unreadable notice or Start fresh', async () => {
    const w = (await state.getSyncStatus()).warnings.filter((x) => x.code.startsWith('CONFIG_'));
    expect(w.map((x) => x.code)).toEqual(['CONFIG_WRITE_FAILED']);
    expect(w[0].fixAction).toMatchObject({ label: 'Try again', kind: 'recheck-settings' });
    expect(w[0].body).not.toMatch(/unreadable|Start fresh/);
  });
  it('Start fresh refuses and leaves the file where it is', async () => {
    expect(await state.startFreshBackupSettings()).toBe(false);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{"storage_backends":[{"id":"drive-my-drive","ty');
  });
  it('Try again (reading the status again) repairs it once saving works', async () => {
    vi.restoreAllMocks();
    expect((await state.getSyncStatus()).backends.map((b) => b.id)).toEqual(['drive-my-drive']);
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8')).storage_backends).toHaveLength(1);
  });
});

describe('the repair notice can be dismissed at once (F-E)', () => {
  it('dismissing a notice the panel built from the file, before any health check stored it, ends it for good', async () => {
    await state.addBackend({ type: 'drive', label: 'My Drive', syncEnabled: true, config: {} });
    fs.writeFileSync(cfg, '{"storage_backends":[{"id":"x"'); // damaged while the app runs
    const first = (await state.getSyncStatus()).warnings.map((w) => w.code);
    expect(first).toContain('CONFIG_RESTORED');
    expect(await state.readWarnings()).toEqual([]); // not stored anywhere yet
    await state.dismissWarning('CONFIG_RESTORED');
    expect((await state.getSyncStatus()).warnings.map((w) => w.code)).not.toContain('CONFIG_RESTORED');
    expect(fs.existsSync(`${cfg}.recovered.json`)).toBe(false);
  });
});

describe('a migration that cannot be saved is not hidden (F-G)', () => {
  it('still answers with the migrated list for this read, and logs the failed save', async () => {
    fs.writeFileSync(cfg, JSON.stringify({ PERSONAL_SYNC_BACKEND: 'drive', DRIVE_ROOT: 'Claude' }));
    failConfigWrites();
    const list = await state.readBackendInstances();
    expect(list.map((b) => b.id)).toEqual(['drive-default']);
    expect(log).toHaveBeenCalledWith('WARN', 'sync-state', expect.stringMatching(/migrated backup list/), expect.anything());
  });
});

describe('deliberate edits refresh the safety copy; silent ones never shrink it (F-A)', () => {
  it('removing the last backup does update the copy (the person asked for it)', async () => {
    await state.addBackend({ type: 'drive', label: 'My Drive', syncEnabled: true, config: {} });
    await state.removeBackend('drive-my-drive');
    expect(JSON.parse(fs.readFileSync(`${cfg}.good`, 'utf8')).storage_backends).toEqual([]);
  });
  it('a missing file with a safety copy is restored by the status read, not turned into an empty list', async () => {
    await state.addBackend({ type: 'drive', label: 'My Drive', syncEnabled: true, config: {} });
    fs.rmSync(cfg);
    expect((await state.getSyncStatus()).backends).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(`${cfg}.good`, 'utf8')).storage_backends).toHaveLength(1);
  });
});
