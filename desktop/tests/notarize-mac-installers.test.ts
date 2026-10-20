import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notarizeInstallers } from '../scripts/notarize-mac-installers.mjs';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notarize-dmg-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
const credentials = {
  APPLE_API_KEY: '/private/runner/AuthKey.p8', APPLE_API_KEY_ID: 'KEYID',
  APPLE_API_ISSUER: 'issuer-id', APPLE_TEAM_ID: 'C2PSZTNNA4',
};
function dmgs() {
  for (const arch of ['x64', 'arm64']) fs.writeFileSync(path.join(dir, `YouCoded-Installer-1.3.2-${arch}.dmg`), '');
}
function runner(overrides: Record<string, string | Error> = {}) {
  const calls: Array<[string, string[], { env?: Record<string, string> }?]> = [];
  const run = (command: string, args: string[], options?: { env?: Record<string, string> }) => {
    calls.push([command, args, options]);
    const operation = command === 'bash' ? 'mounted app' : args.slice(0, 2).join(' ');
    const value = overrides[operation];
    if (value instanceof Error) throw value;
    if (value !== undefined) return value;
    if (operation === 'notarytool submit') return JSON.stringify({ id: 'submission-id', status: 'Accepted' });
    return '';
  };
  return { run, calls };
}

describe('Mac installer notarization', () => {
  it('submits both final DMGs and validates their stapled tickets before Gatekeeper assessment', () => {
    dmgs();
    const r = runner();
    expect(notarizeInstallers(dir, credentials, r.run)).toHaveLength(2);
    for (const arch of ['arm64', 'x64']) {
      const file = path.join(dir, `YouCoded-Installer-1.3.2-${arch}.dmg`);
      const calls = r.calls.filter(([, args]) => args.includes(file));
      expect(calls.map(([, args]) => args.slice(0, 2))).toEqual([
        ['notarytool', 'submit'], ['stapler', 'staple'], ['stapler', 'validate'],
        ['--verify', '--strict'], ['--assess', '--verbose=2'], ['attach', '-readonly'],
      ]);
      expect(calls[0][1]).toEqual(expect.arrayContaining([
        '--key', credentials.APPLE_API_KEY, '--key-id', credentials.APPLE_API_KEY_ID,
        '--issuer', credentials.APPLE_API_ISSUER, '--wait', '--output-format', 'json',
      ]));
      expect(calls[4][1]).toEqual(expect.arrayContaining(['--type', 'open', '--context', 'context:primary-signature']));
    }
  });

  it('verifies the app inside each mounted final DMG in trusted mode', () => {
    dmgs();
    const r = runner();
    notarizeInstallers(dir, credentials, r.run);
    const mountedChecks = r.calls.filter(([command]) => command === 'bash');
    expect(mountedChecks).toHaveLength(2);
    for (const [, args, options] of mountedChecks) {
      expect(path.basename(args[0])).toBe('verify-mac-signature.sh');
      expect(options?.env).toMatchObject({ SIGN_MACOS: 'true', APPLE_TEAM_ID: credentials.APPLE_TEAM_ID });
      expect(r.calls).toContainEqual(['hdiutil', ['detach', args[1]], undefined]);
      expect(fs.existsSync(args[1])).toBe(false);
    }
  });

  it('detaches the image even when its contained app fails validation', () => {
    dmgs();
    const r = runner({ 'mounted app': new Error('Contained app rejected') });
    expect(() => notarizeInstallers(dir, credentials, r.run)).toThrow('Contained app rejected');
    const mounted = r.calls.find(([command]) => command === 'bash')!;
    expect(r.calls.at(-1)).toEqual(['hdiutil', ['detach', mounted[1][1]], undefined]);
    expect(fs.existsSync(mounted[1][1])).toBe(false);
  });

  it.each(['Invalid', 'In Progress', 'Rejected', ''])('refuses a nonaccepted Apple response: %s', (status) => {
    dmgs();
    const r = runner({ 'notarytool submit': JSON.stringify({ id: 'submission-id', status }) });
    expect(() => notarizeInstallers(dir, credentials, r.run)).toThrow(/not accepted.*submission-id/i);
    expect(r.calls.some(([, args]) => args[0] === 'stapler')).toBe(false);
  });

  it('fails closed on malformed Apple output', () => {
    dmgs();
    const r = runner({ 'notarytool submit': 'not json' });
    expect(() => notarizeInstallers(dir, credentials, r.run)).toThrow();
    expect(r.calls).toHaveLength(1);
  });

  it.each(['notarytool submit', 'stapler staple', 'stapler validate', '--verify --strict', '--assess --verbose=2'])(
    'propagates failure from %s', (operation) => {
      dmgs();
      const r = runner({ [operation]: new Error('Apple command failed') });
      expect(() => notarizeInstallers(dir, credentials, r.run)).toThrow('Apple command failed');
      expect(r.calls.at(-1)?.[1].slice(0, 2).join(' ')).toBe(operation);
    },
  );

  it.each(Object.keys(credentials))('refuses missing %s before any command', (key) => {
    dmgs();
    const r = runner();
    expect(() => notarizeInstallers(dir, { ...credentials, [key]: '' }, r.run)).toThrow(key);
    expect(r.calls).toHaveLength(0);
  });

  it('refuses an empty installer directory', () => {
    const r = runner();
    expect(() => notarizeInstallers(dir, credentials, r.run)).toThrow(/no.*DMG/i);
    expect(r.calls).toHaveLength(0);
  });
});
