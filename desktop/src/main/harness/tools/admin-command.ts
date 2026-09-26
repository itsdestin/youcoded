// The admin floor: a check that sits BELOW every permission rule, the same way
// rm-target.ts and bash-secret-paths.ts do (see admin-password technical design
// §4). A Bash command that visibly runs `sudo` ALWAYS asks — even under a
// remembered "Always allow" or Full auto — because it is about to open a
// password prompt inside the app. `doas`, `su`, `pkexec` and `run0` are refused
// outright: `pkexec`/`run0` would raise the desktop's OWN polkit dialog (a
// system pop-up outside the app, with wording the app doesn't control), and
// `doas`/`su` have no askpass mechanism this app can intercept the same way.
//
// Unlike rm-target/bash-secret-paths, this floor must see `sudo` (and the other
// four words) AS the command, not walk past it — WRAPPERS in shell-words.ts
// treats `sudo` as transparent so THOSE floors can see what sudo runs; this one
// needs the opposite, so it calls commandIndex with `stopBefore`.
//
// NOT a sandbox: it reads the command text, so anything that hides the target
// from a reader (a script file, an interpreter's inline call to execvp, base64)
// passes it by construction. Same posture as guards.ts. `python3 -c
// "os.execvp('pkexec', …)"` still reaches polkit — the honest limit of a floor
// that reads shell syntax, not a sandbox.
import { tokenize, commandIndex, inlineShellScript, baseName, WRAPPERS, type Op, type Word } from './shell-words';

export interface AdminCommandContext {
  /** Injected for tests; defaults to the running platform. Windows has neither
   *  a setuid `sudo` nor the other four tools in the sense this floor cares
   *  about, so backslash stays a path separator there like the other floors. */
  platform?: NodeJS.Platform;
}

const REFUSE_WORDS = new Set(['doas', 'su', 'pkexec', 'run0']);
/** The set commandIndex must STOP at rather than skip past (see file header). */
const STOP_WORDS = new Set(['sudo', ...REFUSE_WORDS]);

export type AdminVerdict =
  | { kind: 'admin'; word: 'sudo' }
  | { kind: 'refuse'; word: 'doas' | 'su' | 'pkexec' | 'run0' };

function verdictForWord(name: string): AdminVerdict | null {
  if (name === 'sudo') return { kind: 'admin', word: 'sudo' };
  if (REFUSE_WORDS.has(name)) return { kind: 'refuse', word: name as 'doas' | 'su' | 'pkexec' | 'run0' };
  return null;
}

/** Whether `command` visibly runs `sudo` (→ the admin floor) or one of the
 *  refused tools (`doas`/`su`/`pkexec`/`run0`), reading shell syntax the same
 *  way rm-target.ts and bash-secret-paths.ts do: wrappers, pipelines,
 *  subshells, `bash -c`/`sh -c` scripts, `eval`, and `$(…)`/backtick
 *  substitutions. Null when the command runs none of the five words. */
export function adminCommandVerdict(command: string, ctx?: AdminCommandContext): AdminVerdict | null {
  const win = (ctx?.platform ?? process.platform) === 'win32';

  const analyse = (source: string): AdminVerdict | null => {
    const { tokens, nested } = tokenize(source, !win);
    let words: Word[] = [];
    const runCommand = (): AdminVerdict | null => {
      const cmd = words;
      words = [];
      if (cmd.length === 0) return null;
      const w = commandIndex(cmd, STOP_WORDS);
      if (w >= cmd.length) return null;
      const name = baseName(cmd[w].value);
      const verdict = verdictForWord(name);
      if (verdict) return verdict;
      // `bash -c 'sudo x'`, `sh -c -- '…'`, `eval "sudo x"`: the script is a
      // command line of its own (same idiom as the other two floors).
      const args = cmd.slice(w + 1);
      const script = inlineShellScript(name, args);
      return script !== null ? analyse(script) : null;
    };
    for (const tok of tokens) {
      const op = (tok as Op).op;
      if (!op) { words.push(tok as Word); continue; }
      const why = runCommand();
      if (why) return why;
    }
    const last = runCommand();
    if (last) return last;
    // `$(sudo cat f)` / `` `sudo cat f` ``: substitutions run as commands of
    // their own, wherever they sit in the line.
    for (const inner of nested) {
      const why = analyse(inner);
      if (why) return why;
    }
    return null;
  };

  return analyse(command);
}

/** The argv sudo will actually run in each sudo simple-command inside
 *  `command`, with `sudo` itself and its own options stripped (`sudo --user
 *  root apt update` → `['apt', 'update']`). Used by the up-front password ask
 *  (design §2.4/§4) to match an askpass connection's sudo process to the
 *  approved command's own sudo line — a hidden sudo elsewhere in the same call
 *  (a downloaded script) gets the mid-command card instead, never this one's
 *  password. Only `sudo` lines: the refused words never reach a password ask. */
export function visibleSudoLines(command: string): string[][] {
  const lines: string[][] = [];
  const valueFlags = WRAPPERS.sudo.valueFlags;

  const analyse = (source: string): void => {
    const { tokens, nested } = tokenize(source, true);
    let words: Word[] = [];
    const runCommand = (): void => {
      const cmd = words;
      words = [];
      if (cmd.length === 0) return;
      const w = commandIndex(cmd, STOP_WORDS);
      if (w >= cmd.length) return;
      const name = baseName(cmd[w].value);
      if (name !== 'sudo') {
        const args = cmd.slice(w + 1);
        const script = inlineShellScript(name, args);
        if (script !== null) analyse(script);
        return;
      }
      const rest = cmd.slice(w + 1);
      const argv: string[] = [];
      let endOfFlags = false;
      for (let i = 0; i < rest.length; i++) {
        const v = rest[i].value;
        if (endOfFlags) { argv.push(v); continue; }
        if (v === '--') { endOfFlags = true; continue; }
        if (v.startsWith('-')) { if (valueFlags.includes(v)) i++; continue; }
        endOfFlags = true;
        argv.push(v);
      }
      if (argv.length) lines.push(argv);
    };
    for (const tok of tokens) {
      const op = (tok as Op).op;
      if (!op) { words.push(tok as Word); continue; }
      runCommand();
    }
    runCommand();
    for (const inner of nested) analyse(inner);
  };

  analyse(command);
  return lines;
}
