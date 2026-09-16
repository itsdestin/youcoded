// Best-effort DEDICATED-GPU VRAM probe (spec §4.3 + Amendment 2026-07-14 F).
// IMPURE + platform-specific. Feeds fit-estimator's optional VRAM input.
//
// CONTRACT / SAFETY BIAS: return a non-null `totalVramBytes` ONLY when a real
// DEDICATED GPU's VRAM was confidently probed. EVERY failure/uncertainty —
// no GPU, an integrated GPU (its "memory" is shared system RAM, so counting it
// would double-count), a probe that throws, an implausible reading — returns
// { name: null, totalVramBytes: null } so the estimator falls back to RAM-only.
// Because a null can never worsen a verdict (see fit-estimator), being wrong in
// the null direction is always safe; being wrong in the non-null direction
// over-promises. So we bias hard toward null.
//
// Every probe is wrapped in try/catch and NEVER throws. Result is cached at
// module level (VRAM is fixed for the process lifetime) so repeat calls — one
// per fit computation in the panel — don't re-shell.
//
// 2026-09-05 (local-engine upgrades §A3): this module also answers "WHICH chip
// is it, and would the vendor's own faster engine build actually run on it?".
// That is a different question from VRAM and has the opposite bias — here a
// wrong answer in either direction is bad. Saying no to a supported chip hides a
// large speed-up; saying yes to an unsupported one downloads a build that dies
// at the first model load, which is worse than never offering it.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import type { GpuInfo, GpuVendor } from '../../shared/model-manager-types';
import type { BackendOption, EngineBackend } from '../../shared/engine-types';
import { pickAsset } from '../engine/engine-pin';

const GB = 1024 ** 3;
// A dedicated GPU floor. Integrated GPUs (Intel iGPU / AMD APU) sometimes report
// a small carve-out via the Windows registry qwMemorySize (128MB–1GB of shared
// RAM); a real discrete card is ≥2GB. Readings below this are treated as
// integrated/implausible → no dedicated VRAM. Conservative on purpose: a
// false-null just means RAM-only, which is the safe direction.
const MIN_DEDICATED_VRAM_BYTES = 2 * GB;
// Reject absurd readings (driver junk / sign-extended garbage) as implausible.
const MAX_PLAUSIBLE_VRAM_BYTES = 1024 * GB;

const NULL_GPU: GpuInfo = { name: null, totalVramBytes: null, vendor: null, gfxTarget: null };

// ---------- pure parse helpers (unit-tested) ----------

export function parseNvidiaSmiMemory(stdout: string): number | null {
  // `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits` → MiB
  // lines, one per GPU. Take the largest. Returns BYTES, or null if unparseable.
  const mibs = stdout.split('\n').map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return mibs.length ? Math.max(...mibs) * 1024 * 1024 : null;
}

// Parses the output of THIS exact PowerShell command (kept in sync with
// `readRegistryVram` below):
//   Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\*'
//     -Name 'HardwareInformation.qwMemorySize' -EA SilentlyContinue |
//     Select-Object -ExpandProperty 'HardwareInformation.qwMemorySize'
// which prints one integer (VRAM in BYTES) per display adapter that carries the
// value — e.g. a 24GB card prints `25757220864`. Adapters without the property
// (many virtual/basic-display drivers) print nothing. Returns the MAX plausible
// value in BYTES, or null if empty/unparseable. WHY qwMemorySize and not
// Win32_VideoController.AdapterRAM: AdapterRAM is a signed 32-bit field that
// caps at 4GB and misreports large cards; qwMemorySize is a reliable 64-bit QWORD.
export function parseRegistryQwMemorySize(stdout: string): number | null {
  const vals = stdout.split('\n').map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= MAX_PLAUSIBLE_VRAM_BYTES);
  return vals.length ? Math.max(...vals) : null;
}

// ---------- which chip is it? (2026-09-05 §A3) ----------

// The PCI vendor ids Linux publishes at /sys/class/drm/card*/device/vendor.
// 0x1002 is AMD (it is ATI's original id, which AMD kept); 0x10de NVIDIA;
// 0x8086 Intel. Verified on this machine 2026-09-05: the one card present,
// card1, reads 0x1002.
const PCI_VENDORS: Record<string, GpuVendor> = {
  '0x1002': 'amd', '0x10de': 'nvidia', '0x8086': 'intel',
};

/** One `/sys/class/drm/card*​/device/vendor` reading → vendor. Unknown ids
 *  (virtual displays, a vendor we have no build for) → null. */
export function parseDrmVendorId(raw: string): GpuVendor | null {
  const id = raw.trim().toLowerCase();
  return PCI_VENDORS[id] ?? null;
}

/** Several cards → one answer. A laptop routinely has two: an Intel or AMD
 *  integrated chip AND a discrete card. We rank by "is there a faster engine
 *  build for it" — NVIDIA, then AMD, then Intel — because that is the only
 *  decision this vendor is used for. Picking the wrong one of an AMD+Intel pair
 *  would hide the ROCm option from a machine that can use it. */
export function pickVendor(found: ReadonlyArray<GpuVendor | null>): GpuVendor | null {
  const order: GpuVendor[] = ['nvidia', 'amd', 'intel'];
  for (const v of order) if (found.includes(v)) return v;
  return null;
}

/** The kernel's `gfx_target_version` integer → the ROCm target name.
 *
 *  The integer is `major*10000 + minor*100 + step`, and the NAME writes minor
 *  and step in HEX while major stays decimal: 110501 → 11, 5, 1 → 'gfx1151'
 *  (this machine, read from kfd node 1 on 2026-09-05); 90010 → 9, 0, 10 →
 *  'gfx90a', which is exactly why the hex matters — a decimal render would say
 *  'gfx9010' and match nothing in the engine's compiled-target list.
 *
 *  0 means "this node is not a GPU". Every AMD machine has at least one such
 *  node: the kfd topology lists the CPU as node 0 (confirmed here — node 0
 *  reads 0, node 1 reads 110501), so treating 0 as a target would produce
 *  'gfx000' for every AMD machine on earth. */
export function gfxTargetName(version: number): string | null {
  // One guard, not two: anything under 10000 has no major number at all, which
  // covers the CPU node's 0 and any junk short of a real target. (A second
  // `major <= 0` check further down was dead weight — it made the 0 case
  // survive a deliberate break of this line, so the test could not prove it.)
  // AMD's own rocm_agent_enumerator writes the major as `(id / 10000) % 100`;
  // the plain divide here differs only for a three-digit major, which no
  // shipping target has, and errs toward a name that matches nothing (a refusal)
  // rather than toward mis-naming a real chip.
  if (!Number.isFinite(version) || version < 10000) return null;
  const major = Math.floor(version / 10000);
  const minor = Math.floor(version / 100) % 100;
  const step = version % 100;
  return `gfx${major}${minor.toString(16)}${step.toString(16)}`;
}

/** Pull `gfx_target_version` out of one kfd node's `properties` file. The file
 *  is one `key value` pair per line. Absent/unparseable → null. */
export function parseKfdGfxTargetVersion(properties: string): number | null {
  const m = /^gfx_target_version\s+(\d+)\s*$/m.exec(properties);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Windows has no kfd and no sysfs, so the vendor comes from the display
 *  adapter's driver strings. Parses the output of the PowerShell command in
 *  `readWindowsAdapterStrings` below — one `DriverDesc` / `ProviderName` value
 *  per line. First recognised line wins, in the same NVIDIA→AMD→Intel order and
 *  for the same reason as `pickVendor`. */
export function parseWindowsAdapterVendor(stdout: string): GpuVendor | null {
  const found: Array<GpuVendor | null> = [];
  for (const line of stdout.split('\n')) {
    const s = line.trim().toLowerCase();
    if (!s) continue;
    if (s.includes('nvidia')) found.push('nvidia');
    // 'Advanced Micro Devices' is what ProviderName carries; DriverDesc says
    // 'AMD Radeon …' or, on older drivers, 'ATI …'.
    else if (s.includes('advanced micro devices') || /\bamd\b/.test(s) || /\bati\b/.test(s) || s.includes('radeon')) found.push('amd');
    else if (s.includes('intel')) found.push('intel');
  }
  return pickVendor(found);
}

// Intel Macs: parse `system_profiler SPDisplaysDataType` for a line like
// `VRAM (Total): 4 GB` or `VRAM (Dynamic, Max): 1536 MB`. Returns BYTES or null.
export function parseSystemProfilerVram(stdout: string): number | null {
  const re = /VRAM\s*\([^)]*\)\s*:\s*([\d.]+)\s*(MB|GB)/gi;
  let best: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const bytes = m[2].toUpperCase() === 'GB' ? n * GB : n * 1024 * 1024;
    if (best === null || bytes > best) best = bytes;
  }
  return best;
}

// ---------- impure probes (best-effort, never throw) ----------

function runCmd(file: string, args: string[]): string | null {
  try {
    // Short timeout so a hung/absent tool can't stall the panel; windowsHide
    // keeps a console flash from appearing.
    return execFileSync(file, args, {
      timeout: 4000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // tool missing, non-zero exit, or timeout — all non-fatal.
  }
}

function readNvidiaSmiVram(): number | null {
  const out = runCmd('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']);
  return out ? parseNvidiaSmiMemory(out) : null;
}

function readNvidiaSmiName(): string | null {
  const out = runCmd('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
  if (!out) return null;
  const first = out.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return first ?? null;
}

function readRegistryVram(): number | null {
  const cmd =
    "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*' " +
    "-Name 'HardwareInformation.qwMemorySize' -EA SilentlyContinue | " +
    "Select-Object -ExpandProperty 'HardwareInformation.qwMemorySize'";
  const out = runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd]);
  return out ? parseRegistryQwMemorySize(out) : null;
}

// The display-adapter class key. Same GUID the VRAM probe above reads, but for
// the two driver STRINGS rather than the memory QWORD, so a machine with no
// nvidia-smi can still be identified as AMD.
//
// `ForEach-Object` and NOT `Select-Object -ExpandProperty 'DriverDesc','ProviderName'`:
// -ExpandProperty takes a SINGLE property name (Microsoft's reference says so
// outright — "Multiple properties cannot be expanded"), so the two-name form
// errors, prints nothing, and would leave `vendor` null on every non-NVIDIA
// Windows machine — silently switching the Windows-AMD → ROCm offer off
// altogether. ForEach-Object also gives the one-value-per-line shape
// `parseWindowsAdapterVendor` reads.
function readWindowsAdapterStrings(): string | null {
  const cmd =
    "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*' " +
    "-EA SilentlyContinue | ForEach-Object { $_.DriverDesc; $_.ProviderName }";
  return runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd]);
}

function readLinuxVendor(): GpuVendor | null {
  // Card numbering is NOT dense and does not start at 0 — this machine's only
  // GPU is card1, with no card0 at all. The same directory also holds connector
  // entries (card1-DP-1, card1-eDP-1); `^card\d+$` is what excludes them.
  try {
    const base = '/sys/class/drm';
    const found: Array<GpuVendor | null> = [];
    for (const card of fs.readdirSync(base).filter((d) => /^card\d+$/.test(d))) {
      try {
        found.push(parseDrmVendorId(fs.readFileSync(`${base}/${card}/device/vendor`, 'utf8')));
      } catch { /* a card without the file — skip. */ }
    }
    return pickVendor(found);
  } catch {
    return null;  // no /sys/class/drm at all (a container) — unknown, not "none".
  }
}

function readLinuxGfxTarget(): string | null {
  // /sys/class/kfd only exists when amdkfd — AMD's compute driver — is loaded.
  // No kfd (an NVIDIA-only box, an AMD machine with the compute driver disabled,
  // a container without /sys) means we cannot know the target, so ROCm is not
  // offered. That is the safe direction: a missing answer costs a speed-up, a
  // wrong one costs a broken engine.
  const base = '/sys/class/kfd/kfd/topology/nodes';
  let nodes: string[] = [];
  try { nodes = fs.readdirSync(base); } catch { return null; }
  // Node order is the kernel's; sort numerically so "the first GPU" is stable
  // rather than dependent on readdir order. Node 0 is the CPU and reads 0.
  const ordered = nodes.filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(a) - Number(b));
  for (const node of ordered) {
    try {
      const v = parseKfdGfxTargetVersion(fs.readFileSync(`${base}/${node}/properties`, 'utf8'));
      const name = v === null ? null : gfxTargetName(v);
      if (name) return name;   // first real GPU node wins (multi-GPU: the lowest-numbered one)
    } catch { /* unreadable node — skip. */ }
  }
  return null;
}

function detectWindows(): GpuInfo {
  // nvidia-smi is authoritative (only ever present for a real NVIDIA discrete
  // card). The registry QWORD can include an iGPU carve-out, so gate it on the
  // dedicated floor; then take the larger of the two confident readings.
  const smi = readNvidiaSmiVram();
  const reg = readRegistryVram();
  // Vendor is answered SEPARATELY from VRAM and without the dedicated floor: an
  // AMD laptop chip reports no dedicated VRAM at all, and would still be offered
  // ROCm. nvidia-smi only ever exists for a real NVIDIA card, so its presence is
  // proof on its own; otherwise fall back to the adapter's driver strings.
  // The second PowerShell call is skipped entirely when nvidia-smi already answered.
  const adapters = smi != null ? null : readWindowsAdapterStrings();
  const vendor: GpuVendor | null = smi != null ? 'nvidia'
    : (adapters ? parseWindowsAdapterVendor(adapters) : null);
  const regDedicated = reg != null && reg >= MIN_DEDICATED_VRAM_BYTES ? reg : null;
  const candidates = [smi, regDedicated].filter((n): n is number => n != null && n >= MIN_DEDICATED_VRAM_BYTES);
  // gfxTarget is null on Windows: the kfd topology is a Linux kernel interface
  // and Windows publishes no equivalent, so the Windows ROCm gate cannot use it.
  if (!candidates.length) return { ...NULL_GPU, vendor };
  const totalVramBytes = Math.max(...candidates);
  // Name is diagnostics-only; only trust it when nvidia-smi produced the figure.
  const name = smi != null ? readNvidiaSmiName() : null;
  return { name, totalVramBytes, vendor, gfxTarget: null };
}

function detectMac(): GpuInfo {
  // Apple Silicon = unified memory: the GPU shares system RAM, so its usable
  // working set is a fraction of total RAM (Metal caps the GPU allocation).
  // 0.7 mirrors the estimator's RAM headroom — the model still runs on the
  // "GPU" here, which is why we DO surface a VRAM figure on Apple Silicon.
  if (process.arch === 'arm64') {
    // 'apple' with no gfxTarget: there is nothing faster to offer — Metal is
    // already the vendor's own backend and is what macOS installs by default.
    return {
      name: 'Apple Silicon (unified memory)', totalVramBytes: Math.floor(os.totalmem() * 0.7),
      vendor: 'apple', gfxTarget: null,
    };
  }
  // Intel Mac: a discrete/embedded GPU reports VRAM via system_profiler. The
  // vendor is left null rather than guessed — an Intel Mac's card may be AMD,
  // Intel or NVIDIA, and no faster build exists for any of them on macOS.
  const out = runCmd('system_profiler', ['SPDisplaysDataType']);
  const vram = out ? parseSystemProfilerVram(out) : null;
  if (vram == null || vram < MIN_DEDICATED_VRAM_BYTES) return NULL_GPU;
  return { name: null, totalVramBytes: vram, vendor: null, gfxTarget: null };
}

function readAmdSysfsVram(): number | null {
  // AMD discrete cards expose total VRAM in BYTES at
  // /sys/class/drm/card*/device/mem_info_vram_total. Take the max across cards.
  try {
    const base = '/sys/class/drm';
    const cards = fs.readdirSync(base).filter((d) => /^card\d+$/.test(d));
    let best: number | null = null;
    for (const card of cards) {
      try {
        const raw = fs.readFileSync(`${base}/${card}/device/mem_info_vram_total`, 'utf8').trim();
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0 && (best === null || n > best)) best = n;
      } catch {
        /* card without the file (iGPU / non-AMD) — skip. */
      }
    }
    return best;
  } catch {
    return null;
  }
}

function detectLinux(): GpuInfo {
  // Vendor and gfx target are read FIRST and unconditionally: they are what the
  // faster-engine gate needs, and the VRAM branches below all return early. An
  // AMD laptop chip falls through every VRAM branch to NULL_GPU, and losing its
  // vendor there would silently withhold ROCm from exactly the machines this
  // feature was built for.
  const vendor = readLinuxVendor();
  const gfxTarget = vendor === 'amd' ? readLinuxGfxTarget() : null;
  // NVIDIA first (authoritative + carries a name), then AMD sysfs.
  const smi = readNvidiaSmiVram();
  if (smi != null && smi >= MIN_DEDICATED_VRAM_BYTES) {
    // nvidia-smi answering is proof of an NVIDIA card even when /sys/class/drm
    // named something else (a hybrid laptop whose panel hangs off the iGPU).
    return { name: readNvidiaSmiName(), totalVramBytes: smi, vendor: 'nvidia', gfxTarget: null };
  }
  const amd = readAmdSysfsVram();
  if (amd != null && amd >= MIN_DEDICATED_VRAM_BYTES) {
    return { name: null, totalVramBytes: amd, vendor: vendor ?? 'amd', gfxTarget };
  }
  return { ...NULL_GPU, vendor, gfxTarget };
}

let cached: GpuInfo | undefined;

/** Best-effort dedicated-VRAM probe. Cached; never throws. Non-null VRAM only
 *  on a confidently-detected dedicated GPU (incl. Apple Silicon unified mem). */
export async function detectGpu(): Promise<GpuInfo> {
  if (cached !== undefined) return cached;
  try {
    switch (process.platform) {
      case 'win32': cached = detectWindows(); break;
      case 'darwin': cached = detectMac(); break;
      case 'linux': cached = detectLinux(); break;
      default: cached = NULL_GPU;
    }
  } catch {
    // Belt-and-suspenders: the platform helpers already swallow their own
    // errors, but a top-level throw must still degrade to RAM-only.
    cached = NULL_GPU;
  }
  return cached;
}

// ---------- which faster engine build may this machine be offered? (§A3) ----------

/** Plain-language labels. `EngineCard` writes its own row text today, but the
 *  option carries one so a remote or Android surface has something to render.
 *
 *  WHY ROCm no longer says "faster on AMD": that was never measured, and when it
 *  finally was (2026-09-05, engine b10665, AMD Strix Halo / Radeon 8060S, two
 *  models, 200 forced tokens, speculation off) ROCm read the prompt ~20% faster
 *  and WROTE the reply 24–46% SLOWER than the Vulkan build it replaces. Writing
 *  is the half a user sits and watches, so "faster" was false for the part that
 *  matters. The label now names the trade instead of promising a win. Numbers
 *  and method: docs/engine-dependencies.md → "ROCm vs Vulkan, measured". */
const BACKEND_LABELS: Partial<Record<EngineBackend, string>> = {
  cuda: 'Switch to CUDA (faster on NVIDIA)',
  rocm: 'Try ROCm (AMD) — reads faster, writes slower',
};

export interface BackendOptionInput {
  platform: string;                       // process.platform
  arch: string;                           // process.arch
  vendor: GpuVendor | null;
  gfxTarget: string | null;
  /** The backend the installed engine is already running. Never offered back. */
  installedBackend: EngineBackend | null;
  /** rocm-prereqs' answer for THIS machine. Ignored off the ROCm path. */
  rocmPrereqsSatisfied: boolean;
}

/** The faster builds this machine may be offered, and whether each is ready to
 *  switch to or needs system software installed first.
 *
 *  Pure on purpose: every gate below is a decision a test can pin, and getting
 *  one wrong is either a hidden speed-up or a download that cannot run.
 *
 *  - NVIDIA, Windows x64 → CUDA. Upstream publishes no Linux CUDA build, so
 *    there is nothing to offer an NVIDIA Linux machine; `pickAsset` is what
 *    decides that, rather than a platform list repeated here.
 *  - AMD, Linux x64 → ROCm, but ONLY when the chip's gfx target appears in the
 *    LINUX row's compiled-target list. The two ROCm rows carry different lists
 *    (T1, verified at b10665): Windows adds gfx1103/gfx1153 and drops the four
 *    CDNA parts Linux has. Reading "the pin's gfx list" instead of the row for
 *    the running platform would refuse ROCm to a supported Windows chip, or
 *    offer it to a Linux chip with no machine code in the archive.
 *  - AMD, Windows x64 → ROCm, ready: that zip bundles its own runtime, and
 *    Windows publishes no gfx target to check against.
 *  - Apple and Intel are never offered anything: Metal already IS Apple's own
 *    backend, and upstream ships no Intel-specific build at all — Vulkan is
 *    already the fast path there.
 */
export function backendOptions(input: BackendOptionInput): BackendOption[] {
  const { platform, arch, vendor, gfxTarget, installedBackend, rocmPrereqsSatisfied } = input;
  const offer = (backend: EngineBackend, state: BackendOption['state']): BackendOption[] => {
    if (backend === installedBackend) return [];          // never offer what is already running
    if (!pickAsset(platform, arch, backend)) return [];    // no asset for this platform/arch
    return [{ backend, label: BACKEND_LABELS[backend] ?? `Switch to ${backend}`, state }];
  };

  if (vendor === 'nvidia') return offer('cuda', 'ready');

  if (vendor === 'amd') {
    const asset = pickAsset(platform, arch, 'rocm');
    if (!asset) return [];
    if (platform === 'win32') return offer('rocm', 'ready');
    // Linux: the chip has to be in THIS row's list, and the row must carry one.
    // A row with no gfxTargets means the pin was regenerated without it — refuse
    // rather than assume, because the failure it prevents is a dead engine.
    const targets = asset.gfxTargets;
    if (!targets || !gfxTarget || !targets.includes(gfxTarget)) return [];
    return offer('rocm', rocmPrereqsSatisfied ? 'ready' : 'needs-prereqs');
  }

  return [];   // apple, intel, or nothing detected
}

/** The device name to show on the card, from the `.complete` marker's `devices`
 *  list (written by engine-acquisition from `llama-server --list-devices`).
 *
 *  "Is this a real graphics chip?" is answered by the writer's own `isGpu`
 *  flag, NEVER re-derived here. An earlier draft guessed at it by looking for a
 *  `backend` id starting with 'CPU', which never fires: the engine prints its
 *  own device id verbatim, and on this machine the software renderer llvmpipe
 *  comes back as `backend: 'Vulkan0'` with `isGpu: false`. Two modules deciding
 *  separately what counts as a GPU is how the card ends up claiming hardware
 *  acceleration for work the processor is doing.
 *
 *  Matches `firstGpuDevice()` in engine-acquisition.ts, which is the same rule
 *  in the module that owns the marker. It is not imported because that function
 *  lands with T2, which is not merged here yet; when it is, this can call it.
 *
 *  Deliberately shape-checked rather than typed: an install made before the
 *  field existed has no `devices` key at all, and a marker is a file on disk
 *  that can be anything. A device whose `isGpu` cannot be read is skipped
 *  rather than assumed — we never claim a graphics chip we could not confirm.
 *  Returns null for "no GPU device", which the card renders as "Processor only".
 *
 *  The parenthetical is stripped because the driver appends its own name:
 *  'AMD Radeon 8060S Graphics (RADV GFX1151)' is one chip described twice, and
 *  the half in brackets means nothing to a reader. */
export function gpuDeviceName(devices: unknown): string | null {
  if (!Array.isArray(devices)) return null;
  for (const d of devices) {
    if (!d || typeof d !== 'object') continue;
    const { isGpu, name } = d as { isGpu?: unknown; name?: unknown };
    if (isGpu !== true) continue;
    if (typeof name !== 'string' || !name.trim()) continue;
    const stripped = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
    return stripped || name.trim();
  }
  return null;
}
