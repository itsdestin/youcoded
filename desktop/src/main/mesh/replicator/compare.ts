// Head comparison: ONE pure function that turns "my head, their head, my chain value at their count" into what to do next (plan section 3,
// "Discovery" and "Who sends"). Pure so that every row of the table is a test and nothing else decides it.
//
// WHY a table and not "the longer one wins": a longer copy can be a DIFFERENT history (a writer that rolled back and signed anew, a forged
// peer). Length decides nothing (replicator.ts invariant 5): the chain value at the shared count does. A claim here only schedules work;
// the signature check on the lines themselves is what lets anything reach the store.
import type { AdvertisedState } from './wire';

export interface HeadView {
  lines: number;
  /** 64-hex raw chain value after `lines` lines. */
  hash: string;
  state: AdvertisedState;
}

/** What I know about my own chain at THEIR count: a value, null (I have fewer lines), or 'unknown' (the value was evicted with its index, so no comparison is possible there). */
export type MineAtTheirs = string | null | 'unknown';

export type Verdict =
  | { do: 'in-sync' }
  /** They hold more and agree with me as far as I can tell: ask for lines after my head (the server checks the prefix and says `not-a-prefix` if it does not hold). */
  | { do: 'pull' }
  /** They hold fewer lines and agree with me at their count: they will ask; the writer also pushes. Nothing to send now. */
  | { do: 'wait-for-want' }
  /** Same history cannot be shown: same count with another value, or a prefix that does not match. Never settled by length. */
  | { do: 'diverged' }
  /** They say they cannot serve (refilling or damaged). Ignore their lines and acks; they may still need mine. */
  | { do: 'ignore-theirs'; theyNeedMe: boolean }
  /** I can not compare at their count (evicted): nothing to do until a later head or a restore. */
  | { do: 'cannot-compare' };

export function compareHeads(mine: HeadView, theirs: HeadView, mineAtTheirs: MineAtTheirs): Verdict {
  // A refilling or damaged peer advertises the point it can still vouch for; its acks and lines are worth nothing until it says `ok`.
  if (theirs.state !== 'ok') return { do: 'ignore-theirs', theyNeedMe: theirs.lines < mine.lines };
  // I am refilling: my advertised head is only the point I can vouch for. Anything they hold beyond it is worth asking for.
  if (mine.state !== 'ok') return theirs.lines > mine.lines ? { do: 'pull' } : { do: 'in-sync' };
  if (theirs.lines === mine.lines) return theirs.hash === mine.hash ? { do: 'in-sync' } : { do: 'diverged' };
  if (theirs.lines > mine.lines) return { do: 'pull' };
  // They are shorter: I can say whether they are a prefix of me, only if I still have my chain value at their count.
  if (mineAtTheirs === 'unknown') return { do: 'cannot-compare' };
  if (mineAtTheirs === null) return { do: 'diverged' }; // cannot happen with theirs.lines < mine.lines unless my store disagrees with itself: loud, not quiet
  return mineAtTheirs === theirs.hash ? { do: 'wait-for-want' } : { do: 'diverged' };
}
