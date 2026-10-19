import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseGradleOutcomes, producerViolations } from './ci-gradle-outcomes.mjs';

const producers = scope => ['bundleWebUi', 'buildBackend', `buildRuntime${scope === 'debug' ? 'Debug' : 'ReleaseTest'}`, `materialize${scope === 'debug' ? 'Debug' : 'ReleaseTest'}SpeedPayload`];
const log = scope => producers(scope).map(name => `> Task :app:${name}`).join('\n') + '\nBUILD SUCCESSFUL in 1m\n';

test('records every reported outcome without counting repeated or interleaved headers as execution', () => {
  const parsed = parseGradleOutcomes('> Task :app:compile\r\n> Task :app:other\n> Task :app:compile FROM-CACHE\n> Task :app:compile\n> Task :app:other UP-TO-DATE\n> Task :app:skip SKIPPED\n> Task :app:empty NO-SOURCE\n> Task :app:run\nBUILD SUCCESSFUL in 4s\n');
  assert.deepEqual(parsed, { build: 'SUCCESSFUL', tasks: { ':app:compile': 'FROM-CACHE', ':app:other': 'UP-TO-DATE', ':app:skip': 'SKIPPED', ':app:empty': 'NO-SOURCE', ':app:run': 'executed' } });
});
test('reports failed builds and failed task facts truthfully', () => {
  assert.deepEqual(parseGradleOutcomes('> Task :app:r8 FAILED\nBUILD FAILED in 3s\n'), { build: 'FAILED', tasks: { ':app:r8': 'FAILED' } });
});
test('rejects absent, malformed, unknown and conflicting outcomes', () => {
  for (const text of ['', '> Task :app:x', 'BUILD SUCCESSFUL nonsense', '> Task app:x\nBUILD SUCCESSFUL in 1s', '> Task :app:x UNKNOWN\nBUILD SUCCESSFUL in 1s', '> Task :app:x FROM-CACHE\n> Task :app:x FAILED\nBUILD FAILED in 1s', 'BUILD FAILED in 1s\nBUILD SUCCESSFUL in 1s']) assert.throws(() => parseGradleOutcomes(text));
});
test('checks every selected public producer and fails closed for unknown or missing facts', () => {
  for (const scope of ['debug', 'releaseTest']) {
    const facts = parseGradleOutcomes(log(scope));
    assert.deepEqual(producerViolations(scope, facts), []);
    for (const name of producers(scope)) {
      const path = `:app:${name}`;
      for (const status of ['FROM-CACHE', 'SKIPPED', 'NO-SOURCE', 'FAILED', 'unknown']) assert.ok(producerViolations(scope, { ...facts, tasks: { ...facts.tasks, [path]: status } }).length);
      const tasks = { ...facts.tasks }; delete tasks[path];
      assert.ok(producerViolations(scope, { ...facts, tasks }).length);
    }
    assert.ok(producerViolations(scope, { ...facts, tasks: { ...facts.tasks, ':app:buildRuntimeMystery': 'executed' } }).length);
  }
  assert.throws(() => producerViolations('release', parseGradleOutcomes(log('debug'))));
});
test('CLI emits small scoped SHA facts on success and failure, never acceptance receipts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gradle-outcomes-'));
  const cli = fileURLToPath(new URL('./ci-gradle-outcomes.mjs', import.meta.url));
  try {
    const input = join(dir, 'gradle.log');
    const run = (scope, text) => { writeFileSync(input, text); return spawnSync(process.execPath, [cli, scope, input], { env: { ...process.env, RUNNER_TEMP: dir, GITHUB_SHA: 'a'.repeat(40) }, encoding: 'utf8' }); };
    assert.equal(run('debug', log('debug')).status, 0);
    const result = JSON.parse(readFileSync(join(dir, 'android-gradle-outcomes-debug.json'), 'utf8'));
    assert.equal(result.sha, 'a'.repeat(40)); assert.equal(result.scope, 'debug'); assert.equal(result.diagnosticOnly, true);
    assert.equal(result.build, 'SUCCESSFUL'); assert.equal(Object.keys(result.tasks).length, 4);
    assert.equal(run('releaseTest', '> Task :app:compile FAILED\nBUILD FAILED in 1s').status, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'android-gradle-outcomes-releaseTest.json'), 'utf8')).build, 'FAILED');
    assert.equal(run('release', log('debug')).status, 1);
    assert.equal(run('debug', 'not a Gradle outcome').status, 1);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
});
