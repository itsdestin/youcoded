// Commands a WILDCARD "Always allow" grant must never cover, even when the grant's
// words match — because the same program does something much bigger with one
// extra option (security audit 2026-10-30, finding 10).
//
// WHY this is its own module in shared/: the engine (subject-glob.ts ruleMatches)
// uses it to refuse covering a risky command, bash-grant-shapes.ts uses it to
// decide what to OFFER, and Settings uses it to tell the user what an older grant
// no longer covers. Three readers, one definition — they cannot drift apart.
//
// WHAT it is: a speed bump, not a sandbox. It looks only at the command text. It
// cannot know what a program does with a file it reads, what an alias or a
// config file changes, or what a downloaded script contains. It is modelled on
// how Claude Code (prefix rules; compound commands split and each part checked;
// substitutions are never covered) and Codex (a command with substitutions,
// variables or redirects is never split or trusted — it asks as a whole) treat the
// same problem, and it errs toward asking.
//
// EXACT grants never reach this module: they match one string byte for byte.

export type RiskKind =
  | 'sends-data'      // curl/wget that upload or POST
  | 'setup-scripts'   // package installs that run the packages' own scripts
  | 'remote-change'   // git remote / git config / git -c
  | 'network-tool'    // programs whose whole job is talking to other computers
  | 'env-prefix'      // a command that starts by setting variables
  | 'expansion';      // text the shell fills in when the command runs

/** Text-level cleanup so `'-d'`, `"curl"` and `cu\rl` read like their plain forms. */
function plain(token: string): string {
  return token.replace(/["'\\]/g, '');
}

/** Split on whitespace keeping quoted runs together (same shape as the tokenizer in
 *  bash-grant-shapes, kept separate so this module imports nothing). */
function words(command: string): string[] {
  return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map(plain);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `curl`, `/usr/bin/curl`, `CURL.EXE` → `curl`. */
function programName(token: string | undefined): string {
  if (!token) return '';
  const base = token.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

// ── curl / wget ─────────────────────────────────────────────────────────────

// Long options that send something out or make curl read instructions from a file.
// curl (like wget) accepts any unambiguous PREFIX of a long option (`--upl` is
// `--upload-file`), so a prefix of one of these counts too — see optionIsOneOf.
const CURL_SENDING_LONG = [
  'data', 'data-ascii', 'data-binary', 'data-raw', 'data-urlencode', 'form', 'form-string',
  'upload-file', 'json', 'request', 'config', 'telnet-option', 'mail-from', 'mail-rcpt',
  // Integration review 2026-11-01: these make curl read a file's text into what it sends (`--variable name@file` with an
  // --expand-* option) or take its settings from a file; a cookie FILE is read too (see fetcherReadsOrWritesFiles).
  'variable', 'expand-data', 'expand-url', 'expand-form', 'expand-header', 'expand-json', 'expand-request', 'expand-output', 'proxy-header',
];
const WGET_SENDING_LONG = [
  'post-data', 'post-file', 'body-data', 'body-file', 'method', 'execute', 'config',
  // A list of addresses read from a file, and cookie files read from disk.
  'input-file', 'load-cookies',
];
// Short letters that send (curl -d -F -T -K -X; wget -e). Looked for inside
// clusters like `-sSd`.
const CURL_SENDING_SHORT = /[dFTKX]/;
const WGET_SENDING_SHORT = /[e]/;

function optionIsOneOf(token: string, longNames: string[]): boolean {
  if (!token.startsWith('--')) return false;
  const name = token.slice(2).split('=')[0];
  if (name === '') return false; // a bare `--` ends the options
  return longNames.some((l) => l.startsWith(name));
}

function requestIsReadOnly(list: string[], at: number, program: 'curl' | 'wget'): boolean {
  // `-X GET`, `-XGET`, `--request=HEAD`, `--method GET`: naming the read verbs is harmless.
  const token = list[at];
  let value: string | undefined;
  if (token.startsWith('--')) value = token.includes('=') ? token.split('=').slice(1).join('=') : list[at + 1];
  else if (program === 'curl') {
    const rest = token.slice(token.indexOf('X') + 1);
    value = rest !== '' ? rest : list[at + 1];
  }
  return /^(GET|HEAD)$/i.test(value ?? '');
}

/** A destination the wide grant may cover: a plain relative path that stays below where the command runs. Anything
 *  that names another place (absolute, `~`, `..`, a variable, `-`/devices) is outside "this project" and asks. */
function stayingInsideFolder(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  if (value === '-' || /^[/\\~]|^[A-Za-z]:|\$|`|\.\.|%/.test(value)) return false;
  return true;
}

// Options that WRITE a file (the value is where) and the ones that READ a file into the request.
const CURL_WRITES = { short: 'oc' + 'D', long: ['output', 'output-dir', 'cookie-jar', 'dump-header', 'trace', 'trace-ascii', 'stderr', 'libcurl', 'etag-save', 'hsts', 'alt-svc'] };
const WGET_WRITES = { short: 'OPoa', long: ['output-document', 'directory-prefix', 'output-file', 'append-output', 'save-cookies', 'save-headers-to', 'warc-file', 'rejected-log'] };

/** curl/wget forms that read a file into the request or write one somewhere else (integration review 2026-11-01):
 *  `-H @file` / `--header @file` send a file's text as a header, `-b FILE` sends a cookie file, and `-o`/`--output`
 *  and friends can overwrite any file the person owns unless they stay below the current folder. */
function fetcherReadsOrWritesFiles(program: 'curl' | 'wget', list: string[]): boolean {
  const writes = program === 'curl' ? CURL_WRITES : WGET_WRITES;
  for (let i = 1; i < list.length; i++) {
    const t = list[i];
    if (t === '--') break;
    if (t.startsWith('--')) {
      const name = t.slice(2).split('=')[0];
      if (name === '') break;
      const value = t.includes('=') ? t.split('=').slice(1).join('=') : list[i + 1];
      if (program === 'curl' && ('header'.startsWith(name) || 'proxy-header'.startsWith(name)) && name.length >= 2 && /^@/.test(value ?? '')) return true;
      if (program === 'curl' && 'cookie'.startsWith(name) && name.length >= 2 && !/=/.test(value ?? '')) return true; // a bare word is a FILE to read
      if (writes.long.some((l) => l.startsWith(name)) && name.length >= 2 && !stayingInsideFolder(value)) return true;
      continue;
    }
    if (/^-[A-Za-z0-9]/.test(t)) {
      // Walk the cluster: letters until one takes a value (the rest of the word, else the next word).
      const letters = t.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const ch = letters[k];
        const takes = program === 'curl' ? /[oHbcDKAeEuxzXmwtTFd]/.test(ch) : /[OPoaeitTUwQ]/.test(ch);
        if (!takes) continue;
        const value = k < letters.length - 1 ? letters.slice(k + 1) : list[i + 1];
        if (program === 'curl' && ch === 'H' && /^@/.test(value ?? '')) return true;
        if (program === 'curl' && ch === 'b' && !/=/.test(value ?? '')) return true;
        if (program === 'wget' && ch === 'i') return true;
        if (writes.short.includes(ch) && !stayingInsideFolder(value)) return true;
        break;
      }
    }
  }
  return false;
}

function fetcherSends(program: 'curl' | 'wget', list: string[]): boolean {
  if (fetcherReadsOrWritesFiles(program, list)) return true;
  const longs = program === 'curl' ? CURL_SENDING_LONG : WGET_SENDING_LONG;
  const shortRx = program === 'curl' ? CURL_SENDING_SHORT : WGET_SENDING_SHORT;
  for (let i = 1; i < list.length; i++) {
    const t = list[i];
    if (t === '--') continue;
    if (t.startsWith('--')) {
      if (!optionIsOneOf(t, longs)) continue;
      // --request / --method with a read verb is fine; everything else listed sends.
      const name = t.slice(2).split('=')[0];
      const isVerb = 'request'.startsWith(name) || 'method'.startsWith(name);
      if (isVerb && (program === 'curl' ? 'request' : 'method').startsWith(name) && requestIsReadOnly(list, i, program)) continue;
      return true;
    }
    if (/^-[A-Za-z0-9]+/.test(t) && shortRx.test(t.replace(/^-/, '').split('=')[0])) {
      // -X is the only short letter with a harmless value.
      if (program === 'curl' && /X/.test(t) && !/[dFTK]/.test(t) && requestIsReadOnly(list, i, 'curl')) continue;
      return true;
    }
  }
  return false;
}

// ── package installs ────────────────────────────────────────────────────────

const NODE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cnpm']);
// npm also accepts abbreviations of `install` (inst, insta…), plus add/ci/update.
const NODE_INSTALLERS = /^(i|in|ins|inst|insta|instal|install|isntall|add|ci|clean-install|update|up|upgrade|udpate|it|install-test|rebuild|rb|link|ln)$/;
const PY_INSTALL_WORDS = /^(install|add|sync|upgrade)$/;
const PY_MANAGERS = new Set(['pip', 'pip3', 'pipx', 'uv', 'poetry', 'pdm', 'pipenv', 'conda', 'mamba']);

function nodeInstallRunsScripts(list: string[]): boolean {
  const rest = list.slice(1);
  // Bare `yarn` and `bun` install. Bare `npm`/`pnpm` print help.
  const bareInstalls = rest.length === 0 && (list[0] === 'yarn' || list[0] === 'bun');
  if (!(rest.some((w) => !w.startsWith('-') && NODE_INSTALLERS.test(w)) || bareInstalls)) return false;
  // The LAST ignore-scripts option wins, as in npm.
  let ignoring = false;
  for (const w of rest) {
    if (w === '--ignore-scripts' || w === '--ignore-scripts=true') ignoring = true;
    else if (w === '--no-ignore-scripts' || w === '--ignore-scripts=false') ignoring = false;
  }
  return !ignoring;
}

function pythonInstallRunsCode(list: string[], program: string): boolean {
  // `python -m pip …` is pip.
  const rest = list.slice(1);
  const isPipModule = /^python3?$|^py$/.test(program) && rest[0] === '-m' && rest[1] === 'pip';
  if (!PY_MANAGERS.has(program) && !isPipModule) return false;
  if (!rest.some((w) => PY_INSTALL_WORDS.test(w))) return false;
  // Only pip with "ready-built packages only" runs no package code while installing.
  const pip = program === 'pip' || program === 'pip3' || isPipModule;
  if (pip) {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--only-binary=:all:' || (rest[i] === '--only-binary' && rest[i + 1] === ':all:')) return false;
    }
  }
  return true;
}

// ── git ─────────────────────────────────────────────────────────────────────

function gitChangesRemotesOrConfig(list: string[]): boolean {
  const rest = list.slice(1);
  // Option -c sets config for one run (core.sshCommand, aliases…): runs commands.
  if (rest.some((w) => w === '-c' || w.startsWith('-c') && w.includes('=') || /^--(upload-pack|receive-pack|exec-path|config-env)/.test(w))) return true;
  const sub = rest.find((w) => !w.startsWith('-'));
  if (sub === 'remote') return rest.some((w) => /^(add|set-url|rename|remove|rm|set-head|set-branches|prune|update)$/.test(w));
  if (sub === 'config') return !rest.some((w) => /^(--get|--get-all|--get-regexp|--list|-l|--show-origin)$/.test(w));
  return false;
}

// ── always-risky programs ───────────────────────────────────────────────────

// Their whole job is talking to other computers (or, for rclone/rsync, copying to
// them). A wildcard grant for "Any scp command" would also cover sending any file
// anywhere, so these can only ever be remembered exactly.
const NETWORK_TOOLS = new Set([
  'scp', 'sftp', 'ssh', 'ssh-copy-id', 'mosh', 'rsync', 'rclone', 'nc', 'ncat', 'netcat', 'socat',
  'telnet', 'ftp', 'lftp', 'http', 'https', 'xh', 'aria2c',
]);

// ── text the shell fills in at run time ────────────────────────────────────

/** Variables (`$X`, `${X}`, `$'…'`), and brace lists (`{-d,x}`) turn into other words
 *  AFTER the command was approved: `curl $A url` can be `curl -d @file url`. Text in
 *  single quotes is literal, so it is not counted. $( and ` are already refused by
 *  safety rule 1 in subject-glob.ts; they are repeated here only for completeness. */
function hasExpansion(subject: string): boolean {
  const unsingle = subject.replace(/'[^']*'/g, "''");
  if (/\$[A-Za-z_{@*#?!$0-9'"-]/.test(unsingle)) return true;
  const unquoted = unsingle.replace(/"[^"]*"/g, '""');
  return /\{[^}\s]*(,|\.\.)[^}]*\}/.test(unquoted);
}

/** Why a WILDCARD Bash grant must not cover this command, or null if it may.
 *
 *  `pattern` (the grant's own text) is accepted for callers that have it; no rule
 *  needs it today. */
export function riskyVariant(subject: string, _pattern?: string): RiskKind | null {
  const list = words(subject);
  if (list.length === 0) return null;
  // Leading `FOO=1 cmd`: the grant never named the variable, and variables such as
  // PATH, LD_PRELOAD or NODE_OPTIONS change what runs. Look past them to still
  // classify the program, but the assignment alone is already a reason.
  let start = 0;
  while (start < list.length && ASSIGNMENT.test(list[start])) start++;
  if (start > 0) return 'env-prefix';
  if (hasExpansion(subject)) return 'expansion';

  const program = programName(list[0]);
  if (program === 'curl' || program === 'wget') return fetcherSends(program, list) ? 'sends-data' : null;
  if (NETWORK_TOOLS.has(program)) return 'network-tool';
  if (NODE_MANAGERS.has(program) && nodeInstallRunsScripts(list)) return 'setup-scripts';
  if (pythonInstallRunsCode(list, program)) return 'setup-scripts';
  if (program === 'git') {
    if (gitChangesRemotesOrConfig(list)) return 'remote-change';
    // NOT here: an open-ended "git push" grant. The offer side never produces one
    // (the git push shape names a branch), and an older one is an explicit choice
    // that spec ruling #2 says outranks the deny-list (permission-engine.test.ts).
  }
  return null;
}

/** In the user's words: why only this exact command is remembered. Shown under the
 *  card's single choice, so a missing wider choice reads as a decision. */
export const EXACT_ONLY_REASON: Record<RiskKind, string> = {
  'sends-data': 'Only this exact command is remembered, because it sends data or files out. Other uploads will ask again.',
  'setup-scripts': 'Only this exact install is remembered, because a package can run its own setup scripts. Installs with setup scripts turned off can be remembered more widely.',
  'remote-change': 'Only this exact command is remembered, because it changes where your code is sent or how git behaves.',
  'network-tool': 'Only this exact command is remembered, because it connects to other computers.',
  'env-prefix': 'Only this exact command is remembered, because it sets a variable before it runs.',
  expansion: 'Only this exact command is remembered, because part of it is filled in when it runs.',
};

// ── what an older, too-wide grant no longer covers ──────────────────────────

// One everyday command per kind. A saved wildcard grant that covered one of these
// before this change and does not now was NARROWED, and Settings says so.
const NARROWING_EXEMPLARS: ReadonlyArray<[RiskKind, string]> = [
  ['sends-data', 'curl -d x https://example.com'],
  ['sends-data', 'wget --post-data x https://example.com'],
  ['network-tool', 'scp a.txt host:/tmp'],
  ['setup-scripts', 'npm install left-pad'],
  ['setup-scripts', 'pip install requests'],
  ['remote-change', 'git remote add origin https://example.com/x.git'],
];

const NARROWED_NOTE: Record<RiskKind, string> = {
  'sends-data': 'Sending data or files now asks each time.',
  'setup-scripts': 'Installs that run package setup scripts now ask each time.',
  'remote-change': 'Changing git remotes or settings now asks each time.',
  'network-tool': 'This now asks each time.',
  'env-prefix': 'Commands that start by setting a variable now ask each time.',
  expansion: 'Commands with filled-in text now ask each time.',
};

/** If a SAVED wildcard Bash grant used to cover something the engine now refuses,
 *  the sentence for Settings; else null. `covers` is the old reach (rules 1–3 of
 *  subject-glob), passed in so this module stays import-free. */
export function narrowedGrantNote(
  pattern: string,
  covers: (pattern: string, subject: string) => boolean,
): string | null {
  const kinds = new Set<RiskKind>();
  for (const [kind, command] of NARROWING_EXEMPLARS) {
    if (covers(pattern, command) && riskyVariant(command, pattern) !== null) kinds.add(kind);
  }
  if (ASSIGNMENT.test(pattern.trimStart())) kinds.add('env-prefix');
  if (kinds.size === 0) return null;
  return [...kinds].map((k) => NARROWED_NOTE[k]).join(' ');
}

/** Programs for which one wide choice is safe when the command is the plain-download
 *  or no-setup-scripts form. Used by bash-grant-shapes to word the choice. */
export type SafeFamily = 'download' | 'node-install' | 'pip-install';

export function safeFamilyOf(command: string): { family: SafeFamily; program: string } | null {
  const list = words(command);
  const program = programName(list[0]);
  if (program === 'curl' || program === 'wget') return { family: 'download', program };
  if (NODE_MANAGERS.has(program) && list.slice(1).some((w) => !w.startsWith('-') && NODE_INSTALLERS.test(w))) {
    return { family: 'node-install', program };
  }
  if (program === 'pip' || program === 'pip3') {
    if (list.slice(1).some((w) => PY_INSTALL_WORDS.test(w))) return { family: 'pip-install', program };
  }
  return null;
}
