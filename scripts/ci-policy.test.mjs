import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { completionAllowed as policyGate } from './ci-policy.mjs';

const cli = fileURLToPath(new URL('./ci-policy.mjs', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'ci@example.invalid');
  git('config', 'user.name', 'CI test');
  const put = (path, text = path) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture', '--allow-empty'); return git('rev-parse', 'HEAD'); };
  put('docs/start.md');
  const base = commit();
  function run(event = { pull_request: { base: { sha: base } } }, name = 'pull_request', extra = {}) {
    const eventPath = join(dir, '.git', 'event.json');
    const output = join(dir, '.git', 'output');
    rmSync(output, { force: true });
    writeFileSync(eventPath, typeof event === 'string' ? event : JSON.stringify(event));
    const result = spawnSync(process.execPath, [cli, 'changes'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, ...extra } });
    return { ...result, output: existsSync(output) ? readFileSync(output, 'utf8') : '' };
  }
  return { dir, git, put, commit, base, run };
}
function decision(result, code) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, `code=${code}\n`);
}

test('CLI classifies real docs, mixed, empty and deletion diffs conservatively', t => {
  const f = fixture(t);
  decision(f.run(), true);
  f.put('docs/new.md'); f.commit(); decision(f.run(), false);
  rmSync(join(f.dir, 'docs/start.md')); f.commit(); decision(f.run(), false);
  f.put('desktop/code.ts'); f.commit(); decision(f.run(), true);
});

for (const [from, to] of [['docs/start.md', 'desktop/code.ts'], ['desktop/code.ts', 'docs/code.md']]) {
  test(`CLI counts both endpoints of rename ${from} to ${to}`, t => {
    const f = fixture(t);
    f.put(from); const base = f.commit();
    mkdirSync(dirname(join(f.dir, to)), { recursive: true });
    renameSync(join(f.dir, from), join(f.dir, to)); f.commit();
    decision(f.run({ pull_request: { base: { sha: base } } }), true);
  });
}

test('CLI reads NUL filenames without splitting newlines, tabs or spaces', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  f.put('docs/line\nnot-docs.ts'); f.put('docs/tab\tname'); f.put('docs/a space'); f.commit();
  decision(f.run(), false);
  f.put('outside\n docs/code.ts'); f.commit(); decision(f.run(), true);
});

test('large code diff reproduces old pipefail false-docs result but CLI stays full', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  for (let i = 0; i < 5000; i++) f.put(`desktop/${i.toString().padStart(5, '0')}-${'long'.repeat(15)}.ts`);
  f.commit();
  const old = spawnSync('bash', ['-c', 'set -o pipefail; if git diff --name-only "$1...HEAD" | grep -qv "^docs/"; then echo code=true; else echo code=false; fi', '_', f.base], { cwd: f.dir, encoding: 'utf8' });
  assert.equal(old.stdout.trim(), 'code=false', 'fixture must reproduce original SIGPIPE bug');
  decision(f.run(), true);
});

test('PR uses immutable event base and three-dot HEAD rather than moving base branch', t => {
  const f = fixture(t);
  f.git('checkout', '-qb', 'topic'); f.put('docs/topic'); f.commit();
  f.git('checkout', '-qb', 'moving-base', f.base); f.put('desktop/unrelated'); const eventBase = f.commit();
  f.git('checkout', 'topic');
  // A two-dot diff against the diverged event base sees a code deletion; the
  // PR's three-dot diff correctly measures only the topic's docs additions.
  decision(f.run({ pull_request: { base: { sha: eventBase } } }), false);
  // Moving branch names are not consulted for the earlier immutable event base.
  decision(f.run(), false);
});

test('push uses immutable before and after, not checkout HEAD', t => {
  const f = fixture(t);
  f.put('docs/push'); const after = f.commit();
  f.put('desktop/later'); f.commit();
  decision(f.run({ before: f.base, after }, 'push'), false);
});

test('CLI classifies standalone docs and code deletions and empty pushes', t => {
  const f = fixture(t);
  f.put('desktop/delete-me.ts'); const base = f.commit();
  rmSync(join(f.dir, 'desktop/delete-me.ts')); const after = f.commit();
  decision(f.run({ before: base, after }, 'push'), true);
  const docsBase = after;
  rmSync(join(f.dir, 'docs/start.md')); const docsAfter = f.commit();
  decision(f.run({ before: docsBase, after: docsAfter }, 'push'), false);
  decision(f.run({ before: docsAfter, after: docsAfter }, 'push'), true);
});

test('new branch and non-diff events run full', t => {
  const f = fixture(t);
  decision(f.run({ before: '0'.repeat(40), after: f.base }, 'push'), true);
  for (const name of ['workflow_dispatch', 'schedule', 'unknown']) decision(f.run({}, name), true);
});

test('CLI rejects non-commit refs and unavailable new-branch after commits', t => {
  const f = fixture(t);
  const tree = f.git('rev-parse', 'HEAD^{tree}');
  f.put('docs/change'); f.commit();
  for (const [event, name] of [
    [{ pull_request: { base: { sha: tree } } }, 'pull_request'],
    [{ before: tree, after: f.base }, 'push'],
    [{ before: '0'.repeat(40), after: 'f'.repeat(40) }, 'push'],
    [{ before: '0'.repeat(40), after: tree }, 'push'],
  ]) {
    const result = f.run(event, name);
    assert.notEqual(result.status, 0, JSON.stringify(event));
    assert.equal(result.output, '');
  }
});

test('malformed events, missing or invalid refs and output errors fail without success output', t => {
  const f = fixture(t);
  for (const event of ['{', null, [], {}, { pull_request: { base: { sha: '--help' } } }, { pull_request: { base: { sha: 'f'.repeat(40) } } }]) {
    const result = f.run(event); assert.notEqual(result.status, 0); assert.equal(result.output, '');
  }
  for (const event of [{}, { before: '', after: f.base }, { before: f.base, after: 'bad' }, { before: f.base, after: 'f'.repeat(40) }]) {
    const result = f.run(event, 'push'); assert.notEqual(result.status, 0); assert.equal(result.output, '');
  }
  for (const extra of [{ GITHUB_EVENT_NAME: '' }, { GITHUB_OUTPUT: '' }, { GITHUB_OUTPUT: f.dir }, { GITHUB_EVENT_PATH: join(f.dir, 'missing') }]) {
    const result = f.run(undefined, undefined, extra); assert.notEqual(result.status, 0); assert.equal(result.output, '');
  }
  f.git('update-ref', '-d', 'HEAD');
  const result = f.run(); assert.notEqual(result.status, 0); assert.equal(result.output, '');
});

function gate(needs, scope = 'all', event = 'pull_request') {
  return spawnSync(process.execPath, [cli, 'gate'], { encoding: 'utf8', env: { ...process.env, CI_NEEDS: JSON.stringify(needs), CI_TEST_SCOPE: scope, GITHUB_EVENT_NAME: event } });
}
function needsFor(code, results) {
  return Object.fromEntries(['changes', 'preflight', 'tests', 'package'].map((name, i) => [name, { result: results[i], ...(name === 'changes' ? { outputs: { code } } : {}) }]));
}

test('executable gate accepts only exact full, proven docs and explicit diagnostics truth tables', () => {
  const states = ['success', 'failure', 'cancelled', 'skipped', undefined, 'unknown'];
  for (const code of ['true', 'false', '', undefined, 'unknown']) {
    for (const scope of ['all', 'browser', '', 'unknown']) {
      for (const event of ['pull_request', 'workflow_dispatch']) {
        for (const a of states) for (const b of states) for (const c of states) for (const d of states) {
          // Pure export exercises the whole Cartesian table without spawning 50k processes.
          const expected = a === 'success' && (code === 'false' && scope !== 'browser' && ['all', ''].includes(scope) && b === 'skipped' && c === 'skipped' && d === 'skipped'
            || code === 'true' && ['all', ''].includes(scope) && b === 'success' && c === 'success' && d === 'success'
            || code === 'true' && scope === 'browser' && event === 'workflow_dispatch' && b === 'success' && c === 'success' && d === 'skipped');
          assert.equal(policyGate(needsFor(code, [a, b, c, d]), scope, event), expected, JSON.stringify({ code, scope, event, a, b, c, d }));
        }
      }
    }
  }
  for (const [code, results, scope, event] of [
    ['true', ['success', 'success', 'success', 'success'], 'all', 'pull_request'],
    ['false', ['success', 'skipped', 'skipped', 'skipped'], 'all', 'pull_request'],
    ['true', ['success', 'success', 'success', 'skipped'], 'browser', 'workflow_dispatch'],
  ]) assert.equal(gate(needsFor(code, results), scope, event).status, 0);
  for (const needs of [{}, null, { changes: {} }, needsFor('true', ['success', 'success', 'failure', 'success'])]) assert.notEqual(gate(needs).status, 0);
  const malformed = spawnSync(process.execPath, [cli, 'gate'], { env: { ...process.env, CI_NEEDS: '{' } });
  assert.notEqual(malformed.status, 0);
});
