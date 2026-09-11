// Lives in shared/ because the renderer's deny-list copy module
// (components/permissions/deny-list-copy.ts) must classify with the SAME
// matcher the engine decided with — two matchers would eventually disagree.
// Tiny glob for permission SUBJECTS (bash command strings, relative paths).
// Homegrown on purpose: no new dep, and `*` must cross path separators here
// ("git push*" must match "git push origin x") — unlike file globbing.
// `*` also matches the empty string, so a bare "git push" matches "git push*".
import type { PermissionRule } from './permission-types';
import { CODE_RUNNING_CORPUS, HOSTILE_CORPUS } from './bash-hostile-corpus';

/** Escape a literal run of a pattern for a RegExp, keeping `?` as one character. */
function globLiteral(text: string): string {
  return text
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars EXCEPT * and ?
    .replace(/\?/g, '.');
}

export function subjectMatches(subject: string, pattern?: string): boolean {
  if (pattern === undefined) return true;
  const rx = new RegExp('^' + pattern.split('*').map(globLiteral).join('[\\s\\S]*') + '$', 'i');
  return rx.test(subject);
}

/** Each one starts a SECOND command, or redirects the first one's output.
 *  subjectMatches compiles '*' to [\s\S]* on purpose — that is what lets the
 *  deny-list's '* rm *' catch 'cd repo && rm -rf x' — which means a trailing '*'
 *  in a GRANT would cross them too.
 *
 *  WHY '&' is listed on its own and not only inside '&&' (2026-09-10 security
 *  review): a single '&' backgrounds the command in front of it and starts the
 *  NEXT one at once, so 'a & b' runs b too — and a grant for 'a*' used to cover
 *  it. '&&' stays in the list for readability; '&' alone would catch it. A lone
 *  TRAILING '&' is not a second command and is exempted below. '\r' is a new
 *  line to PowerShell. */
export const SHELL_OPERATORS: readonly string[] = ['&&', '&', '||', ';', '|', '`', '$(', '>', '<', '\n', '\r'];

/** PowerShell — the Windows fallback when Git Bash is absent (tools/bash.ts
 *  detectShell) — also runs code from INSIDE an argument: `(…)`, `@(…)`, `@{…}`,
 *  and `{…}` script blocks. In bash these are plain characters (or a syntax
 *  error), so they count only when the session's shell is PowerShell; counting
 *  them everywhere would cost `git commit -m "fix (x)"` its grant for nothing. */
export const POWERSHELL_OPERATORS: readonly string[] = ['(', '@', '{'];

/** One '&' at the very end, not part of '&&', '>&' or '|&' — "run this in the
 *  background", with nothing after it. */
const TRAILING_BACKGROUND = /(?<![&>|])&\s*$/;

/** Flags that change WHAT a bounded grant does rather than how it does it.
 *  `git push --delete origin feat/x` matches a rule built for
 *  `git push origin feat/x` — the wildcard sits between them — and deletes the
 *  branch the grant is named after. `--prune` deletes every OTHER branch on the
 *  remote; `--all` and `--mirror` push refs the grant never mentioned; `--force`
 *  and `--hard` destroy history rather than adding to it; `--no-verify` skips the
 *  checks the repo runs before a push, which is a behaviour change hiding inside
 *  what otherwise looks like the same command with one more option. */
export const BOUNDED_RUNG_VETO: readonly string[] = [
  '--delete', '-d', '--prune', '--mirror', '--all',
  '--force', '-f', '--force-with-lease', '--hard', '--no-verify',
];

/** What the decision knows about the session a subject came from. */
export interface MatchContext {
  /** The Bash tool is running PowerShell, not bash. */
  powershell?: boolean;
}

/** The ONE function that knows what a whole rule means. `subjectMatches` above is
 *  the primitive; this owns `match` and the safety rules on top of it.
 *
 *  Every decision path must go through here — the engine AND the renderer's
 *  deny-list classifier — or the two will eventually disagree about what a rule
 *  covers, which is the bug the shared location of this file exists to prevent. */
export function ruleMatches(rule: PermissionRule, subject: string, context: MatchContext = {}): boolean {
  // Exact: byte-for-byte, no regex, no metacharacter interpretation, and
  // case-SENSITIVE — the 'i' flag in subjectMatches is a widening the exact
  // promise cannot afford ('RM -rf /' is not 'rm -rf /' on the platforms Bash
  // runs on). No trimming either: the stored pattern IS the approved command.
  if (rule.match === 'exact') return rule.pattern !== undefined && subject === rule.pattern;
  if (!subjectMatches(subject, rule.pattern)) return false;

  const pattern = rule.pattern;
  // The safety rules narrow WILDCARD BASH GRANTS only:
  //  * action !== 'allow' — the deny-list is 'ask' and MUST keep crossing
  //    operators, or '* rm *' stops catching 'cd x && rm -rf y'.
  //  * no pattern — a tool-wide grant ('*' in Full-auto) is a separate, explicit
  //    choice the Settings screen already flags as broad. Not our business here.
  //  * no wildcard — a literal pattern already matches exactly one string.
  //  * tool !== 'Bash' — every other subject is a path or an id, not a shell line.
  if (rule.action !== 'allow' || rule.tool !== 'Bash' || pattern === undefined) return true;
  if (!pattern.includes('*') && !pattern.includes('?')) return true;

  if (!wildcardGrantCovers(pattern, subject, context)) return false;
  // SAFETY RULE 4 — a stored grant that covers a command able to run ANY code
  // covers nothing (2026-09-10). Checked here, at decision time, so a grant saved
  // before an entry joined CODE_RUNNING_CORPUS (an old "Any node command") stops
  // working instead of keeping its reach; the user is simply asked again. Grants
  // covering the destructive families are NOT voided — see bash-hostile-corpus.ts.
  return !grantRunsAnyCode(pattern);
}

/** Safety rules 1–3 for a wildcard Bash allow grant: everything ruleMatches
 *  checks except rule 4, which is built from this. bash-grant-shapes uses it to
 *  judge a rung before offering it. */
export function wildcardGrantCovers(pattern: string, subject: string, context: MatchContext = {}): boolean {
  if (!subjectMatches(subject, pattern)) return false;

  // SAFETY RULE 1 — a wildcard grant never covers a second command.
  // Checked against the WHOLE subject, whatever the pattern holds (2026-09-10):
  // it used to skip an operator the pattern itself contained, so `cd src;ls`
  // stored the grant `cd src;ls*`, which then covered `cd src;ls; rm -rf ~`.
  // A single '&' at the very END only backgrounds the command in front of it, so
  // a grant like 'npm run*' still covers 'npm run dev &'.
  const checked = subject.replace(TRAILING_BACKGROUND, '');
  const operators = context.powershell ? [...SHELL_OPERATORS, ...POWERSHELL_OPERATORS] : SHELL_OPERATORS;
  if (operators.some((op) => checked.includes(op))) return false;

  // SAFETY RULE 2 — a wildcard in the MIDDLE never swallows a destructive flag.
  // Text after the wildcard means the rule is naming a bounded target ("pushing
  // to feat/x"); the flags that would unbind it are vetoed. A pattern that ENDS
  // in its wildcard ('npm run*') is honestly open-ended and is exempt.
  const bounded = !/[*?]$/.test(pattern);
  if (bounded) {
    for (const raw of subject.split(/\s+/)) {
      const token = raw.split('=')[0]; // --force-with-lease=origin/x
      if (BOUNDED_RUNG_VETO.includes(token) && !pattern.includes(token)) return false;
    }
  }

  // SAFETY RULE 3 — a wildcard starts and ends on a word boundary (2026-09-10).
  // Without it "Always allow running x.mjs" (`node x.mjs*`) also covered
  // `node x.mjs_evil`, a different file, and `npx prettier*` covered the package
  // `prettier-evil`. What a '*' matched must be empty, or be separated by
  // whitespace from the literal text on each side of it.
  return wildcardsOnWordBoundaries(pattern, subject);
}

function wildcardsOnWordBoundaries(pattern: string, subject: string): boolean {
  const literals = pattern.split('*');
  if (literals.length === 1) return true;
  const match = new RegExp('^' + literals.map(globLiteral).join('([\\s\\S]*)') + '$', 'i').exec(subject);
  if (!match) return false;
  for (let i = 1; i < match.length; i++) {
    const matched = match[i];
    if (matched === '') continue;
    const before = literals[i - 1];
    const after = literals[i];
    if (before !== '' && !/\s$/.test(before) && !/^\s/.test(matched)) return false;
    if (after !== '' && !/^\s/.test(after) && !/\s$/.test(matched)) return false;
  }
  return true;
}

const hostileVerdicts = new Map<string, boolean>();
const anyCodeVerdicts = new Map<string, boolean>();

/** Whether a wildcard Bash grant pattern covers any HOSTILE_CORPUS command, by
 *  rules 1–3 with bash's operators (the corpus is written for bash). What
 *  bash-grant-shapes asks before OFFERING a rung. Cached per pattern. */
export function grantAdmitsHostile(pattern: string): boolean {
  let verdict = hostileVerdicts.get(pattern);
  if (verdict === undefined) {
    verdict = HOSTILE_CORPUS.some((hostile) => wildcardGrantCovers(pattern, hostile));
    hostileVerdicts.set(pattern, verdict);
  }
  return verdict;
}

/** Whether a wildcard Bash grant pattern covers a command that runs ANY code
 *  (CODE_RUNNING_CORPUS) — safety rule 4. Cached per pattern like the above. */
export function grantRunsAnyCode(pattern: string): boolean {
  let verdict = anyCodeVerdicts.get(pattern);
  if (verdict === undefined) {
    verdict = CODE_RUNNING_CORPUS.some((command) => wildcardGrantCovers(pattern, command));
    anyCodeVerdicts.set(pattern, verdict);
  }
  return verdict;
}
