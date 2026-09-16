// Tests for the IO SHELL of the Conversation Store (Phase 2a design §1).
// Uses REAL temp dirs (fs.mkdtempSync) — no memfs, no fs mocking — because the
// whole point of this module is real disk behavior: on-demand dir creation,
// locked read-modify-write, and heal-on-read that DELETES conflict-copy files.
// The pure record logic it sits on top of is tested separately in
// conversation-store-core.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createConversationStore,
  type ConversationStore,
} from '../src/main/conversations/conversation-store';
import {
  RECORD_SCHEMA_VERSION,
  type ConversationRecord,
} from '../src/main/conversations/store-core';

// Build a valid record JSON string, overriding only the fields a test cares
// about. Keeps each test focused on the one behavior it pins.
function recJson(over: Partial<ConversationRecord> = {}): string {
  const base: ConversationRecord = {
    schema: RECORD_SCHEMA_VERSION,
    id: 'sess-1',
    provider: 'claude',
    projectName: 'my-app',
    originalPath: '/home/a/my-app',
    title: 'Hello',
    lastActive: '2026-07-03T10:00:00.000Z',
    device: 'Laptop',
    flags: {},
    transcriptRef: 'claude/transcripts/my-app/sess-1.jsonl',
    createdAt: '2026-07-01T09:00:00.000Z',
    ...over,
  };
  return JSON.stringify(base, null, 2);
}

// Write a raw file directly into a provider dir, bypassing the store — used to
// stage on-disk state (canonical records, conflict copies, garbage) before a
// read/heal path runs.
function stage(root: string, provider: string, fileName: string, content: string): void {
  const dir = path.join(root, provider);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content);
}

// No file in `dir` still carries the healer's quarantine marker — proves heal
// cleaned up after itself.
function noHealingLeftovers(dir: string): boolean {
  return fs.readdirSync(dir).every((n) => !n.includes('.healing-'));
}

const EPOCH = '1970-01-01T00:00:00.000Z';

let tmp: string;
let store: ConversationStore;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-conv-'));
  store = createConversationStore(tmp);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

describe('createConversationStore', () => {
  it.each(['native', 'claude'])('persists an explicit model-only update in the %s lane without activity', async (provider) => {
    const modelA = { modelId: 'model-a', providerType: 'openrouter', providerLabel: 'Cloud' };
    const modelB = { ...modelA, modelId: 'model-b' };
    const before = await store.upsert({ id: 'model-session', provider,
      lastActive: '2026-07-03T10:00:00.000Z', device: 'Laptop', lastUsedModel: modelA });
    const updated = await store.upsert({ id: before.id, provider, lastUsedModel: modelB });
    expect(updated).toEqual({ ...before, lastUsedModel: modelB });
    const reopened = createConversationStore(tmp);
    expect(await reopened.get(provider, before.id)).toEqual(updated);
    const omitted = await reopened.upsert({ id: before.id, provider });
    expect(omitted).toEqual(updated);
    expect(await createConversationStore(tmp).get(provider, before.id)).toEqual(updated);
  });

  // Contract 1: upsert on a MISSING record creates <root>/claude/<id>.json with
  // schema 1, returns the written record, and creates the provider dir on demand.
  it('upsert creates the record file (and provider dir) on demand', async () => {
    const written = await store.upsert({
      id: 'sess-1',
      provider: 'claude',
      title: 'First',
      lastActive: '2026-07-03T10:00:00.000Z',
      device: 'Laptop',
    });

    const file = path.join(tmp, 'claude', 'sess-1.json');
    expect(fs.existsSync(file)).toBe(true); // dir + file created on demand
    expect(written.schema).toBe(RECORD_SCHEMA_VERSION);
    expect(written.id).toBe('sess-1');
    expect(written.title).toBe('First');
    expect(written.lastActive).toBe('2026-07-03T10:00:00.000Z');

    // The returned record matches what actually landed on disk.
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk).toEqual(written);
  });

  // Contract 2: upsert on an EXISTING record merges via mergeRecords — a partial
  // with a newer lastActive updates activity fields while preserving flags.
  it('upsert merges into an existing record (newer activity wins, flags kept)', async () => {
    // Seed a base record that already carries a flag.
    stage(tmp, 'claude', 'sess-1.json', recJson({
      id: 'sess-1',
      title: 'Old title',
      lastActive: '2026-07-03T10:00:00.000Z',
      device: 'Laptop',
      flags: { pinned: { value: true, updatedAt: '2026-07-03T09:00:00.000Z' } },
    }));

    const merged = await store.upsert({
      id: 'sess-1',
      provider: 'claude',
      lastActive: '2026-07-03T12:00:00.000Z', // newer turn
      device: 'Phone',
    });

    // Activity fields advanced to the newer turn...
    expect(merged.lastActive).toBe('2026-07-03T12:00:00.000Z');
    expect(merged.device).toBe('Phone');
    // ...the flag set on the older record survived the merge...
    expect(merged.flags.pinned).toEqual({ value: true, updatedAt: '2026-07-03T09:00:00.000Z' });
    // ...and the metadata-only partial did NOT blank the existing title.
    expect(merged.title).toBe('Old title');
  });

  // Review fix 3: caller-provided fields are LOCAL TRUTH — a metadata-only
  // upsert (no lastActive) must land every provided field even though the merge
  // ranks the existing record as "newer". lastActive/device stay merge-decided.
  it('metadata-only upsert lands all provided fields without touching activity', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({
      id: 'sess-1',
      title: 'Old',
      projectName: 'old-proj',
      originalPath: '/old',
      transcriptRef: 'old-ref',
      lastActive: '2026-07-03T10:00:00.000Z',
      device: 'Laptop',
    }));

    const rec = await store.upsert({
      id: 'sess-1',
      provider: 'claude',
      // NO lastActive — metadata-only
      projectName: 'new-proj',
      originalPath: '/new',
      title: 'New',
      transcriptRef: 'new-ref',
    });

    // Every provided field landed (this was the red case — all four were
    // silently dropped before the local-truth overlay)...
    expect(rec.projectName).toBe('new-proj');
    expect(rec.originalPath).toBe('/new');
    expect(rec.title).toBe('New');
    expect(rec.transcriptRef).toBe('new-ref');
    // ...but activity fields stayed merge-decided (EPOCH loses to real activity).
    expect(rec.lastActive).toBe('2026-07-03T10:00:00.000Z');
    expect(rec.device).toBe('Laptop');
  });

  // Review follow-up: a provided title of literal 'Untitled' is a legacy
  // placeholder (see store-core realTitle), not a name — the local-truth
  // re-apply must not let it clobber a real title.
  it("upsert with title 'Untitled' never overwrites a real title", async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({
      id: 'sess-1',
      title: 'Real name',
      lastActive: '2026-07-03T10:00:00.000Z',
    }));

    const rec = await store.upsert({
      id: 'sess-1',
      provider: 'claude',
      title: 'Untitled', // placeholder from a non-normalizing caller
    });

    expect(rec.title).toBe('Real name'); // placeholder lost, real title survived
  });

  // Contract 3: get returns null for missing AND corrupt files, and a read must
  // NEVER delete the corrupt file (data isn't ours to throw away).
  it('get returns null for missing files', async () => {
    expect(await store.get('claude', 'nope')).toBeNull();
  });

  it('get returns null for a corrupt file and leaves it in place', async () => {
    stage(tmp, 'claude', 'sess-1.json', 'this is not json at all {{{');
    expect(await store.get('claude', 'sess-1')).toBeNull();
    // The garbage file is untouched — a read never deletes.
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-1.json'))).toBe(true);
  });

  // Contract 4: list returns every VALID record; corrupt files are skipped
  // silently so one bad record can't break the whole listing.
  it('list returns valid records and skips corrupt ones', async () => {
    stage(tmp, 'claude', 'a.json', recJson({ id: 'a' }));
    stage(tmp, 'claude', 'b.json', recJson({ id: 'b' }));
    stage(tmp, 'claude', 'c.json', 'garbage-not-json');

    const list = await store.list('claude');
    const ids = list.map((r) => r.id).sort();
    expect(ids).toEqual(['a', 'b']); // 'c' skipped, but a+b still returned
  });

  it('list returns [] for a provider dir that does not exist', async () => {
    expect(await store.list('gemini')).toEqual([]);
  });

  // Contract 5: HEALER — a canonical file plus a conflict copy carrying a newer
  // flag. get() returns the FOLDED record, rewrites the canonical file with the
  // fold, and DELETES the conflict copy (leaving no quarantine leftovers).
  it('heal folds a conflict copy into the canonical record and deletes the copy', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({
      id: 'sess-1',
      lastActive: '2026-07-03T12:00:00.000Z', // canonical has the later turn
      flags: {},
    }));
    // A valid record conflict copy with a NEWER flag than the canonical (none).
    stage(tmp, 'claude', 'sess-1 (from Laptop, 2026-07-03).json', recJson({
      id: 'sess-1',
      lastActive: '2026-07-03T08:00:00.000Z', // older activity, must lose
      flags: { complete: { value: true, updatedAt: '2026-07-03T13:00:00.000Z' } },
    }));

    const folded = await store.get('claude', 'sess-1');
    expect(folded).not.toBeNull();
    // The fold picked the flag from the copy AND kept the canonical's later turn.
    expect(folded!.flags.complete).toEqual({ value: true, updatedAt: '2026-07-03T13:00:00.000Z' });
    expect(folded!.lastActive).toBe('2026-07-03T12:00:00.000Z');

    // The canonical file on disk now contains the fold...
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'claude', 'sess-1.json'), 'utf8'));
    expect(onDisk.flags.complete).toEqual({ value: true, updatedAt: '2026-07-03T13:00:00.000Z' });
    // ...the conflict copy is gone...
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-1 (from Laptop, 2026-07-03).json'))).toBe(false);
    // ...and the quarantine mechanism left zero .healing- files behind.
    expect(noHealingLeftovers(path.join(tmp, 'claude'))).toBe(true);
  });

  // Contract 5b: remove() — the store's ONLY destructive operation (added
  // 2026-07-18 for the native phantom-record cleanup).
  //
  // The load-bearing part is that it sweeps CONFLICT COPIES too, not just the
  // canonical. heal() seeds a canonical FROM a copy when none exists, so a
  // remove that deleted only `<id>.json` would be silently undone by the very
  // next get()/list() — the delete would report success and the record would
  // reappear (and re-sync) moments later.
  it('remove deletes the canonical AND its conflict copies, so heal cannot resurrect it', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({ id: 'sess-1' }));
    stage(tmp, 'claude', 'sess-1 (from Laptop, 2026-07-03).json', recJson({ id: 'sess-1' }));
    stage(tmp, 'claude', 'sess-1 (from Desktop, 2026-07-04).json', recJson({ id: 'sess-1' }));
    // A DIFFERENT record and its copy must survive untouched.
    stage(tmp, 'claude', 'sess-2.json', recJson({ id: 'sess-2' }));
    stage(tmp, 'claude', 'sess-2 (from Laptop, 2026-07-03).json', recJson({ id: 'sess-2' }));

    expect(await store.remove('claude', 'sess-1')).toBe(true);

    // Gone from disk — canonical and both copies.
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-1.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-1 (from Laptop, 2026-07-03).json'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-1 (from Desktop, 2026-07-04).json'))).toBe(false);
    // THE POINT: a read runs heal first — it must not rebuild the record.
    expect(await store.get('claude', 'sess-1')).toBeNull();
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-1.json'))).toBe(false);

    // The neighbour is intact and still heals normally.
    expect(await store.get('claude', 'sess-2')).not.toBeNull();
  });

  it('remove reports false for an unknown id and refuses unsafe segments', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({ id: 'sess-1' }));
    expect(await store.remove('claude', 'nope')).toBe(false);
    // Path-escape attempts are refused, not resolved — same guard as get/list.
    expect(await store.remove('claude', '../../etc/passwd')).toBe(false);
    expect(await store.remove('..', 'sess-1')).toBe(false);
    // The real record is untouched by any of the above.
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-1.json'))).toBe(true);
  });

  // Contract 6: the healer only touches RECORD conflict copies (.json), never a
  // non-record conflict copy, and never reaches into another provider's dir.
  it('heal ignores non-record conflict copies and never crosses providers', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({ id: 'sess-1', flags: {} }));
    // A conflict copy that is NOT a record file (different extension) — must be
    // left alone.
    stage(tmp, 'claude', 'notes (from Laptop, 2026-07-03).txt', 'just some notes');
    // A same-named conflict copy under a DIFFERENT provider — must not be
    // pulled into claude's heal.
    stage(tmp, 'gemini', 'sess-1 (from Laptop, 2026-07-03).json', recJson({
      id: 'sess-1',
      provider: 'gemini',
      flags: { complete: { value: true, updatedAt: '2026-07-03T13:00:00.000Z' } },
    }));

    await store.get('claude', 'sess-1');

    // The .txt conflict copy is untouched.
    expect(fs.existsSync(path.join(tmp, 'claude', 'notes (from Laptop, 2026-07-03).txt'))).toBe(true);
    // The gemini conflict copy was never healed away (different provider dir).
    expect(fs.existsSync(path.join(tmp, 'gemini', 'sess-1 (from Laptop, 2026-07-03).json'))).toBe(true);
    // claude's canonical picked up NOTHING from gemini's copy.
    const claudeRec = JSON.parse(fs.readFileSync(path.join(tmp, 'claude', 'sess-1.json'), 'utf8'));
    expect(claudeRec.flags.complete).toBeUndefined();
  });

  // Review fix 5d: copies-only heal — no canonical exists yet, only conflict
  // copies. get() must seed the canonical from the fold and delete the copies.
  it('heal seeds the canonical from copies when no canonical exists', async () => {
    stage(tmp, 'claude', 'sess-2 (from Laptop, 2026-07-03).json', recJson({
      id: 'sess-2',
      title: 'Only copy',
      flags: { pinned: { value: true, updatedAt: '2026-07-03T09:00:00.000Z' } },
    }));

    const rec = await store.get('claude', 'sess-2');
    expect(rec).not.toBeNull();
    expect(rec!.title).toBe('Only copy');
    expect(rec!.flags.pinned.value).toBe(true);
    // Canonical materialized; copy gone; no quarantine leftovers.
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-2.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-2 (from Laptop, 2026-07-03).json'))).toBe(false);
    expect(noHealingLeftovers(path.join(tmp, 'claude'))).toBe(true);
  });

  // Review fix 5d: a corrupt copy is deleted (unparseable junk) while valid
  // copies in the same pass still fold in.
  it('heal deletes a corrupt copy while folding valid copies', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({ id: 'sess-1', flags: {} }));
    stage(tmp, 'claude', 'sess-1 (from A, 2026-07-03).json', 'corrupt garbage {{{');
    stage(tmp, 'claude', 'sess-1 (from B, 2026-07-03).json', recJson({
      id: 'sess-1',
      flags: { complete: { value: true, updatedAt: '2026-07-03T13:00:00.000Z' } },
    }));

    const rec = await store.get('claude', 'sess-1');
    expect(rec!.flags.complete.value).toBe(true); // valid copy folded
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-1 (from A, 2026-07-03).json'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-1 (from B, 2026-07-03).json'))).toBe(false);
    expect(noHealingLeftovers(path.join(tmp, 'claude'))).toBe(true);
  });

  // Review fix 5b: a conflict copy that parses to a VALID record with a
  // DIFFERENT id is someone's data (misnamed) — it is left in place, never
  // folded and never deleted.
  it('heal leaves a valid copy with a mismatched id in place', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({ id: 'sess-1', flags: {} }));
    stage(tmp, 'claude', 'sess-1 (from C, 2026-07-03).json', recJson({
      id: 'other-id', // valid record, wrong id for this filename
      flags: { complete: { value: true, updatedAt: '2026-07-03T13:00:00.000Z' } },
    }));

    const rec = await store.get('claude', 'sess-1');
    // Nothing folded in from the foreign record...
    expect(rec!.flags.complete).toBeUndefined();
    // ...and the file is preserved for investigation.
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-1 (from C, 2026-07-03).json'))).toBe(true);
    expect(noHealingLeftovers(path.join(tmp, 'claude'))).toBe(true);
  });

  // Review fix 2 (crash recovery): a stale quarantine file left by a crashed
  // healer ('<copy>.healing-<pid>') is folded in and deleted on the next heal.
  it('heal adopts a stale quarantine file: folds it and deletes it', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({ id: 'sess-1', flags: {} }));
    stage(tmp, 'claude', 'sess-1 (from Laptop, 2026-07-03).json.healing-424242', recJson({
      id: 'sess-1',
      flags: { complete: { value: true, updatedAt: '2026-07-03T13:00:00.000Z' } },
    }));

    const rec = await store.get('claude', 'sess-1');
    expect(rec!.flags.complete.value).toBe(true); // stale quarantine folded in
    expect(noHealingLeftovers(path.join(tmp, 'claude'))).toBe(true); // and deleted
  });

  // Review fix 2: a copy that vanishes between detection and the quarantine
  // rename (another process claimed it first) must be skipped, not crash the read.
  it('heal skips a copy that vanishes mid-heal (rename ENOENT)', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({ id: 'sess-1', title: 'Canonical' }));
    stage(tmp, 'claude', 'sess-1 (from Laptop, 2026-07-03).json', recJson({ id: 'sess-1' }));
    // Simulate the copy vanishing at claim time: the quarantine rename throws
    // ENOENT exactly once (as if another healer renamed it away first).
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      const e: any = new Error('ENOENT: no such file');
      e.code = 'ENOENT';
      throw e;
    });

    const rec = await store.get('claude', 'sess-1');
    expect(rec).not.toBeNull(); // read survived the lost claim
    expect(rec!.title).toBe('Canonical');
  });

  // Review fix 4: heal failure (a live/contended lock on the canonical) must
  // NOT reject reads — get/list serve the un-healed canonical and the next read
  // retries healing. A fresh lock dir makes mutateFileUnderLock wait its 3s max
  // and give up, hence the long test timeout.
  it('get and list still return data when heal cannot acquire the lock', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({ id: 'sess-1', title: 'Survivor' }));
    stage(tmp, 'claude', 'sess-1 (from Laptop, 2026-07-03).json', recJson({ id: 'sess-1' }));
    // A fresh lock dir on the canonical simulates another process mid-write.
    fs.mkdirSync(path.join(tmp, 'claude', 'sess-1.json.lock'));

    const rec = await store.get('claude', 'sess-1');
    expect(rec).not.toBeNull(); // un-healed canonical served, not a rejection
    expect(rec!.title).toBe('Survivor');

    const list = await store.list('claude');
    expect(list.map((r) => r.id)).toEqual(['sess-1']);
  }, 20_000);

  // Contract 7: setFlag on a MISSING record seeds a flag-only record — empty
  // title, lastActive = EPOCH sentinel (so it never outranks real activity in a
  // later merge) — and sets the flag with a fresh updatedAt.
  it('setFlag creates a flag-only seed record when missing', async () => {
    const before = Date.now();
    await store.setFlag('claude', 'sess-9', 'complete', true);
    const after = Date.now();

    const rec = await store.get('claude', 'sess-9');
    expect(rec).not.toBeNull();
    expect(rec!.title).toBe('');            // flag-only seed: no title
    expect(rec!.lastActive).toBe(EPOCH);    // epoch sentinel: loses every real-activity merge
    expect(rec!.flags.complete.value).toBe(true);
    // updatedAt is a fresh timestamp captured at setFlag time.
    const stampedAt = Date.parse(rec!.flags.complete.updatedAt);
    expect(stampedAt).toBeGreaterThanOrEqual(before);
    expect(stampedAt).toBeLessThanOrEqual(after);
  });

  it('setFlag updates a flag on an existing record without touching activity', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({
      id: 'sess-1',
      title: 'Keep me',
      lastActive: '2026-07-03T10:00:00.000Z',
    }));
    await store.setFlag('claude', 'sess-1', 'archived', true);

    const rec = await store.get('claude', 'sess-1');
    expect(rec!.flags.archived.value).toBe(true);
    expect(rec!.title).toBe('Keep me');                       // untouched
    expect(rec!.lastActive).toBe('2026-07-03T10:00:00.000Z'); // untouched
  });

  // Review fix 5d: setTitle behaviors.
  it('setTitle with an empty title is a no-op (never seeds or blanks)', async () => {
    await store.setTitle('claude', 'sess-9', '');
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-9.json'))).toBe(false);
  });

  it('setTitle seeds a title-only record when missing (EPOCH activity)', async () => {
    await store.setTitle('claude', 'sess-9', 'Fresh name');
    const rec = await store.get('claude', 'sess-9');
    expect(rec!.title).toBe('Fresh name');
    expect(rec!.lastActive).toBe(EPOCH); // seed never outranks real activity
  });

  it('setTitle overwrites the title on an existing record, keeping the rest', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({
      id: 'sess-1',
      title: 'Old name',
      lastActive: '2026-07-03T10:00:00.000Z',
      device: 'Laptop',
    }));
    await store.setTitle('claude', 'sess-1', 'New name');
    const rec = await store.get('claude', 'sess-1');
    expect(rec!.title).toBe('New name');
    expect(rec!.lastActive).toBe('2026-07-03T10:00:00.000Z'); // untouched
    expect(rec!.device).toBe('Laptop');                       // untouched
  });

  // Contract 8: two concurrent upserts to the SAME id both land — the final
  // record contains the union of both. Without the lock, both would read a
  // missing file, both create, and the second rename would clobber the first
  // (lost update). The union proves mutateFileUnderLock serialized them.
  it('concurrent upserts to the same id both land (no lost update)', async () => {
    await Promise.all([
      store.upsert({
        id: 'sess-1',
        provider: 'claude',
        title: 'Titled',
        lastActive: '2026-07-03T10:00:00.000Z',
      }),
      store.upsert({
        id: 'sess-1',
        provider: 'claude',
        device: 'DeviceB',
        lastActive: '2026-07-03T11:00:00.000Z',
      }),
    ]);

    const rec = await store.get('claude', 'sess-1');
    expect(rec).not.toBeNull();
    // Both the title from one upsert AND the device from the other survived,
    // regardless of which write won the lock first.
    expect(rec!.title).toBe('Titled');
    expect(rec!.device).toBe('DeviceB');
  });
});

// Review fix 1 (CRITICAL): id/provider become path segments — traversal
// attempts must never escape the store root. Writes throw; reads fail soft
// (null / []). Uses a NESTED store root so "escaped outside the root" is
// observable inside the test's own temp dir.
describe('path traversal guard', () => {
  let base: string;
  let root: string;
  let s: ConversationStore;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-trav-'));
    root = path.join(base, 'nested', 'store');
    fs.mkdirSync(root, { recursive: true });
    s = createConversationStore(root);
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('setFlag with a traversal id throws and writes nothing outside the root', async () => {
    await expect(s.setFlag('claude', '../../escape', 'complete', true)).rejects.toThrow(/invalid/i);
    // Nothing landed at any of the escape targets.
    expect(fs.existsSync(path.join(base, 'escape.json'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'nested', 'escape.json'))).toBe(false);
  });

  it('upsert with a traversal id or provider throws', async () => {
    await expect(
      s.upsert({ id: '../../escape', provider: 'claude', lastActive: '2026-07-03T10:00:00.000Z' }),
    ).rejects.toThrow(/invalid/i);
    await expect(
      s.upsert({ id: 'ok-id', provider: '..\\..', lastActive: '2026-07-03T10:00:00.000Z' }),
    ).rejects.toThrow(/invalid/i);
    expect(fs.existsSync(path.join(base, 'escape.json'))).toBe(false);
  });

  it('setTitle with a traversal id throws', async () => {
    await expect(s.setTitle('claude', '..', 'Evil')).rejects.toThrow(/invalid/i);
  });

  // Review follow-up: Windows reserved device names ('con', 'nul', 'com1', …)
  // pass a pure charset check but map to DEVICES on older Windows — writing
  // 'con.json' can target the console device. Refuse them like traversal names.
  it('write with a Windows reserved device name throws', async () => {
    await expect(s.setFlag('claude', 'con', 'complete', true)).rejects.toThrow(/invalid/i);
    await expect(s.setFlag('claude', 'NUL', 'complete', true)).rejects.toThrow(/invalid/i);
    await expect(s.setFlag('claude', 'com1', 'complete', true)).rejects.toThrow(/invalid/i);
    await expect(s.setFlag('con', 'sess-1', 'complete', true)).rejects.toThrow(/invalid/i);
  });

  it('get with a traversal id/provider fails soft (null)', async () => {
    // Plant a file OUTSIDE the store root that a traversal would reach.
    fs.writeFileSync(path.join(base, 'nested', 'secret.json'), recJson({ id: 'secret' }));
    expect(await s.get('claude', '../secret')).toBeNull();
    expect(await s.get('..', 'secret')).toBeNull();
    expect(await s.get('claude', '.')).toBeNull();
  });

  it('list with a traversal provider fails soft ([])', async () => {
    // '../outside' from the store root resolves to base/nested/outside — stage
    // real records THERE so an unguarded list would actually return them.
    fs.mkdirSync(path.join(base, 'nested', 'outside'), { recursive: true });
    fs.writeFileSync(path.join(base, 'nested', 'outside', 'x.json'), recJson({ id: 'x' }));
    expect(await s.list('../outside')).toEqual([]);
    expect(await s.list('..')).toEqual([]);
  });
});
