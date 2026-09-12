import { describe, it, expect } from 'vitest';
import { bashGrantOptions, describeBashPattern, HOSTILE_CORPUS } from '../src/shared/bash-grant-shapes';
import { grantAdmitsHostile, ruleMatches } from '../src/shared/subject-glob';
import { DESTRUCTIVE_DENY_LIST } from '../src/shared/permission-types';

const wideOf = (cmd: string) => bashGrantOptions(cmd).find((o) => o.scope === 'wide');
const exactOf = (cmd: string) => bashGrantOptions(cmd).find((o) => o.scope === 'exact');

describe('bashGrantOptions — exact rung', () => {
  it('stores the literal command with match:exact', () => {
    expect(exactOf('rm *.log')!.rule).toEqual({
      tool: 'Bash', pattern: 'rm *.log', action: 'allow', match: 'exact',
    });
  });

  it('does NOT trim — the stored pattern is the subject the engine will compare', () => {
    // permissionSubject hands over args.command verbatim (tools/bash.ts). A
    // trimmed pattern would be one character off and never fire again.
    expect(exactOf('ls -la\n')!.rule.pattern).toBe('ls -la\n');
  });

  it('an empty or whitespace command offers nothing', () => {
    expect(bashGrantOptions('')).toEqual([]);
    expect(bashGrantOptions('   ')).toEqual([]);
  });
});

describe('bashGrantOptions — wide rung derivation', () => {
  it('program + subcommand when the second token is a word', () => {
    expect(wideOf('cargo test --release')!.rule.pattern).toBe('cargo test*');
    expect(wideOf('npm run build')!.rule.pattern).toBe('npm run*');
  });

  it('program only when the second token is a flag or a path', () => {
    expect(wideOf('ls -la /tmp')!.rule.pattern).toBe('ls*');
    expect(wideOf('cat ./notes.txt')!.rule.pattern).toBe('cat*');
  });

  it('an env-style assignment is an argument, not a subcommand', () => {
    // `env FOO=1*` would cover `env FOO=1 <any program>`; the program-wide `env*`
    // rung is refused by HOSTILE_CORPUS instead, leaving the exact rung.
    expect(wideOf('env FOO=1 ls')).toBeUndefined();
    expect(exactOf('env FOO=1 ls')).toBeDefined();
  });

  it('a quoted second token is an argument, not a subcommand', () => {
    expect(wideOf('echo "hi there"')!.rule.pattern).toBe('echo*');
  });

  it('the label never contains rule syntax', () => {
    expect(wideOf('cargo test --release')!.label).not.toMatch(/[*?]/);
  });
});

describe('bashGrantOptions — postcondition 1: an option covers its own command', () => {
  const corpus = [
    'npm run build', 'npm run build > log.txt', 'npm run build && git push',
    'ls -la /tmp', 'rm -rf build', 'sudo apt install x', 'cargo test --release',
    'git status', 'echo "hi there"', "grep -r 'x' .", 'node scripts/x.mjs',
    '  npm run build', 'git push origin feat/x',
  ];
  it('never offers an option that does not cover the command it was derived from', () => {
    for (const cmd of corpus) {
      for (const opt of bashGrantOptions(cmd)) {
        expect(ruleMatches(opt.rule, cmd), `${opt.scope} rung for ${JSON.stringify(cmd)}`).toBe(true);
      }
    }
  });

  it('a chained or redirected command gets no wide rung — safety rule 1 vetoes it', () => {
    expect(wideOf('npm run build && git push')).toBeUndefined();
    expect(exactOf('npm run build && git push')).toBeDefined();
    expect(wideOf('npm run build > log.txt')).toBeUndefined();
    expect(exactOf('npm run build > log.txt')).toBeDefined();
  });

  it('leading whitespace costs the wide rung, never the exact one', () => {
    expect(wideOf('  npm run build')).toBeUndefined();
    expect(exactOf('  npm run build')!.rule.pattern).toBe('  npm run build');
  });
});

describe('bashGrantOptions — postcondition 2: an option admits nothing hostile', () => {
  it('refuses a program-wide git rung — it would cover pushes and hard resets', () => {
    // The second token is a flag, so the derived key is the program alone. Without
    // this postcondition the user is offered "Any git command", which outranks the
    // destructive deny-list once stored.
    expect(wideOf('git --no-pager log')).toBeUndefined();
    expect(wideOf('git -C some/repo status')).toBeUndefined();
    expect(exactOf('git --no-pager log')).toBeDefined();
  });

  it('leaves innocent program-wide rungs alone', () => {
    expect(wideOf('ls -la /tmp')!.rule.pattern).toBe('ls*');
    expect(wideOf('git status')!.rule.pattern).toBe('git status*');
  });

  it.each([
    'python -c "print(1)"', 'python3 -c "print(1)"', 'node -e "console.log(1)"',
    'bash -c "ls"', 'sh -c "ls"', 'pwsh -Command Get-Date', "perl -e 'print 1'",
    'find . -name "*.log"', 'xargs -n1 echo', 'npx -y cowsay hi', "awk '{print $1}' f.txt",
    'bun -e "1"', 'deno eval "1"',
    // Found by the fix's own review (2026-09-10): options that run a command.
    'sed -n 1,5p notes.txt', 'tar -xf a.tar', 'rg -n foo src', 'git grep -n foo', 'sort -u f.txt',
    'python -m timeit "1+1"', 'eval ls', 'nohup npm start', 'nice -n 5 make', 'watch -n1 ls',
    'timeout 10 npm test', 'command -v node', 'npm exec vite', 'npm x vite', 'pnpm dlx create-x',
    'bun x cowsay', 'uv run pytest', 'docker run alpine ls', 'sqlite3 x.db .tables',
    'tsx watch src/index.ts', 'powershell ./build.ps1',
  ])('a program that runs code from its arguments gets no wide rung: %s', (cmd) => {
    // "Any python command" would cover `python -c <anything>` (2026-09-10 review).
    expect(wideOf(cmd)).toBeUndefined();
    expect(exactOf(cmd)).toBeDefined();
  });

  it('no wide rung anywhere admits a hostile command', () => {
    const commands = [
      'git --no-pager log', 'git -C x status', 'git status', 'npm run build',
      'ls -la', 'node x.mjs', 'cargo test', 'docker ps', 'echo hi',
      'python build.py', 'python -m pytest -q', 'bash deploy.sh', 'bun run dev',
      'deno run main.ts', 'bun test', 'npx prettier --write .', 'env FOO=1 ls',
    ];
    for (const cmd of commands) {
      const wide = wideOf(cmd);
      if (!wide) continue;
      // grantAdmitsHostile, not ruleMatches: ruleMatches VOIDS a hostile grant, so it
      // would answer "covers nothing" for exactly the rung this test exists to catch.
      expect(grantAdmitsHostile(wide.rule.pattern!), `${wide.rule.pattern} admits a hostile command`).toBe(false);
    }
  });

  it('every destructive deny-list family has a corpus entry (adding a family fails here)', () => {
    // Only the base patterns: the '* …' compound variants exist to catch chained
    // commands, which safety rule 1 already keeps out of every grant.
    const families = DESTRUCTIVE_DENY_LIST.filter((r) => !r.pattern!.startsWith('* '));
    for (const family of families) {
      expect(
        HOSTILE_CORPUS.some((c) => ruleMatches(family, c)),
        `no HOSTILE_CORPUS entry matches ${family.pattern}`,
      ).toBe(true);
    }
  });
});

describe('bashGrantOptions — git push scopes to one branch', () => {
  it('derives a remote-anchored pattern and a branch-named label', () => {
    const opt = wideOf('git push origin feat/x')!;
    expect(opt.rule.pattern).toBe('git push*origin feat/x');
    expect(opt.label).toBe('Always allow pushing to feat/x');
  });

  it('covers the harmless flag forms of the same push', () => {
    const rule = wideOf('git push origin feat/x')!.rule;
    expect(ruleMatches(rule, 'git push origin feat/x')).toBe(true);
    expect(ruleMatches(rule, 'git push -u origin feat/x')).toBe(true);
    expect(ruleMatches(rule, 'git push --set-upstream origin feat/x')).toBe(true);
  });

  it('does NOT cover the flags that would unbind it (safety rule 2)', () => {
    const rule = wideOf('git push origin feat/x')!.rule;
    expect(ruleMatches(rule, 'git push --delete origin feat/x')).toBe(false);
    expect(ruleMatches(rule, 'git push --prune origin feat/x')).toBe(false);
    expect(ruleMatches(rule, 'git push --force origin feat/x')).toBe(false);
    expect(ruleMatches(rule, 'git push --all origin feat/x')).toBe(false);
    // Skips the repo's own pre-push checks — a behaviour change wearing the
    // clothes of "the same command with one more option".
    expect(ruleMatches(rule, 'git push --no-verify origin feat/x')).toBe(false);
  });

  it('is the ONLY option offered — the exact rung would say the same thing', () => {
    // The exact rung for a push differs from the branch rung only by options
    // whose effect the user cannot see (-u, -q). Every difference that would
    // matter is already excluded from both, so offering two would be asking the
    // user to choose between two identical sentences — and would let one push be
    // approved twice as two Settings rows that read the same.
    expect(bashGrantOptions('git push origin feat/x').map((o) => o.scope)).toEqual(['wide']);
    expect(exactOf('git push origin feat/x')).toBeUndefined();
    // The GENERIC rung is not collapsed: this one is a real choice.
    expect(bashGrantOptions('npm run build').map((o) => o.scope)).toEqual(['exact', 'wide']);
  });

  it('does NOT leak to another branch, a longer branch name, or a multi-ref push', () => {
    const rule = wideOf('git push origin feat/x')!.rule;
    expect(ruleMatches(rule, 'git push origin feat/x-2')).toBe(false);
    expect(ruleMatches(rule, 'git push origin master')).toBe(false);
    // The whole reason the remote is in the pattern: this pushes master TOO.
    expect(ruleMatches(rule, 'git push origin master feat/x')).toBe(false);
    expect(ruleMatches(rule, 'git push origin feat/x master')).toBe(false);
  });

  it('master is an ordinary branch — it scopes like any other', () => {
    const opt = wideOf('git push origin master')!;
    expect(opt.rule.pattern).toBe('git push*origin master');
    expect(opt.label).toBe('Always allow pushing to master');
  });

  it('reads the destination out of a HEAD: refspec for the LABEL only', () => {
    expect(wideOf('git push origin HEAD:feat/x')!.label).toBe('Always allow pushing to feat/x');
    expect(wideOf('git push origin HEAD:feat/x')!.rule.pattern).toBe('git push*origin HEAD:feat/x');
  });

  it('a push with no target of its own offers NOTHING — not even exact', () => {
    // These send whatever branch is checked out AT RUN TIME. The branch changes
    // underneath the grant, so no grant — however narrow — can honestly name it.
    expect(bashGrantOptions('git push')).toEqual([]);
    expect(bashGrantOptions('git push --force')).toEqual([]);
    expect(bashGrantOptions('git push origin')).toEqual([]);
    expect(bashGrantOptions('git push origin HEAD')).toEqual([]);
    expect(bashGrantOptions('git push origin @')).toEqual([]);
  });

  it('a push it cannot scope still gets its exact rung', () => {
    // "Cannot widen" is not "cannot remember". Each of these names its target in
    // the command text, so byte-exact is honest and safe.
    for (const cmd of [
      'git push origin master feat/x',   // two refs — cannot bound to one branch
      'git push origin +feat/x',         // force form — a "pushing to" label would lie
      'git push origin :feat/x',         // delete form — ditto
      "git push 'o*' 'b*'",              // metacharacters would become wildcards
    ]) {
      expect(wideOf(cmd), `wide for ${cmd}`).toBeUndefined();
      expect(exactOf(cmd)!.rule, `exact for ${cmd}`).toEqual({
        tool: 'Bash', pattern: cmd, action: 'allow', match: 'exact',
      });
    }
  });
});

describe('describeBashPattern — the reverse direction', () => {
  it('reads a scoped push pattern back as the sentence the confirm showed', () => {
    expect(describeBashPattern('git push*origin feat/x')).toBe('Pushing to feat/x');
    expect(describeBashPattern('git push*origin master')).toBe('Pushing to master');
    expect(describeBashPattern('git push*origin HEAD:feat/x')).toBe('Pushing to feat/x');
  });

  it('reads a generic wide pattern back', () => {
    expect(describeBashPattern('npm run*')).toBe('Any npm run command');
    expect(describeBashPattern('curl*')).toBe('Any curl command');
  });

  it('returns null for anything it cannot phrase', () => {
    expect(describeBashPattern('rm -rf build')).toBeNull();
  });

  it('never emits rule syntax', () => {
    for (const p of ['git push*origin feat/x', 'npm run*', 'curl*']) {
      expect(describeBashPattern(p)).not.toMatch(/[*?]/);
    }
  });

  it('round-trips every wide rung this module can produce', () => {
    // The two directions MUST agree. Living in one file is not a guarantee —
    // this is. A new command shape whose pattern this cannot phrase fails here
    // rather than showing a raw glob in Settings.
    const commands = [
      'git push origin feat/x', 'git push origin master', 'git push origin HEAD:feat/x',
      'npm run build', 'cargo test --release', 'ls -la /tmp', 'node scripts/x.mjs',
      'python build.py --fast', 'python -m pytest -q', 'bun run dev', 'deno run main.ts', 'bun test',
    ];
    for (const cmd of commands) {
      const wide = bashGrantOptions(cmd).find((o) => o.scope === 'wide');
      if (!wide) continue;
      expect(describeBashPattern(wide.rule.pattern!), `no phrase for ${wide.rule.pattern}`).not.toBeNull();
    }
  });
});

describe('bashGrantOptions — a script run is bounded to its file', () => {
  it('offers "running <file>" instead of "Any node command"', () => {
    const opt = wideOf('node scripts/x.mjs')!;
    expect(opt.rule.pattern).toBe('node scripts/x.mjs*');
    expect(opt.label).toBe('Always allow running scripts/x.mjs');
    expect(describeBashPattern(opt.rule.pattern!)).toBe('Running scripts/x.mjs');
  });

  it('covers the same file with arguments, and nothing else', () => {
    const rule = wideOf('python build.py')!.rule;
    expect(ruleMatches(rule, 'python build.py --fast')).toBe(true);
    expect(ruleMatches(rule, 'python other.py')).toBe(false);
    expect(ruleMatches(rule, 'python -c "print(1)"')).toBe(false);
    expect(ruleMatches(rule, 'python build.py & python -c "x"')).toBe(false);
  });

  it('bun and deno: only `run <file>` or a path is a script — a verb stays generic', () => {
    expect(wideOf('bun run dev')!.rule.pattern).toBe('bun run dev*');
    expect(wideOf('deno run main.ts')!.rule.pattern).toBe('deno run main.ts*');
    expect(wideOf('bun ./x.ts')!.rule.pattern).toBe('bun ./x.ts*');
    expect(wideOf('bun test')!.rule.pattern).toBe('bun test*');
    expect(describeBashPattern('bun test*')).toBe('Any bun test command');
  });

  it('python -m names its module, so it is bounded like a subcommand', () => {
    const opt = wideOf('python -m pytest -q')!;
    expect(opt.rule.pattern).toBe('python -m pytest*');
    expect(opt.label).toBe('Any python -m pytest command');
    expect(ruleMatches(opt.rule, 'python -c "x"')).toBe(false);
  });

  it('a quoted script name or one with wildcard characters stays exact', () => {
    expect(wideOf('python "my script.py"')).toBeUndefined();
    expect(wideOf("node 'x*.js'")).toBeUndefined();
  });

  it('a package runner stays bound to the package it named', () => {
    const rule = wideOf('npx prettier --write .')!.rule;
    expect(rule.pattern).toBe('npx prettier*');
    expect(ruleMatches(rule, 'npx prettier --check .')).toBe(true);
    expect(ruleMatches(rule, 'npx prettier-evil')).toBe(false);
  });

  it('only option-taking python modules are widened', () => {
    expect(wideOf('python -m mypy src')!.rule.pattern).toBe('python -m mypy*');
    expect(wideOf('python -m pdb x.py')).toBeUndefined();
  });

  it('a grant stored before this change still reads as before', () => {
    expect(describeBashPattern('node*')).toBe('Any node command');
  });
});

describe('bashGrantOptions — deny-listed families', () => {
  it.each(['rm -rf build', 'rmdir old', 'sudo apt install x', 'format d:', 'git reset --hard HEAD~1'])(
    'offers exact only for %s', (cmd) => {
      expect(wideOf(cmd)).toBeUndefined();
      expect(exactOf(cmd)).toBeDefined();
    },
  );
});
