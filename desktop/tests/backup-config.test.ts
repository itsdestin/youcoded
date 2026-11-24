// The one owner of the saved-backup-settings file (backup fixes 2026-11-18, B-2): a last-known-good copy on every
// write, automatic restore of a damaged file, a salvage that never guesses, and a safe last resort.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/main/logger', () => ({ log: vi.fn() }));
import {
  classifyConfigText, salvageConfigText, readBackupConfig, updateBackupConfig, startFreshBackupConfig,
  readRecoveryNote, clearRecoveryNote, ConfigDamagedError,
} from '../src/main/backup-config';

let dir: string;
let cfg: string;
const good = () => `${cfg}.good`;
const entry = (id: string) => ({ id, type: 'drive', label: id, syncEnabled: true, config: { DRIVE_ROOT: 'Claude' } });
const names = () => fs.readdirSync(dir);

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-config-')); cfg = path.join(dir, 'config.json'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('what the text means (one definition for every reader)', () => {
  it.each([['', 'empty'], ['  \n', 'empty'], ['{}', 'ok'], ['{"a":1}', 'ok'], ['{"a":', 'damaged'], ['[]', 'damaged'], ['"x"', 'damaged']])('%j is %s', (t, kind) => {
    expect(classifyConfigText(t).kind).toBe(kind);
  });
});

describe('writing keeps a last-known-good copy', () => {
  it('every successful write leaves the same whole content in config.json.good', async () => {
    await updateBackupConfig(cfg, (c) => { c.storage_backends = [entry('drive-1')]; });
    expect(JSON.parse(fs.readFileSync(good(), 'utf8'))).toEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')));
    expect(names().filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('a write that cannot be serialised throws and leaves both files as they were', async () => {
    await updateBackupConfig(cfg, (c) => { c.a = 1; });
    const before = fs.readFileSync(good(), 'utf8');
    const circular: any = {}; circular.self = circular;
    await expect(updateBackupConfig(cfg, (c) => { c.bad = circular; })).rejects.toThrow();
    expect(fs.readFileSync(cfg, 'utf8')).toBe(before);
    expect(fs.readFileSync(good(), 'utf8')).toBe(before);
  });

  it('two changes started together are both kept (one at a time)', async () => {
    await Promise.all([
      updateBackupConfig(cfg, (c) => { c.a = 1; }),
      updateBackupConfig(cfg, (c) => { c.b = 2; }),
    ]);
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8'))).toMatchObject({ a: 1, b: 2 });
  });
});

describe('empty is the normal first run', () => {
  it.each([['missing', null], ['zero-byte', ''], ['blank', ' \n']])('a %s file reads as empty and nothing is moved', async (_n, content) => {
    if (content !== null) fs.writeFileSync(cfg, content);
    expect(await readBackupConfig(cfg)).toEqual({ ok: true, config: {} });
    expect(names().filter((n) => n.includes('damaged'))).toEqual([]);
  });
});

describe('a damaged file with a good copy is restored automatically', () => {
  beforeEach(async () => {
    await updateBackupConfig(cfg, (c) => { c.setup_completed = true; c.storage_backends = [entry('drive-1'), entry('drive-2')]; });
    fs.writeFileSync(cfg, '{"storage_backends":[{"id":"drive-1","ty'); // cut off mid-write
  });

  it('brings back the whole last saved settings, including other keys', async () => {
    const r = await readBackupConfig(cfg);
    expect(r.ok && r.config.setup_completed).toBe(true);
    expect(r.ok && r.config.storage_backends.map((b: any) => b.id)).toEqual(['drive-1', 'drive-2']);
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8')).storage_backends).toHaveLength(2);
  });

  it('keeps the damaged file under a dated name and never deletes it', async () => {
    await readBackupConfig(cfg);
    const kept = names().filter((n) => n.startsWith('config.json.damaged-'));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, kept[0]), 'utf8')).toBe('{"storage_backends":[{"id":"drive-1","ty');
  });

  it('leaves a note saying it was restored, until it is cleared', async () => {
    await readBackupConfig(cfg);
    const note = await readRecoveryNote(cfg);
    expect(note).toMatchObject({ kind: 'restored', backups: 2 });
    expect(note!.damagedCopy.startsWith('config.json.damaged-')).toBe(true);
    await clearRecoveryNote(cfg);
    expect(await readRecoveryNote(cfg)).toBeNull();
  });

  it('a second read does not repair again or add another damaged copy', async () => {
    await readBackupConfig(cfg);
    await readBackupConfig(cfg);
    expect(names().filter((n) => n.includes('damaged-'))).toHaveLength(1);
  });

  it('two reads at the same moment repair once', async () => {
    const [a, b] = await Promise.all([readBackupConfig(cfg), readBackupConfig(cfg)]);
    expect(a.ok && b.ok).toBe(true);
    expect(names().filter((n) => n.includes('damaged-'))).toHaveLength(1);
  });

  it('a zero-byte file beside a good copy is restored too (what an old crash leaves)', async () => {
    fs.writeFileSync(cfg, '');
    const r = await readBackupConfig(cfg);
    expect(r.ok && r.config.storage_backends).toHaveLength(2);
  });

  it('a file that cannot be read at all (a folder in its place) is restored and the folder is kept aside', async () => {
    fs.rmSync(cfg); fs.mkdirSync(cfg);
    const r = await readBackupConfig(cfg);
    expect(r.ok && r.config.storage_backends).toHaveLength(2);
    expect(fs.statSync(cfg).isFile()).toBe(true);
    expect(names().some((n) => n.startsWith('config.json.damaged-'))).toBe(true);
  });

  it('a damaged good copy is not trusted: falls through to salvage, then to the safe last resort', async () => {
    fs.writeFileSync(good(), '{"nope');
    const r = await readBackupConfig(cfg);
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{"storage_backends":[{"id":"drive-1","ty');
  });
});

describe('salvage reads only what is complete, never a guess', () => {
  const full = JSON.stringify({ setup_completed: true, storage_backends: [entry('drive-1'), entry('drive-2')], PERSONAL_SYNC_BACKEND: 'drive' }, null, 2);

  it('keeps the complete backup entries before the break and drops the cut-off one', () => {
    const cut = full.slice(0, full.indexOf('"drive-2"') + 4); // inside the second entry
    const s = salvageConfigText(cut)!;
    expect(s.config.storage_backends.map((b: any) => b.id)).toEqual(['drive-1']);
    expect(s.config.setup_completed).toBe(true);
    expect(s.backups).toBe(1);
  });

  it('keeps entries and keys that precede a break after the list', () => {
    const cut = full.slice(0, full.indexOf('"PERSONAL_SYNC_BACKEND"') + 30);
    const s = salvageConfigText(cut)!;
    expect(s.config.storage_backends).toHaveLength(2);
    expect(s.config.PERSONAL_SYNC_BACKEND).toBeUndefined(); // value cut off: not guessed
  });

  it('a number or word at the very end is not trusted (12 could have been 123)', () => {
    const s = salvageConfigText('{"storage_backends":[{"id":"a","type":"drive"}],"x":12')!;
    expect(s.config.x).toBeUndefined();
    expect(s.config.storage_backends).toHaveLength(1);
  });

  it('returns nothing when no backup entry is complete (nothing worth keeping, migrating would be a guess)', () => {
    expect(salvageConfigText('{"storage_backends":[{"id":"drive-1","ty')).toBeNull();
    expect(salvageConfigText('{"setup_completed":true,')).toBeNull();
    expect(salvageConfigText('garbage')).toBeNull();
  });

  it('skips an entry that is complete JSON but not a backup (no id/type)', () => {
    const s = salvageConfigText('{"storage_backends":[{"foo":1},{"id":"a","type":"drive"}')!;
    expect(s.config.storage_backends.map((b: any) => b.id)).toEqual(['a']);
  });

  it('strings holding braces and quotes do not confuse it', () => {
    const e = { id: 'a', type: 'drive', label: 'we "ird} ]name', config: {} };
    const s = salvageConfigText(`{"storage_backends":[${JSON.stringify(e)},{"id":"b","ty`)!;
    expect(s.config.storage_backends[0].label).toBe('we "ird} ]name');
  });

  it('with no good copy, a cut-off file is salvaged, moved aside, and the note says "salvaged"', async () => {
    fs.writeFileSync(cfg, full.slice(0, full.indexOf('"drive-2"') + 4));
    const r = await readBackupConfig(cfg);
    expect(r.ok && r.config.storage_backends).toHaveLength(1);
    expect(await readRecoveryNote(cfg)).toMatchObject({ kind: 'salvaged', backups: 1 });
    expect(names().filter((n) => n.startsWith('config.json.damaged-'))).toHaveLength(1);
  });
});

describe('last resort: nothing readable', () => {
  const DAMAGED = '{"storage_backends":[{"id":"drive-1","ty';
  beforeEach(() => fs.writeFileSync(cfg, DAMAGED));

  it('reads as damaged, writes nothing, moves nothing', async () => {
    expect((await readBackupConfig(cfg)).ok).toBe(false);
    expect(fs.readFileSync(cfg, 'utf8')).toBe(DAMAGED);
    expect(names()).toEqual(['config.json']);
  });

  it('a change is refused with the plain reason and the file is untouched', async () => {
    await expect(updateBackupConfig(cfg, (c) => { c.a = 1; })).rejects.toBeInstanceOf(ConfigDamagedError);
    await expect(updateBackupConfig(cfg, () => {})).rejects.toThrow(/couldn't be read, so nothing was changed/);
    expect(fs.readFileSync(cfg, 'utf8')).toBe(DAMAGED);
  });

  it('"Start fresh" moves it aside under a dated name, and the next read is the normal first run', async () => {
    const aside = await startFreshBackupConfig(cfg);
    expect(aside).toMatch(/^config\.json\.damaged-\d{8}-\d{6}/);
    expect(fs.readFileSync(path.join(dir, aside!), 'utf8')).toBe(DAMAGED);
    expect(fs.existsSync(cfg)).toBe(false);
    expect(await readBackupConfig(cfg)).toEqual({ ok: true, config: {} });
  });

  it('"Start fresh" twice in a second never overwrites the first kept file', async () => {
    const a = await startFreshBackupConfig(cfg);
    fs.writeFileSync(cfg, DAMAGED + 'x');
    const b = await startFreshBackupConfig(cfg);
    expect(a).not.toBe(b);
    expect(fs.existsSync(path.join(dir, a!))).toBe(true);
  });

  it('"Start fresh" refuses to move a healthy file', async () => {
    fs.writeFileSync(cfg, '{"a":1}');
    expect(await startFreshBackupConfig(cfg)).toBeNull();
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{"a":1}');
  });
});
