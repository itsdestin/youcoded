import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';
import { keychainLaunchOptions } from '../src/main/providers/keychain-launch';

const metadata = { packaged: true, appPath: '/app/app.asar', name: 'YouCoded Dev (test)', backend: 'kwallet6', scratch: '/tmp/private-keychain', env: { ELECTRON_RUN_AS_NODE: '1', DISPLAY: ':0', YOUCODED_PROFILE: 'dev' } };

describe('keychain helper launch isolation', () => {
  it('pins identity and backend without forwarding node mode', () => {
    const launch = keychainLaunchOptions(metadata);
    expect(launch.args).toContain('--password-store=kwallet6');
    expect(launch.args).toContain('--user-data-dir=/tmp/private-keychain');
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(launch.env.YOUCODED_KEYCHAIN_NAME).toBe(metadata.name);
    expect(launch.env.DISPLAY).toBe(':0');
    expect(launch.args).not.toContain(metadata.appPath);
  });
  it('uses the absolute app path only for default/dev Electron', () => {
    expect(keychainLaunchOptions({ ...metadata, packaged: false }).args[0]).toBe(metadata.appPath);
  });
  it('maps libsecret spelling and refuses insecure or unknown backends', () => {
    expect(keychainLaunchOptions({ ...metadata, backend: 'gnome_libsecret' }).args).toContain('--password-store=gnome-libsecret');
    for (const backend of ['unknown', 'basic_text', 'basic', '']) {
      expect(() => keychainLaunchOptions({ ...metadata, backend })).toThrow(/secure storage backend/i);
    }
  });

  it.each([true, false])('bootstrap loads exactly one module (helper=%s)', (helper) => {
    const root = path.resolve(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.main).toBe('dist/main/bootstrap.js');
    const source = fs.readFileSync(path.join(root, 'src/main/bootstrap.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const loaded: string[] = [];
    vm.runInNewContext(compiled, {
      process: { env: helper ? { YOUCODED_KEYCHAIN_HELPER: '1' } : {} },
      require: (name: string) => loaded.push(name),
    });
    expect(loaded).toEqual([helper ? './providers/keychain-helper' : './main']);
  });
});
