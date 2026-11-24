// The one owner of the saved-backup-settings file (backup fixes 2026-11-18, B-2): a last-known-good copy on every
// write, automatic restore of a damaged file, a salvage that never guesses, and a safe last resort.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/main/logger', () => ({ log: vi.fn() }));
// Lets a test make a particular write fail, land wrong, or stop (a crash) — everything else really writes.
const hook = vi.hoisted(() => ({ fn: null as null | ((target: string, content: string) => Promise<void> | undefined) }));
vi.mock('../src/main/atomic-write', async (orig) => {
  const real = await orig<typeof import('../src/main/atomic-write')>();
  return { ...real, atomicWrite: async (t: string, c: string, o?: any) => { const r = hook.fn?.(t, c); return r ?? real.atomicWrite(t, c, o); } };
});
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
afterEach(() => { hook.fn = null; vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

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
    expect(salvageConfigText('{"setup_completed":false,')).toBeNull();
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

// ---- review 2026-11-24 ----------------------------------------------------------------------------------------
const backends = (c: any) => (c.storage_backends ?? []).map((b: any) => b.id);
const seed = async (...ids: string[]) => { await updateBackupConfig(cfg, (c) => { c.setup_completed = true; c.storage_backends = ids.map(entry); }, { explicit: true }); };

describe('a missing file beside a good copy (F-A)', () => {
  it('is restored from the good copy and the person is told', async () => {
    await seed('drive-1', 'drive-2');
    fs.rmSync(cfg); // e.g. a stop between "damaged file moved aside" and "repaired file written"
    const r = await readBackupConfig(cfg);
    expect(r.ok && backends(r.config)).toEqual(['drive-1', 'drive-2']);
    expect(fs.existsSync(cfg)).toBe(true);
    expect(await readRecoveryNote(cfg)).toMatchObject({ kind: 'restored', backups: 2 });
  });
  it('a true first run (no good copy either) is still just empty', async () => {
    expect(await readBackupConfig(cfg)).toEqual({ ok: true, config: {} });
    expect(fs.existsSync(cfg)).toBe(false);
  });
  it('the next harmless write after such a stop does not replace the good copy with an empty one', async () => {
    await seed('drive-1', 'drive-2');
    fs.rmSync(cfg);
    await updateBackupConfig(cfg, (c) => { c.storage_backends = c.storage_backends ?? []; }); // like the status poll's migration
    expect(backends(JSON.parse(fs.readFileSync(good(), 'utf8')))).toEqual(['drive-1', 'drive-2']);
  });
  it('a silent write never replaces a copy that holds more backups; a deliberate edit does', async () => {
    await seed('drive-1', 'drive-2');
    fs.writeFileSync(cfg, JSON.stringify({ storage_backends: [] })); // a valid but emptier live file
    await updateBackupConfig(cfg, (c) => { c.x = 1; });
    expect(backends(JSON.parse(fs.readFileSync(good(), 'utf8')))).toEqual(['drive-1', 'drive-2']);
    await updateBackupConfig(cfg, (c) => { c.x = 2; }, { explicit: true });
    expect(backends(JSON.parse(fs.readFileSync(good(), 'utf8')))).toEqual([]);
  });
});

describe('two copies of the app repairing at once (F-B)', () => {
  const DAMAGED = '{"storage_backends":[{"id":"drive-1","ty';
  it('the one that finds the file already moved aside re-reads and gets the repaired settings, never "damaged"', async () => {
    await seed('drive-1', 'drive-2');
    fs.writeFileSync(cfg, DAMAGED);
    const real = fs.promises.rename.bind(fs.promises);
    let first = true;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (a: any, b: any) => {
      if (first) { first = false; fs.writeFileSync(cfg, fs.readFileSync(good(), 'utf8')); throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } // the other copy repaired it
      return real(a, b);
    });
    const r = await readBackupConfig(cfg);
    expect(r.ok && backends(r.config)).toEqual(['drive-1', 'drive-2']);
  });
  it('if what it moved aside turns out to be the other copy\'s repaired file, it puts it back', async () => {
    await seed('drive-1', 'drive-2');
    fs.writeFileSync(cfg, DAMAGED);
    const real = fs.promises.rename.bind(fs.promises);
    let first = true;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (a: any, b: any) => {
      if (first) { first = false; fs.writeFileSync(cfg, JSON.stringify({ storage_backends: [entry('later-save')] })); } // repaired AND saved by the other copy
      return real(a, b);
    });
    const r = await readBackupConfig(cfg);
    expect(r.ok && backends(r.config)).toEqual(['later-save']);
    expect(backends(JSON.parse(fs.readFileSync(cfg, 'utf8')))).toEqual(['later-save']);
    expect(names().filter((n) => n.includes('damaged-'))).toEqual([]);
  });
  it('a repair another copy finished between the first look and the move is not repeated (re-check before moving)', async () => {
    await seed('drive-1', 'drive-2');
    fs.writeFileSync(cfg, DAMAGED);
    const real = fs.promises.readFile.bind(fs.promises);
    let swapped = false;
    vi.spyOn(fs.promises, 'readFile').mockImplementation((async (p: any, ...rest: any[]) => {
      const out = await (real as any)(p, ...rest);
      if (!swapped && String(p) === good()) { swapped = true; fs.writeFileSync(cfg, JSON.stringify({ storage_backends: [entry('other-repair')] })); }
      return out;
    }) as any);
    const renames = vi.spyOn(fs.promises, 'rename');
    const r = await readBackupConfig(cfg);
    expect(r.ok && backends(r.config)).toEqual(['other-repair']);
    expect(renames.mock.calls.filter((c) => String(c[0]) === cfg)).toEqual([]); // nothing was moved: the re-check stopped it first
    expect(names().filter((n) => n.includes('damaged-'))).toEqual([]);
  });
});

describe('a repair that cannot be saved is not "damaged" (F-C)', () => {
  const DAMAGED = '{"storage_backends":[{"id":"drive-1","ty';
  beforeEach(async () => {
    await seed('drive-1', 'drive-2');
    fs.writeFileSync(cfg, DAMAGED);
    hook.fn = (t) => (t === cfg ? Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })) : undefined);
  });
  it('reports a write failure, leaves the original file in place, and offers no Start fresh', async () => {
    const r = await readBackupConfig(cfg);
    expect(r).toMatchObject({ ok: false, kind: 'write-failed' });
    expect(fs.readFileSync(cfg, 'utf8')).toBe(DAMAGED); // the undo put it back
    expect(names().filter((n) => n.includes('damaged-'))).toEqual([]);
    expect(await startFreshBackupConfig(cfg)).toBeNull();
    expect(fs.readFileSync(cfg, 'utf8')).toBe(DAMAGED);
  });
  it('a change is refused with the write-failure sentence, not the "couldn\'t be read" one', async () => {
    await expect(updateBackupConfig(cfg, () => {})).rejects.toMatchObject({ kind: 'write-failed', message: expect.stringMatching(/repair couldn't be saved/) });
  });
  it('"Start fresh" refuses when only a salvage (no good copy) was possible and could not be saved', async () => {
    fs.rmSync(good());
    const cut = JSON.stringify({ setup_completed: true, storage_backends: [entry('a'), entry('b')] }, null, 2);
    fs.writeFileSync(cfg, cut.slice(0, cut.indexOf('"b"')));
    expect(await readBackupConfig(cfg)).toMatchObject({ ok: false, kind: 'write-failed' });
    expect(await startFreshBackupConfig(cfg)).toBeNull();
    expect(fs.existsSync(cfg)).toBe(true);
  });
  it('after the disk problem clears, the same read repairs it', async () => {
    hook.fn = null;
    const r = await readBackupConfig(cfg);
    expect(r.ok && backends(r.config)).toEqual(['drive-1', 'drive-2']);
  });
  it('"Start fresh" also refuses while a good copy exists even if the damaged file is unreadable to a repair', async () => {
    hook.fn = null;
    expect(await startFreshBackupConfig(cfg)).toBeNull(); // repairable: nothing to set aside
    expect(fs.existsSync(cfg)).toBe(true);
  });
});

describe('the good copy never runs ahead of a lost change, nor behind a removal (F-D)', () => {
  it('a stop between the two writes cannot bring back a backup the person removed', async () => {
    await seed('keep', 'removed');
    const before = fs.readFileSync(cfg, 'utf8');
    let calls = 0;
    hook.fn = () => (++calls === 1 ? undefined : Promise.reject(new Error('the app stopped here'))); // good copy lands, then everything stops (even the roll-back)
    await expect(updateBackupConfig(cfg, (c) => { c.storage_backends = c.storage_backends.filter((b: any) => b.id !== 'removed'); }, { explicit: true })).rejects.toThrow();
    hook.fn = null;
    expect(fs.readFileSync(cfg, 'utf8')).toBe(before); // the live file still has the old state
    fs.writeFileSync(cfg, '{"storage_backends":[{"id":"x","ty'); // later damage
    const r = await readBackupConfig(cfg);
    expect(r.ok && backends(r.config)).toEqual(['keep']); // the removal holds: the copy is never OLDER than the file
  });
  it('a write that fails (not a stop) rolls the copy back, so a change reported as failed never returns', async () => {
    await seed('a', 'b');
    const goodBefore = fs.readFileSync(good(), 'utf8');
    hook.fn = (t) => (t === cfg ? Promise.reject(new Error('EIO')) : undefined);
    await expect(updateBackupConfig(cfg, (c) => { c.storage_backends = [entry('a')]; }, { explicit: true })).rejects.toThrow('EIO');
    expect(fs.readFileSync(good(), 'utf8')).toBe(goodBefore);
  });
  it('a write that did not land as written (cut short) counts as failed and rolls the copy back', async () => {
    await seed('a', 'b');
    const goodBefore = fs.readFileSync(good(), 'utf8');
    const liveBefore = fs.readFileSync(cfg, 'utf8');
    hook.fn = (t, c) => (t === cfg ? fs.promises.writeFile(cfg, c.slice(0, 10)) : undefined);
    await expect(updateBackupConfig(cfg, (c) => { c.storage_backends = [entry('a')]; }, { explicit: true })).rejects.toThrow(/did not read back/);
    expect(fs.readFileSync(good(), 'utf8')).toBe(goodBefore);
    expect(liveBefore).not.toBe(fs.readFileSync(cfg, 'utf8')); // (the cut-short live file is what the next read repairs)
    hook.fn = null;
    const r = await readBackupConfig(cfg);
    expect(r.ok && backends(r.config)).toEqual(['a', 'b']);
  });
});

describe('salvage keeps the setup flag (F-F)', () => {
  it('keeps setup_completed when it was written before the cut, even with no complete backup entry', () => {
    const s = salvageConfigText('{"setup_completed":true,"storage_backends":[{"id":"drive-1","ty')!;
    expect(s.config).toEqual({ setup_completed: true, storage_backends: [] });
    expect(s.backups).toBe(0);
  });
  it('new writes put the long backup list LAST, so a cut keeps the small values before it', async () => {
    await seed('a', 'b');
    const text = fs.readFileSync(cfg, 'utf8');
    expect(text.indexOf('"setup_completed"')).toBeLessThan(text.indexOf('"storage_backends"'));
    const cut = text.slice(0, text.indexOf('"b"'));
    expect(salvageConfigText(cut)!.config.setup_completed).toBe(true);
  });
});
