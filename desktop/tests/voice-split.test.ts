// The grey/solid rule, pinned by example.
//
// `splitAtLastSentenceEnd` is the ONE implementation of what the composer draws
// solid and what it draws grey while you are still talking (contract row R2:
// "everything since your last full stop stays grey; it turns solid when you
// finish a sentence"). The worker that drives the real engine and the workbench
// fake both call it, and Android re-implements the same rule in Kotlin against
// this same table — so these cases are the shared definition, not a spot check.
import { describe, it, expect } from 'vitest';
import { splitAtLastSentenceEnd } from '../src/shared/voice-types';

/** what came out of the recogniser → what turns solid | what stays grey */
const CASES: ReadonlyArray<{ text: string; committed: string; tail: string; why: string }> = [
  { text: '', committed: '', tail: '', why: 'nothing heard yet' },
  { text: 'so I was thinking', committed: '', tail: 'so I was thinking',
    why: 'no sentence has ended, so every word is still up for revision' },
  { text: 'Send it today.', committed: 'Send it today.', tail: '',
    why: 'the mark is the last character — the whole thing is settled, nothing is grey' },
  { text: 'Send it today. Then let', committed: 'Send it today.', tail: 'Then let',
    why: 'the normal case: solid sentence, grey words since' },
  { text: 'Can you check it? I think so', committed: 'Can you check it?', tail: 'I think so',
    why: 'a question mark ends a sentence too' },
  { text: 'Stop! That is wrong', committed: 'Stop!', tail: 'That is wrong',
    why: 'so does an exclamation mark' },
  { text: 'One. Two. Three and', committed: 'One. Two.', tail: 'Three and',
    why: 'the LAST mark is the cut, not the first — everything before it is solid' },
  { text: 'Done.   ', committed: 'Done.', tail: '',
    why: 'trailing space belongs to neither half' },
  { text: '   still going', committed: '', tail: 'still going',
    why: 'leading space is trimmed off the grey half' },
  { text: 'Send it today.Then let', committed: 'Send it today.', tail: 'Then let',
    why: 'no space after the mark (the engine does this) — the cut is still the mark' },
  { text: 'Wait... maybe not', committed: 'Wait...', tail: 'maybe not',
    why: 'an ellipsis cuts at its last dot; the grey half never starts with a stray dot' },

  // The two documented non-exceptions. These look wrong read on their own and
  // are deliberate: we split on the punctuation the ENGINE wrote, and a list of
  // abbreviations would be a second, quieter model of English disagreeing with
  // the first. The cost is a word or two turning solid a moment early.
  { text: 'I met Dr. Smith', committed: 'I met Dr.', tail: 'Smith',
    why: 'abbreviations are NOT special-cased' },
  { text: 'It was $2.30 in the end', committed: 'It was $2.', tail: '30 in the end',
    why: 'decimal points are NOT special-cased' },
  { text: 'She said "go." Then we left', committed: 'She said "go.', tail: '" Then we left',
    why: 'a mark inside quotes cuts where it sits — closing punctuation is not tracked' },

  // The workbench fake reads this sentence aloud; this row is what a reviewer
  // sees turn solid halfway through the demo.
  { text: "Can you look at the budget spreadsheet I sent yesterday? Row 14 is",
    committed: 'Can you look at the budget spreadsheet I sent yesterday?', tail: 'Row 14 is',
    why: 'the scripted demo sentence, mid-flight' },
];

describe('splitAtLastSentenceEnd', () => {
  for (const c of CASES) {
    it(`${JSON.stringify(c.text)} — ${c.why}`, () => {
      expect(splitAtLastSentenceEnd(c.text)).toEqual({ committed: c.committed, tail: c.tail });
    });
  }

  // The invariant behind every row: the split MOVES the boundary, it never eats
  // words. Only whitespace may differ between the two halves and the original —
  // the composer re-inserts the single separating space when it joins them.
  it('never loses or invents a character', () => {
    const bare = (s: string) => s.replace(/\s+/g, '');
    for (const c of CASES) {
      const { committed, tail } = splitAtLastSentenceEnd(c.text);
      expect(bare(committed + tail)).toBe(bare(c.text));
    }
  });

  // Cumulative use: the worker re-hears the whole open segment and re-splits it
  // every pass, so the solid half must never go BACKWARDS as words arrive.
  it('the solid half only grows as more words arrive', () => {
    const words = 'One two. Three four? Five six! Seven'.split(' ');
    let previous = '';
    for (let n = 1; n <= words.length; n += 1) {
      const { committed } = splitAtLastSentenceEnd(words.slice(0, n).join(' '));
      expect(committed.startsWith(previous)).toBe(true);
      previous = committed;
    }
    expect(previous).toBe('One two. Three four? Five six!');
  });
});
