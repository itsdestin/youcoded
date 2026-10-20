#!/usr/bin/env node
// WHY: electron-builder 26.15.3 passes the certificate password to a command that
// needs the RANDOM KEYCHAIN password (upstream #10066/#10101). macOS 26 rejects
// it. Apply only the upstream three-line correction, fail on source drift, and
// rename a fresh file so worktree hardlinks can never mutate another checkout.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const replacements = [
  ['return await importCerts(keychainFile, certPaths, cscPasswords);',
    'return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);'],
  ['async function importCerts(keychainFile, paths, keyPasswords) {',
    'async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {'],
  ['["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]',
    '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]'],
];

export function patchKeychainSource(source) {
  if (replacements.every(([, fixed]) => source.split(fixed).length === 2)) return source;
  if (!replacements.every(([original]) => source.split(original).length === 2)) {
    throw new Error('Unsupported electron-builder keychain source; review whether the upstream fix has shipped before updating this compatibility patch.');
  }
  return replacements.reduce((text, [original, fixed]) => text.replace(original, fixed), source);
}

export function patchKeychainFile(target) {
  const original = fs.readFileSync(target, 'utf8');
  const fixed = patchKeychainSource(original);
  if (fixed === original) return false;
  const temporary = `${target}.youcoded-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, fixed, { mode: fs.statSync(target).mode & 0o777, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const require = createRequire(import.meta.url);
  const target = require.resolve('app-builder-lib/out/codeSign/macCodeSign.js');
  console.log(patchKeychainFile(target) ? 'Applied electron-builder keychain password correction.' : 'Keychain password correction is already present.');
}
