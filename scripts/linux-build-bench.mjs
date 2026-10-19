// EXPERIMENT ONLY. No release path imports this harness.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

export const baseline = 'd6c22f14af6bf7e26bd124be238eb582fab27f76';
export const variants = ['AppImage-default', 'deb-default', 'deb-fast', 'rpm-default', 'rpm-fast', 'pacman-default', 'pacman-fast'];
const faster = { deb: 'gz', rpm: 'gzip', pacman: 'gz' };
const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = path.join(root, 'desktop');
const evidence = path.resolve(process.env.BENCH_EVIDENCE || path.join(root, 'bench-evidence'));
const json = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = file => {
  // WHY bounded reads: the shared uncompressed Office/Electron tar can exceed
  // Node's single-buffer limit; transport verification must not need a RAM copy.
  const digest = createHash('sha256'), fd = fs.openSync(file,'r'), buffer = Buffer.allocUnsafe(1024*1024);
  try { let count; while ((count = fs.readSync(fd,buffer,0,buffer.length,null)) > 0) digest.update(buffer.subarray(0,count)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const relativeTest = file => {
  const normalized = file.replaceAll('\\', '/');
  const rel = normalized.includes('/desktop/') ? normalized.split('/desktop/').at(-1) : normalized.replace(/^\.\//, '');
  // WHY: production Vitest discovers tests under BOTH tests/ and src/, and
  // accepts .spec as well as .test. Never reject/omit colocated source tests.
  assert.ok(!rel.split('/').includes('..'), 'Test file escaped the production roots');
  assert.match(rel, /^(?:tests|src)\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/); return rel;
};

export function packageArgs(id, app, output) {
  assert.ok(variants.includes(id), `Unknown fixed variant: ${id}`);
  assert.ok(path.isAbsolute(app) && path.isAbsolute(output), 'Private absolute paths required');
  const [target, speed] = id.split('-');
  return ['--linux', target, '--x64', '--prepackaged', app, `-c.directories.output=${output}`, ...(speed === 'fast' ? [`-c.${target}.compression=${faster[target]}`] : []), '--publish', 'never'];
}

export async function stage(name, command, args, options = {}) {
  assert.match(name, /^[a-zA-Z0-9_-]+$/);
  const dir = options.evidence || evidence;
  fs.mkdirSync(dir, { recursive: true });
  const usage = path.join(dir, `${name}.usage`);
  const start = process.hrtime.bigint(); const startedAt = new Date().toISOString();
  const output = options.stdout ? fs.openSync(options.stdout, 'w') : null;
  // WHY GNU time: Node's resourceUsage measures the parent, not builder/FPM children.
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.env.BENCH_TIME_COMMAND || '/usr/bin/time', ['-f', '%U\t%S\t%M\t%I\t%O', '-o', usage, command, ...args], {
      cwd: options.cwd || desktop, env: { ...process.env, ...options.env }, stdio: ['ignore', output ?? 'inherit', 'inherit'],
    });
    child.once('error', reject); child.once('exit', (code, signal) => resolve(signal ? 128 : code));
  }).finally(() => { if (output !== null) fs.closeSync(output); });
  const [userSeconds, systemSeconds, maxRssKiB, filesystemInputs, filesystemOutputs] = fs.readFileSync(usage, 'utf8').trim().split('\n').at(-1).split('\t').map(Number);
  assert.ok([userSeconds, systemSeconds, maxRssKiB].every(Number.isFinite), 'Missing process statistics');
  const metric = { stage: name, startedAt, completedAt: new Date().toISOString(), wallSeconds: Number(process.hrtime.bigint() - start) / 1e9, userSeconds, systemSeconds, maxRssKiB, filesystemInputs, filesystemOutputs, exitCode };
  json(path.join(dir, `${name}.json`), metric);
  assert.equal(exitCode, 0, `${name} failed (${exitCode}); evidence retained`);
  return metric;
}

export function fingerprint(cwd = root) {
  // WHY: individual lists missed Vite/PostCSS, linux hooks and resources. Freeze
  // the complete tracked Desktop tree as well as readable component identities.
  const paths = ['desktop', 'LICENSE', 'TERMS.md', 'desktop/src', 'desktop/tests', 'desktop/hook-scripts', 'desktop/scripts', 'desktop/assets', 'desktop/package.json', 'desktop/package-lock.json', 'desktop/electron-builder.yml', 'desktop/office-pin.json', 'desktop/vitest.config.ts', 'desktop/tsconfig.json', 'desktop/tsconfig.tests.json', '.github/workflows/desktop-ci.yml', '.github/workflows/desktop-release.yml', '.github/workflows/desktop-test-build.yml'];
  const inputs = {};
  for (const p of paths) {
    git(cwd, 'diff', '--exit-code', baseline, '--', p);
    assert.equal(git(cwd, 'ls-files', '--others', '--exclude-standard', '--', p), '', `Untracked production input: ${p}`);
    inputs[p] = git(cwd, 'rev-parse', `${baseline}:${p}`);
  }
  return { baseline, gitSha: git(cwd, 'rev-parse', 'HEAD'), inputs, digest: hash(JSON.stringify(inputs)) };
}

export function normalizeRpmRequirements(kind, text, compressor) {
  assert.ok(['xz','gzip'].includes(compressor), 'Unexpected RPM payload compressor');
  const expected = kind === 'requires' ? 'rpmlib(PayloadIsXz) <= 5.2-1'
    : kind === 'flags-REQUIRE' ? 'rpmlib(PayloadIsXz)\t16777226\t5.2-1' : null;
  assert.ok(expected, 'Only the two exact RPM requirement views may be accounted for');
  const lines = text.split('\n');
  const capability = lines.filter(line => line.includes('rpmlib(PayloadIsXz)'));
  // WHY: actual RPM default/fast output differs by this ONE generated container
  // capability. Do not hide application dependencies, versions or script flags.
  compare(compressor === 'xz' ? [expected] : [], capability);
  return lines.filter(line => line !== expected).join('\n');
}

export function normalizeMetadata(kind, text) {
  if (kind === 'pkginfo') return text.replace(/^builddate = \d+$/gm, 'builddate = <build timestamp>');
  // rpm --dump: path size mtime digest mode owner group flags rdev symlink.
  // Generated apparmor/package-type mtimes vary across private FPM runs.
  if (kind === 'rpm-dump') return text.replace(/^(\S+ \d+ )\d+( )/gm, '$1<build timestamp>$2');
  // WHY: .MTREE includes FPM-generated metadata mtimes. Only .PKGINFO's own
  // size/digests depend on builddate; its normalized contents are checked separately.
  if (kind === 'mtree') return text.split('\n').map(line => {
    line = line.replace(/\btime=\d+(?:\.\d+)?/g, 'time=<build timestamp>');
    if (/^\.\/\.PKGINFO\s/.test(line)) line = line.replace(/\s(?:size|md5digest|sha256digest)=\S+/g, '');
    return line;
  }).join('\n');
  return text;
}

export function manifest(dir, { packageMetadata = false } = {}) {
  const entries = [];
  function walk(rel) {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const p = path.posix.join(rel, name), full = path.join(dir, p), st = fs.lstatSync(full);
      const e = { path: p, mode: st.mode & 0o7777, type: st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'file' };
      if (st.isSymbolicLink()) e.link = fs.readlinkSync(full);
      else if (st.isDirectory()) { entries.push(e); walk(p); continue; }
      else {
        assert.ok(st.isFile(), `Unsupported filesystem entry: ${p}`);
        if (packageMetadata && (p === '.PKGINFO' || p === '.MTREE')) {
          const bytes = fs.readFileSync(full);
          const normalized = Buffer.from(normalizeMetadata(p === '.PKGINFO' ? 'pkginfo' : 'mtree',p === '.PKGINFO' ? bytes.toString() : gunzipSync(bytes).toString()));
          e.size = normalized.length; e.sha256 = hash(normalized);
        } else { e.size = st.size; e.sha256 = hashFile(full); }
      }
      entries.push(e);
    }
  }
  walk(''); return entries.sort((a,b) => a.path.localeCompare(b.path));
}
export function compare(a, b) { assert.deepEqual(b, a, 'Payload or metadata mismatch (experiment failure)'); }

export function aggregateShards(expected, shards, digest, runnableCases = null) {
  assert.equal(shards.length, 4, 'Missing shard reports');
  const ids = new Set(), files = [], cases = [], counts = { passed: 0, skipped: 0, todo: 0, failed: 0 };
  for (const s of shards) {
    assert.ok([1,2,3,4].includes(s.shard) && !ids.has(s.shard), 'Duplicate/invalid shard'); ids.add(s.shard);
    assert.equal(s.fingerprint, digest, 'Mismatched source');
    const r = s.report;
    assert.equal(r.success, true, 'Failed shard'); assert.equal(r.numFailedTests, 0); assert.equal(r.numFailedTestSuites, 0);
    assert.ok(r.testResults.length, 'Empty/missing report');
    for (const f of r.testResults) {
      assert.ok(['passed','pending'].includes(f.status), 'Failed test file');
      const file = relativeTest(f.name); files.push(file);
      assert.ok(f.assertionResults.length, 'No cases in file');
      for (const c of f.assertionResults) {
        assert.ok(['passed','pending','todo','skipped'].includes(c.status), 'Failed/unknown case status');
        counts[c.status === 'passed' ? 'passed' : c.status === 'todo' ? 'todo' : 'skipped']++;
        // Vitest list uses ' > ' between suites; its JSON reporter fullName uses
        // spaces. Reconstruct from structured ancestors so literal ' > ' in a
        // test title is not accidentally rewritten or used to hide an omission.
        const name = Array.isArray(c.ancestorTitles) ? [...c.ancestorTitles,c.title].join(' > ') : c.fullName;
        cases.push({ file, name, status: c.status });
      }
    }
  }
  assert.equal(new Set(files).size, files.length, 'Duplicate test files');
  compare([...expected].sort(), files.sort());
  // WHY list --json discovers runnable cases, not just files. A new runtime skip
  // cannot silently turn a previously discovered case into a faster green run.
  if (runnableCases) {
    const actual = cases.filter(c => c.status === 'passed').map(c => `${c.file}\0${c.name}`).sort();
    const discovered = runnableCases.map(c => `${relativeTest(c.file)}\0${c.name}`).sort();
    compare(discovered, actual);
  }
  return { files: files.length, ...counts, cases };
}

export function aggregatePackages(records, digest) {
  compare([...variants].sort(),records.map(r => r.info.id).sort());
  for (const r of records) {
    assert.equal(r.info.fingerprint,digest,'Mismatched package source');
    assert.ok(Number.isInteger(r.info.bytes) && r.info.bytes > 0,'Missing/empty installer');
    assert.equal(r.metric.exitCode,0,'Failed package job');
    assert.ok(r.payload,'Missing extracted payload report');
    if (r.info.id.startsWith('rpm-')) {
      assert.equal(r.capability?.compressor, r.info.id.endsWith('fast') ? 'gzip' : 'xz');
      for (const kind of ['requires','flags-REQUIRE']) {
        const normalized = normalizeRpmRequirements(kind,r.capability.original[kind],r.capability.compressor);
        const saved = r.payload.metadata.find(entry => entry.path === kind);
        assert.equal(saved?.sha256,hash(Buffer.from(normalized)), 'RPM capability receipt does not match compared metadata');
      }
    }
    if (!r.info.id.startsWith('AppImage-')) {
      assert.ok(Array.isArray(r.payload.payload) && r.payload.payload.length,'Empty payload manifest');
      assert.ok(Array.isArray(r.payload.metadata),'Missing metadata manifest');
    }
  }
  for (const target of ['deb','rpm','pacman']) {
    const get = speed => records.find(r => r.info.id === `${target}-${speed}`).payload;
    compare(get('default'),get('fast'));
  }
  return records.map(r => r.info);
}

export function validateWorkflow(w) {
  compare(['pull_request'], Object.keys(w.on)); compare({ contents: 'read' }, w.permissions);
  const guard = "github.event_name == 'pull_request' && github.head_ref == 'session/29-linux-build-bench' && github.base_ref != 'session/29-linux-build-bench' && github.head_ref != 'master'";
  for (const [name,j] of Object.entries(w.jobs)) {
    assert.equal(j.if, name === 'gate' ? `always() && ${guard}` : guard, 'Exact named PR condition required; no disabled gate');
    assert.equal(j['runs-on'], 'ubuntu-latest'); assert.ok(!j.permissions && !j.environment);
    assert.ok(!String(j.name || '').startsWith('build'));
  }
  compare(['prep','inventory','packages','shards'], w.jobs.gate.needs);
  assert.equal(w.jobs.inventory.needs, undefined, 'Inventory must run independently of preparation');
  compare(variants, w.jobs.packages.strategy.matrix.variant);
  compare([1,2,3,4], w.jobs.shards.strategy.matrix.shard);
  for (const j of ['packages','shards']) assert.equal(w.jobs[j].strategy['fail-fast'], false);
  const text = JSON.stringify(w);
  assert.ok(!/secrets\.|id-token|workflow_dispatch|pull_request_target|gh release|--publish always/.test(text));
  assert.ok(text.includes('prepared.tar') && text.includes('compression-level') && text.includes('upload-start') && text.includes('download-start'));
  assert.ok(text.includes('linux-build-bench.mjs prepare') && text.includes('linux-build-bench.mjs package') && text.includes('linux-build-bench.mjs shard'));
  assert.ok(w.jobs.gate.if.includes('always()'));
}

function hardware() {
  const tools = {};
  for (const [cmd,args] of [['node',['--version']],['npm',['--version']],['tar',['--version']],['bsdtar',['--version']],['rpm',['--version']],['dpkg-deb',['--version']]]) {
    try { tools[cmd] = execFileSync(cmd,args,{ encoding:'utf8' }).trim(); } catch { tools[cmd] = 'not installed in this job'; }
  }
  const installed = {};
  for (const name of ['electron','electron-builder','app-builder-lib','vitest','typescript','@typescript/native-preview']) {
    try { installed[name] = read(path.join(desktop,'node_modules',name,'package.json')).version; } catch { installed[name] = 'not installed in this job'; }
  }
  return { cpu: os.cpus(), availableParallelism: os.availableParallelism(), totalMemory: os.totalmem(), platform: os.platform(), arch: os.arch(), release: os.release(), runnerImage: process.env.ImageOS, runnerImageVersion: process.env.ImageVersion, tools, installed };
}
const benchStage = (name, command, args, options) => stage(name, command, args, options);
const vitest = path.join(desktop,'node_modules/vitest/vitest.mjs');

async function prepare() {
  const f = fingerprint(); json(path.join(evidence,'fingerprint.json'),f);
  json(path.join(evidence,'hardware.json'), hardware());
  // npm script forwarding appends ONLY to its final electron-builder invocation.
  await benchStage('prepare', 'npm', ['run','build','--','--linux','--x64','--dir','--publish','never']);
  compare(f.digest,fingerprint().digest);
  const app = path.join(desktop,'release/linux-unpacked');
  const preparedManifest = manifest(app); assert.ok(preparedManifest.length > 0);
  json(path.join(evidence,'prepared-manifest.json'),preparedManifest);
  await benchStage('archive','tar',['-cf',path.join(evidence,'prepared.tar'),'-C',path.dirname(app),path.basename(app)]);
  json(path.join(evidence,'archive-info.json'), { bytes:fs.statSync(path.join(evidence,'prepared.tar')).size, sha256:hashFile(path.join(evidence,'prepared.tar')), transport:'uncompressed tar; upload-artifact compression-level 0; no mode/link loss' });
}

async function discover() {
  json(path.join(evidence,'fingerprint.json'), fingerprint());
  json(path.join(evidence,'hardware.json'), hardware());
  await benchStage('discover-files',process.execPath,[vitest,'list','--filesOnly',`--json=${path.join(evidence,'expected-files-raw.json')}`]);
  const files = read(path.join(evidence,'expected-files-raw.json')).map(x => relativeTest(x.file));
  assert.ok(files.length && new Set(files).size === files.length, 'Empty/duplicate discovery');
  json(path.join(evidence,'expected-files.json'),files);
  await benchStage('discover-cases',process.execPath,[vitest,'list',`--json=${path.join(evidence,'expected-cases.json')}`]);
  assert.ok(read(path.join(evidence,'expected-cases.json')).length, 'Missing runnable discovery');
}

async function packageVariant(id) {
  assert.ok(variants.includes(id), 'Invalid variant');
  const f = fingerprint(); compare(read(path.join(root,'prepared/fingerprint.json')).digest, f.digest);
  json(path.join(evidence,'fingerprint.json'),f); json(path.join(evidence,'hardware.json'),hardware());
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(),`linux-bench-${id}-`));
  const tmp = path.join(privateRoot,'tmp'); fs.mkdirSync(tmp);
  const archive = path.join(root,'prepared/prepared.tar');
  const info = read(path.join(root,'prepared/archive-info.json'));
  assert.equal(hashFile(archive),info.sha256,'Transport digest mismatch');
  // WHY extract afresh per runner, never cp -al: FPM writes target-specific app metadata.
  await benchStage('restore','tar',['-xpf',archive,'-C',privateRoot]);
  const app = path.join(privateRoot,'linux-unpacked');
  compare(read(path.join(root,'prepared/prepared-manifest.json')),manifest(app));
  const out = path.join(privateRoot,'out');
  // WHY: FPM's generated Debian changelog embeds Time.now (and a gzip mtime).
  // Its documented SOURCE_DATE_EPOCH hint freezes those timestamps for BOTH
  // controls/fast variants, without stripping/changing any source/legal text.
  const sourceDateEpoch = git(root,'show','-s','--format=%ct',baseline);
  json(path.join(evidence,'reproducibility.json'), { SOURCE_DATE_EPOCH: sourceDateEpoch });
  await benchStage('package',process.execPath,[path.join(desktop,'node_modules/electron-builder/cli.js'),...packageArgs(id, app, out)],{ env:{ TMPDIR:tmp, TMP:tmp, TEMP:tmp, SOURCE_DATE_EPOCH:sourceDateEpoch, CSC_IDENTITY_AUTO_DISCOVERY:'false' } });
  const target = id.split('-')[0];
  const suffix = { AppImage:/\.AppImage$/, deb:/\.deb$/, rpm:/\.rpm$/, pacman:/\.pacman$/ }[target];
  const packages = fs.readdirSync(out).filter(n => suffix.test(n)); assert.equal(packages.length,1,'Expected exactly one installer');
  const installer = path.join(out,packages[0]);
  json(path.join(evidence,'package-info.json'),{ id, fingerprint:f.digest, bytes:fs.statSync(installer).size, sha256:hashFile(installer), filename:packages[0], compression:id.endsWith('fast') ? faster[target] : target === 'rpm' ? 'xzmt' : target === 'AppImage' ? 'unchanged configuration' : 'xz' });
  if (target === 'AppImage') {
    json(path.join(evidence,'payload.json'),{ limit:'AppImage unchanged-compression control; prepared manifest verified before builder. No extraction/install/runtime equivalence claim.' });
    return;
  }
  // Read the exact builder-selected tool AFTER packaging initialized it. This
  // introspection changes no builder behavior and its overhead is timed separately.
  const require = createRequire(path.join(desktop,'package.json'));
  const fpm = await require('app-builder-lib/out/toolsets/linux.js').getFpmPath();
  await benchStage('fpm-version',fpm,['--version'],{stdout:path.join(evidence,'fpm-version.txt')});
  json(path.join(evidence,'fpm-tool.json'),{path:fpm,sha256:hashFile(fpm),version:fs.readFileSync(path.join(evidence,'fpm-version.txt'),'utf8').trim()});
  const payload = path.join(privateRoot,'payload'); fs.mkdirSync(payload);
  const metadata = path.join(privateRoot,'metadata'); fs.mkdirSync(metadata);
  if (target === 'deb') {
    await benchStage('extract','dpkg-deb',['-x',installer,payload]);
    await benchStage('control','dpkg-deb',['-e',installer,metadata]);
  } else {
    await benchStage('extract','bsdtar',['-xpf',installer,'-C',payload]);
    if (target === 'rpm') {
      // Compare all dependency classes, identity/legal fields, scripts and triggers.
      // Compression headers/signature hashes and build host/time are container data,
      // not dependency/control/script semantics. Keep the complete XML as raw evidence.
      await benchStage('rpm-raw','rpm',['-qp','--xml',installer],{stdout:path.join(evidence,'rpm-raw.xml')});
      for (const query of ['requires','provides','conflicts','obsoletes','recommends','suggests','supplements','enhances','scripts','triggers','dump']) {
        await benchStage(`rpm-${query}`,'rpm',['-qp',`--${query}`,installer],{stdout:path.join(metadata,query)});
      }
      // Human --requires output omits prerequisite/script-context flag bits.
      // Preserve the raw dependency arrays as well, including every sense flag.
      for (const dependency of ['REQUIRE','PROVIDE','CONFLICT','OBSOLETE','RECOMMEND','SUGGEST','SUPPLEMENT','ENHANCE']) {
        await benchStage(`rpm-flags-${dependency}`,'rpm',['-qp','--queryformat',`[%{${dependency}NAME}\\t%{${dependency}FLAGS}\\t%{${dependency}VERSION}\\n]`,installer],{stdout:path.join(metadata,`flags-${dependency}`)});
      }
      const tags = ['NAME','EPOCH','VERSION','RELEASE','ARCH','OS','SUMMARY','DESCRIPTION','LICENSE','URL','VENDOR','PACKAGER','GROUP'];
      await benchStage('rpm-identity','rpm',['-qp','--queryformat', tags.map(t => `${t}=%{${t}}\n`).join(''),installer],{stdout:path.join(metadata,'identity')});
      const compressorFile = path.join(evidence,'rpm-compressor.txt');
      await benchStage('rpm-compressor','rpm',['-qp','--queryformat','%{PAYLOADCOMPRESSOR}',installer],{stdout:compressorFile});
      const compressor = fs.readFileSync(compressorFile,'utf8').trim();
      assert.equal(compressor, id.endsWith('fast') ? 'gzip' : 'xz', 'RPM compressor does not match selected trial');
      const capabilityReceipt = { compressor, exception:'Only rpmlib(PayloadIsXz) <= 5.2-1, flags16777226, generated by xz payload', original:{} };
      for (const kind of ['requires','flags-REQUIRE']) {
        const original = fs.readFileSync(path.join(metadata,kind),'utf8');
        capabilityReceipt.original[kind] = original;
        fs.writeFileSync(path.join(metadata,kind),normalizeRpmRequirements(kind,original,compressor));
      }
      json(path.join(evidence,'rpm-compression-capability.json'),capabilityReceipt);
      const dump = fs.readFileSync(path.join(metadata,'dump'),'utf8');
      fs.writeFileSync(path.join(evidence,'rpm-dump-raw.txt'),dump);
      fs.writeFileSync(path.join(metadata,'dump'),normalizeMetadata('rpm-dump',dump));
    }
  }
  const payloadManifest = manifest(payload,{ packageMetadata:target === 'pacman' });
  const metadataManifest = manifest(metadata);
  if (target === 'pacman') {
    for (const p of ['.PKGINFO','.MTREE','.INSTALL']) assert.ok(payloadManifest.some(e => e.path === p && e.type === 'file'),`Missing pacman metadata: ${p}`);
  } else {
    const required = target === 'deb' ? ['control','postinst','postrm'] : ['identity','requires','scripts','triggers','dump'];
    for (const p of required) assert.ok(metadataManifest.some(e => e.path === p && e.type === 'file'),`Missing ${target} metadata: ${p}`);
  }
  json(path.join(evidence,'payload.json'),{ payload:payloadManifest, metadata:metadataManifest });
}

async function shardRun(raw) {
  assert.match(raw || '', /^[1-4]$/); const shard = Number(raw);
  const f = fingerprint(); json(path.join(evidence,'fingerprint.json'),f); json(path.join(evidence,'hardware.json'),hardware());
  await runVitestShard(shard, f.digest);
}

export async function runVitestShard(shard, digest, { directory = evidence, runner = vitest } = {}) {
  assert.ok([1, 2, 3, 4].includes(shard), 'Invalid shard');
  const reportPath = path.join(directory,'vitest.json');
  try {
    // WHY: stage writes <name>.json after the child exits. Reusing "vitest"
    // overwrote the reporter's results with metrics before the finally copied them.
    await benchStage('vitest-metrics',process.execPath,[runner,'run',`--shard=${shard}/4`,'--reporter=default','--reporter=json',`--outputFile.json=${reportPath}`], { evidence: directory });
  } finally {
    if (fs.existsSync(reportPath)) json(path.join(directory,'shard.json'),{shard,fingerprint:digest,report:read(reportPath)});
  }
}

function aggregate() {
  const needs = JSON.parse(process.env.BENCH_NEEDS || '{}');
  compare(['inventory','packages','prep','shards'],Object.keys(needs).sort());
  for (const [name,value] of Object.entries(needs)) assert.equal(value.result,'success',`Failed/missing job: ${name}`);
  const all = path.join(root,'results'); const prep = path.join(all,'evidence-prep');
  const f = read(path.join(prep,'fingerprint.json')); compare(f.digest,fingerprint().digest);
  const shards = [1,2,3,4].map(n => read(path.join(all,`evidence-shard-${n}/shard.json`)));
  const inventory = path.join(all,'evidence-inventory');
  compare(read(path.join(inventory,'fingerprint.json')).digest, f.digest);
  const tests = aggregateShards(read(path.join(inventory,'expected-files.json')),shards,f.digest,read(path.join(inventory,'expected-cases.json')));
  const records = variants.map(id => {
    const dir = path.join(all,`evidence-${id}`); const info = read(path.join(dir,'package-info.json'));
    assert.equal(info.id,id);
    return {info,metric:read(path.join(dir,'package.json')),payload:read(path.join(dir,'payload.json')),
      ...(id.startsWith('rpm-') ? {capability:read(path.join(dir,'rpm-compression-capability.json'))} : {})};
  });
  const packages = aggregatePackages(records,f.digest);
  const timeline = read(path.join(evidence,'github-jobs.json'));
  assert.equal(timeline.jobs.length,timeline.total_count,'Incomplete GitHub timeline');
  const starts = timeline.jobs.map(j => Date.parse(j.started_at)).filter(Number.isFinite);
  assert.ok(starts.length);
  const timing = { observedPrefixSeconds:(Date.now()-Math.min(...starts))/1000, observedPrefixOnly:true, jobs:timeline.jobs.map(j => ({name:j.name,startedAt:j.started_at,completedAt:j.completed_at,conclusion:j.conclusion})), note:'Prefix includes setup, preparation, fan-out and transport so far. Gate completion/teardown and initial workflow queue require completed run API data from parent; this is NOT a final total or a winner-only result.' };
  const summary = { fingerprint:f, timing, tests, packages, observedExperimentTotal:'Parent must read completed GitHub run/job timestamps (includes queue, checkout, setup, artifact transfer and gate teardown). This in-progress gate cannot observe its own completion.', candidateCriticalPath:'NOT MEASURED: first batch includes slower controls. Never sum parallel stage spans or claim a five-minute winner.', limits:['Static installed payload/control/script comparison only, not package-manager installation or runtime proof.', 'AppImage unchanged compression control, not extracted.', 'rpm metadata comparison covers identity/legal fields, all dependency classes, scripts/triggers and strict --dump; raw full header XML retained, container metadata not declared identical.'] };
  json(path.join(evidence,'summary.json'),summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## EXPERIMENT ONLY — all 7 packages / 4 shards validated\n\n${tests.files} files, ${tests.passed} passed, ${tests.skipped} skipped, ${tests.todo} todo. Runnable cases match full Vitest discovery.\n\n| Variant | Installer bytes |\n|---|---:|\n${packages.map(p => `| ${p.id} | ${p.bytes} |`).join('\n')}\n\nNo five-minute result yet. Complete workflow/job timestamps and same-SHA ordinary Desktop CI are the control; no production workflow changed. See diagnostic evidence.\n`);
}

async function main() {
  const [command,...args] = process.argv.slice(2);
  if (command === 'stamp') {
    assert.equal(args.length,1); assert.match(args[0],/^[a-zA-Z0-9_-]+$/);
    fs.mkdirSync(evidence,{recursive:true}); fs.appendFileSync(path.join(evidence,'boundaries.jsonl'),JSON.stringify({name:args[0],timestamp:new Date().toISOString(),monotonicNs:process.hrtime.bigint().toString(),job:process.env.GITHUB_JOB,run:process.env.GITHUB_RUN_ID})+'\n');
  } else if (command === 'stage') {
    const [name,exe,...argv] = args; assert.ok(exe); await stage(name,exe,argv);
  } else if (command === 'fingerprint') { assert.equal(args.length,0); json(path.join(evidence,'fingerprint.json'),fingerprint()); json(path.join(evidence,'hardware.json'),hardware()); }
  else if (command === 'prepare') { assert.equal(args.length,0); await prepare(); }
  else if (command === 'discover') { assert.equal(args.length,0); await discover(); }
  else if (command === 'package') { assert.equal(args.length,1); await packageVariant(args[0]); }
  else if (command === 'shard') { assert.equal(args.length,1); await shardRun(args[0]); }
  else if (command === 'timeline') {
    assert.equal(args.length,0);
    assert.match(process.env.GITHUB_REPOSITORY || '', /^[\w.-]+\/[\w.-]+$/);
    assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/jobs?per_page=100`, {headers:{Accept:'application/vnd.github+json'}});
    assert.ok(response.ok, `Public job timeline API failed: ${response.status}`);
    const timeline = await response.json(); assert.ok(timeline.total_count > 0 && timeline.total_count <= 100);
    json(path.join(evidence,'github-jobs.json'),timeline);
  }
  else if (command === 'aggregate') { assert.equal(args.length,0); aggregate(); }
  else throw new Error('Use fingerprint | prepare | discover | package <fixed-variant> | shard <1-4> | aggregate | stamp <boundary> | stage <name> <executable> [args]');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  json(path.join(evidence,'failure.json'),{name:error.name,message:error.message,stack:error.stack});
  console.error(error); process.exitCode=1;
});
