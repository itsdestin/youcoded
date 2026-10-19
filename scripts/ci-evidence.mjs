import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { run } from './ci-policy.mjs';

export function shardArgs(shard, total, output) {
  assert.ok(Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(shard) && shard >= 1 && shard <= total);
  assert.ok(path.isAbsolute(output));
  return ['run', `--shard=${shard}/${total}`, '--allowOnly=false', '--reporter=default', '--reporter=json', `--outputFile.json=${output}`];
}
export async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
export async function identity(root, expectedSha) {
  const git = async (...args) => (await run('git', args, root)).toString().trim();
  const sha = await git('rev-parse', 'HEAD'); assert.equal(sha, expectedSha);
  // WHY: Git tree binds every current tracked input, including new tests and
  // builder hooks; explicit lock/config digests make provenance easy to inspect.
  assert.equal(await git('diff', '--name-only', 'HEAD', '--'), '', 'Tracked inputs modified');
  return { sha, tree: await git('rev-parse', 'HEAD^{tree}'), lock: await hash(path.join(root, 'desktop/package-lock.json')),
    config: await hash(path.join(root, 'desktop/vitest.config.ts')), builder: await hash(path.join(root, 'desktop/electron-builder.yml')) };
}
export function validateReport(report) {
  assert.equal(report.success, true); assert.ok(Array.isArray(report.testResults) && report.testResults.length > 0);
  for (const key of ['numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites', 'numTotalTests', 'numPassedTests', 'numPendingTests', 'numTodoTests', 'numFailedTests']) assert.ok(Number.isSafeInteger(report[key]) && report[key] >= 0, `Invalid total ${key}`);
  assert.equal(report.numFailedTestSuites, 0);
  assert.equal(report.numTotalTestSuites, report.numPassedTestSuites + report.numPendingTestSuites);
  assert.ok(report.numTotalTestSuites >= report.testResults.length);
  assert.notEqual(report.snapshot?.failure, true);
  const counts = { passed: 0, pending: 0, todo: 0, failed: 0 };
  const files = new Set();
  for (const file of report.testResults) {
    assert.ok(typeof file.name === 'string' && file.name.length > 0 && !files.has(file.name), 'Duplicate/missing report file'); files.add(file.name);
    assert.ok(['passed', 'skipped', 'pending'].includes(file.status), `Bad file status: ${file.status}`);
    assert.ok(Array.isArray(file.assertionResults) && file.assertionResults.length > 0, 'Empty test file');
    for (const item of file.assertionResults) {
      // WHY: Vitest permits equal titles in parameterized rows. Count every
      // assertion record; deduplicating titles would silently drop authored cases.
      assert.ok(typeof item.fullName === 'string' && item.fullName.length > 0, 'Missing case identity');
      if (item.failureMessages !== undefined) { assert.ok(Array.isArray(item.failureMessages)); assert.equal(item.failureMessages.length, 0, 'Successful assertion carries failure evidence'); }
      const status = item.status === 'skipped' ? 'pending' : item.status;
      assert.ok(['passed', 'pending', 'todo'].includes(status), `Bad assertion status: ${item.status}`);
      if (file.status !== 'passed') assert.notEqual(status, 'passed', 'Skipped file reports a pass');
      counts[status]++;
    }
  }
  assert.equal(report.numTotalTests, counts.passed + counts.pending + counts.todo);
  assert.equal(report.numPassedTests, counts.passed); assert.equal(report.numPendingTests, counts.pending);
  assert.equal(report.numTodoTests, counts.todo); assert.equal(report.numFailedTests, 0);
  return { files: [...files], cases: report.numTotalTests, counts };
}
export function aggregate(records, selected, expectedIdentity) {
  let files = 0, cases = 0;
  assert.equal(records.length, selected.reduce((sum, os) => sum + os.total, 0));
  for (const { os, total } of selected) {
    const group = records.filter(record => record.os === os); assert.equal(group.length, total);
    const seen = new Set(); let discovery;
    for (let shard = 1; shard <= total; shard++) {
      const matching = group.filter(record => record.shard === shard); assert.equal(matching.length, 1, 'Missing/duplicate shard');
      const record = matching[0]; assert.deepEqual(record.identity, expectedIdentity, 'Input identity mismatch'); assert.equal(record.total, total);
      if (shard === 1) { discovery = record.discovery; assert.ok(Array.isArray(discovery) && discovery.length > 0); assert.equal(new Set(discovery).size, discovery.length); }
      const result = validateReport(record.report); cases += result.cases;
      for (const name of result.files) { assert.ok(!seen.has(name), `Duplicate shard file ${name}`); seen.add(name); }
    }
    assert.deepEqual([...seen].sort(), [...discovery].sort(), 'Shard union differs from fresh discovery'); files += seen.size;
  }
  return { identity: expectedIdentity, files, cases, selected };
}
export async function manifest(root) {
  const entries = [];
  async function walk(relative) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const key = relative ? `${relative}/${name}` : name, full = path.join(root, key), info = fs.lstatSync(full);
      const entry = { path: key, mode: info.mode & 0o7777 };
      if (info.isSymbolicLink()) entries.push({ ...entry, type: 'link', target: fs.readlinkSync(full) });
      else if (info.isDirectory()) { entries.push({ ...entry, type: 'directory' }); await walk(key); }
      else { assert.ok(info.isFile(), `Unsupported payload entry ${key}`); entries.push({ ...entry, type: 'file', sha256: await hash(full), bytes: info.size }); }
    }
  }
  await walk(''); assert.ok(entries.length > 0); return entries;
}
export function verifyCore(prepared, post) {
  const core = new Map(prepared.map(entry => [entry.path, entry]));
  assert.equal(core.size, prepared.length); assert.ok(core.size > 0);
  const actual = new Map(post.map(entry => [entry.path, entry])); assert.equal(actual.size, post.length);
  for (const [name, entry] of core) assert.deepEqual(actual.get(name), entry, `Prepared core mutated: ${name}`);
  for (const entry of post) if (!core.has(entry.path)) {
    // WHY: this is builder-generated metadata, not an exclusion of application
    // content. Its actual bytes/mode must still match the installed copy exactly.
    assert.equal(entry.path, 'resources/apparmor-profile', 'Unexpected builder app-root addition'); assert.equal(entry.type, 'file');
  }
}
export function verifyInstalled(post, installed) { assert.deepEqual(installed, post, 'Installed app differs from current post-builder app'); }
async function decompressed(file) {
  const digest = createHash('sha256'); let bytes = 0;
  const child = spawn('zstd', ['-d', '-c', '--', file], { stdio: ['ignore', 'pipe', 'inherit'] });
  const done = new Promise((accept, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? accept() : reject(new Error('zstd failed'))); });
  await Promise.all([done, (async () => { for await (const chunk of child.stdout) { bytes += chunk.length; digest.update(chunk); } })()]);
  return { rawBytes: bytes, rawSha256: digest.digest('hex') };
}
export async function transport(app, output) {
  fs.mkdirSync(output, { recursive: true });
  const raw = path.join(output, 'prepared.tar'), compressed = path.join(output, 'prepared.tar.zst');
  await run('tar', ['-cpf', raw, '-C', app, '.']);
  const proof = { rawBytes: fs.statSync(raw).size, rawSha256: await hash(raw) };
  await run('zstd', ['-1', '-T0', '--keep', '-o', compressed, '--', raw]);
  assert.deepEqual(await decompressed(compressed), proof);
  fs.rmSync(raw); return { ...proof, compressedBytes: fs.statSync(compressed).size, compressedSha256: await hash(compressed) };
}
export async function unpack(input, destination, proof) {
  const compressed = path.join(input, 'prepared.tar.zst');
  assert.equal(await hash(compressed), proof.compressedSha256); assert.equal(fs.statSync(compressed).size, proof.compressedBytes);
  const { rawBytes, rawSha256 } = proof; assert.deepEqual(await decompressed(compressed), { rawBytes, rawSha256 });
  fs.mkdirSync(destination, { recursive: false });
  await run('tar', ['--zstd', '-xpf', compressed, '-C', destination]);
}
