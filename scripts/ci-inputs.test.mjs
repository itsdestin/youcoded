import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as inputs from './ci-inputs.mjs';
const { androidOutputs } = inputs;
const scopes = ['jvm', 'debug', 'releaseTest'];
const jvmPaths = ['Debug', 'Release', 'ReleaseTest'].map(variant => `app/build/test-results/test${variant}UnitTest/TEST-current.xml`);
const scopePaths = { jvm: jvmPaths, debug: ['app/build/outputs/apk/debug/current.apk'], releaseTest: ['app/build/outputs/apk/releaseTest/current.apk'] };
const expectedIdentity = { sha: 'current', tree: 'current-tree', lock: 'lock', config: 'config', builder: 'builder' };
function records() {
  return scopes.map(scope => ({ scope, identity: { ...expectedIdentity }, outputs: scopePaths[scope].map(name => ({ path: name, sha256: 'a'.repeat(64) })) }));
}
function fixture(t, files = Object.values(scopePaths).flat()) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ci-android-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  for (const name of files) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), 'current output'); }
  return root;
}
for (const scope of ['all', ...scopes]) test(`Android ${scope} selects only its nonempty current files`, async t => {
  const names = scope === 'all' ? Object.values(scopePaths).flat() : scopePaths[scope];
  const root = fixture(t, names);
  const expectedHash = createHash('sha256').update('current output').digest('hex');
  assert.deepEqual((await androidOutputs(root, scope)).map(output => ({ ...output, path: output.path.split(path.sep).join('/') })).sort((a, b) => a.path.localeCompare(b.path)),
    names.map(name => ({ path: name, sha256: expectedHash })).sort((a, b) => a.path.localeCompare(b.path)));
  if (scope === 'all') assert.deepEqual(await androidOutputs(root), await androidOutputs(root, 'all'));
  for (const name of names) {
    fs.writeFileSync(path.join(root, name), ''); await assert.rejects(androidOutputs(root, scope));
    fs.writeFileSync(path.join(root, name), 'current output');
    fs.rmSync(path.join(root, name)); await assert.rejects(androidOutputs(root, scope));
    fs.mkdirSync(path.join(root, name)); await assert.rejects(androidOutputs(root, scope));
    fs.rmdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name), 'current output');
  }
});
test('Android rejects unknown scopes before looking for outputs', async t => {
  const root = fixture(t);
  for (const scope of ['', 'unknown', 'release', null]) await assert.rejects(androidOutputs(root, scope));
});
for (const name of jvmPaths) test(`JVM scope rejects missing report directory ${name}`, async t => {
  const root = fixture(t, jvmPaths);
  fs.rmSync(path.dirname(path.join(root, name)), { recursive: true });
  await assert.rejects(androidOutputs(root, 'jvm'));
});
test('Android aggregation binds all scopes to current identity with deterministic output order', () => {
  const source = records();
  const expected = { identity: expectedIdentity, outputs: source.flatMap(record => record.outputs).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), scopes };
  assert.deepEqual(inputs.aggregateAndroid(source, expectedIdentity), expected);
  assert.deepEqual(inputs.aggregateAndroid(source.reverse().map(record => ({ ...record, outputs: [...record.outputs].reverse(), success: false })), expectedIdentity), expected);
});
const invalidRecords = {
  'missing scope': rows => rows.pop(),
  'duplicate scope': rows => { rows[2] = structuredClone(rows[1]); },
  'unknown scope': rows => { rows[2].scope = 'all'; },
  'extra record': rows => rows.push(structuredClone(rows[0])),
  'stale identity': rows => { rows[1].identity.sha = 'old'; },
  'missing identity': rows => { delete rows[1].identity; },
  'empty outputs': rows => { rows[1].outputs = []; },
  'missing JVM variant': rows => rows[0].outputs.pop(),
  'duplicate path': rows => rows[0].outputs.push({ ...rows[0].outputs[0] }),
  'cross-scope duplicate path': rows => { rows[2].outputs[0] = { ...rows[1].outputs[0] }; },
  'wrong APK variant': rows => { rows[1].outputs[0].path = 'app/build/outputs/apk/release/current.apk'; },
  'wrong JVM variant': rows => { rows[0].outputs[0].path = 'app/build/test-results/testOtherUnitTest/TEST-current.xml'; },
  'wrong extension': rows => { rows[1].outputs[0].path += '.txt'; },
  'uppercase hash': rows => { rows[1].outputs[0].sha256 = 'A'.repeat(64); },
  'short hash': rows => { rows[1].outputs[0].sha256 = 'a'.repeat(63); },
  'non-string hash': rows => { rows[1].outputs[0].sha256 = 123; },
  'missing outputs': rows => { delete rows[1].outputs; },
};
for (const name of ['/app/build/outputs/apk/debug/current.apk', 'C:/app/build/outputs/apk/debug/current.apk', 'app/build/outputs/apk/debug/../debug/current.apk', 'app/build/outputs/apk/debug//current.apk', 'app/build/outputs/apk/debug/./current.apk', 'app\\build\\outputs\\apk\\debug\\current.apk', 'app/build/outputs/apk/debug/sub/current.apk', 'app/build/outputs/apk/debug/.apk', 'app/build/outputs/apk/debug/current.apk\n']) {
  invalidRecords[`invalid path ${JSON.stringify(name)}`] = rows => { rows[1].outputs[0].path = name; };
}
for (const [label, mutate] of Object.entries(invalidRecords)) test(`Android aggregation rejects ${label}`, () => {
  const rows = records(); mutate(rows); assert.throws(() => inputs.aggregateAndroid(rows, expectedIdentity));
});

test('Android CLI producers and aggregate enforce current identity and exact artifact names', async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['ci-inputs.mjs', 'ci-evidence.mjs', 'ci-policy.mjs']) fs.copyFileSync(new URL(name, import.meta.url), path.join(root, 'scripts', name));
  fs.mkdirSync(path.join(root, 'desktop'));
  for (const name of ['package-lock.json', 'vitest.config.ts', 'electron-builder.yml']) fs.writeFileSync(path.join(root, 'desktop', name), 'fixture');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-q'); git('add', 'scripts', 'desktop');
  // WHY: commits exist only in this disposable fixture; the real worktree is never staged or committed.
  git('-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  // WHY: macOS /var is an alias of /private/var. Reproduce that entrypoint
  // mismatch on POSIX even when this test host's tmpdir is already canonical.
  let launchRoot = root;
  if (process.platform !== 'win32') {
    launchRoot = `${root}-alias`; fs.symlinkSync(root, launchRoot, 'dir');
    t.after(() => fs.rmSync(launchRoot, { force: true }));
  }
  const cli = action => spawnSync(process.execPath, [path.join(launchRoot, 'scripts/ci-inputs.mjs'), action], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: sha } });
  const ok = action => { const result = cli(action); assert.equal(result.status, 0, result.stderr); };
  ok('start');
  for (const scope of scopes) {
    ok(scope);
    const evidence = JSON.parse(fs.readFileSync(path.join(root, 'ci-android-evidence.json'), 'utf8'));
    assert.equal(evidence.scope, scope); assert.equal(evidence.outputs.length, scopePaths[scope].length);
    const directory = path.join(root, 'ci-android-results', `android-scope-${scope}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(path.join(root, 'ci-android-evidence.json'), path.join(directory, 'ci-android-evidence.json'));
  }
  ok('aggregate');
  const combined = JSON.parse(fs.readFileSync(path.join(root, 'ci-android-evidence.json'), 'utf8'));
  assert.deepEqual(combined.scopes, scopes); assert.equal(combined.outputs.length, 5);
  fs.mkdirSync(path.join(root, 'ci-android-results', 'unexpected'));
  assert.notEqual(cli('aggregate').status, 0);
  fs.rmdirSync(path.join(root, 'ci-android-results', 'unexpected'));
  const debug = path.join(root, 'ci-android-results', 'android-scope-debug');
  fs.renameSync(debug, `${debug}-wrong`); assert.notEqual(cli('aggregate').status, 0); fs.renameSync(`${debug}-wrong`, debug);
  const evidenceFile = path.join(debug, 'ci-android-evidence.json');
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  evidence.scope = 'releaseTest'; fs.writeFileSync(evidenceFile, JSON.stringify(evidence)); assert.notEqual(cli('aggregate').status, 0);
  evidence.scope = 'debug'; evidence.identity.sha = 'old'; fs.writeFileSync(evidenceFile, JSON.stringify(evidence)); assert.notEqual(cli('aggregate').status, 0);
  // WHY: later dirty-source checks must not pass merely because this earlier
  // stale record remains invalid. Restore it and prove the clean aggregate.
  evidence.identity.sha = sha; fs.writeFileSync(evidenceFile, JSON.stringify(evidence)); ok('aggregate');
  ok('android');
  fs.writeFileSync(path.join(root, 'ci-android-inputs.json'), JSON.stringify({ sha: 'old' }));
  for (const action of ['android', ...scopes]) assert.notEqual(cli(action).status, 0);
  ok('start'); fs.appendFileSync(path.join(root, 'desktop/vitest.config.ts'), 'changed');
  for (const action of ['android', ...scopes, 'aggregate']) {
    const result = cli(action); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Tracked inputs modified/);
  }
});

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
