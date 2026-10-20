#!/usr/bin/env node
// WHY: a bad signing identity/keychain should fail BEFORE the full Mac suite.
// Use the same builder keychain implementation as packaging, then prove private-
// key access with codesign on a disposable COPY, never an installed executable.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const execute = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) {
    // Do not print argv: security import arguments contain a private password.
    throw new Error(`${path.basename(command)} ${args[0]} failed: ${result.stderr || result.error?.message || `exit ${result.status}`}`);
  }
  return result.stdout;
};

export async function checkMacSigningKeychain({
  env = process.env, cwd = process.cwd(), run = execute,
  keychain = require('app-builder-lib/out/codeSign/macCodeSign'),
  tmpDir = new (require('temp-file').TmpDir)('youcoded-signing-preflight'),
  probeSource = '/usr/bin/true',
} = {}) {
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!env[name]) throw new Error(`${name} is required for Mac signing preflight`);
  }
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('APPLE_TEAM_ID is not a valid team identifier');
  // WHY: v26 can fail AFTER creating/importing but BEFORE returning its handle.
  // Its deterministic path (macCodeSign.js createKeychain) lets cleanup remove
  // that partial keychain too. Preflight and packaging must stay sequential.
  const expectedKeychain = path.join(process.env.APP_BUILDER_TMP_DIR || os.tmpdir(), `${createHash('sha256').update(cwd).update('app-builder').digest('hex')}.keychain`);
  let info;
  try {
    info = await keychain.createKeychain({ tmpDir, currentDir: cwd, cscLink: env.CSC_LINK, cscKeyPassword: env.CSC_KEY_PASSWORD });
    const identities = run('security', ['find-identity', '-v', '-p', 'codesigning', info.keychainFile]);
    const match = identities.match(new RegExp(`([A-Fa-f0-9]{40}) "Developer ID Application: [^"\\n]+ \\(${env.APPLE_TEAM_ID}\\)"`));
    if (!match) throw new Error(`No valid Developer ID Application identity for ${env.APPLE_TEAM_ID}`);
    const probe = path.join(await tmpDir.createTempDir({ prefix: 'youcoded-signing-probe' }), 'signing-probe');
    fs.copyFileSync(probeSource, probe);
    run('codesign', ['--force', '--sign', match[1], '--keychain', info.keychainFile, '--timestamp', '--options', 'runtime', probe]);
    run('codesign', ['--verify', '--strict', '--verbose=2', probe]);
    console.log('Native Developer ID import, private-key access and disposable-code signing passed.');
  } finally {
    try {
      await keychain.removeKeychain(info?.keychainFile || expectedKeychain);
    } finally {
      await tmpDir.cleanup();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.platform !== 'darwin') throw new Error('Native signing preflight requires an isolated macOS build runner');
  checkMacSigningKeychain().catch((error) => {
    let message = error instanceof Error ? error.message : String(error);
    for (const value of [process.env.CSC_KEY_PASSWORD, process.env.CSC_LINK]) {
      if (value) message = message.split(value).join('[redacted]');
    }
    console.error(message);
    process.exitCode = 1;
  });
}
