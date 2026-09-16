// Does this Linux machine already have the AMD system libraries the ROCm engine
// build loads at startup — and if not, what does the user type to get them?
// (Design 2026-09-05 local-engine upgrades §A3.)
//
// WHY this file exists at all: the Windows ROCm zip is self-contained (it bundles
// amdhip64_7.dll), but the LINUX tarball is not — listing b10665's 62 entries on
// 2026-09-05 found libggml-hip.so and no HIP or BLAS library at all (see the
// comment on EngineAsset.runtime in engine-pin.ts). So on Linux the HIP runtime
// and the two BLAS libraries have to already be on the machine. Offering the
// faster engine to someone who does not have them means the download succeeds,
// the switch "works", and then the engine dies at the first model load with a
// linker error — strictly worse than never offering it.
//
// Everything here is pure except `checkRocmPrereqs`, and even that funnels the
// two readings it takes (`ldconfig -p`, /etc/os-release) through `computeRocmPrereqs`,
// so every branch — including "ldconfig is not installed" and "there is no
// /etc/os-release" — is reachable from a test without a fixture machine.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import type { EngineBackend, EnginePrereqs } from '../../shared/engine-types';

/** The three libraries the ROCm build links against.
 *
 *  `libamdhip64.so.7` is pinned to its major version on purpose: that number is
 *  the ABI the b10665 build was compiled against (upstream's own Windows zip
 *  ships `amdhip64_7.dll`), so a machine carrying only a future `.so.8` genuinely
 *  cannot run it and must not be told it can. The two BLAS libraries are matched
 *  by NAME rather than version — the build resolves whichever soname the
 *  distribution ships, and pinning a number there would reject working machines. */
const REQUIRED_LIBS = ['libamdhip64.so.7', 'libhipblas.so', 'librocblas.so'] as const;

/** Where a distribution-packaged ROCm puts its libraries when `ldconfig` has not
 *  been told about it (this is where Arch's own packages land — verified on
 *  CachyOS 2026-09-05: every one of the three resolves to /opt/rocm/lib). */
const ROCM_LIB_DIR = '/opt/rocm/lib';

// AMD's two documentation pages. The quick-start is the one to send a Debian or
// Ubuntu user to, because on those distributions the packages do NOT come from
// the distribution at all — AMD's repository has to be registered first
// (verified 2026-09-05: the page's Ubuntu/Debian path begins by installing
// amdgpu-install from repo.radeon.com). There is no honest one-line command for
// that, so those families get a link instead of something to paste.
const AMD_QUICK_START = 'https://rocm.docs.amd.com/projects/install-on-linux/en/latest/install/quick-start.html';
const AMD_INSTALL_LANDING = 'https://rocm.docs.amd.com/projects/install-on-linux/en/latest/';

/** The engine builds that exist. `enginePrereqs` answers for these and refuses
 *  anything else, rather than reporting a name it does not recognise as needing
 *  nothing. Mirrors `EngineBackend` in shared/engine-types.ts, and
 *  `rocm-prereqs.test.ts` fails if the two drift apart. */
const KNOWN_BACKENDS: ReadonlySet<string> = new Set<EngineBackend>(['vulkan', 'cpu', 'metal', 'cuda', 'rocm']);

/** The parts of /etc/os-release this module cares about. */
export interface OsRelease {
  id: string | null;          // ID= — 'cachyos', 'ubuntu', …
  idLike: string[];           // ID_LIKE= — the families it says it belongs to
  prettyName: string | null;  // PRETTY_NAME= (or NAME=) — what to show the user
}

/** Parse /etc/os-release. Every line is `KEY=value`, where value may be quoted
 *  and may contain '=' itself, so split on the FIRST '=' only. A missing or
 *  unreadable file is handled by the caller passing null, not by throwing. */
export function parseOsRelease(text: string): OsRelease {
  const fields = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one matching pair of quotes; os-release quotes any value with spaces.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    if (key) fields.set(key, value);
  }
  const id = fields.get('ID')?.trim().toLowerCase() || null;
  const idLike = (fields.get('ID_LIKE') ?? '').split(/\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const prettyName = fields.get('PRETTY_NAME')?.trim() || fields.get('NAME')?.trim() || null;
  return { id, idLike, prettyName };
}

/** Does a library file/soname satisfy one of REQUIRED_LIBS?
 *  `librocblas.so.5` satisfies `librocblas.so`; `libhipblasfoo.so` does not. */
function satisfiesLib(soname: string, required: string): boolean {
  return soname === required || soname.startsWith(`${required}.`);
}

/** Read the sonames out of `ldconfig -p` output. Each entry looks like
 *  `\tlibrocblas.so.5 (libc6,x86-64) => /opt/rocm/lib/librocblas.so.5`; the
 *  first line is a count ("6 libs found in cache ...") and is ignored because it
 *  has no ` (` after a .so name. */
export function parseLdconfigSonames(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\S+\.so(?:\.\S+)?)\s+\(/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/** All three required libraries present in this list of sonames/filenames? */
export function hasAllRocmLibs(sonames: readonly string[]): boolean {
  return REQUIRED_LIBS.every((req) => sonames.some((name) => satisfiesLib(name, req)));
}

/** What to tell the user to run, for the Linux flavour they are on.
 *  `command` null means "there is no single honest command for this system" —
 *  either AMD's repository has to be registered first (Debian/Ubuntu) or we do
 *  not recognise the distribution at all. The card then shows docsUrl only.
 *
 *  Package names verified real on 2026-09-05, not guessed:
 *    - Arch: `pacman -Si rocm-hip-runtime hipblas rocblas` → all three in `extra`.
 *    - Fedora: mdapi.fedoraproject.org reports rocm-hip, hipblas and rocblas at 7.14.0.
 *  A wrong name here is a failed `sudo` in the user's own terminal, so it is not
 *  the place for a plausible guess.
 *
 *  Every command MUST stay a single line of plain printable ASCII. §F pastes it
 *  into a real shell for the user to press Enter on, and a carriage return
 *  anywhere inside the string would RUN it with no keypress at all — measured on
 *  bash, zsh and fish. `rocm-prereqs.test.ts` fails on any control character. */
export function rocmSetupGuide(os: OsRelease | null): {
  distro: string | null; command: string | null; docsUrl: string;
  reason?: 'needs-amd-repo' | 'unknown-distro';
} {
  const distro = os?.prettyName ?? null;
  const family = new Set<string>([...(os?.id ? [os.id] : []), ...(os?.idLike ?? [])]);
  const inFamily = (...names: string[]) => names.some((n) => family.has(n));

  // Arch first: CachyOS, Manjaro and EndeavourOS all declare ID_LIKE=arch
  // (verified on this machine — ID=cachyos, ID_LIKE=arch), so the ID_LIKE arm
  // covers the derivatives without listing every one of them.
  if (inFamily('arch', 'cachyos', 'manjaro', 'endeavouros')) {
    return { distro, command: 'sudo pacman -S --needed rocm-hip-runtime hipblas rocblas', docsUrl: AMD_INSTALL_LANDING };
  }
  // Fedora and the RHEL rebuilds ship ROCm in their own repositories; Nobara
  // declares ID_LIKE=fedora, Rocky/Alma declare ID_LIKE="rhel centos fedora".
  if (inFamily('fedora', 'rhel', 'nobara')) {
    return { distro, command: 'sudo dnf install rocm-hip hipblas rocblas', docsUrl: AMD_INSTALL_LANDING };
  }
  // Debian family: no command, on purpose. See AMD_QUICK_START above. The
  // reason matters — we DID recognise this system, so the card must not tell
  // the user we could not.
  if (inFamily('ubuntu', 'debian', 'mint', 'linuxmint', 'pop')) {
    return { distro, command: null, docsUrl: AMD_QUICK_START, reason: 'needs-amd-repo' };
  }
  return { distro, command: null, docsUrl: AMD_INSTALL_LANDING, reason: 'unknown-distro' };
}

/** The readings `computeRocmPrereqs` needs, as an injectable seam so tests can
 *  drive the missing-tool and missing-file cases. Each reader returns null when
 *  the thing it reads is absent or unreadable — never throws. */
export interface RocmPrereqEnv {
  platform: string;
  /** `ldconfig -p` stdout; null when ldconfig is not installed or failed. */
  ldconfig(): string | null;
  /** Filenames in /opt/rocm/lib; null when that directory does not exist. */
  rocmLibDir(): string[] | null;
  /** /etc/os-release contents; null when there is no such file. */
  osRelease(): string | null;
}

export function computeRocmPrereqs(env: RocmPrereqEnv, backend: EngineBackend = 'rocm'): EnginePrereqs {
  // Windows ships its ROCm runtime inside the engine zip, so there is nothing to
  // install and nothing to check — reporting `satisfied` here is what makes the
  // Windows card offer a plain "Switch" instead of a set-up box.
  if (env.platform === 'win32') {
    return {
      backend,
      satisfied: true,
      distro: null,
      command: null,
      docsUrl: AMD_INSTALL_LANDING,
      explainer: 'The AMD engine build for Windows already includes everything it needs.',
    };
  }

  const ldOut = env.ldconfig();
  const fromLdconfig = ldOut !== null && hasAllRocmLibs(parseLdconfigSonames(ldOut));
  // Fallback for a machine where ldconfig is absent (a trimmed container) or has
  // simply never been told about /opt/rocm: the files being there is the fact
  // that matters, and the engine finds them via its own RPATH/LD_LIBRARY_PATH.
  const dirFiles = fromLdconfig ? null : env.rocmLibDir();
  const fromRocmDir = dirFiles !== null && hasAllRocmLibs(dirFiles);

  const osText = env.osRelease();
  const os = osText !== null ? parseOsRelease(osText) : null;
  const guide = rocmSetupGuide(os);
  const satisfied = fromLdconfig || fromRocmDir;

  return {
    backend,
    satisfied,
    distro: guide.distro,
    command: satisfied ? null : guide.command,
    docsUrl: guide.docsUrl,
    // Only meaningful while something is actually missing.
    ...(satisfied || guide.command ? {} : { reason: guide.reason }),
    // One plain sentence, and it has to be TRUE in both states — the card shows
    // it either way. No cause is guessed: we say what the software is and
    // whether we found it, never why it might be missing.
    explainer: satisfied
      ? 'The ROCm engine loads AMD’s ROCm libraries from this computer, and they are already installed.'
      : 'The ROCm engine loads AMD’s ROCm libraries from this computer, and they are not installed yet.',
  };
}

// ---------- the real machine ----------

function realEnv(): RocmPrereqEnv {
  return {
    platform: process.platform,
    ldconfig: () => {
      try {
        // Short timeout + no stderr: a missing ldconfig (it is not on PATH in
        // some minimal images) must degrade to the /opt/rocm/lib check, not stall.
        return execFileSync('ldconfig', ['-p'], {
          timeout: 4000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch { return null; }
    },
    rocmLibDir: () => {
      try { return fs.readdirSync(ROCM_LIB_DIR); } catch { return null; }
    },
    osRelease: () => {
      try { return fs.readFileSync('/etc/os-release', 'utf8'); } catch { return null; }
    },
  };
}

let cached: EnginePrereqs | undefined;

/** Check this machine. Cached, because it shells out and `status()` is called on
 *  every engine event — but `refresh` bypasses the cache, which is what the
 *  card's "Check again" button needs after the user has run the command. */
export function checkRocmPrereqs(opts: { refresh?: boolean } = {}): EnginePrereqs {
  if (cached === undefined || opts.refresh) cached = computeRocmPrereqs(realEnv());
  return cached;
}


/** What the `engine:prereqs` channel answers, for any backend.
 *
 *  ROCm on Linux is the ONLY build with a prerequisite, because it is the only
 *  one whose archive does not carry what it loads (engine-pin.ts documents the
 *  listing that proved it). The Windows CUDA build's missing piece — the CUDA
 *  runtime — ships as its own `runtime` asset that the installer unpacks beside
 *  the binary, so there is nothing for the user to install by hand. Anything
 *  else is reported satisfied rather than left unanswered, so the card can show
 *  a plain "Switch" instead of a set-up box that has nothing to say. */
export function enginePrereqs(backend: string, opts: { refresh?: boolean } = {}): EnginePrereqs {
  if (backend === 'rocm') return checkRocmPrereqs(opts);
  // An allowlist, not a cast. A name that is not a backend at all — a typo from
  // the remote path, say — must not be answered "nothing to install", which is
  // an answer about a build that does not exist.
  if (!KNOWN_BACKENDS.has(backend)) {
    throw new Error(`Unknown engine build: ${backend}`);
  }
  return {
    backend: backend as EngineBackend,
    satisfied: true,
    distro: null,
    command: null,
    // Empty rather than a plausible link: the card only opens docsUrl in the
    // "nothing to install, here is the guide" branch, which `satisfied: true`
    // never reaches — and sending a CUDA user to AMD's page would be worse than
    // sending them nowhere.
    docsUrl: '',
    explainer: 'This engine build brings everything it needs with it.',
  };
}
