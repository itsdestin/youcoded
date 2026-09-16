import { describe, it, expect } from 'vitest';
import { subjectMatches, ruleMatches } from '../src/shared/subject-glob';
import type { PermissionRule } from '../src/shared/permission-types';

describe('subjectMatches', () => {
  it('matches * within a segmentless subject (command strings)', () => {
    expect(subjectMatches('git push origin master', 'git push*')).toBe(true);
    expect(subjectMatches('git pull', 'git push*')).toBe(false);
    expect(subjectMatches('npm rm cache', '* rm *')).toBe(true);
  });
  it('matches ? and literal dots', () => {
    expect(subjectMatches('a.txt', '?.txt')).toBe(true);
    expect(subjectMatches('ab.txt', '?.txt')).toBe(false);
    expect(subjectMatches('aXtxt', 'a.txt')).toBe(false);
  });
  it('is case-insensitive on the subject (Windows paths, casual commands)', () => {
    expect(subjectMatches('Git Push origin', 'git push*')).toBe(true);
  });
  it('undefined pattern matches everything', () => {
    expect(subjectMatches('anything', undefined)).toBe(true);
  });
  it('star matches the empty string (bare "git push")', () => {
    expect(subjectMatches('git push', 'git push*')).toBe(true);
  });
});

describe('ruleMatches — exact', () => {
  const bash = (over: Partial<PermissionRule>): PermissionRule =>
    ({ tool: 'Bash', action: 'allow', ...over });

  it('match:exact is byte-equal — a command containing * is NOT a wildcard', () => {
    const r = bash({ pattern: 'rm *.log', match: 'exact' });
    expect(ruleMatches(r, 'rm *.log')).toBe(true);
    expect(ruleMatches(r, 'rm secrets.log')).toBe(false);
    expect(ruleMatches(r, 'rm -rf / #.log')).toBe(false);
  });

  it('match:exact is case-SENSITIVE, unlike the glob path', () => {
    expect(ruleMatches(bash({ pattern: 'rm -rf x', match: 'exact' }), 'RM -rf x')).toBe(false);
    expect(subjectMatches('RM -rf x', 'rm -rf x')).toBe(true); // the glob path stays 'i'
  });

  it('match:exact does not trim — whitespace is part of the command', () => {
    expect(ruleMatches(bash({ pattern: 'ls', match: 'exact' }), 'ls\n')).toBe(false);
  });

  it('a legacy rule with no match field still globs (nothing on disk changes meaning)', () => {
    expect(ruleMatches(bash({ pattern: 'git push*' }), 'git push origin x')).toBe(true);
  });

  it('a rule with no pattern matches every subject (tool-wide grants)', () => {
    expect(ruleMatches({ tool: 'Read', action: 'allow' }, 'anything')).toBe(true);
  });

  it('match:exact with no pattern never matches — it is not a tool-wide grant', () => {
    expect(ruleMatches({ tool: 'Bash', action: 'allow', match: 'exact' }, 'x')).toBe(false);
  });
});

describe('ruleMatches — safety rule 1: a wildcard never swallows a second command', () => {
  const grant = (pattern: string): PermissionRule =>
    ({ tool: 'Bash', pattern, action: 'allow', match: 'glob' });

  it.each([
    'npm run build && rm -rf /',
    'npm run build || rm -rf /',
    'npm run build; sudo x',
    'npm run build | sh',
    'npm run build > /etc/passwd',
    'npm run build < /etc/passwd',
    'npm run build `id`',
    'npm run build $(id)',
    // A single '&' starts the next command immediately (2026-09-10 security review).
    'npm run build & rm -rf /',
    'npm run build &rm -rf /',
    'npm run build & sudo x &',
    'npm run build\nrm -rf /',
  ])('refuses %j', (evil) => {
    expect(ruleMatches(grant('npm run*'), evil)).toBe(false);
  });

  it('still covers the plain forms', () => {
    expect(ruleMatches(grant('npm run*'), 'npm run build')).toBe(true);
    expect(ruleMatches(grant('npm run*'), 'npm run build --prod')).toBe(true);
  });

  it('a lone trailing & only backgrounds the command — still covered', () => {
    expect(ruleMatches(grant('npm run*'), 'npm run dev &')).toBe(true);
    expect(ruleMatches(grant('npm run*'), 'npm run dev & ')).toBe(true);
  });

  it('a trailing && or a second & is still a second command', () => {
    expect(ruleMatches(grant('npm run*'), 'npm run dev &&')).toBe(false);
    expect(ruleMatches(grant('npm run*'), 'npm run dev & &')).toBe(false);
    // The exact shape the review reproduced against a remembered "git status" grant.
    expect(ruleMatches(grant('git status*'), 'git status & rm -rf ~')).toBe(false);
  });

  it('does NOT apply to ask/deny rules — the deny-list must keep crossing operators', () => {
    const denyEntry: PermissionRule = { tool: 'Bash', pattern: '* rm *', action: 'ask' };
    expect(ruleMatches(denyEntry, 'cd repo && rm -rf x')).toBe(true);
  });

  it('does NOT apply to a pattern-less grant — a tool-wide grant is a separate choice', () => {
    expect(ruleMatches({ tool: '*', action: 'allow' }, 'a && b')).toBe(true);
    expect(ruleMatches({ tool: 'Bash', action: 'allow' }, 'a && b')).toBe(true);
  });
});

describe('ruleMatches — safety rule 2: a middle wildcard never swallows a destructive flag', () => {
  const bounded: PermissionRule =
    { tool: 'Bash', pattern: 'git push*origin feat/x', action: 'allow', match: 'glob' };

  it('covers the harmless flag forms of the same push', () => {
    expect(ruleMatches(bounded, 'git push origin feat/x')).toBe(true);
    expect(ruleMatches(bounded, 'git push -u origin feat/x')).toBe(true);
    expect(ruleMatches(bounded, 'git push --set-upstream origin feat/x')).toBe(true);
    expect(ruleMatches(bounded, 'git push -q origin feat/x')).toBe(true);
  });

  it.each([
    'git push --delete origin feat/x',        // deletes the branch the grant is named after
    'git push -d origin feat/x',
    'git push --prune origin feat/x',         // deletes every OTHER branch on the remote
    'git push --mirror origin feat/x',
    'git push --all origin feat/x',           // pushes branches the grant never mentioned
    'git push --force origin feat/x',
    'git push -f origin feat/x',
    'git push --force-with-lease=origin/x origin feat/x',
  ])('refuses %s', (evil) => {
    expect(ruleMatches(bounded, evil)).toBe(false);
  });

  it('an OPEN-ENDED rung is exempt — "any npm run command" says what it means', () => {
    const open: PermissionRule = { tool: 'Bash', pattern: 'npm run*', action: 'allow', match: 'glob' };
    expect(ruleMatches(open, 'npm run build --force')).toBe(true);
  });
});

describe("ruleMatches — holes found by the fix's own review (2026-09-10)", () => {
  const grant = (pattern: string): PermissionRule =>
    ({ tool: 'Bash', pattern, action: 'allow', match: 'glob' });

  it('an operator stored inside the pattern no longer lets it cover a chain', () => {
    // `cd src;ls` used to store the grant `cd src;ls*`, and an operator the pattern
    // itself carried was exempt from rule 1.
    expect(ruleMatches(grant('cd src;ls*'), 'cd src;ls; rm -rf ~')).toBe(false);
    expect(ruleMatches(grant('echo $(date)*'), 'echo $(date) $(rm -rf ~)')).toBe(false);
  });

  it('a trailing wildcard starts on a word boundary — another file or package is not covered', () => {
    expect(ruleMatches(grant('node scripts/x.mjs*'), 'node scripts/x.mjs --watch')).toBe(true);
    expect(ruleMatches(grant('node scripts/x.mjs*'), 'node scripts/x.mjs_evil')).toBe(false);
    expect(ruleMatches(grant('npx prettier*'), 'npx prettier-evil')).toBe(false);
    expect(ruleMatches(grant('ls*'), 'lsblk')).toBe(false);
    expect(ruleMatches(grant('ls*'), 'ls')).toBe(true);
  });

  it('a middle wildcard is bounded on both sides', () => {
    const push = grant('git push*origin feat/x');
    expect(ruleMatches(push, 'git push -u origin feat/x')).toBe(true);
    expect(ruleMatches(push, 'git push --repo=xorigin feat/x')).toBe(false);
  });

  it('a stored grant that covers a code-running command covers nothing at all', () => {
    // A grant saved before this change ("Any node command") stops matching rather
    // than keeping its reach; the user is asked again and offered a narrower choice.
    expect(ruleMatches(grant('node*'), 'node -e "require(1)"')).toBe(false);
    expect(ruleMatches(grant('node*'), 'node scripts/x.mjs')).toBe(false);
    expect(ruleMatches(grant('python*'), 'python build.py')).toBe(false);
    expect(ruleMatches(grant('npx*'), 'npx prettier --write .')).toBe(false);
    // An ordinary grant is untouched.
    expect(ruleMatches(grant('npm run*'), 'npm run build')).toBe(true);
  });

  it('PowerShell sessions also refuse code inside arguments', () => {
    const ps = { powershell: true };
    expect(ruleMatches(grant('git status*'), 'git status (Remove-Item -Recurse ~)', ps)).toBe(false);
    expect(ruleMatches(grant('git status*'), 'git status @{a=Remove-Item ~}', ps)).toBe(false);
    expect(ruleMatches(grant('git status*'), 'git status --short', ps)).toBe(true);
    // In bash, parentheses inside a quoted message are just text — no grant lost.
    expect(ruleMatches(grant('git commit*'), 'git commit -m "fix (x)"')).toBe(true);
  });

  it('a lone carriage return is refused everywhere — PowerShell reads it as a new line', () => {
    expect(ruleMatches(grant('git status*'), 'git status\rRemove-Item ~')).toBe(false);
  });
});
