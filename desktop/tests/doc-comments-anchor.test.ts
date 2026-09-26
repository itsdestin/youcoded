// Pins T2 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §2.2): `resolveSelector`'s single edit-distance-minimizing
// scoring function (review 1 F9a/F9b, unified review 2 F14) — an out-of-range
// `occurrence` never clamps to a fixed index, and a genuine scoring tie
// resolves to the earlier document position, not array order — plus the
// zero-occurrences `'detached'` case and `resolveCellSelector`'s trivial
// cell-presence check.
import { describe, it, expect } from 'vitest';
import { resolveSelector, resolveCellSelector, cellSelectorKey } from '../src/shared/doc-comments-anchor';
import type { CellSelector, TextQuoteSelector } from '../src/shared/doc-comments-types';

function textSelector(overrides: Partial<TextQuoteSelector>): TextQuoteSelector {
  return { type: 'TextQuoteSelector', exact: '', prefix: '', suffix: '', occurrence: 0, ...overrides };
}

describe('resolveSelector — exact match', () => {
  it('anchors at the recorded offsets when the quote appears once with matching context', () => {
    const fullText = 'The quick brown fox jumps over the lazy dog.';
    const sel = textSelector({ exact: 'brown fox', prefix: 'quick ', suffix: ' jumps', occurrence: 0 });
    const start = fullText.indexOf('brown fox');
    expect(resolveSelector(fullText, sel)).toEqual({ start, end: start + 'brown fox'.length });
  });
});

describe('resolveSelector — moved text', () => {
  it('still anchors a uniquely-occurring quote even though its recorded prefix/suffix no longer match anywhere', () => {
    // WHY this must still anchor: prefix/suffix only disambiguate among
    // MULTIPLE candidates (§2.2 step 3) — they never gate whether a single,
    // unique match counts. An edit that moved this sentence to a new
    // paragraph with entirely different neighbors is exactly R6's "an edit
    // that shifts the quote's position" case.
    const fullText = 'Totally different neighbors now: TARGET word here, in a new place.';
    const sel = textSelector({
      exact: 'TARGET word',
      prefix: 'stale prefix that no longer appears ',
      suffix: ' stale suffix that no longer appears',
      occurrence: 0,
    });
    const start = fullText.indexOf('TARGET word');
    expect(resolveSelector(fullText, sel)).toEqual({ start, end: start + 'TARGET word'.length });
  });
});

describe('resolveSelector — ambiguous repeated phrase', () => {
  it('resolves to the occurrence whose surrounding text is the closest match', () => {
    const fullText = 'xa PHRASE ax and later yb PHRASE by and later zc PHRASE cz.';
    const sel = textSelector({ exact: 'PHRASE', prefix: 'yb ', suffix: ' by', occurrence: 0 });
    const start = fullText.indexOf('yb PHRASE by') + 'yb '.length;
    expect(resolveSelector(fullText, sel)).toEqual({ start, end: start + 'PHRASE'.length });
  });
});

describe('resolveSelector — not found', () => {
  it('reports detached when the exact text has zero occurrences', () => {
    const fullText = 'Nothing here matches anything in particular.';
    const sel = textSelector({ exact: 'nonexistent phrase', prefix: '', suffix: '', occurrence: 0 });
    expect(resolveSelector(fullText, sel)).toBe('detached');
  });
});

describe('resolveSelector — whitespace tolerance', () => {
  it('matches despite different internal whitespace between the selector and the document (same tolerance as findQuote)', () => {
    const fullText = 'Line one.\n  Line   two continues here.\nLine three.';
    const sel = textSelector({
      exact: 'Line two continues',
      prefix: 'one.\n  ',
      suffix: ' here',
      occurrence: 0,
    });
    const result = resolveSelector(fullText, sel);
    expect(result).not.toBe('detached');
    const { start, end } = result as { start: number; end: number };
    expect(fullText.slice(start, end).replace(/\s+/g, '')).toBe(sel.exact.replace(/\s+/g, ''));
  });
});

describe('resolveSelector — occurrence out of range', () => {
  it('never clamps to a fixed index: scores every remaining occurrence and takes the best one', () => {
    const fullText =
      'nope TARGET wrongctx here. Filler in between padding text that is unrelated. ' +
      'yes TARGET rightctx appears finally.';
    // Only two occurrences exist; `occurrence: 7` names a match that was
    // never even created against THIS document — it must be ignored, not
    // read as "the 8th" or clamped to "the last".
    const sel = textSelector({ exact: 'TARGET', prefix: 'yes ', suffix: ' rightctx', occurrence: 7 });
    const start = fullText.indexOf('yes TARGET rightctx') + 'yes '.length;
    expect(resolveSelector(fullText, sel)).toEqual({ start, end: start + 'TARGET'.length });
  });
});

describe('resolveSelector — scoring tie', () => {
  it('resolves a genuine tie to the earlier document position, not array order', () => {
    const block = 'ppp TARGET qqq';
    const fullText = `${block} between two identical blocks ${block}`;
    const sel = textSelector({ exact: 'TARGET', prefix: 'ppp ', suffix: ' qqq', occurrence: 0 });
    const start = fullText.indexOf('TARGET');
    expect(resolveSelector(fullText, sel)).toEqual({ start, end: start + 'TARGET'.length });
  });
});

describe('resolveSelector — combined out-of-range occurrence and scoring tie', () => {
  it('ignores the out-of-range occurrence AND resolves the tie among the remaining candidates to the earlier one', () => {
    const decoy = 'xxx TARGET yyy';
    const block = 'ppp TARGET qqq';
    const fullText = `${decoy} filler filler filler ${block} more filler ${block} end.`;
    const sel = textSelector({ exact: 'TARGET', prefix: 'ppp ', suffix: ' qqq', occurrence: 99 });
    const firstBlockStart = fullText.indexOf(block);
    const start = firstBlockStart + block.indexOf('TARGET');
    expect(resolveSelector(fullText, sel)).toEqual({ start, end: start + 'TARGET'.length });
  });
});

describe('resolveCellSelector', () => {
  it('reports detached when the cell key is not among the currently-present cells', () => {
    const sel: CellSelector = { type: 'CellSelector', cell: 'C4', sheet: 'Sheet1' };
    expect(resolveCellSelector(sel, new Set())).toBe('detached');
  });

  it('reports anchored when the cell key is present', () => {
    const sel: CellSelector = { type: 'CellSelector', cell: 'C4', sheet: 'Sheet1' };
    expect(resolveCellSelector(sel, new Set([cellSelectorKey(sel)]))).toBe('anchored');
  });

  it('a cell with no sheet name uses the bare cell reference as its key', () => {
    const sel: CellSelector = { type: 'CellSelector', cell: 'A1' };
    expect(resolveCellSelector(sel, new Set(['A1']))).toBe('anchored');
  });
});
