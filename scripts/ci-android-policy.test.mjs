import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { acceptAndroidNeeds } from './ci-android-policy.mjs';

const needsFor = (jvm, apk, source) => ({ jvm: { result: jvm }, apk: { result: apk }, 'source-preflight': { result: source } });
const normal = needsFor('success', 'success', 'skipped');
const collection = needsFor('skipped', 'skipped', 'success');

test('only the selected producer success tuple passes in either Boolean mode', () => {
  // WHY: a matrix failure, unexpected skip or missing result must never turn
  // the reusable workflow green merely because its final job ran successfully.
  const results = ['success', 'failure', 'cancelled', 'skipped', '', 'neutral', undefined, 'unknown'];
  let combinations = 0;
  for (const collect of [false, true]) for (const jvm of results) for (const apk of results) for (const source of results) {
    const expected = collect ? jvm === 'skipped' && apk === 'skipped' && source === 'success' : jvm === 'success' && apk === 'success' && source === 'skipped';
    assert.equal(acceptAndroidNeeds(needsFor(jvm, apk, source), collect), expected, JSON.stringify({ collect, jvm, apk, source }));
    combinations++;
  }
  assert.equal(combinations, 1024);
});

test('rejects malformed needs, missing or extra jobs, non-object records and non-Boolean modes', () => {
  for (const collect of [false, true]) {
    const valid = collect ? collection : normal;
    assert.equal(acceptAndroidNeeds(valid, collect), true);
    for (const needs of [undefined, null, [], 'success', true, 1, {}, { ...valid, extra: { result: 'success' } }, { jvm: valid.jvm, apk: valid.apk }]) assert.equal(acceptAndroidNeeds(needs, collect), false);
    for (const key of Object.keys(valid)) {
      const missing = { ...valid }; delete missing[key];
      assert.equal(acceptAndroidNeeds(missing, collect), false);
      for (const record of [null, undefined, 'success', [], true, 1, {}, { result: true }, { result: null }]) assert.equal(acceptAndroidNeeds({ ...valid, [key]: record }, collect), false);
    }
    assert.equal(acceptAndroidNeeds(needsFor('skipped', 'skipped', 'skipped'), collect), false);
  }
  for (const mode of [undefined, null, '', 'true', 'false', 0, 1, {}, []]) assert.equal(acceptAndroidNeeds(normal, mode), false);
  assert.equal(acceptAndroidNeeds({ jvm: { ...normal.jvm, outputs: {} }, apk: normal.apk, 'source-preflight': normal['source-preflight'] }, false), true);
});

const cli = (needs, mode) => {
  const env = { ...process.env };
  delete env.CI_ANDROID_NEEDS; delete env.CI_COLLECT_SOURCES;
  if (needs !== undefined) env.CI_ANDROID_NEEDS = needs;
  if (mode !== undefined) env.CI_COLLECT_SOURCES = mode;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ci-android-policy.mjs', import.meta.url))], { env, encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
};

test('CLI accepts exact environment Booleans with the matching JSON tuple', () => {
  for (const [needs, mode] of [[normal, 'false'], [collection, 'true']]) {
    const result = cli(JSON.stringify(needs), mode);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Android selected producers verified/);
  }
});

test('CLI fails closed for absent, malformed, unexpected or mismatched environment data', () => {
  for (const mode of [undefined, '', 'TRUE', 'False', '0', '1', ' true ', 'null']) assert.notEqual(cli(JSON.stringify(normal), mode).status, 0);
  for (const needs of [undefined, '', '{', 'null', '[]', '{}', JSON.stringify({ ...normal, extra: {} }), JSON.stringify(needsFor('skipped', 'skipped', 'skipped'))]) assert.notEqual(cli(needs, 'false').status, 0);
  assert.notEqual(cli(JSON.stringify(normal), 'true').status, 0);
  assert.notEqual(cli(JSON.stringify(collection), 'false').status, 0);
});
