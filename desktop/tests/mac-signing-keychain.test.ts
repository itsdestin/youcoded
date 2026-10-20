import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { patchKeychainSource, patchKeychainFile } from '../scripts/patch-mac-signing-keychain.mjs';

const requireFromDesktop = createRequire(path.join(__dirname, '..', 'package.json'));
const sourcePath = requireFromDesktop.resolve('app-builder-lib/out/codeSign/macCodeSign.js');
// CI preflight patches the installed copy BEFORE tests. Reintroduce only these
// exact three sites in memory so the actual-module regression and hardlink test
// still exercise a real change, rather than passing vacuously on patched input.
const source = fs.readFileSync(sourcePath, 'utf8')
  .replace('return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);', 'return await importCerts(keychainFile, certPaths, cscPasswords);')
  .replace('async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {', 'async function importCerts(keychainFile, paths, keyPasswords) {')
  .replace('["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]', '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]');
let temp: string;
beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-keychain-patch-')); });
afterEach(() => { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }); });

// Exercise the installed module's ACTUAL createKeychain function with security
// replaced, not a lookalike of the upstream password mix-up. No Apple tools run.
async function securityCalls(code: string) {
  const calls: string[][] = [];
  const exports: Record<string, any> = {};
  const localRequire = createRequire(sourcePath);
  const requireStub = (name: string) => {
    if (name === 'builder-util') return {
      ...localRequire(name),
      exec: async (_command: string, args: string[]) => { calls.push(args); return ''; },
    };
    if (name === './codesign') return { importCertificate: async () => '/private/test.p12' };
    return localRequire(name);
  };
  vm.runInNewContext(code, {
    exports, require: requireStub, Buffer, console,
    process: { ...process, env: { ...process.env, TRAVIS: 'true' } },
    __dirname: path.dirname(sourcePath), __filename: sourcePath,
  });
  await exports.createKeychain({ tmpDir: {}, cscLink: 'test', cscKeyPassword: 'certificate-password', currentDir: temp });
  return calls;
}

describe('Mac signing keychain password compatibility', () => {
  it('uses the generated keychain password for partition access, not the certificate password', async () => {
    const calls = await securityCalls(patchKeychainSource(source));
    const created = calls.find((args) => args[0] === 'create-keychain')!;
    const imported = calls.find((args) => args[0] === 'import')!;
    const partition = calls.find((args) => args[0] === 'set-key-partition-list')!;
    expect(created).toBeDefined();
    expect(imported[imported.indexOf('-P') + 1]).toBe('certificate-password');
    expect(partition[partition.indexOf('-k') + 1]).toBe(created[created.indexOf('-p') + 1]);
    expect(partition[partition.indexOf('-k') + 1]).not.toBe('certificate-password');
  });

  it('is idempotent on the corrected dependency', () => {
    const corrected = patchKeychainSource(source);
    expect(patchKeychainSource(corrected)).toBe(corrected);
  });

  it('rejects unknown source instead of guessing after a dependency update', () => {
    expect(() => patchKeychainSource('unexpected source')).toThrow(/unsupported/i);
  });

  it('replaces the file atomically rather than changing a shared hardlink inode', () => {
    const target = path.join(temp, 'macCodeSign.js');
    const sibling = path.join(temp, 'shared-copy.js');
    fs.writeFileSync(target, source);
    fs.linkSync(target, sibling);
    expect(patchKeychainFile(target)).toBe(true);
    expect(fs.readFileSync(sibling, 'utf8')).toBe(source);
    expect(fs.readFileSync(target, 'utf8')).toBe(patchKeychainSource(source));
  });
});
