import { describe, it, expect } from 'vitest';
import { destructiveRmReason, destructiveRmVerdict, type RmTargetContext } from '../src/main/harness/tools/rm-target';

const ctx: RmTargetContext = { cwd: '/home/ana/proj', home: '/home/ana', platform: 'linux' };
const flagged = (cmd: string, c: RmTargetContext = ctx) => destructiveRmReason(cmd, c);

describe('removal-target floor: removals that are always asked about', () => {
  it.each([
    ['rm -rf /', 'root of the disk'],
    ['rm -rf ~', 'home folder'],
    ['rm -rf ~/', 'home folder'],
    ['rm -rf $HOME', 'home folder'],
    // eslint-disable-next-line no-template-curly-in-string -- shell syntax under test, not a JS template
    ['rm -rf "${HOME}"', 'home folder'],
    ['rm -rf .', 'whole workspace'],
    ['rm -rf ..', 'home folder'],
    ['rm -rf /home/ana/proj', 'whole workspace'],
    ['rm -rf /etc', 'system folder'],
    ['sudo rm -rf /usr', 'system folder'],
    ['rm -r -f /var/lib', 'system folder'],
    ['rm --recursive /opt', 'system folder'],
    ['/bin/rm -rf /home', 'home folder'],
    ['cd .. && rm -rf proj', 'whole workspace'],
    ['cd / ; rm -rf etc', 'system folder'],
    ['rm -rf ./*', 'everything inside the whole workspace'],
    ['rm -f ~/*', 'everything inside your home folder'],
    ['rm -rf /*', 'everything inside the root'],
    ['echo hi && rm -rf ~', 'home folder'],
    ['FOO=1 rm -rf ~', 'home folder'],
    ['x=$(rm -rf ~)', 'home folder'],
    // Shell keywords and grouping before the command.
    ['if [ -d x ]; then rm -rf ~; fi', 'home folder'],
    ['for d in x; do rm -rf ~; done', 'home folder'],
    ['{ rm -rf ~; }', 'home folder'],
    ['! rm -rf ~', 'home folder'],
    ['while true; do rm -rf ~; done', 'home folder'],
    ['until false; do rm -rf ~; done', 'home folder'],
    ['if false; then :; elif true; then rm -rf ~; fi', 'home folder'],
    ['if false; then :; else rm -rf ~; fi', 'home folder'],
    // Wrappers that run the command they are given.
    ['timeout 5 rm -rf ~', 'home folder'],
    ['timeout -s KILL 5 rm -rf ~', 'home folder'],
    ['nice -n 10 rm -rf ~', 'home folder'],
    ['nohup rm -rf ~', 'home folder'],
    ['env VAR=x rm -rf ~', 'home folder'],
    ['command rm -rf ~', 'home folder'],
    ['builtin rm -rf ~', 'home folder'],
    ['exec rm -rf ~', 'home folder'],
    ['time rm -rf ~', 'home folder'],
    ['sudo -u root rm -rf /etc', 'system folder'],
    ['echo ~ | xargs -I {} rm -rf ~', 'home folder'],
    // Flag clusters of any length.
    ['rm -rfvI ~', 'home folder'],
    ['rm -dfrv ~', 'home folder'],
    // A subshell's cd ends at its `)`.
    ['(cd /tmp) && rm -rf .', 'whole workspace'],
  ])('%s', (cmd, why) => {
    expect(flagged(cmd)).toContain(why);
  });

  // An EMPTY variable followed by more path is the danger (`"$BUILD_DIR"/` → `/`);
  // the reason names the variable and says it only applies if it is empty.
  it('text after an unguarded variable is judged as if the variable were empty, and says so', () => {
    expect(flagged('rm -rf "$BUILD_DIR"/')).toBe('removes the root of the disk if $BUILD_DIR is empty (the command reads $BUILD_DIR/)');
    // eslint-disable-next-line no-template-curly-in-string -- shell syntax under test, not a JS template
    expect(flagged('rm -rf ${OUT}/*')).toMatch(/^removes everything inside the root of the disk if \$\{OUT\} is empty/);
    expect(flagged('rm -rf $X*')).toMatch(/^removes everything inside the whole workspace if \$X is empty/);
    expect(flagged('rm -rf "$PREFIX/usr"')).toMatch(/system folder \/usr if \$PREFIX is empty/);
  });

  it('dot targets after a cd into an unknowable folder are asked about', () => {
    expect(flagged('cd "$DIR" && rm -rf .')).toMatch(/can't be known in advance/);
    expect(flagged('cd - && rm -rf ..')).toMatch(/can't be known in advance/);
  });

  it('runs from the persisted shell folder, not only the workspace root', () => {
    expect(flagged('rm -rf ..', { ...ctx, shellCwd: '/home/ana/proj/src' })).toContain('whole workspace');
  });

  // The target is a command's output, which reading the text cannot resolve.
  it.each(['rm -rf $(pwd)', 'rm -rf `pwd`', 'rm -rf $(pwd)/*', 'rm -rf "$(pwd)"'])('%s asks, naming the command output', (cmd) => {
    expect(flagged(cmd)).toMatch(/^removes a path given by a command's output \(.+\), which can't be checked before it runs$/);
  });

  it('Windows spellings', () => {
    const w: RmTargetContext = { cwd: 'C:\\Users\\ana\\proj', home: 'C:\\Users\\ana', platform: 'win32' };
    expect(flagged('Remove-Item -Recurse -Force C:\\Windows', w)).toContain('system folder');
    expect(flagged('rm -r $env:USERPROFILE', w)).toContain('home folder');
    expect(flagged('rd /s /q C:\\', w)).toContain('root of the disk');
    expect(flagged('Remove-Item -Force build', w)).toBeNull();
  });
});

describe('removal-target floor: ordinary removals are left alone', () => {
  it.each([
    'rm -rf build',
    'rm -rf ./node_modules dist',
    'rm *.log',
    'rm -rf src/*/dist',
    'rm -rf /tmp/scratch',
    'rm -rf ~/.cache/pip',
    'rm -rf "$HOME/.cache/x"',
    'rm -rf build/$NAME',
    'rm -f ~/notes.txt',
    'rm .',               // not recursive: rm refuses a folder, nothing happens
    'cd build && rm -rf out',
    'cd "$DIR" && rm -rf out',
    'git rm -r --cached .',
    'echo "rm -rf /"',
    'npm run clean',
    'find . -name "*.tmp" | xargs rm -f',
    // A bare variable removes nothing when it is empty.
    'rm "$f"',
    'rm -f "$LOCKFILE"',
    'rm -rf "$tmp"',
    'rm -f -- "$@"',
    // `${X:?}` aborts the shell instead of expanding to nothing.
    // eslint-disable-next-line no-template-curly-in-string -- shell syntax under test, not a JS template
    'rm -rf "${BUILD_DIR:?}/"*',
    // eslint-disable-next-line no-template-curly-in-string -- shell syntax under test, not a JS template
    'rm -rf "${X:?}"',
    // Removing files a command lists (not recursive) is left to the rules.
    'rm -f $(find . -name "*.o")',
    'rm -rf "$tmp/build"',
    // A cd inside a subshell does not move the outer command.
    '(cd / && ls) && rm -rf build',
    'rm -Force build',
  ])('%s', (cmd) => {
    expect(flagged(cmd)).toBeNull();
  });
});

// Re-review (2026-09-23): scripts run by a shell, comments, heredocs.
describe('removal-target floor: scripts, comments and heredocs', () => {
  it.each([
    ["bash -c 'rm -rf ~'", 'home folder'],
    ["sh -c -- 'rm -rf ~'", 'home folder'],
    ["sudo bash -c 'rm -rf /etc'", 'system folder'],
    ['eval "rm -rf ~"', 'home folder'],
    ["bash <<'EOF'\nrm -rf ~\nEOF", 'home folder'],
    ["ssh host <<'EOF'\nrm -rf ~\nEOF", 'home folder'],
    ['/usr/bin/sudo rm -rf /etc', 'system folder'],
    ['rm --rec ~', 'home folder'],
    // eslint-disable-next-line no-template-curly-in-string -- shell syntax under test, not a JS template
    ['rm -rf "${HOME:?}"/', 'home folder'],
    // eslint-disable-next-line no-template-curly-in-string -- shell syntax under test, not a JS template
    ['rm -rf ${HOME:?}/*', 'everything inside your home folder'],
    ['rm -rf "$PWD"', 'whole workspace'],
    ['rm -rf ~/*/', 'everything inside your home folder'],
  ])('%s asks', (cmd, why) => {
    expect(flagged(cmd)).toContain(why);
  });

  it.each([
    'rm -rf build # clean everything in ~',
    'rm -rf .next  # wipes /',
    "cat > notes.md <<'EOF'\nrm -rf ~\nEOF",
    "git commit -m \"$(cat <<'EOF'\nrm -rf / is now asked about\nEOF\n)\"",
    'tmp=$(mktemp -d) && cd "$tmp" && rm -rf *',
    "bash -c 'npm test'",
  ])('%s stays quiet', (cmd) => {
    expect(flagged(cmd)).toBeNull();
  });

  // The card's line is picked from the kind, so it never claims more than the check knows.
  it('reports how sure it is', () => {
    expect(destructiveRmVerdict('rm -rf ~', ctx)?.kind).toBe('removal');
    expect(destructiveRmVerdict('rm -rf "$BUILD_DIR"/', ctx)?.kind).toBe('removal-if-empty');
    expect(destructiveRmVerdict('rm -rf $(pwd)', ctx)?.kind).toBe('removal-unknown');
    expect(destructiveRmVerdict('cd - && rm -rf ..', ctx)?.kind).toBe('removal-unknown');
  });
});
