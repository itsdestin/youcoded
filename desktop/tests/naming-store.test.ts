// Disk behaviour for the naming sidecar: it writes where no older client
// looks, it refuses path escapes, and a sync conflict copy is folded in rather
// than discarded — losing a copy here would lose a name the user typed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNamingStore, createTitleQueue, mayPublishAutomaticName } from '../src/main/conversations/naming-store';
import { emptyNamingRecord, NAMING_SCHEMA_VERSION } from '../src/main/conversations/naming-core';

let root = '';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'naming-store-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

const nameOf = (p: string, id: string) => path.join(root, p, `${id}.json`);

describe('publication revalidation', () => {
  it('orders a manual rename after a pending automatic projection, even when the automatic write awaits', async () => {
    const queue = createTitleQueue();
    const shown: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const auto = queue('native/n1', async () => {
      entered();
      await gate;
      shown.push('Automatic');
    });
    await writing;
    const manual = queue('native/n1', async () => { shown.push('Manual'); });
    // Another conversation is not blocked by this one's projection.
    await queue('native/n2', async () => { shown.push('Other'); });
    expect(shown).toEqual(['Other']);
    release();
    await Promise.all([auto, manual]);
    expect(shown).toEqual(['Other', 'Automatic', 'Manual']);
  });
  it('rejects an opening writer after a newer AI review has replaced its sidecar', async () => {
    const store = createNamingStore(root);
    const opening = await store.mutate('native', 'n1', (cur) => ({ ...cur, auto: 'Opening', autoAt: '2026-09-09T10:00:00.000Z' }));
    // The initial write finished first; AI finished before its publication.
    await store.mutate('native', 'n1', (cur) => ({ ...cur, auto: 'AI review', autoAt: '2026-09-09T10:00:01.000Z' }));
    const check = (name: string, expectedAutoAt: string, openingName: boolean) => mayPublishAutomaticName({
      read: () => store.get('native', 'n1'), hasTitle: async () => false,
      name, expectedAutoAt, opening: openingName, enabled: () => true,
    });
    expect(await check('Opening', opening.autoAt, true)).toBe(false);
    expect(await check('AI review', '2026-09-09T10:00:01.000Z', false)).toBe(true);
  });

  it('rejects a legacy title arriving after the opening pre-lock check, but lets AI replace automatic names', async () => {
    const store = createNamingStore(root);
    const rec = await store.mutate('native', 'n1', (cur) => ({ ...cur, auto: 'Opening', autoAt: '2026-09-09T10:00:00.000Z' }));
    let legacy = false;
    const check = (opening: boolean) => mayPublishAutomaticName({
      read: () => store.get('native', 'n1'), hasTitle: async () => legacy,
      name: 'Opening', expectedAutoAt: rec.autoAt, opening, enabled: () => true,
    });
    expect(await check(true)).toBe(true);
    legacy = true;
    expect(await check(true)).toBe(false);
    expect(await check(false)).toBe(true);
  });

  it('refuses a rename or Off between the sidecar write and publication', async () => {
    const store = createNamingStore(root);
    const rec = await store.mutate('native', 'n1', (cur) => ({ ...cur, auto: 'AI', autoAt: '2026-09-09T10:00:00.000Z' }));
    let enabled = true;
    const check = () => mayPublishAutomaticName({
      read: () => store.get('native', 'n1'), hasTitle: async () => false,
      name: rec.auto, expectedAutoAt: rec.autoAt, enabled: () => enabled,
    });
    enabled = false;
    expect(await check()).toBe(false);
    enabled = true;
    await store.mutate('native', 'n1', (cur) => ({ ...cur, manual: 'Mine', manualAt: '2026-09-09T10:00:01.000Z' }));
    expect(await check()).toBe(false);
  });
});

describe('createNamingStore', () => {
  it('has no record until something is written', async () => {
    const store = createNamingStore(root);
    expect(await store.get('claude', 'c1')).toBeNull();
  });

  it('writes one file per conversation under <root>/<provider>/', async () => {
    const store = createNamingStore(root);
    await store.mutate('claude', 'c1', (cur) => ({ ...cur, manual: 'Mine', manualAt: '2026-09-09T10:00:00.000Z' }));
    expect(fs.existsSync(nameOf('claude', 'c1'))).toBe(true);
    expect(await store.get('claude', 'c1')).toMatchObject({ manual: 'Mine', provider: 'claude', id: 'c1' });
  });

  it('does not rewrite a record when a conditional mutation returns the locked record', async () => {
    const store = createNamingStore(root);
    const returned = await store.mutate('native', 'n1', (cur) => cur);
    expect(returned.auto).toBe('');
    expect(fs.existsSync(nameOf('native', 'n1'))).toBe(false);
  });

  it('keeps native and claude ids in separate buckets', async () => {
    const store = createNamingStore(root);
    await store.mutate('claude', 'same-id', (cur) => ({ ...cur, manual: 'CC' , manualAt: '2026-09-09T10:00:00.000Z' }));
    await store.mutate('native', 'same-id', (cur) => ({ ...cur, manual: 'Native', manualAt: '2026-09-09T10:00:00.000Z' }));
    expect((await store.get('claude', 'same-id'))!.manual).toBe('CC');
    expect((await store.get('native', 'same-id'))!.manual).toBe('Native');
  });

  it('refuses a provider or id that would escape the root', async () => {
    const store = createNamingStore(root);
    await expect(store.mutate('../..', 'c1', (c) => c)).rejects.toThrow(/invalid provider/);
    await expect(store.mutate('claude', '../escape', (c) => c)).rejects.toThrow(/invalid conversation id/);
    // The read path answers null rather than throwing across an IPC boundary.
    expect(await store.get('claude', '../escape')).toBeNull();
  });

  it('survives a corrupt file instead of throwing', async () => {
    const store = createNamingStore(root);
    fs.mkdirSync(path.join(root, 'claude'), { recursive: true });
    fs.writeFileSync(nameOf('claude', 'c1'), '{ not json');
    expect(await store.get('claude', 'c1')).toBeNull();
    // and a later write starts clean rather than refusing forever
    await store.mutate('claude', 'c1', (cur) => ({ ...cur, manual: 'Recovered', manualAt: '2026-09-09T10:00:00.000Z' }));
    expect((await store.get('claude', 'c1'))!.manual).toBe('Recovered');
  });

  it('folds a sync conflict copy in and then deletes it', async () => {
    const store = createNamingStore(root);
    await store.mutate('claude', 'c1', (cur) => ({ ...cur, auto: 'Auto from here', autoAt: '2026-09-09T10:00:00.000Z' }));
    const copy = path.join(root, 'claude', 'c1 (from phone, 2026-09-09).json');
    fs.writeFileSync(copy, JSON.stringify({
      ...emptyNamingRecord('c1', 'claude'),
      schema: NAMING_SCHEMA_VERSION,
      manual: 'Named on the phone', manualAt: '2026-09-09T11:00:00.000Z',
    }));

    const got = await store.get('claude', 'c1');
    expect(got).toMatchObject({ manual: 'Named on the phone', auto: 'Auto from here' });
    expect(fs.existsSync(copy)).toBe(false);
    // Durable, not just returned: a second read sees the folded content.
    expect((await store.get('claude', 'c1'))!.manual).toBe('Named on the phone');
  });

  it('deletes an unparseable conflict copy without losing the canonical record', async () => {
    const store = createNamingStore(root);
    await store.mutate('claude', 'c1', (cur) => ({ ...cur, manual: 'Kept', manualAt: '2026-09-09T10:00:00.000Z' }));
    const copy = path.join(root, 'claude', 'c1 (from phone, 2026-09-09).json');
    fs.writeFileSync(copy, 'garbage');
    expect((await store.get('claude', 'c1'))!.manual).toBe('Kept');
    expect(fs.existsSync(copy)).toBe(false);
  });

  it('ignores another conversation’s conflict copy', async () => {
    const store = createNamingStore(root);
    await store.mutate('claude', 'c1', (cur) => ({ ...cur, manual: 'Mine', manualAt: '2026-09-09T10:00:00.000Z' }));
    const other = path.join(root, 'claude', 'c2 (from phone, 2026-09-09).json');
    fs.writeFileSync(other, JSON.stringify({ ...emptyNamingRecord('c2', 'claude'), manual: 'Theirs' }));
    expect((await store.get('claude', 'c1'))!.manual).toBe('Mine');
    expect(fs.existsSync(other)).toBe(true);
  });

  it('remove drops the record and is safe to repeat', async () => {
    const store = createNamingStore(root);
    await store.mutate('claude', 'c1', (cur) => ({ ...cur, manual: 'Gone soon', manualAt: '2026-09-09T10:00:00.000Z' }));
    await store.remove('claude', 'c1');
    await store.remove('claude', 'c1');
    expect(await store.get('claude', 'c1')).toBeNull();
  });
});

// WHY (2026-09-24 main-blocking triage B3): get() runs on every completed
// reply and used to list the whole naming folder synchronously each time.
// These pin that the folder is listed only when it changed, that a stale or
// racy index never hides a sync conflict copy, and that nothing blocks.
describe('conflict-copy index', () => {
  const OLD = new Date(Date.now() - 60_000);
  const age = (p: string) => fs.utimesSync(path.join(root, p), OLD, OLD);
  const phoneCopy = (id: string, manual: string) => {
    fs.writeFileSync(path.join(root, 'claude', `${id} (from phone, 2026-09-09).json`), JSON.stringify({
      ...emptyNamingRecord(id, 'claude'), schema: NAMING_SCHEMA_VERSION,
      manual, manualAt: '2026-09-09T11:00:00.000Z',
    }));
  };

  it('does not re-list an unchanged folder on every read', async () => {
    const store = createNamingStore(root);
    await store.mutate('claude', 'c1', (cur) => ({ ...cur, manual: 'Mine', manualAt: '2026-09-09T10:00:00.000Z' }));
    age('claude');
    const readdir = vi.spyOn(fs.promises, 'readdir');
    for (let i = 0; i < 5; i++) expect((await store.get('claude', 'c1'))!.manual).toBe('Mine');
    expect(readdir).toHaveBeenCalledTimes(1);
  });

  it('still folds a copy that lands after the folder was indexed', async () => {
    const store = createNamingStore(root);
    await store.mutate('claude', 'c1', (cur) => ({ ...cur, auto: 'Auto', autoAt: '2026-09-09T10:00:00.000Z' }));
    age('claude');
    await store.get('claude', 'c1'); // warms a trusted index
    phoneCopy('c1', 'Named on the phone'); // bumps the folder's time
    expect(await store.get('claude', 'c1')).toMatchObject({ manual: 'Named on the phone', auto: 'Auto' });
    expect(fs.readdirSync(path.join(root, 'claude'))).toEqual(['c1.json']);
  });

  it('never trusts an index taken right after a change (coarse-clock filesystems)', async () => {
    const store = createNamingStore(root);
    await store.mutate('claude', 'c1', (cur) => ({ ...cur, auto: 'Auto', autoAt: '2026-09-09T10:00:00.000Z' }));
    // A whole-second, just-now folder time, as a coarse filesystem records it.
    const dir = path.join(root, 'claude');
    const tick = Math.floor(Date.now() / 1000);
    fs.utimesSync(dir, tick, tick);
    await store.get('claude', 'c1'); // folder changed just now: index not trusted
    // A copy lands in the same tick: the folder time does not move, so only
    // the racy rule stands between the stale index and a missed copy.
    phoneCopy('c1', 'Same tick');
    fs.utimesSync(dir, tick, tick);
    expect((await store.get('claude', 'c1'))!.manual).toBe('Same tick');
  });

  it('mutate folds copies found before the lock and deletes only those', async () => {
    const store = createNamingStore(root);
    await store.mutate('claude', 'c1', (cur) => ({ ...cur, auto: 'Auto', autoAt: '2026-09-09T10:00:00.000Z' }));
    phoneCopy('c1', 'Phone');
    const rec = await store.mutate('claude', 'c1', (cur) => ({ ...cur, auto: 'Newer', autoAt: '2026-09-09T12:00:00.000Z' }));
    expect(rec).toMatchObject({ manual: 'Phone', auto: 'Newer' });
    expect(fs.readdirSync(path.join(root, 'claude'))).toEqual(['c1.json']);
    expect(JSON.parse(fs.readFileSync(nameOf('claude', 'c1'), 'utf8'))).toMatchObject({ manual: 'Phone', auto: 'Newer' });
  });

  it('shares one listing between overlapping reads and uses no sync fs', async () => {
    const store = createNamingStore(root);
    await store.mutate('claude', 'c1', (cur) => ({ ...cur, manual: 'Mine', manualAt: '2026-09-09T10:00:00.000Z' }));
    await store.mutate('claude', 'c2', (cur) => ({ ...cur, manual: 'Other', manualAt: '2026-09-09T10:00:00.000Z' }));
    const readdir = vi.spyOn(fs.promises, 'readdir');
    const sync = [vi.spyOn(fs, 'readdirSync'), vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs, 'statSync')];
    const [a, b] = await Promise.all([store.get('claude', 'c1'), store.get('claude', 'c2')]);
    expect([a!.manual, b!.manual]).toEqual(['Mine', 'Other']);
    expect(readdir).toHaveBeenCalledTimes(1);
    for (const s of sync) expect(s).not.toHaveBeenCalled();
  });
});
