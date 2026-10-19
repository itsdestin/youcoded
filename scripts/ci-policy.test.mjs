import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { classify, matrixFor, completionAllowed, packagingMode } from './ci-policy.mjs';
import { identity } from './ci-evidence.mjs';

test('fast compression is limited to proven ordinary PR TypeScript source/tests', () => {
  assert.equal(packagingMode('pull_request', ['desktop/src/main/new.ts', 'desktop/tests/new.test.tsx']), 'fast');
  for (const name of ['desktop/package-lock.json', 'desktop/electron-builder.yml', 'desktop/resources/new', 'desktop/assets/new', 'desktop/src/native/new.cpp', 'scripts/ci-linux.mjs', '.github/workflows/desktop-ci.yml', 'desktop/office-pin.json', 'app/runtime/pins.env']) {
    assert.equal(packagingMode('pull_request', ['desktop/src/main/new.ts', name]), 'default');
  }
  assert.equal(packagingMode('pull_request', []), 'default');
  for (const event of ['push', 'schedule', 'workflow_dispatch', 'unknown']) assert.equal(packagingMode(event, ['desktop/src/main/new.ts']), 'default');
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'ci-policy-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false'); git('config', 'commit.gpgsign', 'false');
  const put = (name, body = name) => { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), body); };
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  put('src/core'); const base = commit();
  return { root, git, put, commit, base, close: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}
test('input identity accepts fresh ordinary source/test commits and rejects dirty or mismatched checkout inputs', async () => {
  const r = repository();
  try {
    for (const name of ['desktop/package-lock.json', 'desktop/vitest.config.ts', 'desktop/electron-builder.yml']) r.put(name, 'current input');
    const firstSha = r.commit(), first = await identity(r.root, firstSha);
    r.put('desktop/src/new.ts'); r.put('desktop/tests/new.test.ts'); const secondSha = r.commit(), second = await identity(r.root, secondSha);
    assert.notEqual(first.sha, second.sha); assert.notEqual(first.tree, second.tree); assert.equal(first.lock, second.lock);
    await assert.rejects(identity(r.root, firstSha));
    r.put('desktop/package-lock.json', 'changed lock'); await assert.rejects(identity(r.root, secondSha));
    const thirdSha = r.commit(); assert.notEqual((await identity(r.root, thirdSha)).lock, second.lock);
  } finally { r.close(); }
});
test('complete NUL diff handles large docs, deletions, cross-root renames and unusual paths', async () => {
  const r = repository();
  try {
    for (let i = 0; i < 6000; i++) r.put(`docs/long-${i}`);
    if (process.platform !== 'win32') r.put('docs/a\nb\t');
    let head = r.commit();
    assert.equal((await classify('push', { before: r.base, after: head }, head, r.root)).route, 'docs');
    // WHY: sort a code path before thousands of docs so an early-closing grep
    // would leave Git writing to a closed pipe; the classifier consumes all NULs.
    r.put('000-code'); rmSync(join(r.root, 'src/core')); head = r.commit();
    assert.equal((await classify('push', { before: r.base, after: head }, head, r.root)).route, 'full');
    r.put('src/renamed'); const before = r.commit(); renameSync(join(r.root, 'src/renamed'), join(r.root, 'docs/renamed')); head = r.commit();
    assert.equal((await classify('push', { before, after: head }, head, r.root)).route, 'full');
    await assert.rejects(classify('push', { before: 'f'.repeat(40), after: head }, head, r.root));
    await assert.rejects(classify('push', { before, after: head }, before, r.root));
    assert.equal((await classify('push', { before: head, after: head }, head, r.root)).route, 'full');
  } finally { r.close(); }
});
test('verified PR merge uses actual first parent despite stale event base and rejects checkout mismatches', async () => {
  const r = repository();
  try {
    r.git('checkout', '-qb', 'topic'); r.put('docs/new'); const head = r.commit();
    r.git('checkout', '-q', '-'); r.put('src/new'); const testedBase = r.commit();
    r.git('merge', '--no-ff', '-qm', 'merge', 'topic'); const sha = r.git('rev-parse', 'HEAD');
    const event = { pull_request: { base: { sha: r.base }, head: { sha: head }, merge_commit_sha: sha } };
    const result = await classify('pull_request', event, sha, r.root);
    assert.equal(result.route, 'docs'); assert.equal(result.testedBase, testedBase); assert.equal(result.eventBase, r.base);
    await assert.rejects(classify('pull_request', event, head, r.root));
    assert.equal((await classify('schedule', {}, sha, r.root)).route, 'full');
    assert.equal((await classify('workflow_dispatch', { inputs: { test_scope: 'browser' } }, sha, r.root)).route, 'browser');
  } finally { r.close(); }
});
test('all selected OS shard IDs include exactly the complete nonempty range and shard one', () => {
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
    const matrix = matrixFor(event);
    for (const [os, count] of event === 'pull_request' ? [['ubuntu-latest', 4]] : [['ubuntu-latest', 4], ['windows-latest', 6], ['macos-latest', 4]]) {
      assert.deepEqual(matrix.include.filter(x => x.os === os).map(x => x.shard), Array.from({ length: count }, (_, i) => i + 1));
    }
    assert.equal(matrix.include.length, event === 'pull_request' ? 4 : 14);
  }
});
test('completion Cartesian truth set rejects every nonselected result and SHA mismatch', () => {
  const keys = ['tests', 'prepare', 'formats', 'android', 'evidence', 'browser'];
  const statuses = ['success', 'skipped', 'failure', 'cancelled', undefined, 'unknown'];
  const good = { changes: { result: 'success', outputs: { route: 'full', sha: 'a'.repeat(40), packageMode: 'fast' } }, ...Object.fromEntries(keys.map(key => [key, { result: key === 'browser' ? 'skipped' : 'success' }])) };
  good.evidence.outputs = { sha: 'a'.repeat(40), packageMode: 'fast' };
  assert.equal(completionAllowed(good, 'a'.repeat(40), 'pull_request'), true);
  assert.equal(completionAllowed({ ...good, unknown: { result: 'failure' } }, 'a'.repeat(40), 'pull_request'), false);
  assert.equal(completionAllowed({ ...good, evidence: { ...good.evidence, outputs: { sha: 'a'.repeat(40), packageMode: 'default' } } }, 'a'.repeat(40), 'pull_request'), false);
  assert.equal(completionAllowed({ ...good, evidence: { ...good.evidence, outputs: { sha: 'b'.repeat(40), packageMode: 'fast' } } }, 'a'.repeat(40), 'pull_request'), false);
  assert.equal(completionAllowed(good, undefined, 'pull_request'), false);
  assert.equal(completionAllowed({ ...good, changes: { ...good.changes, result: 'failure' } }, 'a'.repeat(40), 'pull_request'), false);
  for (const route of ['full', 'docs', 'browser']) {
    for (let n = 0; n < statuses.length ** keys.length; n++) {
      let value = n;
      const needs = { changes: { result: 'success', outputs: { route, sha: 'a'.repeat(40), packageMode: 'default' } } };
      for (const key of keys) { needs[key] = { result: statuses[value % statuses.length] }; value = Math.floor(value / statuses.length); }
      needs.evidence.outputs = { sha: 'a'.repeat(40), packageMode: 'default' };
      const expected = keys.every(key => needs[key].result === (route === 'full' ? (key === 'browser' ? 'skipped' : 'success') : route === 'browser' && key === 'browser' ? 'success' : 'skipped'));
      assert.equal(completionAllowed(needs, 'a'.repeat(40), route === 'browser' ? 'workflow_dispatch' : 'pull_request'), expected);
      assert.equal(completionAllowed(needs, 'b'.repeat(40), 'pull_request'), false);
    }
  }
});
