// A damaged settings file must never be read as "no backups" and written back (backup fixes 2026-11-18, D-5).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as state from '../src/main/sync-state';

let home: string;
let cfg: string;
const DAMAGED = '{"storage_backends":[{"id":"drive-1","type":"dr';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-state-cfg-'));
  state.setClaudeDirForTests(home);
  cfg = path.join(home, '.claude', 'toolkit-state', 'config.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

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

describe('a missing settings file', () => {
  it('is the normal first run: the first backup can be added', async () => {
    const b = await state.addBackend({ type: 'drive', label: 'My Drive', syncEnabled: true, config: {} });
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8')).storage_backends[0].id).toBe(b.id);
  });
});
