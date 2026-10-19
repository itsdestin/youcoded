import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregate, validateReport, manifest, verifyCore, verifyInstalled, transport, unpack, shardArgs } from './ci-evidence.mjs';
test('shard argv is unfiltered, forbid-only, default timeouts with an absolute structured report', () => {
  const output = join(tmpdir(), 'a space', 'report.json');
  assert.deepEqual(shardArgs(1, 4, output), ['run', '--shard=1/4', '--allowOnly=false', '--reporter=default', '--reporter=json', `--outputFile.json=${output}`]);
  for (const args of [[0, 4, output], [5, 4, output], [1.5, 4, output], [1, 0, output], [1, 4, 'relative.json']]) assert.throws(() => shardArgs(...args));
});
const identity = { sha: 'a'.repeat(40), tree: 'b'.repeat(40), lock: 'c'.repeat(64), config: 'd'.repeat(64) };
function report(names) {
  return { success: true, numTotalTestSuites: names.length, numPassedTestSuites: names.length, numPendingTestSuites: 0, numFailedTestSuites: 0, numTotalTests: names.length * 2, numPassedTests: names.length, numPendingTests: names.length, numFailedTests: 0, numTodoTests: 0,
    testResults: names.map(name => ({ name, status: 'passed', assertionResults: [{ fullName: 'passes', status: 'passed' }, { fullName: 'OS skip', status: 'pending' }] })) };
}
function evidence(shard, names) { return { identity, os: 'ubuntu-latest', shard, total: 2, report: report(names), discovery: shard === 1 ? ['a.test.ts', 'new.test.ts'] : undefined }; }
test('fresh discovery accepts added file/cases but rejects gaps, duplicates, SHA/config mismatches and malformed reports', () => {
  const first = evidence(1, ['a.test.ts']), second = evidence(2, ['new.test.ts']);
  assert.equal(aggregate([first, second], [{ os: first.os, total: 2 }], identity).files, 2);
  for (const mutate of [x => x.pop(), x => x.push(x[0]), x => x[1].report.testResults[0].name = 'a.test.ts', x => x[1].identity.sha = 'e'.repeat(40), x => x[1].identity.config = 'f'.repeat(64), x => x[1].report.numTotalTests++, x => x[1].report.testResults[0].assertionResults[0].status = 'unknown', x => x[1].report.success = false, x => x[1].report.testResults[0].status = 'failed', x => x[0].discovery.push('missing.test.ts')]) {
    const copy = structuredClone([first, second]); mutate(copy); assert.throws(() => aggregate(copy, [{ os: first.os, total: 2 }], identity));
  }
  assert.throws(() => validateReport({}));
  const more = structuredClone([first, second]);
  more[1].report.testResults[0].assertionResults.push({ fullName: 'newly authored case', status: 'passed' });
  more[1].report.numTotalTests++; more[1].report.numPassedTests++;
  assert.equal(aggregate(more, [{ os: first.os, total: 2 }], identity).cases, 5);
});
test('current prepared core preserves bytes, modes and links; only explicit generated metadata is added', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-core-'));
  try {
    const app = join(root, 'app'); mkdirSync(join(app, 'resources'), { recursive: true });
    writeFileSync(join(app, 'core'), 'fresh current source'); chmodSync(join(app, 'core'), 0o755);
    if (process.platform !== 'win32') symlinkSync('core', join(app, 'link'));
    const prepared = await manifest(app);
    assert.doesNotThrow(() => verifyCore(prepared, prepared));
    if (process.platform !== 'win32') {
      chmodSync(join(app, 'core'), 0o644); const changedMode = await manifest(app); assert.throws(() => verifyCore(prepared, changedMode)); chmodSync(join(app, 'core'), 0o755);
      rmSync(join(app, 'link')); symlinkSync('different', join(app, 'link')); const changedLink = await manifest(app); assert.throws(() => verifyCore(prepared, changedLink));
      rmSync(join(app, 'link')); symlinkSync('core', join(app, 'link'));
    }
    writeFileSync(join(app, 'resources/apparmor-profile'), 'generated'); const post = await manifest(app);
    assert.doesNotThrow(() => verifyCore(prepared, post)); assert.doesNotThrow(() => verifyInstalled(post, post));
    writeFileSync(join(app, 'unexpected'), 'bad');
    const extra = await manifest(app); assert.throws(() => verifyCore(prepared, extra));
    rmSync(join(app, 'unexpected')); writeFileSync(join(app, 'core'), 'mutated'); const mutated = await manifest(app);
    assert.throws(() => verifyCore(prepared, mutated)); assert.throws(() => verifyInstalled(post, mutated));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
test('zstd TAR round trip proves full byte identity and preserves executable mode and symlink', { skip: process.platform !== 'linux' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-transport-'));
  try {
    const app = join(root, 'app'); mkdirSync(app); writeFileSync(join(app, 'core'), 'payload'); chmodSync(join(app, 'core'), 0o755); symlinkSync('core', join(app, 'link'));
    const proof = await transport(app, root); const target = join(root, 'copy');
    await unpack(root, target, proof); verifyInstalled(await manifest(app), await manifest(target));
    await assert.rejects(unpack(root, join(root, 'bad'), { ...proof, rawSha256: '0'.repeat(64) }));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
