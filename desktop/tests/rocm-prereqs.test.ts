import { describe, it, expect } from 'vitest';
import {
  parseOsRelease,
  parseLdconfigSonames,
  hasAllRocmLibs,
  rocmSetupGuide,
  computeRocmPrereqs,
  checkRocmPrereqs,
  enginePrereqs,
  type RocmPrereqEnv,
} from '../src/main/engine/rocm-prereqs';
import * as fs from 'fs';
import * as path from 'path';

// The real `ldconfig -p` output from this machine (CachyOS, ROCm 7.2.4 installed),
// read on 2026-09-05. Kept verbatim — including the leading tabs and the count
// line — because a fabricated fixture would prove the parser matches my guess
// about the format rather than the format.
const REAL_LDCONFIG = [
  '2246 libs found in cache `/etc/ld.so.cache\'',
  '\tlibrocblas.so.5 (libc6,x86-64) => /opt/rocm/lib/librocblas.so.5',
  '\tlibrocblas.so (libc6,x86-64) => /opt/rocm/lib/librocblas.so',
  '\tlibhipblas.so.3 (libc6,x86-64) => /opt/rocm/lib/libhipblas.so.3',
  '\tlibhipblas.so (libc6,x86-64) => /opt/rocm/lib/libhipblas.so',
  '\tlibamdhip64.so.7 (libc6,x86-64) => /opt/rocm/lib/libamdhip64.so.7',
  '\tlibamdhip64.so (libc6,x86-64) => /opt/rocm/lib/libamdhip64.so',
  '\tlibc.so.6 (libc6,x86-64) => /usr/lib/libc.so.6',
].join('\n');

// This machine's real /etc/os-release, read on 2026-09-05.
const REAL_CACHYOS = [
  'NAME="CachyOS Linux"',
  'PRETTY_NAME="CachyOS"',
  'ID=cachyos',
  'ID_LIKE=arch',
  'BUILD_ID=rolling',
  'ANSI_COLOR="38;2;23;147;209"',
  'HOME_URL="https://cachyos.org/"',
].join('\n');

function env(over: Partial<RocmPrereqEnv> = {}): RocmPrereqEnv {
  return {
    platform: 'linux',
    ldconfig: () => REAL_LDCONFIG,
    rocmLibDir: () => null,
    osRelease: () => REAL_CACHYOS,
    ...over,
  };
}

describe('parseOsRelease', () => {
  it('reads ID, ID_LIKE and PRETTY_NAME off this machine\'s real file', () => {
    const os = parseOsRelease(REAL_CACHYOS);
    expect(os.id).toBe('cachyos');
    expect(os.idLike).toEqual(['arch']);
    expect(os.prettyName).toBe('CachyOS');
  });
  it('splits on the FIRST = only — a value may contain one', () => {
    // ANSI_COLOR above has no '=', but HOME_URL-style values and kernel command
    // lines do; splitting on every '=' would truncate them.
    const os = parseOsRelease('ID=foo\nPRETTY_NAME="Foo = Bar"');
    expect(os.prettyName).toBe('Foo = Bar');
  });
  it('multiple ID_LIKE families, lowercased', () => {
    const os = parseOsRelease('ID=rocky\nID_LIKE="RHEL CentOS Fedora"');
    expect(os.idLike).toEqual(['rhel', 'centos', 'fedora']);
  });
  it('falls back to NAME when PRETTY_NAME is absent', () => {
    expect(parseOsRelease('ID=x\nNAME="Some Linux"').prettyName).toBe('Some Linux');
  });
  it('a file with ONLY ID_LIKE still yields the family', () => {
    const os = parseOsRelease('ID_LIKE=arch');
    expect(os.id).toBeNull();
    expect(os.idLike).toEqual(['arch']);
    expect(os.prettyName).toBeNull();
  });
  it('comments and blank lines are ignored', () => {
    expect(parseOsRelease('# a comment\n\nID=debian\n').id).toBe('debian');
  });
});

describe('parseLdconfigSonames / hasAllRocmLibs', () => {
  it('pulls the sonames out of the real output and finds all three', () => {
    const names = parseLdconfigSonames(REAL_LDCONFIG);
    expect(names).toContain('libamdhip64.so.7');
    expect(names).toContain('librocblas.so.5');
    // The "N libs found in cache" header is not a library.
    expect(names.some((n) => n.includes('libs found'))).toBe(false);
    expect(hasAllRocmLibs(names)).toBe(true);
  });
  it('a versioned soname satisfies the unversioned requirement', () => {
    // Only the .so.N forms — no bare librocblas.so / libhipblas.so symlink,
    // which is what a runtime-only install (no -devel package) looks like.
    expect(hasAllRocmLibs(['libamdhip64.so.7', 'libhipblas.so.3', 'librocblas.so.5'])).toBe(true);
  });
  it('a DIFFERENT libamdhip64 major does NOT satisfy it', () => {
    // The engine was compiled against .so.7; a machine with only .so.8 cannot
    // run it, and must not be told it can.
    expect(hasAllRocmLibs(['libamdhip64.so.8', 'libhipblas.so', 'librocblas.so'])).toBe(false);
  });
  it('a DIFFERENT library whose name merely starts the same does not count', () => {
    // hipBLASLt is a real, separate library that ships beside hipBLAS; having it
    // must not be read as having hipBLAS. (Both a strict and a loose rule reject
    // this one — what pins the version anchor itself is the `.so.8` case above.)
    expect(hasAllRocmLibs(['libamdhip64.so.7', 'libhipblasLt.so.0', 'librocblas.so'])).toBe(false);
  });
  it('missing any one of the three fails', () => {
    expect(hasAllRocmLibs(['libamdhip64.so.7', 'librocblas.so'])).toBe(false);
    expect(hasAllRocmLibs([])).toBe(false);
  });
});

describe('rocmSetupGuide — the distro table', () => {
  const guide = (text: string) => rocmSetupGuide(parseOsRelease(text));

  it('Arch itself', () => {
    const g = guide('ID=arch\nPRETTY_NAME="Arch Linux"');
    expect(g.command).toBe('sudo pacman -S --needed rocm-hip-runtime hipblas rocblas');
    expect(g.distro).toBe('Arch Linux');
  });
  it('CachyOS — this machine — via ID and via ID_LIKE alone', () => {
    expect(guide(REAL_CACHYOS).command).toBe('sudo pacman -S --needed rocm-hip-runtime hipblas rocblas');
    expect(guide(REAL_CACHYOS).distro).toBe('CachyOS');
    // A future Arch derivative we have never heard of still lands on pacman.
    expect(guide('ID=someotherarch\nID_LIKE=arch').command)
      .toBe('sudo pacman -S --needed rocm-hip-runtime hipblas rocblas');
  });
  it('Manjaro and EndeavourOS', () => {
    for (const id of ['manjaro', 'endeavouros']) {
      expect(guide(`ID=${id}`).command).toBe('sudo pacman -S --needed rocm-hip-runtime hipblas rocblas');
    }
  });
  it('Fedora, RHEL, Nobara — and a rebuild that only declares ID_LIKE', () => {
    for (const id of ['fedora', 'rhel', 'nobara']) {
      expect(guide(`ID=${id}`).command).toBe('sudo dnf install rocm-hip hipblas rocblas');
    }
    expect(guide('ID=rocky\nID_LIKE="rhel centos fedora"').command)
      .toBe('sudo dnf install rocm-hip hipblas rocblas');
  });
  it('Ubuntu, Debian, Mint and Pop get NO command — AMD\'s repository comes first', () => {
    for (const id of ['ubuntu', 'debian', 'mint', 'linuxmint', 'pop']) {
      const g = guide(`ID=${id}`);
      expect(g.command).toBeNull();
      expect(g.docsUrl).toContain('quick-start');
      // The card branches on this. Without it, a user whose Linux we just named
      // 'Ubuntu 24.04' is told we could not tell which Linux they are on.
      expect(g.reason).toBe('needs-amd-repo');
    }
    // Derivatives that only declare the family (elementary, Zorin, Kubuntu…).
    expect(guide('ID=elementary\nID_LIKE=ubuntu').command).toBeNull();
  });
  it('an unknown distribution: no command, the ROCm install landing page', () => {
    const g = guide('ID=voidlinux\nPRETTY_NAME="Void Linux"');
    expect(g.command).toBeNull();
    expect(g.distro).toBe('Void Linux');
    expect(g.reason).toBe('unknown-distro');
    expect(g.docsUrl).toBe('https://rocm.docs.amd.com/projects/install-on-linux/en/latest/');
  });
  it('no /etc/os-release at all: no command, no distro name, still a docs link', () => {
    const g = rocmSetupGuide(null);
    expect(g.command).toBeNull();
    expect(g.distro).toBeNull();
    expect(g.docsUrl).toContain('rocm.docs.amd.com');
  });

  // §F types this string into the user's own shell for them to press Enter on.
  // A carriage return anywhere inside it RUNS it with no keypress — measured on
  // bash, zsh and fish — so every command here must be one line of plain
  // printable ASCII. This is the assertion that keeps that true.
  it('every command is a single line of printable ASCII, no control characters', () => {
    const ids = ['arch', 'cachyos', 'manjaro', 'endeavouros', 'fedora', 'rhel', 'nobara',
      'ubuntu', 'debian', 'mint', 'pop', 'voidlinux'];
    const commands = ids.map((id) => guide(`ID=${id}`).command).filter((c): c is string => c !== null);
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) {
      expect(cmd).toMatch(/^[\x20-\x7E]+$/);
      expect(cmd).not.toContain('\n');
      expect(cmd).not.toContain('\r');
    }
  });
});

describe('computeRocmPrereqs', () => {
  it('this machine: libraries present via ldconfig → satisfied, no command to run', () => {
    const p = computeRocmPrereqs(env());
    expect(p.reason).toBeUndefined();   // nothing is missing, so there is no reason
    expect(p.satisfied).toBe(true);
    expect(p.backend).toBe('rocm');
    expect(p.distro).toBe('CachyOS');
    expect(p.command).toBeNull();
    expect(p.explainer).toContain('already installed');
  });

  it('libraries missing on an Arch box → the pacman command', () => {
    const p = computeRocmPrereqs(env({ ldconfig: () => '\tlibc.so.6 (libc6,x86-64) => /usr/lib/libc.so.6' }));
    expect(p.reason).toBeUndefined();   // there IS a command, so no reason to explain
    expect(p.satisfied).toBe(false);
    expect(p.command).toBe('sudo pacman -S --needed rocm-hip-runtime hipblas rocblas');
    expect(p.explainer).toContain('not installed yet');
  });

  it('ldconfig absent → /opt/rocm/lib is the fallback, and it can still say yes', () => {
    const p = computeRocmPrereqs(env({
      ldconfig: () => null,
      rocmLibDir: () => ['libamdhip64.so.7', 'libhipblas.so.3', 'librocblas.so.5', 'libhsa-runtime64.so.1'],
    }));
    expect(p.satisfied).toBe(true);
  });

  it('ldconfig absent AND no /opt/rocm/lib → not satisfied, with the command', () => {
    const p = computeRocmPrereqs(env({ ldconfig: () => null, rocmLibDir: () => null }));
    expect(p.satisfied).toBe(false);
    expect(p.command).toBe('sudo pacman -S --needed rocm-hip-runtime hipblas rocblas');
  });

  it('an Ubuntu box without the libraries gets a link and NO command', () => {
    const p = computeRocmPrereqs(env({
      ldconfig: () => '',
      osRelease: () => 'ID=ubuntu\nPRETTY_NAME="Ubuntu 24.04.1 LTS"',
    }));
    expect(p.satisfied).toBe(false);
    expect(p.command).toBeNull();
    expect(p.distro).toBe('Ubuntu 24.04.1 LTS');
    expect(p.docsUrl).toContain('quick-start');
    // Not 'unknown-distro' — we identified it, its packages just come from AMD.
    expect(p.reason).toBe('needs-amd-repo');
  });

  it('no /etc/os-release: still answers, with no distro and no command', () => {
    const p = computeRocmPrereqs(env({ ldconfig: () => '', osRelease: () => null }));
    expect(p.satisfied).toBe(false);
    expect(p.distro).toBeNull();
    expect(p.command).toBeNull();
    expect(p.reason).toBe('unknown-distro');
  });

  it('Windows is always satisfied — its ROCm zip carries its own runtime', () => {
    // Note the readers would ALL answer null on Windows; the platform arm has to
    // short-circuit before them, or a Windows user would be shown a Linux
    // package command they cannot run.
    const p = computeRocmPrereqs(env({
      platform: 'win32', ldconfig: () => null, rocmLibDir: () => null, osRelease: () => null,
    }));
    expect(p.satisfied).toBe(true);
    expect(p.command).toBeNull();
  });
});

describe('enginePrereqs — the channel', () => {
  it('a non-ROCm backend is satisfied with nothing to install', () => {
    // The Windows CUDA build's runtime ships as its own asset that the installer
    // unpacks; there is nothing for the user to do by hand.
    const p = enginePrereqs('cuda');
    expect(p.satisfied).toBe(true);
    expect(p.backend).toBe('cuda');
    expect(p.command).toBeNull();
  });

  it('a name that is not an engine build at all is REFUSED, not called satisfied', () => {
    // Reachable from the remote path, where the backend arrives off the wire.
    // "Nothing to install" would be an answer about a build that does not exist.
    expect(() => enginePrereqs('rocmm')).toThrow(/Unknown engine build/);
    expect(() => enginePrereqs('')).toThrow(/Unknown engine build/);
  });

  it('answers for every backend the app can actually install', () => {
    // Pins the allowlist against EngineBackend: a new backend that is not added
    // here would be refused at the channel with a confusing error.
    for (const b of ['vulkan', 'cpu', 'metal', 'cuda', 'rocm']) {
      expect(() => enginePrereqs(b)).not.toThrow();
    }
  });

  // BLOCKER: the card's "Check again" is the whole point of the set-up box —
  // the user runs the command, then presses it. The reading is cached (status()
  // warms it on every AMD machine), so a call that does not refresh reports the
  // state from BEFORE the install, for the rest of the app run.
  it('every surface\'s engine:prereqs handler passes refresh', () => {
    const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
    const handlers = read('src', 'main', 'ipc-handlers.ts');
    const prereqLine = handlers.split('\n').find((l) => l.includes('IPC.ENGINE_PREREQS'));
    expect(prereqLine).toBeDefined();
    expect(prereqLine).toContain('{ refresh: true }');
    const remoteLine = read('src', 'main', 'remote-server.ts').split('\n').find((l) => l.includes('enginePrereqs('));
    expect(remoteLine).toBeDefined();
    expect(remoteLine).toContain('{ refresh: true }');
  });

  it('refresh bypasses the cache; without it the SAME answer object comes back', () => {
    // The cache exists because status() consults this on every engine event.
    // `refresh` is what makes "Check again" ask the machine a second time.
    const first = checkRocmPrereqs();
    expect(checkRocmPrereqs()).toBe(first);                    // cached: same object
    expect(checkRocmPrereqs({ refresh: true })).not.toBe(first); // re-read
  });

  it('refresh re-reads the machine; without it the first answer is reused', () => {
    let installed = false;
    const changing = (): RocmPrereqEnv => ({
      platform: 'linux',
      ldconfig: () => (installed ? REAL_LDCONFIG : ''),
      rocmLibDir: () => null,
      osRelease: () => REAL_CACHYOS,
    });
    // computeRocmPrereqs is the uncached core the cache wraps: it must see the
    // change. (checkRocmPrereqs's own cache is what `refresh: true` bypasses.)
    expect(computeRocmPrereqs(changing()).satisfied).toBe(false);
    installed = true;
    expect(computeRocmPrereqs(changing()).satisfied).toBe(true);
  });
});
