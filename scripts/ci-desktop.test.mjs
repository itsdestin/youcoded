import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { appImagePayload, expectedMetadata, packageArgs, encoderProfile, writeEncoderConfig } from './ci-linux.mjs';
import { run } from './ci-policy.mjs';
import * as linux from './ci-linux.mjs';
import { aggregate, identity, manifest, shardArgs } from './ci-evidence.mjs';
const vitest = fileURLToPath(new URL('../desktop/node_modules/vitest/vitest.mjs', import.meta.url));
const mergeConfigs = [
  ['inline target merge', 'linux: {}\ndeb: { <<: { fpm: ["--custom-sentinel=keep"] } }\nrpm: { <<: { fpm: ["--custom-sentinel=keep"] } }\n'],
  ['inline linux merge', 'linux: { <<: { fpm: ["--custom-sentinel=keep"] } }\n'],
  ['anchored target merge', 'linux: {}\ndeb: &target\n  <<: &flags { fpm: ["--custom-sentinel=keep"] }\nrpm:\n  <<: *target\n'],
  ['anchored linux merge', 'deb: &flags { fpm: ["--custom-sentinel=keep"] }\nlinux:\n  <<: *flags\nrpm:\n  <<: *flags\n'],
];
test('capsule producer bypasses unsupported npm command shims on PATH', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ci-npm-capsule-'));
  try {
    const bin = path.join(root, 'shim tools'), evidence = path.join(root, 'evidence'), marker = path.join(root, 'shim-executed');
    fs.mkdirSync(bin); fs.mkdirSync(evidence);
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf called > "$CI_NPM_SHIM_MARKER"\nexit 86\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npm.cmd'), '@echo called>"%CI_NPM_SHIM_MARKER%"\r\n@exit /b 86\r\n');
    const env = { ...process.env, CI_NPM_SHIM_MARKER: marker };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    const source = `import {packParserCapsule} from ${JSON.stringify(new URL('./ci-linux.mjs', import.meta.url).href)}; await packParserCapsule(${JSON.stringify(fileURLToPath(new URL('../desktop/', import.meta.url)))},${JSON.stringify(evidence)},${JSON.stringify(root)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.statSync(path.join(evidence, 'yaml-parser.tgz')).size > 0);
    assert.ok(!fs.existsSync(marker), 'The command shim must never execute');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
test('producer and private capsule agree with actual installed builder YAML merge semantics', async t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ci-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const require = createRequire(new URL('../desktop/package.json', import.meta.url));
  const builderLoad = require('app-builder-lib/out/util/config/load.js');
  const desktop = fileURLToPath(new URL('../desktop/', import.meta.url));
  const capsule = await linux.packParserCapsule(desktop, root, root);
  fs.copyFileSync(path.join(desktop, 'package-lock.json'), path.join(root, 'package-lock.json'));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  for (const [label, source] of mergeConfigs) await t.test(label, async () => {
    const file = path.join(root, 'electron-builder.yml'); fs.writeFileSync(file, source);
    const before = fs.readFileSync(file), pkgBefore = fs.readFileSync(path.join(root, 'package.json'));
    const builder = (await builderLoad.getConfig({ projectDir: root }, file)).result;
    const producer = (await expectedMetadata(file)).config;
    const consumer = (await linux.readEncoderInputs(root, capsule, root)).config;
    assert.deepEqual(producer, builder, 'Producer must use actual builder merge semantics');
    assert.deepEqual(consumer, builder, 'Consumer must use actual builder merge semantics');
    for (const config of [producer, consumer]) for (const format of ['deb', 'rpm']) {
      assert.deepEqual(config[format]?.fpm ?? config.linux.fpm, ['--custom-sentinel=keep']);
      const requested = encoderProfile(format, 'fast', config, {}); assert.equal(requested, null);
      assert.equal(writeEncoderConfig(format, requested, file, root), undefined);
      assert.ok(!fs.existsSync(path.join(root, `encoder-${format}.json`)));
    }
    assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(fs.readFileSync(path.join(root, 'package.json')), pkgBefore);
  });
});

test('actual aggregate CLI derives encoder proof from current config with no node_modules', async t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ci-consumer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const put = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  for (const name of ['ci-desktop.mjs', 'ci-linux.mjs', 'ci-policy.mjs', 'ci-evidence.mjs']) {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true }); fs.copyFileSync(new URL(name, import.meta.url), path.join(root, 'scripts', name));
  }
  const lock = JSON.parse(fs.readFileSync(new URL('../desktop/package-lock.json', import.meta.url), 'utf8'));
  put('desktop/package-lock.json', lock); put('desktop/vitest.config.ts', '// current fixture');
  put('.gitignore', 'ci-results/\nprivate/\noutput\n');
  fs.mkdirSync(path.join(root, 'private'));
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q');
  // WHY: only disposable fixture inputs are committed. The real staged branch
  // stays untouched, while the actual CLI performs its normal input identity check.
  const capsuleDir = path.join(root, 'ci-results/prepared-evidence'); fs.mkdirSync(capsuleDir, { recursive: true });
  // WHY: exercise the real portable producer instead of duplicating npm shim
  // invocation logic inside the consumer fixture.
  await linux.packParserCapsule(fileURLToPath(new URL('../desktop/', import.meta.url)), capsuleDir, root);
  const formats = ['AppImage', 'deb', 'rpm', 'pacman'], core = [{ path: 'resources', type: 'directory', mode: 0o755 }];
  const setup = async (mode, config = 'linux:\n  category: Development\n', pkg = {}, optimized = true) => {
    put('desktop/electron-builder.yml', config); put('desktop/package.json', pkg);
    git('add', 'scripts', 'desktop', '.gitignore');
    git('-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
    const sha = git('rev-parse', 'HEAD'), input = await identity(root, sha);
    put('ci-results/prepared-evidence/prepared.json', { identity: input, mode, manifest: core });
    for (let shard = 1; shard <= 4; shard++) {
      const file = `tests/current-${shard}.test.ts`;
      put(`ci-results/tests-ubuntu-latest-${shard}/shard.json`, { identity: input, os: 'ubuntu-latest', shard, total: 4,
        discovery: shard === 1 ? [1, 2, 3, 4].map(id => `tests/current-${id}.test.ts`) : undefined,
        report: { success: true, numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0,
          numTotalTests: 1, numPassedTests: 1, numPendingTests: 0, numTodoTests: 0, numFailedTests: 0,
          testResults: [{ name: file, status: 'passed', assertionResults: [{ fullName: 'current case', status: 'passed' }] }] } });
    }
    for (const format of formats) {
      const eligible = optimized && mode === 'fast' && ['deb', 'rpm'].includes(format) && !config.includes('fpm') && !Object.hasOwn(pkg, 'build');
      put(`ci-results/format-${format}/package.json`, { identity: input, mode, format, prepared: core, post: core, installed: core, validated: true, bytes: 1,
        encoder: { requested: eligible ? { compressor: 'gzip', level: 1 } : null,
          observed: eligible ? format === 'deb' ? { compressor: 'gzip', xfl: 4 } : { compressor: 'gzip', flags: '1' } : null, xzThreadsRequested: 0 } });
    }
    return () => {
      fs.rmSync(path.join(root, 'ci-results/summary.json'), { force: true });
      return spawnSync(process.execPath, [path.join(root, 'scripts/ci-desktop.mjs'), 'aggregate'], { cwd: root, encoding: 'utf8', env: { ...process.env,
        GITHUB_SHA: sha, GITHUB_EVENT_NAME: 'pull_request', CI_PACKAGE_MODE: mode, GITHUB_OUTPUT: path.join(root, 'output'), RUNNER_TEMP: path.join(root, 'private') } });
    };
  };
  for (const mode of ['default', 'fast']) {
    await t.test(`${mode} valid current proof`, async () => {
      const cli = await setup(mode), result = cli(); assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(fs.readFileSync(path.join(root, 'ci-results/summary.json'), 'utf8')); assert.equal(summary.formats.length, 4);
      assert.ok(!fs.existsSync(path.join(root, 'desktop/node_modules'))); assert.deepEqual(fs.readdirSync(path.join(root, 'private')), []);
    });
  }
  const mutations = {
    'missing requested': value => { delete value.encoder.requested; },
    'missing observed': value => { delete value.encoder.observed; },
    'null requested bypass': value => { value.encoder.requested = null; value.encoder.observed = null; },
    'false requested bypass': value => { value.encoder.requested = false; value.encoder.observed = null; },
    'wrong observed level': value => { if (value.format === 'deb') value.encoder.observed.xfl = 2; else value.encoder.observed.flags = '9'; },
    'wrong claimed mode': value => { value.mode = 'default'; },
  };
  for (const format of ['deb', 'rpm']) for (const [label, mutate] of Object.entries(mutations)) await t.test(`fast ${format} rejects ${label}`, async () => {
    const cli = await setup('fast'), file = path.join(root, `ci-results/format-${format}/package.json`);
    const value = JSON.parse(fs.readFileSync(file, 'utf8')); mutate(value); fs.writeFileSync(file, JSON.stringify(value));
    const result = cli(); assert.notEqual(result.status, 0, `${label} incorrectly accepted: ${result.stdout}`);
    assert.ok(!fs.existsSync(path.join(root, 'ci-results/summary.json'))); assert.deepEqual(fs.readdirSync(path.join(root, 'private')), []);
  });
  for (const [label, mode, config, pkg, optimized] of [
    ['default', 'default', 'linux: {}\n', {}], ['custom FPM', 'fast', 'linux:\n  fpm: [--sentinel=keep]\n', {}], ['package build', 'fast', 'linux: {}\n', { build: {} }],
    ['extends', 'fast', 'extends: ./parent.yml\n', {}, false],
    ['empty implicit preset spec', 'fast', 'linux: {}\n', { dependencies: { 'react-scripts': '' } }, false],
    ['false implicit preset spec', 'fast', 'linux: {}\n', { devDependencies: { 'electron-webpack': false } }, false],
  ]) {
    await t.test(`${label} accepts explicit null proof and rejects a fast request`, async () => {
      const cli = await setup(mode, config, pkg, optimized), valid = cli(); assert.equal(valid.status, 0, valid.stderr);
      const file = path.join(root, 'ci-results/format-deb/package.json'), value = JSON.parse(fs.readFileSync(file, 'utf8'));
      value.encoder.requested = { compressor: 'gzip', level: 1 }; value.encoder.observed = { compressor: 'gzip', xfl: 4 };
      fs.writeFileSync(file, JSON.stringify(value)); assert.notEqual(cli().status, 0, `${label} accepted unexpected fast profile`);
    });
  }
  for (const [label, config] of mergeConfigs) await t.test(`consumer ${label} accepts null and rejects level one for both native targets`, async () => {
    const cli = await setup('fast', config, {}, false), valid = cli(); assert.equal(valid.status, 0, valid.stderr);
    const before = fs.readFileSync(path.join(root, 'desktop/electron-builder.yml'));
    for (const format of ['deb', 'rpm']) {
      const file = path.join(root, `ci-results/format-${format}/package.json`), original = fs.readFileSync(file), value = JSON.parse(original);
      value.encoder.requested = { compressor: 'gzip', level: 1 };
      value.encoder.observed = format === 'deb' ? { compressor: 'gzip', xfl: 4 } : { compressor: 'gzip', flags: '1' };
      fs.writeFileSync(file, JSON.stringify(value)); assert.notEqual(cli().status, 0, `${label} ${format} accepted level one`);
      fs.writeFileSync(file, original);
    }
    assert.deepEqual(fs.readFileSync(path.join(root, 'desktop/electron-builder.yml')), before);
    assert.deepEqual(fs.readdirSync(path.join(root, 'private')), []);
  });
  for (const field of ['requested', 'observed']) await t.test(`default rejects missing ${field}`, async () => {
    const cli = await setup('default'), file = path.join(root, 'ci-results/format-deb/package.json'), value = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete value.encoder[field]; fs.writeFileSync(file, JSON.stringify(value)); assert.notEqual(cli().status, 0);
  });
  await t.test('consumer rejects missing or tampered parser capsule and leaves no private extraction', async () => {
    const cli = await setup('fast'), file = path.join(capsuleDir, 'yaml-parser.tgz'), original = fs.readFileSync(file);
    const bad = Buffer.from(original); bad[bad.length - 1] ^= 1; fs.writeFileSync(file, bad);
    assert.notEqual(cli().status, 0); assert.deepEqual(fs.readdirSync(path.join(root, 'private')), []);
    fs.rmSync(file); assert.notEqual(cli().status, 0); assert.deepEqual(fs.readdirSync(path.join(root, 'private')), []);
    fs.writeFileSync(file, original);
  });
  await t.test('default rejects unexpected observation with null request', async () => {
    const cli = await setup('default'), file = path.join(root, 'ci-results/format-rpm/package.json'), value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.encoder.observed = { compressor: 'gzip', flags: '1' }; fs.writeFileSync(file, JSON.stringify(value));
    assert.notEqual(cli().status, 0, 'unexpected observation accepted');
  });
});

test('parser location follows current builder lock nesting and rejects unsupported layouts', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ci-parser-layout-'));
  try {
    const lock = JSON.parse(fs.readFileSync(new URL('../desktop/package-lock.json', import.meta.url), 'utf8'));
    const put = value => fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(value));
    put(lock); const original = linux.lockedParser(root);
    const nestedKey = 'node_modules/app-builder-lib/node_modules/js-yaml';
    const nested = structuredClone(lock); nested.packages[nestedKey] = { ...original, version: 'fixture-nested' };
    put(nested); assert.equal(linux.lockedParser(root).location, nestedKey); assert.equal(linux.lockedParser(root).version, 'fixture-nested');
    delete nested.packages['node_modules/js-yaml']; put(nested); assert.equal(linux.lockedParser(root).location, nestedKey);
    for (const mutate of [
      value => { delete value.packages['node_modules/js-yaml']; },
      value => { delete value.packages['node_modules/app-builder-lib'].dependencies['js-yaml']; },
      value => { value.packages['node_modules/app-builder-lib/out/node_modules/js-yaml'] = original; },
      value => { value.packages['node_modules/js-yaml'].link = true; },
    ]) { const invalid = structuredClone(lock); mutate(invalid); put(invalid); assert.throws(() => linux.lockedParser(root)); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('locked parser capsule verifies current SRI before importing, parses current source, and always cleans private files', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ci-parser-test-'));
  try {
    const desktop = path.join(root, 'desktop'), evidence = path.join(root, 'evidence'), temporary = path.join(root, 'private');
    for (const dir of [desktop, evidence, temporary]) fs.mkdirSync(dir);
    const lock = JSON.parse(fs.readFileSync(new URL('../desktop/package-lock.json', import.meta.url), 'utf8'));
    const lockFile = path.join(desktop, 'package-lock.json'); fs.writeFileSync(lockFile, JSON.stringify(lock));
    const parserLocation = linux.lockedParser(desktop).location;
    fs.writeFileSync(path.join(desktop, 'electron-builder.yml'), 'linux: {}\n');
    fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({ scripts: { prepack: 'exit 99', postpack: 'exit 99' } }));
    const before = await manifest(desktop), capsule = await linux.packParserCapsule(desktop, evidence, temporary);
    assert.deepEqual(fs.readdirSync(temporary), []);
    assert.deepEqual(await manifest(desktop), before); assert.deepEqual(fs.readdirSync(evidence), ['yaml-parser.tgz']);
    assert.ok(fs.statSync(capsule).size > 0);
    const first = await linux.readEncoderInputs(desktop, capsule, temporary);
    assert.deepEqual(first.config, { linux: {} }); assert.deepEqual(first.pkg.scripts, { prepack: 'exit 99', postpack: 'exit 99' });
    fs.writeFileSync(path.join(desktop, 'electron-builder.yml'), 'linux:\n  fpm: [--current-sentinel]\n');
    assert.deepEqual((await linux.readEncoderInputs(desktop, capsule, temporary)).config.linux.fpm, ['--current-sentinel']);
    assert.deepEqual(fs.readdirSync(temporary), []); assert.ok(!fs.existsSync(path.join(desktop, 'node_modules')));
    const sourceBeforeErrors = await manifest(desktop), original = fs.readFileSync(capsule);
    const malicious = path.join(root, 'malicious'); fs.mkdirSync(path.join(malicious, 'package/dist'), { recursive: true });
    const marker = path.join(root, 'UNTRUSTED_CODE_EXECUTED');
    fs.writeFileSync(path.join(malicious, 'package/index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'); exports.load = () => ({});`);
    await run('tar', ['-czf', capsule, '-C', malicious, 'package']);
    await assert.rejects(linux.readEncoderInputs(desktop, capsule, temporary), /integrity/i);
    assert.ok(!fs.existsSync(marker)); assert.deepEqual(fs.readdirSync(temporary), []);
    fs.writeFileSync(capsule, original);
    for (const integrity of ['sha1-unsupported', 'sha512-invalid', undefined]) {
      const changed = structuredClone(lock); changed.packages[parserLocation].integrity = integrity;
      fs.writeFileSync(lockFile, JSON.stringify(changed));
      await assert.rejects(linux.readEncoderInputs(desktop, capsule, temporary), /integrity/i);
      assert.deepEqual(fs.readdirSync(temporary), []);
    }
    const wrongDigest = structuredClone(lock);
    wrongDigest.packages[parserLocation].integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
    fs.writeFileSync(lockFile, JSON.stringify(wrongDigest));
    const refusedOutput = path.join(root, 'refused-output'); fs.mkdirSync(refusedOutput);
    await assert.rejects(linux.packParserCapsule(desktop, refusedOutput, temporary), /integrity/i);
    assert.deepEqual(fs.readdirSync(refusedOutput), []); assert.deepEqual(fs.readdirSync(temporary), []);
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    fs.writeFileSync(path.join(desktop, 'electron-builder.yml'), 'invalid: [\n');
    await assert.rejects(linux.readEncoderInputs(desktop, capsule, temporary)); assert.deepEqual(fs.readdirSync(temporary), []);
    fs.writeFileSync(path.join(desktop, 'electron-builder.yml'), 'linux:\n  fpm: [--current-sentinel]\n');
    assert.deepEqual(await manifest(desktop), sourceBeforeErrors);
    // WHY: the retained npm tarball includes its own license; no install needed.
    const listing = (await run('tar', ['-tzf', capsule])).toString();
    for (const ending of ['\n', '\r\n']) {
      const platformListing = listing.replace(/\r?\n/g, ending);
      const entries = platformListing.split(/\r?\n/); assert.ok(entries.includes('package/LICENSE'));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('package metadata loads current installed builder defaults and current configuration', async () => {
  // WHY: pure metadata fixtures cannot detect the installed builder's CJS export
  // shape. This integration contract runs after npm ci, against the real module.
  const actual = await expectedMetadata();
  const require = createRequire(new URL('../desktop/package.json', import.meta.url));
  const Builder = require('app-builder-lib/out/targets/FpmTarget.js').default;
  const builderRequire = createRequire(require.resolve('app-builder-lib/out/util/config/load.js'));
  const desktop = fileURLToPath(new URL('../desktop/', import.meta.url));
  const locked = linux.lockedParser(desktop);
  assert.equal(builderRequire.resolve('js-yaml'), path.join(desktop, locked.location, 'index.js'));
  const config = builderRequire('js-yaml').load(fs.readFileSync(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8'));
  const pkg = require('./package.json');
  assert.equal(typeof Builder, 'function');
  assert.deepEqual(actual.config, config);
  assert.equal(actual.name, pkg.name); assert.equal(actual.version, pkg.version);
  assert.equal(actual.productName, config.productName); assert.equal(actual.category, config.linux.category);
  for (const format of ['deb', 'rpm', 'pacman']) {
    const expected = config[format]?.depends ?? config.linux.depends ?? Builder.prototype.getDefaultDepends(format);
    assert.ok(Array.isArray(expected) && expected.length > 0 && expected.every(item => typeof item === 'string' && item.length > 0));
    assert.deepEqual(format === 'pacman' ? actual.pacmanDependencies : actual.nativeDependencies[format], expected);
  }
});

test('real builder config resolution preserves custom FPM arrays, extends and package build untouched', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ci-custom-config-'));
  const require = createRequire(new URL('../desktop/package.json', import.meta.url));
  const { createYargs, configureBuildCommand, normalizeOptions } = require('electron-builder/out/builder.js');
  const { getConfig } = require('app-builder-lib/out/util/config/config.js');
  try {
    for (const format of ['deb', 'rpm']) {
      const sentinel = ['--custom-sentinel=must-survive', `--${format}-compression-level=7`];
      for (const kind of ['linux', 'target', 'extends', 'package']) {
        const pkg = { name: 'fixture', version: '1.0.0' };
        let config = kind === 'linux' ? { linux: { fpm: sentinel } } : { [format]: { fpm: sentinel } };
        if (kind === 'extends') {
          const parent = path.join(root, 'parent.json'); fs.writeFileSync(parent, JSON.stringify(config));
          config = { extends: parent };
        }
        if (kind === 'package') pkg.build = config;
        const original = path.join(root, 'electron-builder.yml');
        fs.writeFileSync(original, JSON.stringify(config));
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
        const before = fs.readFileSync(original, 'utf8'), pkgBefore = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
        const requested = encoderProfile(format, 'fast', config, pkg);
        assert.equal(requested, null);
        const override = writeEncoderConfig(format, requested, original, root);
        assert.equal(override, undefined);
        const args = packageArgs(format, 'fast', path.join(root, 'app'), path.join(root, 'out'), override);
        assert.deepEqual(args, packageArgs(format, 'fast', path.join(root, 'app'), path.join(root, 'out')));
        const options = normalizeOptions(configureBuildCommand(createYargs()).parse(args));
        const resolved = await getConfig(root, undefined, options.config);
        assert.deepEqual(kind === 'linux' ? resolved.linux.fpm : resolved[format].fpm, sentinel);
        assert.equal(fs.readFileSync(original, 'utf8'), before);
        assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), pkgBefore);
        assert.ok(!fs.existsSync(path.join(root, `encoder-${format}.json`)));
      }
      assert.equal(writeEncoderConfig(format, encoderProfile(format, 'default', {}, {}), '/unused/original.yml', root), undefined);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('current builder AppImage proof preserves stored modes and verifies real generated integration', { skip: process.platform !== 'linux' }, async () => {
  // WHY: synthetic metadata never exercises the real extraction runtime or its
  // generated structural directories. Use a tiny disposable prepared payload;
  // build and extract only, never execute AppRun or the application stub.
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ci-appimage-'));
  try {
    const expected = await expectedMetadata(), app = path.join(root, 'app'), output = path.join(root, 'output');
    fs.mkdirSync(path.join(app, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(app, 'resources', 'fixture.txt'), 'current prepared payload\n');
    fs.writeFileSync(path.join(app, expected.name), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const desktop = fileURLToPath(new URL('../desktop/', import.meta.url));
    const cli = path.join(desktop, 'node_modules/electron-builder/out/cli/cli.js');
    const require = createRequire(new URL('../desktop/package.json', import.meta.url));
    const { createYargs, configureBuildCommand, normalizeOptions } = require('electron-builder/out/builder.js');
    const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
    const original = path.join(desktop, 'electron-builder.yml');
    const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
    // WHY: use the actual CLI, config loader, schema and packager, not a guessed
    // JSON-valued dot argument. The unused FPM array must survive resolution.
    for (const format of ['deb', 'rpm']) {
      const requested = encoderProfile(format, 'fast', expected.config, pkg);
      assert.deepEqual(requested, { compressor: 'gzip', level: 1 });
      const configFile = writeEncoderConfig(format, requested, original, root);
      assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
      assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).extends, original);
      const args = packageArgs('AppImage', 'default', app, output, configFile);
      await run(process.execPath, [cli, ...args], desktop);
      const options = normalizeOptions(configureBuildCommand(createYargs()).parse(args));
      const resolved = await getConfig(desktop, undefined, options.config);
      await validateConfiguration(resolved, {});
      assert.deepEqual(resolved[format].fpm, [`--${format}-compression-level=1`]);
      assert.equal(resolved.directories.output, output);
      assert.equal(resolved.productName, expected.productName);
      assert.equal(resolved.linux.icon, expected.config.linux.icon);
      assert.deepEqual(resolved.pacman.depends, expected.config.pacman.depends);
    }
    const images = fs.readdirSync(output).filter(name => name.endsWith('.AppImage'));
    assert.equal(images.length, 1);
    const installer = path.join(output, images[0]), post = await manifest(app);
    const payload = path.join(root, 'payload'), evidence = path.join(root, 'evidence');
    fs.mkdirSync(payload); fs.mkdirSync(evidence);
    await appImagePayload(installer, payload, post, evidence, expected);
    const wrongMode = structuredClone(post);
    wrongMode.find(entry => entry.path === 'resources').mode = 0o700;
    const rejected = path.join(root, 'rejected'); fs.mkdirSync(rejected);
    await assert.rejects(() => appImagePayload(installer, rejected, wrongMode, evidence, expected), /Installed app differs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('actual Vitest discovery and unfiltered shards accept fresh source/new test files and cases', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ci-vitest-'));
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  try {
    fs.writeFileSync(path.join(root, 'vitest.config.mjs'), 'export default { test: { globals: true } };\n');
    const source = path.join(root, 'source.js'); fs.writeFileSync(source, 'export const current = 1;\n');
    fs.writeFileSync(path.join(root, 'initial.test.js'), "import {current} from './source.js'; it('current source', () => expect(current).toBe(1)); it.skip('OS-specific skip', () => {}); it.todo('future');\n");
    const collect = async sha => {
      await run(process.execPath, [vitest, 'list', '--filesOnly', '--json=discovery.json', '--allowOnly=false'], root);
      const discovery = read('discovery.json').map(item => path.relative(root, item.file).replaceAll('\\', '/'));
      const records = [];
      for (const shard of [1, 2]) {
        await run(process.execPath, [vitest, ...shardArgs(shard, 2, path.join(root, `report-${shard}.json`))], root);
        const report = read(`report-${shard}.json`);
        for (const item of report.testResults) item.name = path.relative(root, item.name).replaceAll('\\', '/');
        records.push({ identity: { sha }, os: 'fixture', shard, total: 2, discovery: shard === 1 ? discovery : undefined, report });
      }
      return records;
    };
    // WHY: two fresh files make each shard nonempty, just like the production
    // contract; no frozen list, previous artifact or magic case count is read.
    fs.writeFileSync(path.join(root, 'second.test.js'), "it('second', () => expect(true).toBe(true));\n");
    const first = await collect('first');
    const baseline = aggregate(first, [{ os: 'fixture', total: 2 }], { sha: 'first' });
    fs.writeFileSync(source, 'export const current = 2;\n');
    fs.writeFileSync(path.join(root, 'initial.test.js'), "import {current} from './source.js'; it('current source', () => expect(current).toBe(2)); it.skip('OS-specific skip', () => {}); it.todo('future');\n");
    fs.writeFileSync(path.join(root, 'brand-new.test.js'), "it('new file/new case', () => expect(2 + 2).toBe(4));\n");
    const fresh = await collect('fresh'), result = aggregate(fresh, [{ os: 'fixture', total: 2 }], { sha: 'fresh' });
    assert.ok(result.files > baseline.files && result.cases > baseline.cases);
    assert.throws(() => aggregate([first[0], fresh[1]], [{ os: 'fixture', total: 2 }], { sha: 'fresh' }));
    const malformed = structuredClone(fresh); malformed[0].report.numTotalTests++;
    assert.throws(() => aggregate(malformed, [{ os: 'fixture', total: 2 }], { sha: 'fresh' }));
    fs.writeFileSync(path.join(root, 'brand-new.test.js'), "it.only('must not focus authored coverage', () => expect(true).toBe(true));\n");
    await assert.rejects(run(process.execPath, [vitest, ...shardArgs(1, 1, path.join(root, 'forbid-only.json'))], root));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
