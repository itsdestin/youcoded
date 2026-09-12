// Commands no WILDCARD "Always allow" grant may cover.
//
// WHY this is its own module (2026-09-10 security review): it is read in TWO
// places. bash-grant-shapes.ts refuses to OFFER a wide rung that covers any of
// these, and subject-glob.ts's ruleMatches VOIDS a stored wildcard grant that
// covers any of these — so a grant saved before an entry was added (an old
// "Any node command") stops matching instead of keeping its reach. subject-glob
// cannot import bash-grant-shapes (that module imports it), so the list lives here.
//
// Every entry is written with NO shell operator: one with an operator is already
// refused by safety rule 1, so it would never exercise either check.
//
// This list is not the whole defence — bash-grant-shapes.ts also offers no wide
// rung at all for the programs in NO_WIDE_RUNG. The list is what catches a STORED
// grant for those programs.
//
// TWO groups, because they differ at decision time:
//  * DESTRUCTIVE_FAMILY_CORPUS — commands that destroy (force-push, rm -rf). A wide
//    rung covering one is never OFFERED, but a grant the user already saved keeps
//    working: an explicit remembered decision outranks the deny-list (spec ruling
//    #2, pinned in permission-engine.test.ts). Whoever picked "Any git push
//    command" was told what it covers.
//  * CODE_RUNNING_CORPUS — commands whose arguments run ANY code or program. A saved
//    grant covering one is VOID: nobody choosing "Any node command" agreed to "run
//    anything", because the label never said so.
export const DESTRUCTIVE_FAMILY_CORPUS: readonly string[] = [
  // One per destructive deny-list family — pinned by bash-grant-shapes.test.ts.
  'git push --delete origin master',
  'git push --prune origin master',
  'git reset --hard HEAD~1',
  'rm -rf /',
  'sudo rm -rf /',
  'rmdir /s /q C:\\Windows',
  'del /f /q C:\\boot.ini',
  'sudo apt-get install anything',
  'format c:',
];

export const CODE_RUNNING_CORPUS: readonly string[] = [
  // Interpreters: the ARGUMENT is code. "Any python command" covers `python -c …`.
  `python -c "__import__('shutil').rmtree('/')"`,
  `python3 -c "__import__('shutil').rmtree('/')"`,
  `python -m timeit "__import__('shutil').rmtree('/')"`,
  `node -e "require('fs').rmSync('/', {recursive: true})"`,
  `tsx -e "require('fs').rmSync('/', {recursive: true})"`,
  `ts-node -e "require('fs').rmSync('/', {recursive: true})"`,
  `bun -e "require('fs').rmSync('/', {recursive: true})"`,
  `deno eval "Deno.removeSync('/', {recursive: true})"`,
  "bash -c 'rm -rf /'",
  "sh -c 'rm -rf /'",
  "zsh -c 'rm -rf /'",
  "pwsh -Command 'Remove-Item -Recurse -Force /'",
  "powershell -Command 'Remove-Item -Recurse -Force C:/'",
  'cmd /c rd /s /q C:\\',
  "perl -e 'system qq{rm -rf /}'",
  "ruby -e 'system %q{rm -rf /}'",
  `awk 'BEGIN { system("rm -rf /") }'`,

  // Launchers: the first argument is itself a program.
  'find / -delete',
  'find / -exec rm -rf {} +',
  'xargs rm -rf /',
  'env rm -rf /',
  'eval rm -rf /',
  'exec rm -rf /',
  'command rm -rf /',
  'nohup rm -rf /',
  'nice rm -rf /',
  'time rm -rf /',
  'watch rm -rf /',
  'timeout 5 rm -rf /',
  'doas rm -rf /',
  "su -c 'rm -rf /'",
  'ssh localhost rm -rf /',
  'docker run -v /:/h alpine rm -rf /h',
  'npx rimraf /',
  'npm exec rimraf /',
  'npm x rimraf /',
  'pnpm dlx rimraf /',
  'pnpm exec rimraf /',
  'yarn dlx rimraf /',
  'bunx rimraf /',
  'bun x rimraf /',
  'uvx rimraf',
  `uv run python -c "__import__('shutil').rmtree('/')"`,
  'pipx run rimraf',

  // Everyday tools with an option that runs a command.
  "sed -n '1e rm -rf /' notes.txt",
  "tar -xf a.tar --to-command='rm -rf /'",
  'sort --compress-program=sh notes.txt',
  'rg --pre bash x .',
  "git grep -O'rm -rf /' x",
  "sqlite3 x.db '.shell rm -rf /'",
];

export const HOSTILE_CORPUS: readonly string[] = [...DESTRUCTIVE_FAMILY_CORPUS, ...CODE_RUNNING_CORPUS];
