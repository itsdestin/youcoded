import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { variants, packageArgs, normalizeMetadata, compare, aggregateShards, aggregatePackages, stage, manifest, fingerprint, validateWorkflow, runVitestShard, normalizeRpmRequirements } from './linux-build-bench.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../desktop/package.json', import.meta.url));
const YAML = require('yaml');
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'linux-bench-test-'));
const clean = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });

test('fixed variants reject arbitrary targets/compression and never publish', () => {
  assert.equal(variants.length, 7);
  for (const id of variants) {
    const args = packageArgs(id, '/private/app', '/private/out');
    assert.ok(args.includes('--prepackaged'));
    assert.deepEqual(args.slice(-2), ['--publish', 'never']);
  }
  for (const id of ['deb; touch /tmp/pwn', 'AppImage-fast', 'rpm-zstd', '', '../deb-default']) assert.throws(() => packageArgs(id, '/a', '/b'));
  assert.ok(packageArgs('deb-fast', '/a', '/b').includes('-c.deb.compression=gz'));
  assert.ok(packageArgs('rpm-fast', '/a', '/b').includes('-c.rpm.compression=gzip'));
  assert.ok(packageArgs('pacman-fast', '/a', '/b').includes('-c.pacman.compression=gz'));
});

test('installed builder schema accepts every override and dir mode resolves to one unpacked target', async () => {
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
  const config = YAML.parse(fs.readFileSync(path.join(root,'desktop/electron-builder.yml'),'utf8'));
  const { DebugLogger } = require('builder-util');
  for (const id of variants) {
    const c = structuredClone(config);
    for (const arg of packageArgs(id,'/a','/b')) {
      const m = /^-c\.(deb|rpm|pacman)\.compression=(.+)$/.exec(arg);
      if (m) c[m[1]] = { ...c[m[1]], compression:m[2] };
    }
    await validateConfiguration(c,new DebugLogger(false));
  }
  await assert.rejects(validateConfiguration({ ...config, deb:{ compression:'gzip' } },new DebugLogger(false)));
  const { normalizeOptions } = require('electron-builder/out/builder.js');
  const options = normalizeOptions({ linux:[], x64:true, dir:true, publish:'never' });
  assert.equal(options.targets.size,1);
  assert.deepEqual([...options.targets.values()][0].get(1),['dir']);
});

test('stage records real subprocess wall/CPU and records failure before throwing', async () => {
  const dir = fixture();
  try {
    const m = await stage('ok', process.execPath, ['-e', 'console.log("fixture")'], { evidence: dir });
    assert.equal(m.exitCode, 0); assert.ok(m.wallSeconds >= 0); assert.ok(m.userSeconds >= 0); assert.ok(m.systemSeconds >= 0);
    await assert.rejects(stage('bad', process.execPath, ['-e', 'process.exit(7)'], { evidence: dir }));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'bad.json'))).exitCode, 7);
  } finally { clean(dir); }
});

for (const exitCode of [0, 1]) {
  test(`shard preserves the structured Vitest report separately from metrics on exit ${exitCode}`, async () => {
    const dir = fixture();
    try {
      const expected = { ...report('fixture'), success: exitCode === 0, numFailedTests: exitCode, numFailedTestSuites: exitCode, numPassedTests: 1 - exitCode };
      if (exitCode) {
        expected.testResults[0].status = 'failed';
        expected.testResults[0].assertionResults[0].status = 'failed';
      }
      const runner = path.join(dir, 'reporter.mjs');
      // WHY a real child: the metric is written only AFTER the reporter process
      // exits. Mocking stage would hide the overwrite that lost hosted results.
      fs.writeFileSync(runner, `import fs from 'node:fs';
const output = process.argv.find(arg => arg.startsWith('--outputFile.json=')).slice('--outputFile.json='.length);
fs.writeFileSync(output, ${JSON.stringify(JSON.stringify(expected))});
process.exit(${exitCode});\n`);
      const run = runVitestShard(3, 'fixture-digest', { directory: dir, runner });
      if (exitCode) await assert.rejects(run, /failed \(1\)/); else await run;
      const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      assert.deepEqual(read('vitest.json'), expected);
      assert.deepEqual(read('shard.json'), { shard: 3, fingerprint: 'fixture-digest', report: expected });
      const metric = read('vitest-metrics.json');
      assert.equal(metric.exitCode, exitCode);
      assert.ok(Number.isFinite(metric.wallSeconds));
      assert.equal(metric.testResults, undefined);
    } finally { clean(dir); }
  });
}

test('manifest preserves links/modes/hashes and fails closed on any payload difference', () => {
  const dir = fixture();
  try {
    fs.writeFileSync(path.join(dir, 'payload'), 'legal/source'); fs.chmodSync(path.join(dir, 'payload'), 0o755);
    fs.symlinkSync('payload', path.join(dir, 'link'));
    const a = manifest(dir); assert.equal(a.find(x => x.path === 'link').link, 'payload');
    assert.equal(a.find(x => x.path === 'payload').mode, 0o755);
    compare(a, manifest(dir));
    fs.chmodSync(path.join(dir, 'payload'), 0o644); assert.throws(() => compare(a, manifest(dir)));
    fs.chmodSync(path.join(dir, 'payload'), 0o755); fs.writeFileSync(path.join(dir, 'payload'), 'changed'); assert.throws(() => compare(a, manifest(dir)));
  } finally { clean(dir); }
});

test('metadata only normalizes documented pacman builddate, never scripts or dependencies', () => {
  compare(normalizeMetadata('pkginfo', 'pkgname = a\nbuilddate = 123\ndepend = b\n'), normalizeMetadata('pkginfo', 'pkgname = a\nbuilddate = 456\ndepend = b\n'));
  assert.throws(() => compare(normalizeMetadata('pkginfo', 'depend = a'), normalizeMetadata('pkginfo', 'depend = b')));
  assert.notEqual(normalizeMetadata('script', 'date=123'), normalizeMetadata('script', 'date=456'));
});

test('tar transport round trips executable modes and symlinks without hardlink copies', async () => {
  const dir = fixture();
  try {
    const app = path.join(dir,'app'), restored = path.join(dir,'restored');
    fs.mkdirSync(app); fs.mkdirSync(restored);
    fs.writeFileSync(path.join(app,'executable'),'fixture'); fs.chmodSync(path.join(app,'executable'),0o755);
    fs.symlinkSync('executable',path.join(app,'link'));
    const before = manifest(app);
    await stage('archive','tar',['-cf',path.join(dir,'app.tar'),'-C',dir,'app'],{evidence:path.join(dir,'metrics')});
    await stage('restore','tar',['-xpf',path.join(dir,'app.tar'),'-C',restored],{evidence:path.join(dir,'metrics')});
    compare(before,manifest(path.join(restored,'app')));
    fs.writeFileSync(path.join(restored,'app/executable'),'private mutation');
    compare(before,manifest(app));
  } finally { clean(dir); }
});

test('RPM compression accounts for only the exact generated XZ capability and preserves application requirements', () => {
  const application = 'nss\n/bin/sh\n';
  assert.equal(normalizeRpmRequirements('requires', application + 'rpmlib(PayloadIsXz) <= 5.2-1\n', 'xz'), application);
  assert.equal(normalizeRpmRequirements('requires', application, 'gzip'), application);
  const flags = 'nss\t0\t\n/bin/sh\t1280\t\n';
  assert.equal(normalizeRpmRequirements('flags-REQUIRE', flags + 'rpmlib(PayloadIsXz)\t16777226\t5.2-1\n', 'xz'), flags);
  assert.notEqual(normalizeRpmRequirements('requires', 'changed-app\n', 'gzip'), application);
  for (const [kind, text, compressor] of [
    ['requires', application, 'xz'],
    ['requires', application + 'rpmlib(PayloadIsXz) <= 5.2-1\n', 'gzip'],
    ['requires', application + 'rpmlib(PayloadIsXz) <= 6.0-1\n', 'xz'],
    ['flags-REQUIRE', flags + 'rpmlib(PayloadIsXz)\t0\t5.2-1\n', 'xz'],
    ['requires', application, 'unknown'],
  ]) assert.throws(() => normalizeRpmRequirements(kind, text, compressor));
});

test('pacman compressed metadata normalization retains every non-timestamp payload field', () => {
  const dir = fixture();
  try {
    fs.writeFileSync(path.join(dir,'.PKGINFO'),'pkgname = fixture\nbuilddate = 123\ndepend = lib\n');
    const mtree = timestamp => `#mtree\n./.PKGINFO type=file time=${timestamp} size=44 md5digest=${timestamp} sha256digest=${timestamp}\n./opt/file type=file mode=755 time=${timestamp} sha256digest=payload\n`;
    fs.writeFileSync(path.join(dir,'.MTREE'),gzipSync(mtree(123)));
    const a = manifest(dir,{packageMetadata:true});
    fs.writeFileSync(path.join(dir,'.PKGINFO'),'pkgname = fixture\nbuilddate = 456\ndepend = lib\n');
    fs.writeFileSync(path.join(dir,'.MTREE'),gzipSync(mtree(456)));
    compare(a,manifest(dir,{packageMetadata:true}));
    fs.writeFileSync(path.join(dir,'.MTREE'),gzipSync(mtree(456).replace('mode=755','mode=644')));
    assert.throws(() => compare(a,manifest(dir,{packageMetadata:true})));
    const rpmDump = t => `/opt/file 100 ${t} digest 0100755 root root 0 0 0 X\n`;
    compare(normalizeMetadata('rpm-dump',rpmDump(123)),normalizeMetadata('rpm-dump',rpmDump(456)));
    assert.throws(() => compare(normalizeMetadata('rpm-dump',rpmDump(123)),normalizeMetadata('rpm-dump',rpmDump(456).replace('root root','user root'))));
  } finally { clean(dir); }
});

const report = name => ({ success: true, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 1, numTodoTests: 0, numPassedTests: 1, testResults: [{ name: `/checkout/desktop/tests/${name}.test.ts`, status: 'passed', assertionResults: [{ fullName: `${name} works`, status: 'passed' }, { fullName: `${name} platform skip`, status: 'pending' }] }] });
test('four structured shards aggregate exact file union, cases and explicit skip counts', () => {
  const expected = ['a', 'b', 'c', 'd'].map(x => `tests/${x}.test.ts`);
  const shards = ['a','b','c','d'].map((x, i) => ({ shard: i + 1, fingerprint: 'same', report: report(x) }));
  const result = aggregateShards(expected, shards, 'same');
  assert.equal(result.files, 4); assert.equal(result.passed, 4); assert.equal(result.skipped, 4);
  for (const broken of [shards.slice(1), [...shards.slice(0, 3), shards[0]], shards.map((s,i) => i ? s : { ...s, fingerprint:'other' }), shards.map((s,i) => i ? s : { ...s, report: { ...s.report, success:false } }), shards.map((s,i) => i ? s : { ...s, report: { ...s.report, testResults: [] } })]) assert.throws(() => aggregateShards(expected, broken, 'same'));
  assert.throws(() => aggregateShards([...expected,'tests/missing.test.ts'], shards, 'same'));
});

test('shard inventory retains both production roots and test/spec file patterns', () => {
  const expected = ['tests/a.test.ts', 'src/renderer/view.test.tsx', 'tests/extra.spec.ts', 'src/main/extra.spec.ts'];
  const shards = expected.map((file, index) => {
    const r = report(`fixture-${index}`);
    r.testResults[0].name = `/checkout/desktop/${file}`;
    return { shard: index + 1, fingerprint: 'same', report: r };
  });
  assert.equal(aggregateShards(expected, shards, 'same').files, 4);
  const escaped = structuredClone(shards);
  escaped[0].report.testResults[0].name = '/checkout/desktop/src/../../outside.test.ts';
  assert.throws(() => aggregateShards(expected, escaped, 'same'));
});

test('all package controls must have matching source and real corresponding payload manifests', () => {
  const records = variants.map(id => {
    const record = {info:{id,fingerprint:'same',bytes:100},metric:{exitCode:0},payload:{payload:[{path:'opt/legal',mode:420,sha256:'abc'}],metadata:[]}};
    if (id.startsWith('rpm-')) {
      const xz = id.endsWith('default');
      record.capability = {compressor:xz ? 'xz' : 'gzip',original:{requires:'nss\n' + (xz ? 'rpmlib(PayloadIsXz) <= 5.2-1\n' : ''),'flags-REQUIRE':'nss\t0\t\n' + (xz ? 'rpmlib(PayloadIsXz)\t16777226\t5.2-1\n' : '')}};
      record.payload.metadata = Object.entries(record.capability.original).map(([kind,text]) => ({path:kind,type:'file',mode:420,sha256:createHash('sha256').update(normalizeRpmRequirements(kind,text,record.capability.compressor)).digest('hex')}));
    }
    return record;
  });
  assert.equal(aggregatePackages(records,'same').length,7);
  for (const mutate of [r => r.pop(), r => {r[1]=r[0];}, r => {r[1].info.fingerprint='other';}, r => {r[1].metric.exitCode=1;}, r => {r[1].info.bytes=0;}, r => {r[2].payload.payload[0].sha256='different';}, r => {delete r[2].payload;}, r => {delete r[3].capability;}, r => {r[3].capability.original.requires='different-app\nrpmlib(PayloadIsXz) <= 5.2-1\n';}, r => {r[4].capability.compressor='xz';}]) {
    const broken = structuredClone(records); mutate(broken);
    assert.throws(() => aggregatePackages(broken,'same'));
  }
});

test('runnable discovery uses Vitest suite separators rather than JSON reporter fullName spaces', () => {
  const shards = ['a','b','c','d'].map((x,i) => {
    const r = report(x);
    r.testResults[0].assertionResults[0] = { ancestorTitles: ['suite'], title: x, fullName: `suite ${x}`, status: 'passed' };
    return { shard:i+1, fingerprint:'same', report:r };
  });
  const expected = ['a','b','c','d'].map(x => `tests/${x}.test.ts`);
  const runnable = ['a','b','c','d'].map(x => ({ file:`tests/${x}.test.ts`, name:`suite > ${x}` }));
  aggregateShards(expected,shards,'same',runnable);
  shards[0].report.testResults[0].assertionResults[0].status = 'pending';
  assert.throws(() => aggregateShards(expected,shards,'same',runnable));
});

test('fingerprints pin production inputs to the frozen baseline', () => {
  const f = fingerprint(root);
  assert.equal(f.baseline, 'd6c22f14af6bf7e26bd124be238eb582fab27f76');
  assert.ok(f.inputs['desktop/src']); assert.ok(f.inputs['desktop/tests']); assert.ok(f.inputs['desktop/package-lock.json']);
  assert.ok(f.inputs.desktop, 'Freeze the entire tracked desktop tree, including Vite/PostCSS/linux/resources inputs');
  assert.ok(f.inputs.LICENSE && f.inputs['TERMS.md'], 'Retain root legal input identities');
});

test('parsed workflow is PR-only diagnostic with all targets/shards and preserved tar transport', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/linux-speed-benchmark.yml'), 'utf8'));
  validateWorkflow(workflow);
  assert.ok(workflow.jobs.inventory, 'Full case collection must not serialize app preparation');
  assert.equal(workflow.jobs.inventory.needs, undefined);
  assert.ok(workflow.jobs.inventory.steps.some(step => step.run?.endsWith('linux-build-bench.mjs discover')));
  assert.ok(!workflow.jobs.prep.steps.some(step => step.run?.endsWith('linux-build-bench.mjs discover')));
  assert.deepEqual(workflow.jobs.gate.needs, ['prep', 'inventory', 'packages', 'shards']);
  const changed = structuredClone(workflow); changed.on.push = { branches: ['master'] };
  assert.throws(() => validateWorkflow(changed));
  const missing = structuredClone(workflow); missing.jobs.packages.strategy.matrix.variant.pop();
  assert.throws(() => validateWorkflow(missing));
  const privileged = structuredClone(workflow); privileged.permissions['id-token'] = 'write';
  assert.throws(() => validateWorkflow(privileged));
  const disabled = structuredClone(workflow); disabled.jobs.gate.if = `false && ${disabled.jobs.gate.if}`;
  assert.throws(() => validateWorkflow(disabled));
});
