// Disk behaviour for the naming sidecar: it writes where no older client
// looks, it refuses path escapes, and a sync conflict copy is folded in rather
// than discarded — losing a copy here would lose a name the user typed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNamingStore } from '../src/main/conversations/naming-store';
import { emptyNamingRecord, NAMING_SCHEMA_VERSION } from '../src/main/conversations/naming-core';

let root = '';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'naming-store-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const nameOf = (p: string, id: string) => path.join(root, p, `${id}.json`);

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
