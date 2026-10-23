import { describe, expect, it } from 'vitest';
import { computeInstallFacts, isWindowsPerMachinePath, type InstallFactsDeps } from '../src/main/update-install-facts';

const base = (over: Partial<InstallFactsDeps>): InstallFactsDeps => ({
  platform: 'linux', isPackaged: true, execPath: '/opt/YouCoded/youcoded', env: {}, linuxKind: 'unknown',
  canWrite: async () => true, probeFolderWritable: async () => true, ...over,
});

describe('what installing an update here would take', () => {
  it.each(['pacman', 'deb', 'rpm'] as const)('a Linux %s install needs a password', async (linuxKind) => {
    expect(await computeInstallFacts(base({ linuxKind }))).toMatchObject({ needsPassword: true, installRefused: false });
  });

  it('an AppImage never needs a password', async () => {
    expect(await computeInstallFacts(base({ linuxKind: 'appimage', env: { APPIMAGE: '/home/u/YouCoded.AppImage' } })))
      .toEqual({ needsPassword: false, installRefused: false, noBackgroundDownload: false });
  });

  it('an AppImage in a folder that cannot be written is refused and gets no background download', async () => {
    const probed: string[] = [];
    const facts = await computeInstallFacts(base({
      linuxKind: 'appimage', env: { APPIMAGE: '/opt/apps/YouCoded.AppImage' },
      probeFolderWritable: async (dir) => { probed.push(dir); return false; },
    }));
    expect(probed).toEqual(['/opt/apps']);
    expect(facts).toMatchObject({ installRefused: true, noBackgroundDownload: true });
  });

  it('an unpackaged build is refused', async () => {
    expect((await computeInstallFacts(base({ isPackaged: false, linuxKind: 'appimage', env: { APPIMAGE: '/x/Y.AppImage' } }))).installRefused).toBe(true);
  });

  it('a Mac needs a password when the app or its folder is not writable by this user', async () => {
    const mac = { platform: 'darwin' as const, execPath: '/Applications/YouCoded.app/Contents/MacOS/YouCoded' };
    expect((await computeInstallFacts(base(mac))).needsPassword).toBe(false);
    expect((await computeInstallFacts(base({ ...mac, canWrite: async (p) => p !== '/Applications' }))).needsPassword).toBe(true);
    expect((await computeInstallFacts(base({ ...mac, canWrite: async (p) => p !== '/Applications/YouCoded.app' }))).needsPassword).toBe(true);
  });

  it('a Mac copy not named YouCoded.app, or running from App Translocation, is refused', async () => {
    const run = (execPath: string) => computeInstallFacts(base({ platform: 'darwin', execPath }));
    expect((await run('/Applications/YouCoded.app/Contents/MacOS/YouCoded')).installRefused).toBe(false);
    expect((await run('/Applications/YouCoded 2.app/Contents/MacOS/YouCoded')).installRefused).toBe(true);
    expect((await run('/private/var/folders/x/AppTranslocation/ABC/d/YouCoded.app/Contents/MacOS/YouCoded')).installRefused).toBe(true);
  });

  it('Windows needs a password only for a per-machine install under Program Files', async () => {
    const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
    const win = (execPath: string) => computeInstallFacts(base({ platform: 'win32', execPath, env }));
    expect((await win('C:\\Program Files\\YouCoded\\YouCoded.exe')).needsPassword).toBe(true);
    expect((await win('c:\\program files (x86)\\YouCoded\\YouCoded.exe')).needsPassword).toBe(true);
    expect((await win('C:\\Users\\u\\AppData\\Local\\Programs\\YouCoded\\YouCoded.exe')).needsPassword).toBe(false);
    // a folder that merely starts with the same letters is not Program Files
    expect(isWindowsPerMachinePath('C:\\Program Files Evil\\a.exe', env)).toBe(false);
  });
});
