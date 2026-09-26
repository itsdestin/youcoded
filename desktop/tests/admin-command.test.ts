import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { adminCommandVerdict, visibleSudoLines } from '../src/main/harness/tools/admin-command';

describe('admin-command floor: sudo asks, whatever shape it hides in', () => {
  it.each([
    'sudo apt update',
    '/usr/bin/sudo apt update',
    'echo x|sudo tee f',
    '(sudo x)',
    "bash -c 'sudo x'",
    '$(sudo cat f)',
    'timeout 5 sudo x',
    'env A=1 sudo x',
  ])('%s', (cmd) => {
    expect(adminCommandVerdict(cmd)).toEqual({ kind: 'admin', word: 'sudo' });
  });

  it('finds sudo through nested substitutions and backticks together', () => {
    expect(adminCommandVerdict('x=`sudo cat f`; echo "$x"')).toEqual({ kind: 'admin', word: 'sudo' });
  });

  it('finds sudo inside a pipeline stage that is not the first', () => {
    expect(adminCommandVerdict('echo a && sudo -u root whoami')).toEqual({ kind: 'admin', word: 'sudo' });
  });

  it('finds sudo inside a subshell that also has a leading command', () => {
    expect(adminCommandVerdict('cd /tmp && (sudo rm -rf /var/log/old)')).toEqual({ kind: 'admin', word: 'sudo' });
  });
});

describe('admin-command floor: doas/su/pkexec/run0 refuse outright', () => {
  it.each([
    ['doas apt update', 'doas'],
    ['su -c "whoami"', 'su'],
    ['pkexec apt update', 'pkexec'],
    ['run0 apt update', 'run0'],
    ['/usr/bin/pkexec apt update', 'pkexec'],
    ['timeout 5 doas x', 'doas'],
  ] as const)('%s', (cmd, word) => {
    expect(adminCommandVerdict(cmd)).toEqual({ kind: 'refuse', word });
  });

  // The known limit of a floor that reads shell syntax, not a sandbox
  // (admin-password design §4): an interpreter's inline call to execvp still
  // reaches polkit. Documented here so the gap is not silently "fixed" by
  // reading it as an accidental pass.
  it('does not look inside an interpreter one-liner (documented limit)', () => {
    expect(adminCommandVerdict('python3 -c "import os; os.execvp(\'pkexec\', [\'pkexec\', \'x\'])"')).toBeNull();
  });
});

// The re-review's everyday sweep (2026-09-23, tests/fixtures/everyday-shell-commands.txt):
// real commands a developer types daily, none of which name sudo/doas/su/pkexec/run0
// as their actual command. Confirms the floor stays quiet on all of them.
describe('everyday commands never trip the admin floor', () => {
  const fixture = fs.readFileSync(fileURLToPath(new URL('./fixtures/everyday-shell-commands.txt', import.meta.url)), 'utf8');
  const commands = fixture.split('\n@@\n').map((c) => c.replace(/\n$/, '')).filter(Boolean);

  it('the fixture is the full sweep', () => {
    expect(commands.length).toBe(76);
  });

  it.each(commands)('%s', (cmd) => {
    expect(adminCommandVerdict(cmd)).toBeNull();
  });

  it.each([
    'sudoku --solve board.txt',
    'run pseudo-random-test',
    'echo sudo',
    'grep sudo file',
    'git commit -m "sudo fix"',
    'echo "run doas later"',
    'cat notes-about-su.txt',
  ])('%s', (cmd) => {
    expect(adminCommandVerdict(cmd)).toBeNull();
  });
});

describe('visibleSudoLines: sudo argv with sudo and its own options stripped', () => {
  it('strips no options', () => {
    expect(visibleSudoLines('sudo apt update')).toEqual([['apt', 'update']]);
  });

  it('strips a short option with a separate value', () => {
    expect(visibleSudoLines('sudo -u root apt update')).toEqual([['apt', 'update']]);
  });

  // The known mis-parse this task fixes (design §4): a long option with a
  // separate value must consume it, or "root" reads as the command sudo runs.
  it('strips a long option with a separate value', () => {
    expect(visibleSudoLines('sudo --user root apt update')).toEqual([['apt', 'update']]);
  });

  it('strips every long option the design names', () => {
    const cmd = 'sudo --user root --group wheel --close-from 5 --host h --prompt "p" --role r --type t --other-user o --chdir /tmp --chroot /jail apt update';
    expect(visibleSudoLines(cmd)).toEqual([['apt', 'update']]);
  });

  it('keeps flags that belong to the wrapped command, not sudo', () => {
    expect(visibleSudoLines('sudo rm -rf /tmp/x')).toEqual([['rm', '-rf', '/tmp/x']]);
  });

  it('finds a sudo line inside a pipeline and a subshell', () => {
    expect(visibleSudoLines('echo x | sudo tee f')).toEqual([['tee', 'f']]);
    expect(visibleSudoLines('(sudo whoami)')).toEqual([['whoami']]);
  });

  it('finds a sudo line inside bash -c and a command substitution', () => {
    expect(visibleSudoLines("bash -c 'sudo apt update'")).toEqual([['apt', 'update']]);
    expect(visibleSudoLines('$(sudo cat f)')).toEqual([['cat', 'f']]);
  });

  it('collects every sudo line in a multi-command line', () => {
    expect(visibleSudoLines('sudo apt update && sudo apt upgrade')).toEqual([['apt', 'update'], ['apt', 'upgrade']]);
  });

  it('is empty when the command runs no sudo', () => {
    expect(visibleSudoLines('rm -rf build')).toEqual([]);
  });

  it('is empty for the refused words — never a sudo line', () => {
    expect(visibleSudoLines('doas apt update')).toEqual([]);
  });
});
