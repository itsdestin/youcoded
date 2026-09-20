import { describe, it, expect } from 'vitest';
import { detectLinuxInstallKind, type LinuxInstallKind } from '../src/main/linux-install-kind';

// The question the updater asks before it downloads anything. Getting it wrong
// cost an Arch user a 180 MB AppImage that could not be applied (2026-09-20).

const EXEC = '/opt/YouCoded/youcoded';

/** A machine where exactly one package manager claims to own the binary. */
function owner(kind: 'pacman' | 'dpkg' | 'rpm' | null) {
  return (cmd: string, args: string[]) => {
    expect(args).toContain(EXEC); // every query asks about the running binary
    if (cmd === kind) return 0;
    // A package manager that is installed but does not own the file exits 1;
    // one that is not installed at all never starts, which defaultRun reads as null.
    return cmd === 'pacman' || cmd === 'dpkg' || cmd === 'rpm' ? 1 : null;
  };
}

const detect = (over: Parameters<typeof detectLinuxInstallKind>[0] = {}) =>
  detectLinuxInstallKind({ platform: 'linux', execPath: EXEC, exists: () => true, run: owner(null), ...over });

describe('detectLinuxInstallKind', () => {
  it('reads a running AppImage from $APPIMAGE, before asking any package manager', () => {
    const asked: string[] = [];
    const kind = detect({
      envAppImage: '/home/u/Apps/YouCoded.AppImage',
      run: (cmd) => { asked.push(cmd); return 0; },
    });
    expect(kind).toBe('appimage');
    expect(asked).toEqual([]);
  });

  it('ignores a stale $APPIMAGE pointing at a file that is gone', () => {
    // Left over in the environment of a shell that launched the packaged app.
    expect(detect({ envAppImage: '/tmp/deleted.AppImage', exists: () => false, run: owner('pacman') })).toBe('pacman');
  });

  const CASES: Array<['pacman' | 'dpkg' | 'rpm', LinuxInstallKind]> = [
    ['pacman', 'pacman'],
    ['dpkg', 'deb'],
    ['rpm', 'rpm'],
  ];
  for (const [cmd, kind] of CASES) {
    it(`reports ${kind} when ${cmd} owns the binary`, () => {
      expect(detect({ run: owner(cmd) })).toBe(kind);
    });
  }

  it('reports unknown when nothing owns the binary — a dev checkout or a tarball', () => {
    expect(detect({ run: owner(null) })).toBe('unknown');
  });

  it('reports unknown when no package manager is even installed', () => {
    expect(detect({ run: () => null })).toBe('unknown');
  });

  it('is unknown off Linux, without running anything', () => {
    const asked: string[] = [];
    const kind = detectLinuxInstallKind({ platform: 'win32', run: (cmd) => { asked.push(cmd); return 0; } });
    expect(kind).toBe('unknown');
    expect(asked).toEqual([]);
  });
});
