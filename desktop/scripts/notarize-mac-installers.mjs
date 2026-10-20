#!/usr/bin/env node
// WHY: electron-builder notarizes/staples the .app before packaging. The DMG handed
// to users needs its own ticket too, and must finish changing BEFORE update hashes
// or upload. This helper is shared by beta and release workflows.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const verifier = fileURLToPath(new URL('./verify-mac-signature.sh', import.meta.url));
const execute = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ...options.env },
  // Bound a stuck Apple submission rather than occupying a runner indefinitely.
  timeout: 35 * 60 * 1000,
});

export function notarizeInstallers(directory, env = process.env, run = execute) {
  for (const name of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_TEAM_ID']) {
    if (!env[name]) throw new Error(`${name} is required for Mac installer notarization`);
  }
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((file) => file.isFile() && file.name.endsWith('.dmg'))
    .map((file) => path.resolve(directory, file.name)).sort();
  if (!files.length) throw new Error(`No DMG installers found under ${directory}`);
  for (const file of files) {
    const response = JSON.parse(run('xcrun', [
      'notarytool', 'submit', file,
      '--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID,
      '--issuer', env.APPLE_API_ISSUER,
      '--wait', '--timeout', '30m', '--output-format', 'json',
    ]));
    if (response.status !== 'Accepted') {
      throw new Error(`Apple notarization not accepted for ${path.basename(file)}: ${response.status || '<missing status>'}; submission ${response.id || '<missing id>'}`);
    }
    run('xcrun', ['stapler', 'staple', file]);
    run('xcrun', ['stapler', 'validate', file]);
    run('codesign', ['--verify', '--strict', '--verbose=2', file]);
    run('spctl', ['--assess', '--verbose=2', '--type', 'open', '--context', 'context:primary-signature', file]);
    // WHY: checking an unpacked build directory is not proof of what the user
    // downloads. Inspect the app FROM the final read-only image with the same
    // strict verifier, and detach it even when that assessment fails.
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-dmg-'));
    let mounted = false;
    try {
      run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, file]);
      mounted = true;
      run('bash', [verifier, mount], { env: { SIGN_MACOS: 'true', APPLE_TEAM_ID: env.APPLE_TEAM_ID } });
    } finally {
      if (mounted) run('hdiutil', ['detach', mount]);
      // Never recursively remove a mount: a detach failure must leave it alone.
      fs.rmdirSync(mount);
    }
    console.log(`${path.basename(file)}: notarized, stapled, image and contained-app checks passed (submission ${response.id})`);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    notarizeInstallers(process.argv[2] || 'release');
  } catch (error) {
    // CLI diagnostics retain Apple's stderr, but never print private-key contents.
    console.error(error instanceof Error ? error.message : String(error));
    if (error?.stderr) console.error(String(error.stderr));
    process.exitCode = 1;
  }
}
