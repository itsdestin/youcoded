import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { expectedMetadata } from './ci-linux.mjs';
import { run } from './ci-policy.mjs';
import { aggregate, shardArgs } from './ci-evidence.mjs';
const vitest = fileURLToPath(new URL('../desktop/node_modules/vitest/vitest.mjs', import.meta.url));

test('package metadata loads current installed builder defaults and current configuration', async () => {
  // WHY: pure metadata fixtures cannot detect the installed builder's CJS export
  // shape. This integration contract runs after npm ci, against the real module.
  const actual = await expectedMetadata();
  const require = createRequire(new URL('../desktop/package.json', import.meta.url));
  const Builder = require('app-builder-lib/out/targets/FpmTarget.js').default;
  const config = require('yaml').parse(fs.readFileSync(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8'));
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
