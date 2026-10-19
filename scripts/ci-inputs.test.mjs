import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { androidOutputs } from './ci-inputs.mjs';
test('Android current output evidence requires both real APKs and all three nonempty JVM report directories', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ci-android-'));
  const files = ['app/build/outputs/apk/debug/current.apk', 'app/build/outputs/apk/releaseTest/current.apk',
    ...['Debug', 'Release', 'ReleaseTest'].map(variant => `app/build/test-results/test${variant}UnitTest/TEST-current.xml`)];
  try {
    for (const name of files) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), 'current output'); }
    assert.equal((await androidOutputs(root)).length, files.length);
    for (const name of files) {
      fs.writeFileSync(path.join(root, name), ''); await assert.rejects(androidOutputs(root));
      fs.writeFileSync(path.join(root, name), 'current output'); fs.rmSync(path.join(root, name)); await assert.rejects(androidOutputs(root));
      fs.writeFileSync(path.join(root, name), 'current output');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
