#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, hash } from './ci-evidence.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const scopes = ['jvm', 'debug', 'releaseTest'];
const jvmPrefixes = ['Debug', 'Release', 'ReleaseTest'].map(variant => `app/build/test-results/test${variant}UnitTest/`);
function scopePrefixes(scope) {
  assert.ok(['all', ...scopes].includes(scope), `Unknown Android scope: ${scope}`);
  const apks = (scope === 'all' ? ['debug', 'releaseTest'] : scopes.includes(scope) && scope !== 'jvm' ? [scope] : [])
    .map(variant => `app/build/outputs/apk/${variant}/`);
  return [...apks, ...(scope === 'all' || scope === 'jvm' ? jvmPrefixes : [])];
}
export async function androidOutputs(root, scope = 'all') {
  const outputs = [];
  // WHY: a successful Gradle invocation must leave current APKs AND XML from
  // every selected JVM variant, not only a cached success/empty artifact path.
  for (const prefix of scopePrefixes(scope)) {
    const directory = path.join(root, prefix), extension = jvmPrefixes.includes(prefix) ? '.xml' : '.apk';
    const names = fs.readdirSync(directory).filter(name => name.endsWith(extension)).sort();
    assert.ok(names.length > 0, `Missing Android outputs: ${prefix}`);
    for (const name of names) {
      const full = path.join(directory, name), info = fs.lstatSync(full);
      assert.ok(info.isFile() && info.size > 0, `Not a nonempty output file: ${full}`);
      outputs.push({ path: `${prefix}${name}`, sha256: await hash(full) });
    }
  }
  return outputs;
}
export function aggregateAndroid(records, expectedIdentity) {
  assert.ok(Array.isArray(records) && records.length === scopes.length, 'Expected exactly three Android scope records');
  const outputs = [], seen = new Set();
  // WHY: downloaded evidence is untrusted until its identity, complete scope union
  // and exact normalized variant paths are checked; a success flag is not proof.
  for (const scope of scopes) {
    const matching = records.filter(record => record?.scope === scope);
    assert.equal(matching.length, 1, `Missing/duplicate Android scope: ${scope}`);
    const record = matching[0];
    assert.deepEqual(record.identity, expectedIdentity, 'Android input identity mismatch');
    assert.ok(Array.isArray(record.outputs) && record.outputs.length > 0, `Missing ${scope} outputs`);
    const prefixes = scopePrefixes(scope), covered = new Set();
    for (const output of record.outputs) {
      const name = output?.path, digest = output?.sha256;
      assert.ok(typeof name === 'string' && !name.includes('\\') && !/[\x00-\x1f\x7f]/.test(name)
        && !path.posix.isAbsolute(name) && path.posix.normalize(name) === name, 'Invalid Android output path');
      const prefix = prefixes.find(prefix => name.startsWith(prefix));
      assert.ok(prefix, `Out-of-scope Android output: ${name}`);
      const basename = name.slice(prefix.length), extension = scope === 'jvm' ? '.xml' : '.apk';
      assert.ok(!basename.includes('/') && basename.endsWith(extension) && basename.length > extension.length, `Invalid Android output filename: ${name}`);
      assert.ok(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'Invalid Android output hash');
      assert.ok(!seen.has(name), `Duplicate Android output: ${name}`);
      seen.add(name); covered.add(prefix); outputs.push({ path: name, sha256: digest });
    }
    assert.equal(covered.size, prefixes.length, `Missing ${scope} variant outputs`);
  }
  outputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { identity: expectedIdentity, outputs, scopes: [...scopes] };
}
async function main() {
  const file = path.join(root, 'ci-android-inputs.json'), input = await identity(root, process.env.GITHUB_SHA);
  if (process.argv[2] === 'start') fs.writeFileSync(file, JSON.stringify(input));
  else if (process.argv[2] === 'android' || scopes.includes(process.argv[2])) {
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), input, 'Android build changed tracked inputs');
    const scope = process.argv[2] === 'android' ? 'all' : process.argv[2];
    const outputs = await androidOutputs(root, scope);
    fs.writeFileSync(path.join(root, 'ci-android-evidence.json'), JSON.stringify({ scope, identity: input, outputs }, null, 2) + '\n');
    console.log(`Android current inputs and ${scope} outputs verified`);
  } else if (process.argv[2] === 'aggregate') {
    const directory = path.join(root, 'ci-android-results');
    const artifacts = scopes.map(scope => `android-scope-${scope}`);
    assert.deepEqual(fs.readdirSync(directory).sort(), [...artifacts].sort(), 'Unexpected/missing Android scope artifacts');
    const records = artifacts.map((artifact, index) => {
      const record = JSON.parse(fs.readFileSync(path.join(directory, artifact, 'ci-android-evidence.json'), 'utf8'));
      assert.equal(record.scope, scopes[index], 'Android artifact scope mismatch');
      return record;
    });
    fs.writeFileSync(path.join(root, 'ci-android-evidence.json'), JSON.stringify(aggregateAndroid(records, input), null, 2) + '\n');
    console.log('Android current scope evidence aggregated');
  } else throw new Error('Use start|android|jvm|debug|releaseTest|aggregate');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
