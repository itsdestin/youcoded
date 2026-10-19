import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function acceptAndroidNeeds(needs, collectSources) {
  // WHY: the unselected path must be skipped, not failed/cancelled; accepting
  // arbitrary skips would let a partial reusable workflow satisfy its parent.
  if (typeof collectSources !== 'boolean' || !needs || typeof needs !== 'object' || Array.isArray(needs)) return false;
  const keys = ['jvm', 'apk', 'source-preflight'];
  if (Object.keys(needs).length !== keys.length || !keys.every(key => Object.hasOwn(needs, key))) return false;
  const expected = collectSources ? ['skipped', 'skipped', 'success'] : ['success', 'success', 'skipped'];
  return keys.every((key, index) => {
    const record = needs[key];
    return record !== null && typeof record === 'object' && !Array.isArray(record) && Object.hasOwn(record, 'result') && record.result === expected[index];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.env.CI_COLLECT_SOURCES;
  assert.ok(mode === 'true' || mode === 'false', 'CI_COLLECT_SOURCES must be exactly true or false');
  const needs = JSON.parse(process.env.CI_ANDROID_NEEDS);
  assert.ok(acceptAndroidNeeds(needs, mode === 'true'), 'Selected Android producers did not complete successfully');
  console.log('Android selected producers verified');
}
