// Pure-core rules for session name ownership. Every case here is one of the
// promises the approved contract makes to the user, expressed as a fact about
// the record: a name you typed is never replaced, a clear is a real event,
// and the review schedule survives replayed and missed completions.
import { describe, it, expect } from 'vitest';
import {
  NAMING_SCHEMA_VERSION, emptyNamingRecord, parseNamingRecord, mergeNamingRecords,
  effectiveName, isManuallyNamed, normalizeManualName, sanitizeAutoName, basicNameFrom,
  nextReviewAt, isReviewDue, MANUAL_NAME_MAX, AUTO_NAME_MAX,
} from '../src/main/conversations/naming-core';

const rec = (over: Partial<ReturnType<typeof emptyNamingRecord>> = {}) => ({
  ...emptyNamingRecord('c1', 'claude'), ...over,
});

describe('parseNamingRecord', () => {
  it('round-trips a well-formed record', () => {
    const r = rec({ manual: 'Biology revision', manualAt: '2026-09-09T10:00:00.000Z', replies: 4, reviewed: 3 });
    expect(parseNamingRecord(JSON.stringify(r))).toEqual(r);
  });

  it('rejects junk, a wrong schema and a missing id rather than half-parsing', () => {
    expect(parseNamingRecord('not json')).toBeNull();
    expect(parseNamingRecord('[]')).toBeNull();
    expect(parseNamingRecord(JSON.stringify({ ...rec(), schema: 99 }))).toBeNull();
    expect(parseNamingRecord(JSON.stringify({ ...rec(), id: '' }))).toBeNull();
    expect(parseNamingRecord(JSON.stringify({ ...rec(), provider: 5 }))).toBeNull();
  });

  it('repairs damaged fields without discarding the record', () => {
    const parsed = parseNamingRecord(JSON.stringify({
      schema: NAMING_SCHEMA_VERSION, id: 'c1', provider: 'claude',
      manual: 'x'.repeat(500), manualAt: 'yesterday',
      auto: 'y'.repeat(500), autoAt: null,
      replies: -3, reviewed: 1.5,
    }))!;
    expect(parsed.manual).toHaveLength(MANUAL_NAME_MAX);
    expect(parsed.auto).toHaveLength(AUTO_NAME_MAX);
    // An unparseable stamp becomes epoch, which LOSES every merge — a corrupt
    // timestamp must never win one.
    expect(parsed.manualAt).toBe('1970-01-01T00:00:00.000Z');
    expect(parsed.replies).toBe(0);
    expect(parsed.reviewed).toBe(0);
  });
});

describe('mergeNamingRecords', () => {
  const A = rec({ manual: 'Laptop name', manualAt: '2026-09-09T10:00:00.000Z' });
  const B = rec({ auto: 'Phone auto name', autoAt: '2026-09-09T11:00:00.000Z' });

  it('is commutative and associative, so devices converge in any fold order', () => {
    expect(mergeNamingRecords(A, B)).toEqual(mergeNamingRecords(B, A));
    const C = rec({ manual: 'Third', manualAt: '2026-09-09T09:00:00.000Z', replies: 9 });
    expect(mergeNamingRecords(mergeNamingRecords(A, B), C))
      .toEqual(mergeNamingRecords(A, mergeNamingRecords(B, C)));
  });

  it('keeps a manual name against a NEWER automatic name from another device', () => {
    // The whole reason this record exists: ConversationRecord.title merges by
    // conversation activity, so the busier device's auto-title would win.
    const merged = mergeNamingRecords(A, B);
    expect(merged.manual).toBe('Laptop name');
    expect(merged.auto).toBe('Phone auto name');
    expect(effectiveName(merged, 'Untitled')).toEqual({ name: 'Laptop name', manual: true });
  });

  it('lets a later clear beat an earlier rename, and a later rename beat a clear', () => {
    const named = rec({ manual: 'Mine', manualAt: '2026-09-09T10:00:00.000Z' });
    const cleared = rec({ manual: '', manualAt: '2026-09-09T12:00:00.000Z' });
    expect(mergeNamingRecords(named, cleared).manual).toBe('');
    const renamedAfter = rec({ manual: 'Mine again', manualAt: '2026-09-09T13:00:00.000Z' });
    expect(mergeNamingRecords(cleared, renamedAfter).manual).toBe('Mine again');
  });

  it('never rewinds progress counters', () => {
    const ahead = rec({ replies: 30, reviewed: 28 });
    const behind = rec({ replies: 4, reviewed: 3 });
    expect(mergeNamingRecords(ahead, behind)).toMatchObject({ replies: 30, reviewed: 28 });
  });

  it('breaks an exact timestamp tie the same way on both devices', () => {
    const at = '2026-09-09T10:00:00.000Z';
    const x = rec({ manual: 'Alpha', manualAt: at });
    const y = rec({ manual: 'Beta', manualAt: at });
    expect(mergeNamingRecords(x, y)).toEqual(mergeNamingRecords(y, x));
  });
});

describe('effectiveName', () => {
  it('prefers manual, then automatic, then the caller fallback', () => {
    expect(effectiveName(rec({ manual: 'M', auto: 'A' }), 'F')).toEqual({ name: 'M', manual: true });
    expect(effectiveName(rec({ auto: 'A' }), 'F')).toEqual({ name: 'A', manual: false });
    expect(effectiveName(rec(), 'F')).toEqual({ name: 'F', manual: false });
    expect(effectiveName(null, 'F')).toEqual({ name: 'F', manual: false });
  });

  it('an empty record never blanks a name the old pipeline already set', () => {
    expect(effectiveName(rec(), 'Fix chat scroll').name).toBe('Fix chat scroll');
  });

  it('isManuallyNamed answers only for a real user choice', () => {
    expect(isManuallyNamed(rec({ manual: 'M' }))).toBe(true);
    expect(isManuallyNamed(rec({ auto: 'A' }))).toBe(false);
    expect(isManuallyNamed(null)).toBe(false);
  });
});

describe('name cleaning', () => {
  it('normalizeManualName collapses whitespace and refuses a blank', () => {
    expect(normalizeManualName('  Biology   revision \n')).toBe('Biology revision');
    expect(normalizeManualName('   ')).toBe('');
    expect(normalizeManualName('x'.repeat(400))).toHaveLength(MANUAL_NAME_MAX);
  });

  it('sanitizeAutoName strips the quotes models add and flattens newlines', () => {
    expect(sanitizeAutoName('"Fix the chat scroll"')).toBe('Fix the chat scroll');
    expect(sanitizeAutoName("'Fix it'")).toBe('Fix it');
    expect(sanitizeAutoName('Line one\nline two')).toBe('Line one line two');
    expect(sanitizeAutoName('   ')).toBe('');
  });

  it('basicNameFrom quotes the opening request, cut at a word boundary', () => {
    expect(basicNameFrom('help me fix the scroll')).toBe('help me fix the scroll');
    expect(basicNameFrom('   ')).toBe('');
    const long = basicNameFrom('please look at the landing page and tell me what is wrong with the hero');
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(49);
    expect(long).not.toMatch(/ …$/); // no dangling space before the ellipsis
    // A single very long word hard-cuts rather than shrinking to nothing.
    expect(basicNameFrom('x'.repeat(90))).toBe('x'.repeat(48) + '…');
  });
});

describe('review schedule', () => {
  it('runs at replies 1, 3, then every 25', () => {
    expect(nextReviewAt(0)).toBe(1);
    expect(nextReviewAt(1)).toBe(3);
    expect(nextReviewAt(2)).toBe(3);
    expect(nextReviewAt(3)).toBe(28);
    expect(nextReviewAt(28)).toBe(53);
    expect(nextReviewAt(53)).toBe(78);
  });

  it('does not re-fire on a replayed completion', () => {
    // reviewed already caught up to replies — a duplicate turn-complete event
    // for the same reply must not spend a second naming call.
    expect(isReviewDue(rec({ replies: 3, reviewed: 3 }))).toBe(false);
  });

  it('still fires after completions were missed while the app was closed', () => {
    // Jumped 3 -> 31 without ever being exactly 28.
    expect(isReviewDue(rec({ replies: 31, reviewed: 3 }))).toBe(true);
  });

  it('is due at the very first reply of a fresh conversation', () => {
    expect(isReviewDue(rec({ replies: 1, reviewed: 0 }))).toBe(true);
    expect(isReviewDue(rec({ replies: 0, reviewed: 0 }))).toBe(false);
  });
});
