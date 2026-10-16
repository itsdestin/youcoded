import { describe, it, expect } from 'vitest';
import { encodeTurnLine, decodeTurnLine, CHATSEARCH_FORMAT_VERSION } from '../src/main/chatsearch-index/index-format';
import { buildMetaFile } from '../src/main/chatsearch-index/meta-builder';
import type { ConversationRecord } from '../src/main/conversations/store-core';

const rec = (over: Partial<ConversationRecord> = {}): ConversationRecord => ({
  schema: 1,
  id: 'c1',
  provider: 'claude',
  projectName: 'youcoded',
  originalPath: '/home/destin/youcoded-dev',
  title: 'Permission ask timeout',
  lastActive: '2026-07-26T18:04:11.000Z',
  device: 'dev1',
  flags: {},
  transcriptRef: 'claude/transcripts/youcoded/c1.jsonl',
  createdAt: '2026-07-26T17:00:00.000Z',
  note: '',
  noteUpdatedAt: '',
  ...over,
});

describe('turn line format', () => {
  it('round-trips a turn', () => {
    const t = { conversationId: 'c1', turn: 142, ts: '2026-07-26T18:04:11.000Z', text: 'the actual message' };
    const line = encodeTurnLine(t);
    // Short keys are the wire format the CLI greps — pin them, not just the round-trip.
    expect(JSON.parse(line)).toEqual({ c: 'c1', t: 142, ts: '2026-07-26T18:04:11.000Z', x: 'the actual message' });
    expect(decodeTurnLine(line)).toEqual(t);
  });

  // The CLI reads this file line-by-line; one torn or malformed line must never
  // crash a search. decode returns null and the caller drops it.
  it('returns null for malformed lines instead of throwing', () => {
    expect(decodeTurnLine('')).toBeNull();
    expect(decodeTurnLine('{"c":"x"')).toBeNull();
    expect(decodeTurnLine('{"c":"x","t":"not-a-number","ts":"","x":"y"}')).toBeNull();
    expect(decodeTurnLine('{"nope":1}')).toBeNull();
  });

  it('encodes newlines safely (one JSON object per physical line)', () => {
    const line = encodeTurnLine({ conversationId: 'c', turn: 1, ts: '2026-01-01T00:00:00.000Z', text: 'a\nb' });
    expect(line.includes('\n')).toBe(false);
    expect(decodeTurnLine(line)!.text).toBe('a\nb');
  });
});

describe('buildMetaFile', () => {
  const base = {
    provider: 'claude' as const,
    refreshedAt: '2026-08-05T12:00:00.000Z',
    tagLabels: new Map<string, string>(),
    stats: new Map(),
    resolveTranscriptPath: (r: ConversationRecord) => `/local/${r.id}.jsonl`,
    transcriptExists: () => true,
    // WHY: storeRoot is a required field of buildMetaFile's input; shared here so every call is well-typed.
    storeRoot: '/tmp/store',
  };

  const baseInput = () => ({ ...base, storeRoot: '/tmp/store' });

  it('denormalizes a record into a metadata entry', () => {
    const out = buildMetaFile({ ...base, records: [rec()] });
    expect(out.v).toBe(CHATSEARCH_FORMAT_VERSION);
    expect(out.provider).toBe('claude');
    expect(out.conversations.c1).toMatchObject({
      id: 'c1',
      provider: 'claude',
      projectName: 'youcoded',
      title: 'Permission ask timeout',
      complete: false,
      priority: false,
      tags: [],
      transcriptPath: '/local/c1.jsonl',
      tombstone: false,
    });
  });

  // Flags are stored as an open-keyed FlagState map holding BOTH reserved names
  // and tag: keys. The snapshot must expose resolved values only — the CLI never
  // sees raw flag-map internals.
  it('resolves complete/priority to plain booleans and tags to LABELS', () => {
    const tagLabels = new Map([['tag_a', 'sync'], ['tag_b', 'ui']]);
    const r = rec({
      flags: {
        complete: { value: true, updatedAt: 'x' },
        priority: { value: false, updatedAt: 'x' },
        'tag:tag_a': { value: true, updatedAt: 'x' },
        'tag:tag_b': { value: false, updatedAt: 'x' },
        'tag:tag_missing': { value: true, updatedAt: 'x' },
      },
    });
    const out = buildMetaFile({ ...base, records: [r], tagLabels });
    expect(out.conversations.c1.complete).toBe(true);
    expect(out.conversations.c1.priority).toBe(false);
    // Only applied tags, only resolvable ones, labels not ids.
    expect(out.conversations.c1.tags).toEqual(['sync']);
  });

  // Phantom metadata-only seeds: epoch lastActive, blank title, EMPTY ref.
  // pruneNativePhantomRecords exists to clean these up; the builder must not
  // invent a path for them.
  it('skips phantom records with an empty transcriptRef', () => {
    const out = buildMetaFile({ ...base, records: [rec({ id: 'ph', transcriptRef: '' })] });
    expect(out.conversations.ph).toBeUndefined();
  });

  // D5, never cross-materialize.
  it('refuses a record whose ref is in another provider lane', () => {
    const r = rec({ id: 'x', provider: 'native', transcriptRef: 'claude/transcripts/p/x.jsonl' });
    const out = buildMetaFile({ ...base, provider: 'native', records: [r] });
    expect(out.conversations.x).toBeUndefined();
  });

  // Tombstones (decided 2026-08-05): a deleted transcript keeps its row.
  it('marks a record whose transcript is gone as a tombstone, and keeps it', () => {
    const out = buildMetaFile({ ...base, records: [rec()], transcriptExists: () => false });
    expect(out.conversations.c1).toBeDefined();
    expect(out.conversations.c1.tombstone).toBe(true);
  });

  it('folds in per-conversation stats when present', () => {
    const stats = new Map([['c1', {
      sizeBytes: 4210338, turnCount: 187,
      firstTurnTs: '2026-07-26T17:01:00.000Z', lastTurnTs: '2026-07-26T18:04:11.000Z',
    }]]);
    const out = buildMetaFile({ ...base, records: [rec()], stats });
    expect(out.conversations.c1).toMatchObject({ sizeBytes: 4210338, turnCount: 187 });
  });

  it('defaults stats to zero when the turns builder has not seen it yet', () => {
    const out = buildMetaFile({ ...base, records: [rec()] });
    expect(out.conversations.c1).toMatchObject({ turnCount: 0, sizeBytes: 0, firstTurnTs: '', lastTurnTs: '' });
  });

  // 'Untitled' is a placeholder, not a title (store-core's realTitle rule).
  it('normalizes placeholder titles to empty string', () => {
    for (const t of ['Untitled', '', 'New Session']) {
      const out = buildMetaFile({ ...base, records: [rec({ title: t })] });
      expect(out.conversations.c1.title).toBe('');
    }
  });

  it('records the store root the index was built from', () => {
    const meta = buildMetaFile({ ...baseInput(), records: [rec()] });
    expect(meta.storeRoot).toBe('/tmp/store');
  });
});
