#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, matrixFor } from './ci-policy.mjs';
import { encoderProfile, readEncoderInputs, validateEncoder } from './ci-linux.mjs';
import { identity, aggregate, validateReport, verifyCore, verifyInstalled, shardArgs } from './ci-evidence.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), desktop = path.join(root, 'desktop');
const vitest = path.join(desktop, 'node_modules/vitest/vitest.mjs');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function relative(name) {
  const key = path.relative(desktop, name).replaceAll('\\', '/');
  assert.ok(key && !key.startsWith('../') && !path.isAbsolute(key), 'Test path outside checkout'); return key;
}
async function main() {
  const [command, os, rawShard, rawTotal] = process.argv.slice(2);
  if (command === 'shard') {
    // WHY: direct Node CLI is portable on Windows (spawn npm.cmd is not).
    // Refuse to silently bypass changed npm test semantics or lifecycle hooks.
    const scripts = read(path.join(desktop, 'package.json')).scripts;
    assert.equal(scripts.test, 'vitest'); assert.equal(scripts.pretest, undefined); assert.equal(scripts.posttest, undefined);
    const shard = Number(rawShard), total = Number(rawTotal);
    assert.ok(matrixFor(process.env.GITHUB_EVENT_NAME).include.some(item => item.os === os && item.shard === shard && item.total === total));
    const directory = path.join(root, 'ci-results', `tests-${os}-${shard}`); fs.mkdirSync(directory, { recursive: true });
    const input = await identity(root, process.env.GITHUB_SHA);
    let discovery;
    if (shard === 1) {
      const file = path.join(directory, 'discovery.json');
      await run(process.execPath, [vitest, 'list', '--filesOnly', `--json=${file}`, '--allowOnly=false'], desktop, false);
      discovery = read(file).map(item => relative(item.file));
      assert.ok(discovery.length > 0 && new Set(discovery).size === discovery.length);
    }
    // WHY: this argv is intentionally fixed and unfiltered. No file selectors,
    // timeout overrides, tag exclusions or test-name filters may speed up CI.
    const file = path.join(directory, 'vitest.json');
    await run(process.execPath, [vitest, ...shardArgs(shard, total, file)], desktop, false);
    const report = read(file); for (const item of report.testResults) item.name = relative(item.name);
    validateReport(report); assert.deepEqual(await identity(root, process.env.GITHUB_SHA), input);
    json(path.join(directory, 'shard.json'), { identity: input, os, shard, total, discovery, report });
  } else if (command === 'aggregate') {
    const input = await identity(root, process.env.GITHUB_SHA), directory = path.join(root, 'ci-results');
    const matrix = matrixFor(process.env.GITHUB_EVENT_NAME).include;
    const selected = [...new Map(matrix.map(item => [item.os, { os: item.os, total: item.total }])).values()];
    const records = fs.readdirSync(directory).filter(name => name.startsWith('tests-')).map(name => read(path.join(directory, name, 'shard.json')));
    const tests = aggregate(records, selected, input);
    const prepared = read(path.join(directory, 'prepared-evidence', 'prepared.json')); assert.deepEqual(prepared.identity, input);
    assert.ok(['fast', 'default'].includes(process.env.CI_PACKAGE_MODE)); assert.equal(prepared.mode, process.env.CI_PACKAGE_MODE);
    // WHY: producer records must not choose their own proof requirements. Parse
    // current checked-out config using only the independently lock-verified capsule.
    const { config, pkg } = await readEncoderInputs(desktop, path.join(directory, 'prepared-evidence/yaml-parser.tgz'));
    const selectedFormats = ['AppImage', 'deb', 'rpm', 'pacman'];
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.startsWith('format-')).sort(), selectedFormats.map(format => `format-${format}`).sort(), 'Missing/unknown package artifact');
    const formats = selectedFormats.map(format => {
      const result = read(path.join(directory, `format-${format}`, 'package.json'));
      assert.equal(result.format, format); assert.deepEqual(result.identity, input); assert.deepEqual(result.prepared, prepared.manifest);
      assert.equal(result.mode, prepared.mode); verifyCore(prepared.manifest, result.post); verifyInstalled(result.post, result.installed);
      assert.equal(result.encoder.xzThreadsRequested, 0);
      const requested = encoderProfile(format, prepared.mode, config, pkg);
      assert.deepEqual(result.encoder.requested, requested, 'Encoder request disagrees with current profile');
      validateEncoder(format, requested, result.encoder.observed);
      assert.equal(result.validated, true); assert.ok(result.bytes > 0); return result;
    });
    assert.deepEqual(await identity(root, process.env.GITHUB_SHA), input);
    json(path.join(directory, 'summary.json'), { tests, formats: formats.map(({ format, mode, compression, encoder, bytes, sha256, elapsedSeconds, cpuUserSeconds, cpuSystemSeconds, builderWallSeconds }) => ({ format, mode, compression, encoder, bytes, sha256, elapsedSeconds, cpuUserSeconds, cpuSystemSeconds, builderWallSeconds })),
      limits: 'Static extraction and current payload/metadata checks; not package-manager installation or application execution. Whole workflow timing requires completed GitHub job timestamps.' });
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha=${input.sha}\npackageMode=${prepared.mode}\n`);
    console.log(`Current inputs verified: ${tests.files} OS/file identities, ${tests.cases} cases, four extracted Linux formats`);
  } else throw new Error('Use shard <os> <id> <total>|aggregate');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
