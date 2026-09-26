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
    // F2 (review): assert the LITERAL substring and its exact start/end, not
    // just a whitespace-collapsed equality — a collapsed compare would pass
    // even if `start`/`end` landed a character or two off (e.g. swallowing a
    // neighboring space into or out of the match), which is exactly the
    // off-by-one class this anchor's offsets must never have: every other
    // caller (highlight marks, MoveComment's range) slices `fullText` with
    // these numbers directly.
    const literal = 'Line   two continues'; // the document's ACTUAL internal spacing
    const start = fullText.indexOf(literal);
    expect(start).toBeGreaterThan(-1);
    expect(resolveSelector(fullText, sel)).toEqual({ start, end: start + literal.length });
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

describe('resolveSelector — occurrence at the very start of the document', () => {
  it('clamps the prefix window at 0 instead of reading (or wrapping) past it', () => {
    // F3 (review): `windowStart = Math.max(0, occ.start - sel.prefix.length)`
    // — this pins that clamp for the occurrence it actually matters for: one
    // starting at offset 0, where `occ.start - sel.prefix.length` goes
    // negative. Without the clamp, `String.prototype.slice` treats a
    // negative start as "from the end of the string", which would silently
    // score this candidate against unrelated text from the document's TAIL
    // instead of "there's nothing before it" — exactly backwards, and enough
    // to make the decoy below win instead.
    //
    // The real match's SUFFIX is left intact (available, matching) so only
    // its prefix is clamped away — a small, unavoidable "missing 6 chars"
    // cost. The decoy has BOTH sides fully available but drawn from a
    // disjoint alphabet (digits vs. the selector's own digits-as-letters
    // stand-in), so its cost is a real, larger mismatch rather than a tie —
    // this is a clamp check, not a "which candidate happens to read closer"
    // check.
    const fullText = 'TARGET222222 filler filler completely unrelated padding text 000000TARGET333333';
    const sel = textSelector({ exact: 'TARGET', prefix: '111111', suffix: '222222', occurrence: 0 });
    const start = fullText.indexOf('TARGET');
    expect(start).toBe(0); // the real match sits flush against the start of the document
    const decoyStart = fullText.lastIndexOf('TARGET');
    expect(decoyStart).toBeGreaterThan(start);
    expect(resolveSelector(fullText, sel)).toEqual({ start, end: start + 'TARGET'.length });
  });
});

describe('resolveSelector — occurrence at the very end of the document', () => {
  it('clamps the suffix window at the document length instead of reading past it', () => {
    // F3 (review): the matching clamp on the other edge —
    // `windowEnd = Math.min(fullText.length, occ.end + sel.suffix.length)`
    // — for an occurrence whose match ends exactly at `fullText.length`. Same
    // disjoint-alphabet decoy technique as the start-of-document test above.
    const fullText = '000000TARGET111111 filler filler completely unrelated padding text in between PREFIXTARGET';
    const sel = textSelector({ exact: 'TARGET', prefix: 'PREFIX', suffix: 'SUFFIX', occurrence: 0 });
    const decoyStart = fullText.indexOf('TARGET');
    const start = fullText.lastIndexOf('TARGET');
    expect(start + 'TARGET'.length).toBe(fullText.length); // the real match sits flush against EOF
    expect(start).toBeGreaterThan(decoyStart);
    expect(resolveSelector(fullText, sel)).toEqual({ start, end: start + 'TARGET'.length });
  });
});

describe('resolveSelector — many occurrences of a large quote (F1 perf bound)', () => {
  it('resolves the correct occurrence, quickly, for a 20 KB quote repeated 50 times', () => {
    // F1 (review, major perf finding): before the bound, this scored every
    // occurrence by running Levenshtein over the FULL prefix+exact+suffix —
    // ~20 KB per candidate, 50 candidates — on every anchoring lookup for a
    // file with a large quote pasted many times. The bound (sampling
    // `exact`'s edges, §"F1" note on `sampleEdges`) makes the cost
    // independent of `exact`'s length; this pins BOTH that it stays fast AND
    // that it still picks the one true candidate out of 50 near-identical
    // ones by its (short) prefix/suffix context.
    const quote = 'Q'.repeat(20_000);
    const blockCount = 50;
    const targetIndex = 37;
    const blocks: string[] = [];
    for (let i = 0; i < blockCount; i++) {
      blocks.push(`PRE${i}--${quote}--POST${i}`);
    }
    const fullText = blocks.join(' filler filler filler ');
    const sel = textSelector({
      exact: quote,
      prefix: `PRE${targetIndex}--`,
      suffix: `--POST${targetIndex}`,
      occurrence: 0,
    });
    const targetBlock = `PRE${targetIndex}--${quote}--POST${targetIndex}`;
    const blockStart = fullText.indexOf(targetBlock);
    expect(blockStart).toBeGreaterThan(-1);
    const start = blockStart + `PRE${targetIndex}--`.length;

    // CPU time, never wall clock (test-suite-hygiene.md "Never assert on
    // wall-clock time") — a loaded machine must not make this flaky.
    const startedCpu = process.cpuUsage();
    const result = resolveSelector(fullText, sel);
    const usedCpu = process.cpuUsage(startedCpu);
    const cpuMs = (usedCpu.user + usedCpu.system) / 1000;

    // Generous — measured well under 100ms locally; the old unbounded
    // algorithm did O(50 * 20000^2) Levenshtein cells, seconds to minutes of
    // CPU time for one anchoring lookup. This is a "did the bound work"
    // check, not a tight budget.
    expect(cpuMs).toBeLessThan(5_000);
    expect(result).toEqual({ start, end: start + quote.length });
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
