// The four rubric questions every CLAUDE.md-guidance case asks, in one place.
//
// WHY these four and not more: this experiment compares three versions of one
// block of writing guidance, so the rubric has to measure the WRITING, not the
// task. These four are the only questions that mean the same thing on all four
// tasks — everything task-specific lives on the case itself.
//
// TWO RULES SHAPED EVERY WORD BELOW, and both exist because of how the judge
// works (judge.ts):
//
//  1. ANSWERABLE FROM THE WRITTEN ANSWER ALONE. The judge is shown the model's
//     final answer and its list of tool calls — nothing else. It cannot open a
//     file, so a question like "is its explanation of index.ts correct?" would
//     be graded by guessing.
//
//  2. QUOTABLE EITHER WAY. Every grade must carry a quote that a program finds
//     verbatim in the answer, and a grade whose quote fails that check is
//     DISCARDED rather than scored low (judge.ts's verifyQuote). So a question
//     with no quotable negative — "is any term left unexplained?" on an answer
//     that explains everything — produces no grade at all rather than a top
//     score, and the rubric item comes back blank. Each ask therefore names
//     something to quote in BOTH directions.
//
// The scoring DIRECTION is stated in each ask on purpose. The judge is told a
// numeric range but never which end is good, and "unexplained-jargon: 4" is
// unreadable without it — a reader cannot tell whether 4 means four offenders
// or a near-clean answer. Saying "score HIGH when…" makes every one of the 24
// cells read the same way round.
import type { RubricItem } from '../case-types';

export const PROSE_RUBRIC: RubricItem[] = [
  {
    id: 'plain-language',
    ask:
      'Could someone who has never written a line of code follow this answer without looking anything up? '
      + 'Score HIGH when they could. Quote the clearest passage; if they could not follow it, quote the first '
      + 'place they would get stuck.',
  },
  {
    id: 'unexplained-jargon',
    ask:
      'Does any technical term appear without being explained in the same breath? Score HIGH when none does. '
      + 'Quote the first unexplained term in its own sentence; if every term is explained, quote one that is '
      + 'explained well.',
  },
  {
    id: 'padding',
    // Destin, 2026-09-05, after the prompt-doctrine run scored a closing "want me
    // to fix any of these?" as padding on two cells: offering to do the next piece
    // of work is behaviour the product WANTS, so the rubric was wrong, not the
    // answer. Without this carve-out the case argues against a shipped intention
    // every time it runs.
    ask:
      'Is there a sentence that could be deleted without losing any information? Score HIGH when there is not. '
      + 'A closing offer to do the next step ("want me to fix these?") is NOT padding — it is a useful handoff; '
      + 'do not count it. Restating what was already said, narrating the process, and filler openers ARE padding. '
      + 'Quote the most deletable sentence; if nothing is deletable, quote the densest sentence as evidence '
      + 'that there is no padding.',
  },
  {
    id: 'evidence-not-assertion',
    ask:
      'Does the answer show what it actually found — file names, values, lines it read — or only assert what it '
      + 'concluded? Score HIGH when it shows the evidence. Quote the strongest piece of evidence it gives; if it '
      + 'gives none, quote its biggest unsupported claim.',
  },
];
