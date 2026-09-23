import { describe, it, expect } from 'vitest';
import { destructiveRmReason, type RmTargetContext } from '../src/main/harness/tools/rm-target';

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
  ])('%s', (cmd, why) => {
    expect(flagged(cmd)).toContain(why);
  });

  it('a target that starts with a variable is asked about, because empty means the disk root', () => {
    expect(flagged('rm -rf "$BUILD_DIR"/')).toMatch(/starts with a variable/);
    // eslint-disable-next-line no-template-curly-in-string -- shell syntax under test, not a JS template
    expect(flagged('rm -rf ${OUT}/*')).toMatch(/starts with a variable/);
  });

  it('dot targets after a cd into an unknowable folder are asked about', () => {
    expect(flagged('cd "$DIR" && rm -rf .')).toMatch(/cannot be known/);
  });

  it('runs from the persisted shell folder, not only the workspace root', () => {
    expect(flagged('rm -rf ..', { ...ctx, shellCwd: '/home/ana/proj/src' })).toContain('whole workspace');
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
  ])('%s', (cmd) => {
    expect(flagged(cmd)).toBeNull();
  });
});
