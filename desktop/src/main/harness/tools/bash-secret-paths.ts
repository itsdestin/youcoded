// The secret-path floor for Bash: a check that sits BELOW every permission rule.
//
// WHY this exists (roadmap: "The assistant refuses to open ~/.ssh or .env with
// its file tools, but `cat` through a shell command reads the same file").
// Read/Grep/Glob hard-refuse credential files (guards.ts checkPathGuard), but
// Bash never looked at the paths inside its command, so `cat ~/.ssh/id_rsa` ran
// — silently, whenever a saved "Always allow" covered the command. Destin,
// 2026-09-23 (option B): a Bash command that names a secret path ALWAYS gets an
// approval card with no "Always allow", even when a saved grant covers it. It is
// an ask, not a refusal, because real work needs these files too
// (`ssh -i ~/.ssh/key host`, `chmod 600 ~/.ssh/config`) and the person can say yes.
//
// ONE LIST. The decision is checkPathGuard's own 'deny' verdict — the exact set
// the file tools refuse (isSensitivePath + the home credential folders +
// credential-paths.ts). Never add a second list here: the two would drift, and
// a path the file tools refuse must never be one Bash can read without asking.
//
// What counts as a path reference: every word of the command (quotes removed,
// `~` / `$HOME` expanded), plus the value after the first `=` in a word
// (`--env-file=.env`, `KEY=~/.aws/credentials`). A word is resolved from the
// shell's current folder and handed to the guard; a word that is not a secret
// PATH — `printenv`, `env:check`, `.envrc-template` — does not match the list,
// because the list is about path segments and file names, never substrings.
// URLs are skipped: `https://host/.env.example` is not a file on this machine.
//
// NOT a sandbox: a command that builds the path at run time (variables, base64,
// a script file) passes by construction. Same posture as guards.ts.
import * as os from 'os';
import * as path from 'path';
import { checkPathGuard } from './guards';
import { tokenize, expandHome, type Op, type Word } from './rm-target';

export interface SecretPathContext {
  /** The workspace (session) root. */
  cwd: string;
  /** Where the next Bash call starts (the persisted shell cwd); defaults to `cwd`. */
  shellCwd?: string;
  /** Injected for tests; defaults to the real home folder. */
  home?: string;
}

/** The first secret path `command` names, or null when it names none. */
export function secretPathIn(command: string, ctx: SecretPathContext): string | null {
  const win = process.platform === 'win32';
  const home = ctx.home ?? os.homedir();
  const base = ctx.shellCwd ?? ctx.cwd;
  for (const token of tokenize(command, !win)) {
    if ((token as Op).op) continue;
    const word = token as Word;
    const candidates = [word.value];
    const eq = word.value.indexOf('=');
    if (eq > 0) candidates.push(word.value.slice(eq + 1));
    for (const [i, raw] of candidates.entries()) {
      if (!raw || raw.includes('://')) continue;
      // `~` expands only at the very start of the word, as the shell does.
      const expanded = expandHome(raw, i === 0 ? word.tilde : raw.startsWith('~'), home);
      const verdict = checkPathGuard(path.resolve(base, expanded), ctx.cwd);
      if (verdict.kind === 'deny') return raw;
    }
  }
  return null;
}
