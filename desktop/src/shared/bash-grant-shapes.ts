// The grant options offered when the user picks "Always allow" on a Bash command.
//
// WHY this is in shared/ and not in main/: the sentence the user reads in the
// confirm and the rule the engine stores must come from ONE function. Two
// derivations would eventually disagree, and the disagreement would be a grant
// that is wider than the sentence describing it — the exact failure this item
// exists to fix. Same reasoning as subject-glob.ts's own header.
import { DESTRUCTIVE_DENY_LIST } from './permission-types';
import type { PermissionRule } from './permission-types';
import { grantAdmitsHostile, ruleMatches } from './subject-glob';

export type GrantScope = 'exact' | 'wide';

export interface GrantOption {
  scope: GrantScope;
  /** Exactly what gets persisted. The renderer never constructs this — it sends
   *  the `scope` selector and the main process re-derives from the tool call. */
  rule: PermissionRule;
  /** Plain-English label. MUST NOT contain '*' or '?' — this string is rendered
   *  in the confirm and in Settings, on a screen written for people who have
   *  never seen a glob. */
  label: string;
  /** What this grant will NOT cover, in the user's words, shown under the choice.
   *
   *  LOAD-BEARING, not decoration: the item deliberately does not explain a
   *  re-ask after the fact (spec A5), so this sentence is the only warning the
   *  user gets about the two cases that will ask again anyway — a chained
   *  command, and a flag that changes what the command does. Settled in compare
   *  round 2 (candidate C); do not trim it for space. */
  limits: string;
}

// The default limits sentence. A shape may override it with one that names the
// thing it actually scoped to.
// Destin's 2026-08-26/27 copy review: lighter wording, same two exclusions.
const GENERIC_LIMITS =
  "Doesn't cover this command chained onto another one, or run with different options.";

// Commands a wide rung must never admit. One entry per destructive deny-list
// FAMILY, pinned by a test that fails if a family is added without one.
//
// WHY this exists at all: isDenyListed() below asks "is the command in front of
// the user dangerous?" — but the rule being offered covers commands nobody
// tested. `git --no-pager log` is not deny-listed and derives the rung `git*`,
// which then covers `git push origin master` and `git reset --hard` and, once
// stored, OUTRANKS the deny-list. Checking the rung against this corpus is the
// mirror image of the self-coverage postcondition, and the only thing standing
// between a mild-sounding button and a silent force-push.
//
// NOT in the corpus: a plain `git push origin master`. Pushing to master is
// something the user is deliberately allowed to grant (master is an ordinary
// branch), so it is not "hostile regardless of intent" — putting it here would
// refuse the very branch rung Task 3 exists to build. `git*` is still caught, by
// the --delete and --prune and reset --hard entries.
// The list itself lives in bash-hostile-corpus.ts (2026-09-10): subject-glob.ts
// reads it too, to void a STORED grant that covers one, and cannot import this module.
export { HOSTILE_CORPUS } from './bash-hostile-corpus';

/** Turn a stored Bash pattern back into the sentence the confirm showed.
 *
 *  WHY it lives beside bashGrantOptions rather than in describe-rule.ts: the two
 *  directions must agree, and keeping them in one module that changes together is
 *  half of that. The other half is the round-trip test — proximity is a habit,
 *  the test is the guarantee.
 *
 *  Returns null when the pattern is not one this module produces; the caller
 *  falls back to its generic rendering rather than inventing a sentence. */
export function describeBashPattern(pattern: string): string | null {
  const push = /^git push\*(\S+) (.+)$/.exec(pattern);
  if (push) return `Pushing to ${refDestination(push[2])}`;
  // A script-run rung (`node scripts/x.mjs*`) reads as the file it runs. Decided
  // by the same scriptIndex the offer used, so a legacy `node*` grant — no file
  // token — still falls through to "Any node command".
  if (/^[^*?]+\*$/.test(pattern)) {
    const tokens = pattern.slice(0, -1).split(' ');
    const i = scriptIndex(tokens);
    if (i >= 0 && i === tokens.length - 1) return `Running ${tokens[i]}`;
  }
  const generic = /^([^*?]+?)\*$/.exec(pattern);
  if (generic) return `Any ${generic[1].trim()} command`;
  return null;
}

interface CommandShape {
  /** Matched against `${program} ${subcommand}`. */
  key: string;
  /** False → NO "Always allow" of any kind, not even exact. Reserve this for the
   *  one situation an exact grant cannot honour either: the command text does not
   *  say what it will act on, because that resolves when it RUNS (bare
   *  `git push`). A command that is merely too complex to widen still gets its
   *  exact rung — remembering it byte-for-byte is as safe as any other exact
   *  grant, and refusing it means a repeated command that can never be answered
   *  permanently. */
  rememberable(tokens: string[]): boolean;
  /** Why nothing may be remembered, in the user's words — shown on the card in
   *  place of the missing "Always allow" button. Shape-specific ON PURPOSE: it
   *  describes a push because `git push` is the only shape that can refuse, and
   *  a future shape that refuses must say its own reason rather than inherit a
   *  sentence about branches. */
  noGrantNote: string;
  /** The scoped wide rung, or null for "exact only". Never falls back to the
   *  generic rung: a shape exists precisely because the generic one is too wide
   *  for this command, so falling back would grant MORE, not less. */
  scope(tokens: string[]): { pattern: string; label: string; limits: string } | null;
}

/** Positional arguments to `git push` — the remote and the refspecs, with flags
 *  removed. `--opt=value` is one token so it filters out cleanly; a `--opt value`
 *  form would leave `value` looking positional, which is why the branch rung is
 *  produced ONLY at exactly two positionals. */
function pushPositionals(tokens: string[]): string[] {
  return tokens.slice(2).filter((t) => !t.startsWith('-'));
}

/** The branch a refspec ends up writing to, ignoring decoration. `HEAD:feat/x`
 *  and `+feat/x` and `:feat/x` all end at feat/x. */
function refDestination(refspec: string): string {
  const afterColon = refspec.includes(':')
    ? refspec.slice(refspec.indexOf(':') + 1)
    : refspec.replace(/^\+/, '');
  return afterColon.replace(/^refs\/heads\//i, '');
}

/** Does the command TEXT fix where this ref goes? `HEAD` and `@` do not — they
 *  resolve to whatever is checked out when the command runs, which is a different
 *  branch next week. Nothing can be remembered about them, at any width. */
function namesItsTarget(refspec: string): boolean {
  const dest = refDestination(refspec);
  return dest.length > 0 && !/^(HEAD|@)$/i.test(dest);
}

const COMMAND_SHAPES: CommandShape[] = [
  {
    key: 'git push',
    // Destin's 2026-08-26/27 copy review: same fact, fewer words.
    noGrantNote:
      "Nothing to remember here — this pushes whichever branch is checked out at the time, so next time it could be a different one.",
    // A bare `git push` pushes whatever branch is checked out AT RUN TIME, and
    // that branch changes underneath the grant — approve it on a feature branch
    // and next week it silently pushes master. Nothing here can name the target,
    // so no "Always allow" is offered at all; allow-once only. Same for
    // `git push origin` and `git push origin HEAD`.
    //
    // Everything else IS remembered, at least exactly: a two-ref push or a `+`/`:`
    // refspec cannot be widened honestly, but it names its own targets, so a
    // byte-exact grant is as safe as any other.
    rememberable: (tokens) => {
      const pos = pushPositionals(tokens);
      return pos.length >= 2 && pos.slice(1).every(namesItsTarget);
    },
    scope: (tokens) => {
      const pos = pushPositionals(tokens);
      // Exactly one remote + one refspec. Zero or one positional never reaches
      // here (rememberable already returned false); three or more is a multi-ref
      // push, which cannot be bounded to a single branch.
      if (pos.length !== 2) return null;
      const [remote, refspec] = pos;
      // A '*' or '?' would become a WILDCARD in the stored pattern rather than a
      // literal. Git forbids both in ref names, so this only fires on something
      // adversarial — refuse to widen rather than widen wrongly.
      if (/[*?]/.test(remote) || /[*?]/.test(refspec)) return null;
      // '+feat/x' force-pushes and ':feat/x' DELETES the branch. A rung labelled
      // "pushing to feat/x" would describe neither. Exact only.
      if (refspec.startsWith('+') || refspec.startsWith(':')) return null;
      // WHY the remote is in the pattern and not just the branch: `git push*feat/x`
      // also matches `git push origin master feat/x`, which pushes master TOO —
      // git takes any number of refspecs and this glob cannot count tokens. Pinning
      // the token that must immediately precede the refspec is the only way to
      // bound the command to a single ref. A grant named "pushing to feat/x" that
      // silently also pushes master is exactly what this item exists to prevent.
      //
      // The trailing text after the wildcard is also what makes safety rule 2 fire
      // on this rule, keeping --delete / --prune / --force out of it.
      return {
        pattern: `git push*${remote} ${refspec}`,
        label: `Always allow pushing to ${refDestination(refspec)}`,
        // Names what safety rule 2 keeps out of THIS grant specifically. The
        // generic sentence ("options that change what it does") would be true but
        // would not tell a user that deleting the branch is the thing excluded.
        // Destin's 2026-08-26/27 copy review: matches GENERIC_LIMITS' new opening.
        limits: "Doesn't cover deleting or force-pushing the branch, or this command chained onto another one.",
      };
    },
  },
];

/** Whitespace split that keeps quoted runs together. */
function tokenize(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

/** A word, as opposed to a flag, a path, or a quoted argument — i.e. plausibly a
 *  subcommand. The quote test matters: without it `echo "hi there"` derives a
 *  rung labelled `Any echo "hi there" command`, which is an argument masquerading
 *  as a verb. */
function isSubcommand(token: string | undefined): boolean {
  // '=' (2026-09-10): `env FOO=1 ls` is an assignment, not a verb. Treated as a
  // subcommand it derived `env FOO=1*`, which covers `env FOO=1 <any program>` and
  // slipped past HOSTILE_CORPUS's `env …` entry.
  return !!token && !token.startsWith('-') && !/^["']/.test(token) && !/[/\\.=]/.test(token);
}

/** `program sub` when the second token is a verb, else `program`. */
function shapeKey(tokens: string[]): string {
  return isSubcommand(tokens[1]) ? `${tokens[0]} ${tokens[1]}` : tokens[0];
}

function isDenyListed(command: string): boolean {
  return DESTRUCTIVE_DENY_LIST.some((r) => ruleMatches(r, command));
}

function wideRule(pattern: string): PermissionRule {
  return { tool: 'Bash', pattern, action: 'allow', match: 'glob' };
}

function deriveWide(command: string, tokens: string[]): GrantOption | null {
  const key = shapeKey(tokens);
  const shape = COMMAND_SHAPES.find((s) => s.key === key);
  if (shape) {
    const scoped = shape.scope(tokens);
    return scoped
      ? { scope: 'wide', rule: wideRule(scoped.pattern), label: scoped.label, limits: scoped.limits }
      : null;
  }

  // A deny-listed family with no shape row gets no widening: for rm / sudo /
  // format / git reset --hard the varying part IS the dangerous part, and there
  // is nothing that must precede an `rm` target the way a remote must precede a
  // push refspec, so it cannot be bounded to a single target.
  if (isDenyListed(command)) return null;

  // A script run gets a rung bound to that one file (see SCRIPT_RUNNERS). Anything
  // else from these programs (`python -c …`, `node -e …`) falls through to the
  // generic rung, which postcondition 2 then refuses against HOSTILE_CORPUS — so
  // those commands are offered their exact rung only.
  // Programs that run code or another program handed to them get no wide rung,
  // whatever follows (see NO_WIDE_RUNG).
  if (NO_WIDE_RUNG.has(tokens[0]) || NO_WIDE_RUNG.has(key)) return null;

  const run = scriptRunScope(tokens);
  if (run) return { scope: 'wide', rule: wideRule(run.pattern), label: run.label, limits: run.limits };

  return { scope: 'wide', rule: wideRule(`${key}*`), label: `Any ${key} command`, limits: GENERIC_LIMITS };
}

/** Programs that run a FILE of code: `python build.py`, `node scripts/x.mjs`.
 *
 *  WHY (2026-09-10 security review): their generic rung — "Any python command" —
 *  also covers `python -c …`, which runs anything at all, so HOSTILE_CORPUS now
 *  refuses it. Refusing it outright would cost every repeated script run its
 *  "Always allow", so a script run is offered a rung bound to that one file
 *  instead. That grant trusts whatever the file contains when it runs — the same
 *  trust as approving the run itself.
 *
 *  Not here: `tsx`/`ts-node` (a bare word after them is a verb such as `watch`, and
 *  both take `-e`) and Windows PowerShell 5.1's `powershell`, which reads its first
 *  bare argument as a COMMAND rather than a file — `pwsh` reads it as a file. */
const SCRIPT_RUNNERS = new Set([
  'python', 'python3', 'py', 'node', 'bun', 'deno',
  'bash', 'sh', 'zsh', 'perl', 'ruby', 'pwsh',
]);

/** Programs, or `program subcommand` keys, never offered a wide rung.
 *
 *  WHY (2026-09-10 security review): each runs code, or another program, handed
 *  to it in its arguments — `sed`'s `e` command, `tar --to-command`, `rg --pre`,
 *  `timeout 10 <any program>` — so "Any sed command" would quietly mean "any
 *  command". HOSTILE_CORPUS alone cannot catch these when offering: `timeout 10*`
 *  is a different rung from the corpus's `timeout 5 …`. The exact rung is still
 *  offered, so a repeated command can always be remembered.
 *
 *  Considered, not done: an ALLOW-list of programs that may be widened. Safer in
 *  principle, but every program missing from it would lose "Any … command" at
 *  once — a visible change with no known hole behind it. This list grows when
 *  one is found. Package runners bound to a named package (`npx prettier*`) stay
 *  widenable: safety rule 3 keeps them off a different package. */
export const NO_WIDE_RUNG: ReadonlySet<string> = new Set([
  // Interpreters that take code as an argument (script runs have their own rung).
  'tsx', 'ts-node', 'powershell', 'cmd', 'awk', 'gawk',
  // Launchers: the next word is itself a program.
  'find', 'xargs', 'env', 'eval', 'exec', 'command', 'nohup', 'nice', 'time', 'watch', 'timeout',
  'doas', 'su', 'ssh', 'script', 'strace', 'setsid', 'stdbuf', 'parallel',
  'npm exec', 'npm x', 'pnpm dlx', 'pnpm exec', 'yarn dlx', 'yarn exec', 'bun x', 'uv run',
  'docker run', 'docker exec',
  // Everyday tools with an option that runs a command.
  'sed', 'tar', 'sort', 'rg', 'git grep', 'sqlite3', 'rsync', 'zip',
]);

/** `python -m <module>` is widened only for modules whose arguments are options,
 *  never code — `python -m timeit "<code>"` and `python -m pdb` run what they are
 *  handed (2026-09-10 review). */
const PYTHON_MODULE_RUNGS: ReadonlySet<string> = new Set([
  'pytest', 'unittest', 'mypy', 'black', 'ruff', 'flake8', 'pylint', 'isort', 'venv', 'build',
]);

/** bun and deno take verbs of their own (`bun test`, `deno fmt`), so a bare word
 *  after them is a subcommand, not a file: only `run <file>` or a path-shaped
 *  token is a script. */
const SUBCOMMAND_RUNNERS = new Set(['bun', 'deno']);

const SCRIPT_LIMITS = "Doesn't cover other files, or this command chained onto another one.";

/** Where the script sits in a runner command, or -1 when the command is not "run
 *  this file" — a flag first (`-c`, `-e`), or a name that is quoted or carries a
 *  '*'/'?' (which would become a wildcard in the stored pattern). Shared by the
 *  offer and by describeBashPattern so the two directions cannot disagree. */
function scriptIndex(tokens: string[]): number {
  if (!SCRIPT_RUNNERS.has(tokens[0])) return -1;
  let i = 1;
  if (SUBCOMMAND_RUNNERS.has(tokens[0])) {
    if (tokens[1] === 'run') i = 2;
    else if (!/[/\\.]/.test(tokens[1] ?? '')) return -1;
  }
  const script = tokens[i];
  if (!script || script.startsWith('-') || /^["']/.test(script) || /[*?]/.test(script)) return -1;
  return i;
}

function scriptRunScope(tokens: string[]): { pattern: string; label: string; limits: string } | null {
  const [program, flag, module] = tokens;
  // `python -m pytest` names the module it runs, so it can be bounded like a
  // subcommand — for the modules in PYTHON_MODULE_RUNGS; anything else stays exact.
  if (/^(python3?|py)$/.test(program) && flag === '-m' && PYTHON_MODULE_RUNGS.has(module ?? '')) {
    return { pattern: `${program} -m ${module}*`, label: `Any ${program} -m ${module} command`, limits: GENERIC_LIMITS };
  }
  const i = scriptIndex(tokens);
  if (i < 0) return null;
  return {
    pattern: `${tokens.slice(0, i + 1).join(' ')}*`,
    label: `Always allow running ${tokens[i]}`,
    limits: SCRIPT_LIMITS,
  };
}

/** Why this command may not be remembered at any width, in the user's words —
 *  or null if it can be. The card shows this in place of the missing button, so
 *  a vanished "Always allow" reads as a decision rather than a bug. */
export function bashNoGrantNote(command: string): string | null {
  const tokens = tokenize(command);
  if (tokens.length === 0) return null;
  const shape = COMMAND_SHAPES.find((s) => s.key === shapeKey(tokens));
  return shape && !shape.rememberable(tokens) ? shape.noGrantNote : null;
}

/** Grant options for a Bash command, narrowest first.
 *
 *  An EMPTY array means no "Always allow" may be offered at all — the caller must
 *  suppress the button, not fall back to something. */
export function bashGrantOptions(command: string): GrantOption[] {
  const tokens = tokenize(command);
  if (tokens.length === 0) return [];

  const shape = COMMAND_SHAPES.find((s) => s.key === shapeKey(tokens));
  if (shape && !shape.rememberable(tokens)) return [];

  // The command is stored VERBATIM — never trimmed. permissionSubject hands the
  // engine args.command unchanged, so a trimmed pattern would differ from the
  // subject by a character the user cannot see and would never match again.
  const options: GrantOption[] = [
    {
      scope: 'exact',
      rule: { tool: 'Bash', pattern: command, action: 'allow', match: 'exact' },
      label: command,
      limits: GENERIC_LIMITS,
    },
  ];
  const wide = deriveWide(command, tokens);
  if (wide) options.push(wide);

  const offered = options.filter((o) => {
    // POSTCONDITION 1 — never offer a rung that cannot cover the command in front
    // of the user. Without it, `npm run build > log.txt` is offered "any npm run
    // command", a rule safety rule 1 immediately refuses, so the user saves a
    // grant, gets asked again identically, and nothing explains why.
    if (!ruleMatches(o.rule, command)) return false;
    // POSTCONDITION 2 — never offer a rung that admits a known-destructive
    // command. An exact rung is exempt: it covers exactly the string the user is
    // looking at, so approving `rm -rf build` is a decision, not a surprise.
    if (o.scope === 'exact') return true;
    // grantAdmitsHostile, not ruleMatches: ruleMatches now VOIDS a hostile grant
    // (rule 4), so asking it "does this rung cover a hostile command?" would say no.
    return !grantAdmitsHostile(o.rule.pattern!);
  });

  // A SHAPED rung already says, in the user's own words, what the command does
  // ("pushing to feat/login"). Its exact rung differs from it ONLY by options the
  // user cannot see the effect of (-u, -q, --repo=…) — every difference that
  // would matter is excluded from both by safety rule 2. Offering both would ask
  // the user to choose between two sentences that mean the same thing, and would
  // let one push be approved twice, as two Settings rows that read identically
  // and cover different amounts.
  //
  // The GENERIC rung is not collapsed: "only this command" vs "any npm run
  // command" is a real difference in how much trust is being handed over.
  if (shape && offered.some((o) => o.scope === 'wide')) {
    return offered.filter((o) => o.scope === 'wide');
  }
  return offered;
}
