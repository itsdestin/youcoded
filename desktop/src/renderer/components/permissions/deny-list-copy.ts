// Copy for the Full-auto safety-stop footer (spec 2026-08-12, M5 2b).
// Classifies a deny-listed Bash command into the family that stopped it by
// re-matching against the SAME shared list + matcher the engine decided with
// (DESTRUCTIVE_DENY_LIST + ruleMatches) — so the card can never name a
// different reason than the engine had. First match in list order wins:
// the engine's last-match-wins is across LAYERS; within the deny-list layer
// every entry has the same action, so order carries no meaning and the list's
// own family grouping is safe to walk front-to-back.
import { DESTRUCTIVE_DENY_LIST } from '../../../shared/permission-types';
import { ruleMatches } from '../../../shared/subject-glob';
import type { FloorStop } from '../../../shared/types';

type DenyFamily = 'deleting' | 'pushing' | 'undoing' | 'admin' | 'formatting';

// Keyed on the deny-list PATTERN, not the raw command — the pattern is what
// the engine matched. If a new family joins DESTRUCTIVE_DENY_LIST without a
// row here, the footer uses the fallback — honest, just less specific
// (pinned by the fallback test).
const FAMILY_TESTS: Array<{ family: DenyFamily; match: (pattern: string) => boolean }> = [
  { family: 'deleting', match: (p) => /(^|\* )(rm|rmdir|del) \*/.test(p) },
  { family: 'pushing', match: (p) => p.includes('git push') },
  { family: 'undoing', match: (p) => p.includes('git reset --hard') },
  { family: 'admin', match: (p) => p.includes('sudo ') },
  { family: 'formatting', match: (p) => p.includes('format ') },
];

const HEADERS: Record<DenyFamily, string> = {
  deleting: 'Stopped before deleting files',
  pushing: 'Stopped before pushing code',
  undoing: 'Stopped before undoing commits',
  admin: 'Stopped before an admin command',
  formatting: 'Stopped before formatting a drive',
};

// Destin's 2026-08-26/27 copy review: each clause now starts with "this", so
// the subline reads as one sentence about the command in front of the user
// rather than about the app ("Full auto still stops here — this deletes files").
const CLAUSES: Record<DenyFamily, string> = {
  deleting: 'this permanently removes files.',
  pushing: 'this changes your published code.',
  undoing: 'this permanently discards saved work.',
  admin: 'this runs with full control of your computer.',
  formatting: 'this erases everything on it.',
};

// Owner-settled line (compare surface 'full-auto-ask', R3/R4; reworded in
// Destin's 2026-08-26/27 copy review) — em dash, lowercase clause. Don't
// reword without a new compare round.
const SUBLINE_BASE = 'Full auto still stops here';

/** The stops that come from a floor below the rules rather than the deny-list
 *  (shared/types.ts FloorStop). Used when the deny-list itself has no family
 *  for the command — a PowerShell `Remove-Item`, or `cat ~/.ssh/id_rsa`. */
const FLOOR_COPY: Record<FloorStop, { header: string; subline: string }> = {
  removal: { header: HEADERS.deleting, subline: `${SUBLINE_BASE} — ${CLAUSES.deleting}` },
  'secret-path': { header: 'Stopped before using a secret file', subline: `${SUBLINE_BASE} — this uses a file that holds passwords or keys.` },
};

export function fullAutoStopCopy(command: string | undefined, floorStop?: FloorStop): { header: string; subline: string } {
  if (command) {
    for (const rule of DESTRUCTIVE_DENY_LIST) {
      // ruleMatches, not subjectMatches: the engine decides through it, and its
      // safety rules skip deny-list entries (they are 'ask'), so this classifies
      // identically while staying impossible to drift from the decision path.
      if (!ruleMatches(rule, command)) continue;
      const fam = FAMILY_TESTS.find((f) => f.match(rule.pattern ?? ''))?.family;
      if (fam) return { header: HEADERS[fam], subline: `${SUBLINE_BASE} — ${CLAUSES[fam]}` };
    }
  }
  // The deny-list names what the command DOES (deleting, pushing); a floor is
  // the reason when it does not — `rm ~/.ssh/old` still reads "deleting files".
  if (floorStop) return FLOOR_COPY[floorStop];
  // Deny-listed per the engine but unclassifiable here (or command missing):
  // generic header, no invented consequence.
  return { header: 'Stopped before a risky command', subline: `${SUBLINE_BASE}.` };
}
