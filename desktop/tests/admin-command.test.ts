import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { adminCommandVerdict, visibleSudoLines, displayCommandFromSudoArgv } from '../src/main/harness/tools/admin-command';

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

  // Review T1-2: find's own -exec/-execdir/-ok/-okdir runs an arbitrary
  // command from ordinary shell syntax, the same shape bash-secret-paths.ts
  // already recurses into for its own threat model.
  it.each(['-exec', '-execdir', '-ok', '-okdir'])('finds sudo inside find %s … \\;', (action) => {
    expect(adminCommandVerdict(`find . -name x ${action} sudo rm {} \\;`)).toEqual({ kind: 'admin', word: 'sudo' });
  });

  it('finds sudo inside find -exec terminated by +', () => {
    expect(adminCommandVerdict('find . -exec sudo chown root {} +')).toEqual({ kind: 'admin', word: 'sudo' });
  });

  it('finds a refused word inside find -exec too', () => {
    expect(adminCommandVerdict('find . -exec pkexec rm {} \\;')).toEqual({ kind: 'refuse', word: 'pkexec' });
  });

  it('leaves a find with no -exec/-execdir/-ok/-okdir alone', () => {
    expect(adminCommandVerdict('find . -name "sudo*"')).toBeNull();
  });
});

// Review T1-1: a heredoc BODY is text fed to a command, not a command — the
// missing splitHeredocs() call read a body's first line as a second top-level
// shell command, so a harmless script mentioning one of the five words on its
// own line got asked (or, worse, silently refused with no card at all).
describe('admin-command floor: heredoc bodies are text, not commands', () => {
  it('a heredoc body mentioning sudo is NOT flagged when the feeder only writes it', () => {
    expect(adminCommandVerdict('cat <<EOF\nsudo x\nEOF')).toBeNull();
  });

  it('a heredoc body mentioning pkexec is NOT flagged (would otherwise refuse a harmless write)', () => {
    expect(adminCommandVerdict("cat > install.sh <<'EOF'\npkexec do-something --now\nEOF")).toBeNull();
  });

  it('`sudo bash <<EOF` IS flagged — sudo is the command that runs, right there on the first line', () => {
    expect(adminCommandVerdict('sudo bash <<EOF\nls\nEOF')).toEqual({ kind: 'admin', word: 'sudo' });
  });

  it('a heredoc fed to a shell DOES run its body as commands', () => {
    expect(adminCommandVerdict('bash <<EOF\nsudo apt update\nEOF')).toEqual({ kind: 'admin', word: 'sudo' });
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

  // Review T1-3: -R/--chroot's short pair and -T/--command-timeout (both
  // forms) were missing from the first pass at this fix, so each misparsed
  // its value as the command sudo runs.
  it('strips -R (the short form of --chroot)', () => {
    expect(visibleSudoLines('sudo -R /jail apt update')).toEqual([['apt', 'update']]);
  });

  it('strips -T (the short form of --command-timeout)', () => {
    expect(visibleSudoLines('sudo -T 30 apt update')).toEqual([['apt', 'update']]);
  });

  it('strips --command-timeout', () => {
    expect(visibleSudoLines('sudo --command-timeout 30 apt update')).toEqual([['apt', 'update']]);
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

  // Same two fixes as adminCommandVerdict, kept symmetric (review T1-1/T1-2).
  it('finds a sudo line inside find -exec', () => {
    expect(visibleSudoLines('find . -exec sudo rm {} \\;')).toEqual([['rm', '{}']]);
  });

  it('a heredoc body mentioning sudo yields no line when the feeder only writes it', () => {
    expect(visibleSudoLines('cat <<EOF\nsudo apt update\nEOF')).toEqual([]);
  });

  it('a heredoc fed to a shell yields its sudo line', () => {
    expect(visibleSudoLines('bash <<EOF\nsudo apt update\nEOF')).toEqual([['apt', 'update']]);
  });
});

// admin-password-service.ts (design §2.4/§3 item 5): the up-front/mid-command
// card's command text, built from a REAL sudo process's own argv (already
// read from /proc/<sudo>/cmdline) rather than parsed shell text — the same
// option-stripping rule as visibleSudoLines above, applied to a plain argv
// array instead.
describe('displayCommandFromSudoArgv', () => {
  it('strips sudo itself (by basename) and joins the rest with spaces', () => {
    expect(displayCommandFromSudoArgv(['sudo', 'apt', 'update'])).toBe('apt update');
  });

  it('strips sudo read by its real path, not just the bare word', () => {
    expect(displayCommandFromSudoArgv(['/usr/bin/sudo', 'apt', 'update'])).toBe('apt update');
  });

  it('strips a bare flag and a value-taking flag before the real command', () => {
    expect(displayCommandFromSudoArgv(['sudo', '-n', '--user', 'root', 'apt', 'update'])).toBe('apt update');
  });

  it('stops stripping at -- (everything after belongs to the wrapped command)', () => {
    expect(displayCommandFromSudoArgv(['sudo', '--', '-x', 'rm'])).toBe('-x rm');
  });

  it('keeps flags that belong to the wrapped command, not sudo', () => {
    expect(displayCommandFromSudoArgv(['sudo', 'rm', '-rf', '/tmp/x'])).toBe('rm -rf /tmp/x');
  });

  it('single-quotes an argument containing whitespace, for display only', () => {
    expect(displayCommandFromSudoArgv(['sudo', 'sh', '-c', 'echo hello world'])).toBe("sh -c 'echo hello world'");
  });

  it('is empty when sudo was given no command at all', () => {
    expect(displayCommandFromSudoArgv(['sudo'])).toBe('');
  });
});
