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
import {
  tokenize, commandIndex, inlineShellScript, baseName, splitHeredocs, SHELL_FEEDERS, WRAPPERS, type Op, type Word,
} from './shell-words';

export interface AdminCommandContext {
  /** Injected for tests; defaults to the running platform. Windows has neither
   *  a setuid `sudo` nor the other four tools in the sense this floor cares
   *  about, so backslash stays a path separator there like the other floors. */
  platform?: NodeJS.Platform;
}

const REFUSE_WORDS = new Set(['doas', 'su', 'pkexec', 'run0']);
/** The set commandIndex must STOP at rather than skip past (see file header). */
const STOP_WORDS = new Set(['sudo', ...REFUSE_WORDS]);
/** `find`'s own actions that run an arbitrary command (review T1-2): the same
 *  shape bash-secret-paths.ts already recurses into for its own threat model.
 *  Ended by a bare `;` or `+`. */
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);

export type AdminVerdict =
  | { kind: 'admin'; word: 'sudo' }
  | { kind: 'refuse'; word: 'doas' | 'su' | 'pkexec' | 'run0' };

function verdictForWord(name: string): AdminVerdict | null {
  if (name === 'sudo') return { kind: 'admin', word: 'sudo' };
  if (REFUSE_WORDS.has(name)) return { kind: 'refuse', word: name as 'doas' | 'su' | 'pkexec' | 'run0' };
  return null;
}

/** Refusal text for each refused word — states the TRUE cause for THAT word
 *  (docs/error-message-standards.md: never invent one; review T1-4).
 *  `pkexec`/`run0` raise the desktop's OWN polkit dialog outside the app;
 *  `doas`/`su` have no askpass hook this app can intercept, so they'd ask for
 *  the password in a terminal YouCoded can't show — a different failure, not
 *  "a password window outside YouCoded". */
const REFUSE_CAUSE: Record<'doas' | 'su' | 'pkexec' | 'run0', string> = {
  pkexec: 'it would open a password window outside YouCoded',
  run0: 'it would open a password window outside YouCoded',
  doas: "it asks for your password in a terminal, which YouCoded can't show",
  su: "it asks for your password in a terminal, which YouCoded can't show",
};

/** The model-facing tool result for a refused word — the caller (harness-
 *  session.ts step 3b) denies with this text and no ask at all. */
export function refuseMessage(word: 'doas' | 'su' | 'pkexec' | 'run0'): string {
  return `${word} can't be used here: ${REFUSE_CAUSE[word]}. Use sudo instead — the user is asked for their password in the app.`;
}

/** Whether `command` visibly runs `sudo` (→ the admin floor) or one of the
 *  refused tools (`doas`/`su`/`pkexec`/`run0`), reading shell syntax the same
 *  way rm-target.ts and bash-secret-paths.ts do: wrappers, pipelines,
 *  subshells, `bash -c`/`sh -c` scripts, `eval`, and `$(…)`/backtick
 *  substitutions. Null when the command runs none of the five words. */
export function adminCommandVerdict(command: string, ctx?: AdminCommandContext): AdminVerdict | null {
  const win = (ctx?.platform ?? process.platform) === 'win32';

  const analyse = (source: string): AdminVerdict | null => {
    // Heredoc bodies are text unless a shell runs them (review T1-1, same
    // idiom as rm-target.ts/bash-secret-paths.ts): `cat <<EOF\nsudo x\nEOF`
    // never runs sudo — `sudo x` there is just a line `cat` will write out.
    const { text, bodies } = splitHeredocs(source);
    const { tokens, nested } = tokenize(text, !win);
    let words: Word[] = [];
    const verdictForCmd = (cmd: Word[]): AdminVerdict | null => {
      if (cmd.length === 0) return null;
      const w = commandIndex(cmd, STOP_WORDS);
      if (w >= cmd.length) return null;
      const name = baseName(cmd[w].value);
      const verdict = verdictForWord(name);
      if (verdict) return verdict;
      const args = cmd.slice(w + 1);
      // `bash -c 'sudo x'`, `sh -c -- '…'`, `eval "sudo x"`: the script is a
      // command line of its own (same idiom as the other two floors).
      const script = inlineShellScript(name, args);
      if (script !== null) return analyse(script);
      // `find … -exec sudo … \;` / `-execdir`/`-ok`/`-okdir` (review T1-2):
      // find runs the command that follows as its own process, the same shape
      // bash-secret-paths.ts already recurses into for FIND_EXEC.
      if (name === 'find') {
        for (let i = 0; i < args.length; i++) {
          if (!FIND_EXEC.has(args[i].value)) continue;
          const sub: Word[] = [];
          for (i++; i < args.length && args[i].value !== ';' && args[i].value !== '+'; i++) sub.push(args[i]);
          const hit = verdictForCmd(sub);
          if (hit) return hit;
        }
      }
      return null;
    };
    const runCommand = (): AdminVerdict | null => {
      const cmd = words;
      words = [];
      return verdictForCmd(cmd);
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
    // A heredoc fed to a shell (`bash <<EOF`) runs its body as commands; any
    // other feeder (`cat > install.sh <<EOF`) only writes it as text.
    for (const h of bodies) {
      if (!SHELL_FEEDERS.has(h.feeder)) continue;
      const why = analyse(h.body);
      if (why) return why;
    }
    return null;
  };

  return analyse(command);
}

/** The shared flag-skip loop behind both `visibleSudoLines` (a `sudo` word
 *  found while parsing shell TEXT) and `displayCommandFromSudoArgv` below (a
 *  `sudo` word already at argv[0] of a REAL process, read from
 *  /proc/<pid>/cmdline by askpass-server.ts's verify.ts) — both need the same
 *  rule for what sudo itself will consume before its real command starts:
 *  `--` ends flag parsing, a known value-flag consumes the next slot,
 *  anything else starting with `-` is a bare flag, and the first non-flag
 *  word starts the command sudo will actually run. `rest` is everything
 *  AFTER the `sudo` word itself in both callers. */
function stripSudoOptionsFromArgv(rest: string[]): string[] {
  const valueFlags = WRAPPERS.sudo.valueFlags;
  const argv: string[] = [];
  let endOfFlags = false;
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i];
    if (endOfFlags) { argv.push(v); continue; }
    if (v === '--') { endOfFlags = true; continue; }
    if (v.startsWith('-')) { if (valueFlags.includes(v)) i++; continue; }
    endOfFlags = true;
    argv.push(v);
  }
  return argv;
}

/** admin-password-service.ts (design §2.4/§3 item 5, §11 task 5): the argv
 *  sudo will actually run for a REAL sudo process's own argv (already read
 *  fresh from /proc/<sudo>/cmdline by verify.ts) — `sudo` itself (argv[0], by
 *  basename — sudo's own argv[0] is whatever path invoked it, e.g.
 *  `/usr/bin/sudo`) and its own options stripped. This is the up-front ask's
 *  match key (task 5): compared directly against a `visibleSudoLines` entry
 *  (which strips the SAME way, starting from shell text instead of a live
 *  process) to tell "the approved sudo line" from a hidden one elsewhere in
 *  the same call. */
export function sudoRealArgv(sudoArgv: string[]): string[] {
  const rest = sudoArgv.length > 0 && baseName(sudoArgv[0]) === 'sudo' ? sudoArgv.slice(1) : sudoArgv;
  return stripSudoOptionsFromArgv(rest);
}

/** Display only: joins with single spaces and single-quotes any argument
 *  containing whitespace, never re-parsed as shell syntax, never shown the
 *  raw argv a hostile arg could otherwise use to fake a different-looking
 *  command. Shared by `displayCommandFromSudoArgv` (a real sudo process's
 *  argv) and the up-front card (an already-stripped `visibleSudoLines`
 *  entry) — task 5. */
export function displayCommandFromArgv(argv: string[]): string {
  return argv
    .map((a) => (/\s/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a))
    .join(' ');
}

/** admin-password-service.ts (design §2.4/§3 item 5): builds the password
 *  card's command text directly from a REAL sudo process's own argv — the
 *  up-front ask's counterpart to `visibleSudoLines` below, which reads shell
 *  TEXT instead of a live process. */
export function displayCommandFromSudoArgv(sudoArgv: string[]): string {
  return displayCommandFromArgv(sudoRealArgv(sudoArgv));
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

  const pushSudoLine = (rest: Word[]): void => {
    const argv = stripSudoOptionsFromArgv(rest.map((w) => w.value));
    if (argv.length) lines.push(argv);
  };

  const analyse = (source: string): void => {
    // Same heredoc-body exemption as adminCommandVerdict (review T1-1).
    const { text, bodies } = splitHeredocs(source);
    const { tokens, nested } = tokenize(text, true);
    let words: Word[] = [];
    const visitCmd = (cmd: Word[]): void => {
      if (cmd.length === 0) return;
      const w = commandIndex(cmd, STOP_WORDS);
      if (w >= cmd.length) return;
      const name = baseName(cmd[w].value);
      const args = cmd.slice(w + 1);
      if (name === 'sudo') { pushSudoLine(args); return; }
      const script = inlineShellScript(name, args);
      if (script !== null) { analyse(script); return; }
      // `find … -exec sudo … \;` (review T1-2, same shape as adminCommandVerdict).
      if (name === 'find') {
        for (let i = 0; i < args.length; i++) {
          if (!FIND_EXEC.has(args[i].value)) continue;
          const sub: Word[] = [];
          for (i++; i < args.length && args[i].value !== ';' && args[i].value !== '+'; i++) sub.push(args[i]);
          visitCmd(sub);
        }
      }
    };
    const runCommand = (): void => {
      const cmd = words;
      words = [];
      visitCmd(cmd);
    };
    for (const tok of tokens) {
      const op = (tok as Op).op;
      if (!op) { words.push(tok as Word); continue; }
      runCommand();
    }
    runCommand();
    for (const inner of nested) analyse(inner);
    for (const h of bodies) {
      if (SHELL_FEEDERS.has(h.feeder)) analyse(h.body);
    }
  };

  analyse(command);
  return lines;
}
