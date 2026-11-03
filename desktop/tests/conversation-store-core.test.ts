// PURE Conversation Store record logic (store-core.ts has no fs/path/os), exercised directly on plain objects/strings.
import { describe, it, expect } from 'vitest';
import {
  RECORD_SCHEMA_VERSION,
  parseRecord,
  mergeRecords,
  isConflictCopyName,
  extractConflictBase,
  foldConflictCopies,
  type ConversationRecord,
  type FlagState,
} from '../src/main/conversations/store-core';

// Each test states only the fields it cares about; the rest default to a valid baseline record.
function rec(over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
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
    note: '',
    noteUpdatedAt: '2026-07-01T09:00:00.000Z',
    ...over,
  };
}

function flag(value: boolean, updatedAt: string): FlagState {
  return { value, updatedAt };
}

describe('parseRecord', () => {
  it('parses valid JSON with schema:1 and all required fields', () => {
    const source = rec();
    expect(parseRecord(JSON.stringify(source))).toEqual(source);
  });

  // Invalid input is null, never a throw.
  it.each(['{ not json', '', 'null', '42', '  ', '[1,2,3'])('returns null on malformed JSON %j', (text) => {
    expect(parseRecord(text)).toBeNull();
  });

  it.each([
    ['wrong schema version', { schema: 2 }],
    ['missing id', { id: undefined }],
    ['empty id', { id: '' }],
    ['missing provider', { provider: undefined }],
    ['empty provider', { provider: '' }],
    ['missing lastActive', { lastActive: undefined }],
    ['unparseable lastActive', { lastActive: 'not-a-date' }],
  ])('returns null on %s', (_n, over) => {
    expect(parseRecord(JSON.stringify({ ...rec(), ...over }))).toBeNull();
  });

  // WHY: flags must round-trip LOSSLESSLY or not at all; a malformed FlagState reaching mergeRecords would corrupt the per-flag updatedAt comparison.
  it('drops malformed flag entries but keeps well-formed ones', () => {
    const parsed = parseRecord(JSON.stringify({
      ...rec(),
      flags: {
        good: { value: true, updatedAt: '2026-07-01T00:00:00.000Z' },
        stringValue: 'yes',                    // not an object
        emptyObject: {},                       // missing both fields
        badValue: { value: 'yes', updatedAt: '2026-07-01T00:00:00.000Z' }, // non-boolean
        badUpdatedAt: { value: true, updatedAt: 42 },                      // non-string
      },
    }));
    expect(parsed!.flags).toEqual({ good: { value: true, updatedAt: '2026-07-01T00:00:00.000Z' } });
  });

  it('normalizes a non-record flags shape (array, which is typeof object) to {}', () => {
    expect(parseRecord(JSON.stringify({ ...rec(), flags: [1, 2, 3] }))!.flags).toEqual({});
  });

  // WHY: a garbage createdAt would parse to epoch 0 and win every "earliest claim" comparison in mergeRecords.
  it.each([['corrupt', 'not-a-date'], ['absent', undefined]])('falls back to lastActive when createdAt is %s', (_n, createdAt) => {
    expect(parseRecord(JSON.stringify({ ...rec(), createdAt }))!.createdAt).toBe(rec().lastActive);
  });
});

describe('mergeRecords', () => {
  // Contract 3: incoming NEWER → activity fields (lastActive/device/title) from
  // incoming; createdAt keeps the OLDER of the two; flags merge per-flag newest-wins.
  it('takes activity fields from the newer side and keeps the older createdAt', () => {
    const base = rec({
      lastActive: '2026-07-03T10:00:00.000Z',
      device: 'Laptop',
      title: 'Old title',
      createdAt: '2026-07-01T00:00:00.000Z',
      flags: { pinned: flag(true, '2026-07-02T00:00:00.000Z') },
    });
    const incoming = rec({
      lastActive: '2026-07-04T10:00:00.000Z', // newer
      device: 'Desktop',
      title: 'New title',
      createdAt: '2026-07-05T00:00:00.000Z', // later birth claim — should NOT win
      flags: { pinned: flag(false, '2026-07-06T00:00:00.000Z') }, // newer flag
    });
    const merged = mergeRecords(base, incoming);
    expect(merged.lastActive).toBe('2026-07-04T10:00:00.000Z');
    expect(merged.device).toBe('Desktop');
    expect(merged.title).toBe('New title');
    // createdAt keeps the EARLIER of the two, not the newer side's value.
    expect(merged.createdAt).toBe('2026-07-01T00:00:00.000Z');
    // Flag merged per-flag by updatedAt (incoming's is newer).
    expect(merged.flags.pinned).toEqual(flag(false, '2026-07-06T00:00:00.000Z'));
  });

  // Contract 4: incoming OLDER → base's activity fields win, but incoming's
  // newer individual flags STILL land (field-level, not record-level).
  it('lets an older record still contribute its newer individual flags', () => {
    const base = rec({
      lastActive: '2026-07-10T10:00:00.000Z', // newer overall
      device: 'Laptop',
      title: 'Base title',
      flags: { archived: flag(false, '2026-07-01T00:00:00.000Z') },
    });
    const incoming = rec({
      lastActive: '2026-07-02T10:00:00.000Z', // older overall
      device: 'Phone',
      title: 'Incoming title',
      // This flag was updated AFTER base's copy of it — must survive the merge.
      flags: { archived: flag(true, '2026-07-09T00:00:00.000Z') },
    });
    const merged = mergeRecords(base, incoming);
    // Activity fields come from the newer (base) side.
    expect(merged.lastActive).toBe('2026-07-10T10:00:00.000Z');
    expect(merged.device).toBe('Laptop');
    expect(merged.title).toBe('Base title');
    // But the older record's newer flag still lands.
    expect(merged.flags.archived).toEqual(flag(true, '2026-07-09T00:00:00.000Z'));
  });

  it('merges disjoint flag keys from both sides', () => {
    const base = rec({ flags: { a: flag(true, '2026-07-01T00:00:00.000Z') } });
    const incoming = rec({ flags: { b: flag(true, '2026-07-02T00:00:00.000Z') } });
    const merged = mergeRecords(base, incoming);
    expect(merged.flags.a).toEqual(flag(true, '2026-07-01T00:00:00.000Z'));
    expect(merged.flags.b).toEqual(flag(true, '2026-07-02T00:00:00.000Z'));
  });

  // Title precedence: a non-empty title beats empty/'Untitled' regardless of age ('Untitled' is a legacy placeholder older clients wrote into
  // topic files); two non-empty titles go to the newest lastActive side. Both argument orders must agree.
  it.each([
    ['a real title beats an empty title even when the empty side is newer', 'Real title', '', 'Real title'],
    ["a real title beats a literal 'Untitled' even when the placeholder side is newer", 'Real title', 'Untitled', 'Real title'],
    ["a newer real title beats an older 'Untitled'", 'Untitled', 'Real title', 'Real title'],
    ['the newest side wins when both titles are non-empty', 'Older title', 'Newer title', 'Newer title'],
  ])('title: %s', (_n, olderTitle, newerTitle, expected) => {
    const older = rec({ lastActive: '2026-07-01T00:00:00.000Z', title: olderTitle });
    const newer = rec({ lastActive: '2026-07-09T00:00:00.000Z', title: newerTitle });
    expect(mergeRecords(older, newer).title).toBe(expected);
    expect(mergeRecords(newer, older).title).toBe(expected);
  });

  it('degrades gracefully when both sides are placeholders', () => {
    // The renderer treats '' and 'Untitled' alike as untitled, so either result is fine.
    const a = rec({ lastActive: '2026-07-01T00:00:00.000Z', title: 'Untitled' });
    const b = rec({ lastActive: '2026-07-09T00:00:00.000Z', title: '' });
    expect(['', 'Untitled']).toContain(mergeRecords(a, b).title);
    expect(['', 'Untitled']).toContain(mergeRecords(b, a).title);
    const c = rec({ title: 'Untitled' });
    expect(['', 'Untitled']).toContain(mergeRecords(c, c).title);
  });

  // LOAD-BEARING: two devices merging the same pair must agree even on an exact lastActive tie. Positional tie-breaking makes the healer fold enumeration-order dependent (devices ping-pong), so ties break on CONTENT (total order), never argument position.
  it('is commutative on an exact lastActive tie (content tiebreak)', () => {
    const same = '2026-07-05T12:00:00.000Z';
    const x = rec({
      lastActive: same,
      device: 'Laptop',
      title: 'Title from laptop',
      flags: { pinned: flag(true, same) },
    });
    const y = rec({
      lastActive: same,
      device: 'Desktop',
      title: 'Title from desktop',
      flags: { pinned: flag(false, same) }, // same updatedAt, different value
    });
    const xy = mergeRecords(x, y);
    expect(xy).toEqual(mergeRecords(y, x));
    // Pin the CONCRETE winner, not just symmetry (JSON first differs at `title`, 'l' > 'd'), so a comparator change flipping historical tie resolutions is caught.
    expect(xy.device).toBe('Laptop');
    expect(xy.title).toBe('Title from laptop');
    // Flag tie: '{"value":true,...}' sorts above '{"value":false,...}' ('t' > 'f').
    expect(xy.flags.pinned).toEqual(flag(true, same));
  });

  it('flag ties on equal updatedAt break by content, not argument order', () => {
    const same = '2026-07-05T12:00:00.000Z';
    const a = rec({ flags: { starred: flag(true, same) } });
    const b = rec({ flags: { starred: flag(false, same) } });
    const ab = mergeRecords(a, b).flags.starred;
    const ba = mergeRecords(b, a).flags.starred;
    expect(ab).toEqual(ba);
    // '{"value":true,...}' sorts above '{"value":false,...}', so the true-valued FlagState wins.
    expect(ab).toEqual(flag(true, same));
  });

  // lastUsedModel merges like an activity-coupled field: a real value never loses to an absent one; between two real values the later turn wins.
  it('lastUsedModel survives parse and travels with the newer side on merge', () => {
    const older = rec({ lastActive: '2026-07-01T00:00:00Z', lastUsedModel: { modelId: 'a', providerType: 'openrouter', providerLabel: 'OpenRouter' } });
    const newer = rec({ lastActive: '2026-07-02T00:00:00Z' });          // no model → keeps older's
    expect(mergeRecords(older, newer).lastUsedModel?.modelId).toBe('a');
    const newer2 = rec({ lastActive: '2026-07-02T00:00:00Z', lastUsedModel: { modelId: 'b', providerType: 'local-engine', providerLabel: 'Local' } });
    expect(mergeRecords(older, newer2).lastUsedModel?.modelId).toBe('b'); // newer side wins
    expect(parseRecord(JSON.stringify(newer2))?.lastUsedModel?.modelId).toBe('b'); // whitelist parse keeps it
  });

  it('parseRecord drops a malformed lastUsedModel (missing/empty field) instead of the whole record', () => {
    const withEmptyField = rec({ lastUsedModel: { modelId: '', providerType: 'openrouter', providerLabel: 'OpenRouter' } as any });
    const parsed = parseRecord(JSON.stringify(withEmptyField));
    expect(parsed).not.toBeNull();
    expect(parsed?.lastUsedModel).toBeUndefined();
    expect(parsed?.id).toBe(withEmptyField.id); // the rest of the record survives

    const withWrongShape = { ...rec(), lastUsedModel: 'not-an-object' };
    const parsed2 = parseRecord(JSON.stringify(withWrongShape));
    expect(parsed2).not.toBeNull();
    expect(parsed2?.lastUsedModel).toBeUndefined();
  });

  it('parseRecord drops a lastUsedModel poisoned with CC\'s <synthetic> placeholder', () => {
    // WHY: session-browser's store overlay OVERWRITES its transcript scan with the record's value, so a poisoned record (3 of 1,855 real ones, synced to peers) defeated the transcript-side fix; filtering on parse heals each on first load.
    const poisoned = rec({ lastUsedModel: { modelId: '<synthetic>', providerType: 'claude-code', providerLabel: 'Claude Code' } });
    const parsed = parseRecord(JSON.stringify(poisoned));
    expect(parsed).not.toBeNull();
    expect(parsed?.lastUsedModel).toBeUndefined();
    expect(parsed?.id).toBe(poisoned.id);       // the rest of the record survives

    // Discrimination: a real id on the same shape is untouched.
    const clean = rec({ lastUsedModel: { modelId: 'claude-opus-5', providerType: 'claude-code', providerLabel: 'Claude Code' } });
    expect(parseRecord(JSON.stringify(clean))?.lastUsedModel?.modelId).toBe('claude-opus-5');
  });

  it('parseRecord round-trips a record with NO lastUsedModel without inventing the key', () => {
    const parsed = parseRecord(JSON.stringify(rec()));
    expect(parsed).not.toBeNull();
    expect('lastUsedModel' in (parsed as object)).toBe(false);
  });
});

describe('isConflictCopyName / extractConflictBase', () => {
  // The REAL format (git-transport.ts conflictCopyName) uses an ISO date; the 'Jul 3' shape is the task example. The producer (guards.ts)
  // permits ')' inside device names, so the matcher runs greedily to the LAST ')' before '.json'.
  it.each([
    'abc123 (from Laptop, 2026-07-03).json',
    'abc123 (from Laptop, Jul 3).json',
    'abc123 (from foo)bar, 2026-07-03).json',
  ])('detects the conflict-copy name %j and extracts its canonical base', (name) => {
    expect(isConflictCopyName(name)).toBe(true);
    expect(extractConflictBase(name)).toBe('abc123.json');
  });

  it('rejects a plain canonical filename', () => {
    expect(isConflictCopyName('abc123.json')).toBe(false);
    expect(extractConflictBase('abc123.json')).toBeNull();
  });
});

describe('foldConflictCopies', () => {
  // Folding is order-independent: lastActive/device/flags/createdAt converge via the pairwise total-order picks; title via the fold's SET-BASED pick over the inputs (the pairwise title heuristic is not associative).
  it('folds copies into the canonical record, order-independently', () => {
    const canonical = rec({
      id: 'sess-1',
      lastActive: '2026-07-03T00:00:00.000Z',
      title: 'Canonical',
      flags: { pinned: flag(true, '2026-07-03T00:00:00.000Z') },
    });
    const copy1 = rec({
      id: 'sess-1',
      lastActive: '2026-07-05T00:00:00.000Z', // newest activity
      device: 'Desktop',
      title: 'Copy One',
      flags: { archived: flag(true, '2026-07-05T00:00:00.000Z') },
    });
    const copy2 = rec({
      id: 'sess-1',
      lastActive: '2026-07-04T00:00:00.000Z',
      device: 'Phone',
      title: 'Copy Two',
      flags: { pinned: flag(false, '2026-07-06T00:00:00.000Z') }, // newest pinned flag
    });

    const forward = foldConflictCopies(canonical, [copy1, copy2]);
    const reversed = foldConflictCopies(canonical, [copy2, copy1]);

    // Both orders converge to the same record (associativity for these fields).
    expect(forward).toEqual(reversed);
    // And the fold matches successive pairwise merges.
    const manual = mergeRecords(mergeRecords(canonical, copy1), copy2);
    expect(forward).toEqual(manual);
    // Sanity on the winning fields: newest activity from copy1, newest flags win.
    expect(forward.lastActive).toBe('2026-07-05T00:00:00.000Z');
    expect(forward.device).toBe('Desktop');
    expect(forward.flags.pinned).toEqual(flag(false, '2026-07-06T00:00:00.000Z'));
    expect(forward.flags.archived).toEqual(flag(true, '2026-07-05T00:00:00.000Z'));
  });

  it('returns the canonical record unchanged when there are no copies', () => {
    const canonical = rec();
    expect(foldConflictCopies(canonical, [])).toEqual(canonical);
  });

  // WHY (no tie needed): an accumulator that adopts a title from its first partner keeps it via its newest lastActive and beats a NEWER real title later, so fold [B,C] healed to 'M-title' but [C,B] to 'Q-title' and devices re-conflicted forever; the fix is the set-based pick (newest REAL title wins).
  it('heals to the newest real title regardless of copy enumeration order', () => {
    const canon = rec({ lastActive: '2026-07-05T00:00:00.000Z', title: '' });
    const b = rec({ lastActive: '2026-07-01T00:00:00.000Z', title: 'M-title' });
    const c = rec({ lastActive: '2026-07-03T00:00:00.000Z', title: 'Q-title' });
    const bc = foldConflictCopies(canon, [b, c]);
    const cb = foldConflictCopies(canon, [c, b]);
    expect(bc).toEqual(cb);
    // The newest REAL title (the canonical's newer-but-empty title doesn't count).
    expect(bc.title).toBe('Q-title');
    expect(cb.title).toBe('Q-title');
  });

  // Convergence under ties: canonical and every copy share ONE lastActive (two devices ran the same clock second) and the fold must still be order-independent.
  it('is order-independent even when all records tie on lastActive', () => {
    const same = '2026-07-05T12:00:00.000Z';
    const canon = rec({ lastActive: same, device: 'Laptop', title: 'Canon' });
    const x = rec({ lastActive: same, device: 'Desktop', title: 'From desktop' });
    const y = rec({ lastActive: same, device: 'Phone', title: 'From phone' });
    expect(foldConflictCopies(canon, [x, y])).toEqual(foldConflictCopies(canon, [y, x]));
  });

  // WHY: with a 3-way exact tie, an 'Untitled' canonical and real-titled copies straddling it in JSON order, picking over the MUTATED accumulator shrank its JSON and flipped a later tie (device healed per enumeration order); the pick is over the ORIGINAL inputs.
  it('picks activity fields over the original inputs, not the mutated accumulator', () => {
    const same = '2026-07-05T12:00:00.000Z';
    const canon = rec({ lastActive: same, title: 'Untitled', device: 'C-dev' });
    const alpha = rec({ lastActive: same, title: 'Alpha', device: 'B-dev' });
    const delta = rec({ lastActive: same, title: 'Delta', device: 'A-dev' });
    const fwd = foldConflictCopies(canon, [alpha, delta]);
    const rev = foldConflictCopies(canon, [delta, alpha]);
    expect(fwd).toEqual(rev);
    // Concrete winners ('Untitled' > 'Delta' > 'Alpha' in JSON order): the canonical is the spread-source max, so device 'C-dev'; the title pick considers only REAL titles, where 'Delta' beats 'Alpha'.
    expect(fwd.device).toBe('C-dev');
    expect(fwd.title).toBe('Delta');
  });
});

describe('note field', () => {
  it('parses default note when absent', () => {
    expect(parseRecord(JSON.stringify({ ...rec(), note: undefined, noteUpdatedAt: undefined }))?.note).toBe('');
  });
  it('merges the note with the newest noteUpdatedAt, independent of activity', () => {
    // a has the newer TURN but the OLDER note; b's newer note must still win.
    const a = rec({ lastActive: '2026-07-13T09:00:00.000Z', note: 'old', noteUpdatedAt: '2026-07-13T01:00:00.000Z' });
    const b = rec({ lastActive: '2026-07-13T02:00:00.000Z', note: 'new', noteUpdatedAt: '2026-07-13T05:00:00.000Z' });
    expect(mergeRecords(a, b).note).toBe('new');
  });
});
