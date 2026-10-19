import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkMacSigningKeychain } from '../scripts/check-mac-signing-keychain.mjs';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-signing-check-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
const fingerprint = 'A'.repeat(40);
const env = { CSC_LINK: 'encoded-test-certificate', CSC_KEY_PASSWORD: 'certificate-password', APPLE_TEAM_ID: 'C2PSZTNNA4' };
function fixture(failCommand = '') {
  const calls: string[][] = [];
  const lifecycle: string[] = [];
  const probe = path.join(dir, 'source-executable');
  fs.writeFileSync(probe, 'test executable bytes');
  return {
    env, probeSource: probe, cwd: dir,
    keychain: {
      createKeychain: async (options: { cscKeyPassword: string }) => {
        expect(options.cscKeyPassword).toBe(env.CSC_KEY_PASSWORD);
        lifecycle.push('create');
        return { keychainFile: path.join(dir, 'signing.keychain') };
      },
      removeKeychain: async () => { lifecycle.push('remove'); },
    },
    tmpDir: { createTempDir: async () => dir, cleanup: async () => { lifecycle.push('cleanup'); } },
    run: (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (args[0] === failCommand) throw new Error('native operation rejected');
      return args[0] === 'find-identity' ? `  1) ${fingerprint} "Developer ID Application: Destin's Adventures, LLC (C2PSZTNNA4)"` : '';
    },
    calls, lifecycle,
  };
}

describe('Native Mac signing preflight', () => {
  it('checks identity and proves private-key access by signing a disposable copy, then cleans up', async () => {
    const f = fixture();
    await checkMacSigningKeychain(f);
    expect(f.calls[0].slice(0, 5)).toEqual(['security', 'find-identity', '-v', '-p', 'codesigning']);
    const sign = f.calls.find((args) => args[0] === 'codesign' && args[1] === '--force')!;
    expect(sign).toEqual(expect.arrayContaining(['--sign', fingerprint, '--keychain', '--timestamp', '--options', 'runtime']));
    expect(sign.at(-1)).not.toBe(f.probeSource);
    expect(fs.readFileSync(f.probeSource, 'utf8')).toBe('test executable bytes');
    expect(f.calls.at(-1)?.slice(0, 3)).toEqual(['codesign', '--verify', '--strict']);
    expect(f.lifecycle).toEqual(['create', 'remove', 'cleanup']);
  });

  it('creates the probe directory with the real temporary-directory implementation', async () => {
    const f = fixture();
    const { TmpDir } = require('temp-file');
    const tmpDir = new TmpDir('mac-signing-real-temp-test');
    await checkMacSigningKeychain({ ...f, tmpDir });
    const probe = f.calls.find((args) => args[0] === 'codesign' && args[1] === '--force')!.at(-1)!;
    expect(fs.existsSync(probe)).toBe(false); // native check finished and cleanup removed its copy
  });

  it.each(['find-identity', '--force', '--verify'])('cleans up after %s fails', async (command) => {
    const f = fixture(command);
    await expect(checkMacSigningKeychain(f)).rejects.toThrow('native operation rejected');
    expect(f.lifecycle).toEqual(['create', 'remove', 'cleanup']);
  });

  it('removes a partially created keychain when import rejects before returning', async () => {
    const f = fixture();
    f.keychain.createKeychain = async () => {
      f.lifecycle.push('create');
      throw new Error('native import rejected');
    };
    await expect(checkMacSigningKeychain(f)).rejects.toThrow('native import rejected');
    expect(f.lifecycle).toEqual(['create', 'remove', 'cleanup']);
  });

  it('rejects an identity from another team', async () => {
    const f = fixture();
    f.run = () => `1) ${fingerprint} "Developer ID Application: Another company (OTHERTEAM1)"`;
    await expect(checkMacSigningKeychain(f)).rejects.toThrow(/Developer ID.*C2PSZTNNA4/);
    expect(f.lifecycle).toEqual(['create', 'remove', 'cleanup']);
  });

  it.each(Object.keys(env))('refuses missing %s before creating a keychain', async (key) => {
    const f = fixture();
    await expect(checkMacSigningKeychain({ ...f, env: { ...env, [key]: '' } })).rejects.toThrow(key);
    expect(f.lifecycle).toEqual([]);
  });
});
