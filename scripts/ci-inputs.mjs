#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, hash } from './ci-evidence.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function androidOutputs(root) {
  const outputs = [];
  // WHY: a successful Gradle invocation must leave current APKs AND XML from
  // every selected JVM variant, not only a cached success/empty artifact path.
  for (const variant of ['debug', 'releaseTest']) {
    const directory = path.join(root, 'app/build/outputs/apk', variant);
    const names = fs.readdirSync(directory).filter(name => name.endsWith('.apk')); assert.ok(names.length > 0);
    for (const name of names) { const full = path.join(directory, name); assert.ok(fs.statSync(full).size > 0); outputs.push({ path: path.relative(root, full), sha256: await hash(full) }); }
  }
  for (const variant of ['Debug', 'Release', 'ReleaseTest']) {
    const directory = path.join(root, 'app/build/test-results', `test${variant}UnitTest`);
    const names = fs.readdirSync(directory).filter(name => name.endsWith('.xml')); assert.ok(names.length > 0, `Missing ${variant} JVM results`);
    for (const name of names) { const full = path.join(directory, name); assert.ok(fs.statSync(full).size > 0); outputs.push({ path: path.relative(root, full), sha256: await hash(full) }); }
  }
  return outputs;
}
async function main() {
  const file = path.join(root, 'ci-android-inputs.json'), input = await identity(root, process.env.GITHUB_SHA);
  if (process.argv[2] === 'start') fs.writeFileSync(file, JSON.stringify(input));
  else if (process.argv[2] === 'android') {
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), input, 'Android build changed tracked inputs');
    const outputs = await androidOutputs(root);
    fs.writeFileSync(path.join(root, 'ci-android-evidence.json'), JSON.stringify({ identity: input, outputs }, null, 2) + '\n');
    console.log('Android current inputs, all three JVM variant reports and debug/R8 APK outputs verified');
  } else throw new Error('Use start|android');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
