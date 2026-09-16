// EngineManager — the composition root ipc-handlers talks to. Owns one
// EngineAcquisition + (lazily) one EngineSupervisor, reads engine config from
// ~/.youcoded/config.json, and exposes:
//   - status()/install()/restart() for the engine:* IPC surface
//   - registryHook() — the LocalEngineHook ProviderRegistry's local-engine
//     branch calls (installed / ensureRunning / trackedFetch)
//   - catalogModels() — ModelCatalog's local source for the model picker
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs'; // Plan C: deleteModel needs fs.rmSync for model files
import { NativeHome } from '../native-home';
import { EngineAcquisition, InstalledEngine } from './engine-acquisition';
import type { EngineDevice } from './engine-acquisition';
import { EngineSupervisor, SLEEP_IDLE_SECONDS } from './engine-supervisor';
import type { EngineSpawnConfig } from './engine-supervisor';
import { ENGINE_VERSION, pickAsset, defaultBackend } from './engine-pin';
import type { EngineAsset } from './engine-pin';
import {
  readEngineConfig, updateEngineConfig, updateEngineSpeed, removeModelSettings,
  updateModelSettings, modelSettingsFor,
} from './engine-config';
import type { ModelSettingsPatch } from './engine-config';
import {
  presetFilePath, renderPresetFile, writePresetFile, parsePresetSections,
  presetGlobalValue, parseExtraFlags, checkFlagsAgainstBinary,
} from './model-presets';
import type { BinaryCheckOptions, BinaryCheckResult } from './model-presets';
import { contextLengthFor } from '../models/fit-estimator';
import { readManifest, removeManifest, markManifestComplete, isManifestComplete } from '../models/download-manifest';
import { ManifestBackfill, defaultBackfillLookups, isStaleBackfillMiss } from '../models/manifest-backfill';
import type { BackfillCandidate, BackfillLookups } from '../models/manifest-backfill';
import { scanGgufCache, scanLocalDownloads, isComplete } from './cache-scan';
import { parseGgufName, quantDescription } from '../models/quant-parser';
import { stripSplitSuffix } from '../../shared/gguf-split';
import { detectGpu, backendOptions, gpuDeviceName } from '../models/gpu-detector';
import type { GpuVendor } from '../../shared/model-manager-types';
import { checkRocmPrereqs } from './rocm-prereqs';
import { healInterruptedMove, interruptedMoveIds } from '../models/add-vision';
import type {
  EngineBackend, EngineInstallProgress, EngineStatus, EngineModel, EngineModelState, BackendOption,
  ReplyTimings, EngineSpeedSettings,
} from '../../shared/engine-types';
import type { CatalogModel } from '../../shared/provider-types';
import type {
  InstalledLocalModel, ModelSettingsWrite, StoredModelSettings,
} from '../../shared/model-manager-types';

/** What ProviderRegistry's local-engine branch consumes (replaces Plan A's
 *  bare localBaseUrl callback). Defined here, imported by provider-registry. */
export interface LocalEngineHook {
  installed(): boolean;
  ensureRunning(): Promise<string>;   // OpenAI-compatible base URL (…/v1)
  fetchImpl(): typeof fetch;          // supervisor.trackedFetch — idle accounting sees every request
  /** Can the router actually SERVE this model right now? Fails OPEN. */
  ensureServable(modelId: string): Promise<boolean>;
  /** Report how fast a finished reply ran, straight off the engine's final
   *  streamed frame — or `null` when that frame carried no timings, which
   *  CLEARS the reading rather than leaving the previous reply's number
   *  standing under a newer one. Feeds the engine card's fact line. */
  recordReply(timings: ReplyTimings | null): void;
}

/** Pick the asset to install: the preferred backend if it ships an asset for
 *  this platform/arch, else CPU (which every shipped platform has), else null.
 *  Returns the backend too so the caller records the one it actually used.
 *  Fix: Windows arm64 has no Vulkan asset — without this fallback Install would
 *  error out ("not available") even though a CPU build exists. */
export function selectInstallAsset(
  platform: string, arch: string, preferred: EngineBackend
): { asset: EngineAsset; backend: EngineBackend } | null {
  const first = pickAsset(platform, arch, preferred);
  if (first) return { asset: first, backend: preferred };
  const cpu = pickAsset(platform, arch, 'cpu');
  if (cpu) return { asset: cpu, backend: 'cpu' };
  return null;
}

// The REAL effective context window for a local model = min(what llama-server
// actually loaded, the GGUF-trained max). Guessing this overflows small models:
// a 4k-trained model driven at a configured 32k -c silently corrupts once history
// crosses the file's real ceiling. Take the smaller of the two known numbers;
// with neither known, fall back to a conservative default that nothing overruns.
/** Resolve the window from a RAW /props reading plus our own configured -c.
 *
 *  Extracted as a pure function because the bug this exists to prevent lived in
 *  an inline expression that no test could reach: `loaded ?? configured` does
 *  NOT fall back when loaded is 0, because `??` only catches null/undefined. In
 *  router mode /props reports a literal `n_ctx: 0`, so the fallback added on
 *  2026-07-26 was inert in precisely the case it was written for — and the unit
 *  tests passed anyway, because they exercised clampContextWindow directly with
 *  the values I ASSUMED reached it. Test the seam, not the collaborator.
 *
 *  A non-positive reading means "unknown", never "zero context". */
export function resolveEffectiveContext(
  loadedRaw: unknown,
  configured: number | null,
  trainedMax: number | null,
): number {
  const loaded = typeof loadedRaw === 'number' && Number.isFinite(loadedRaw) && loadedRaw > 0 ? loadedRaw : null;
  return clampContextWindow(loaded ?? configured, trainedMax);
}

export function clampContextWindow(loaded: number | null, trainedMax: number | null): number {
  const vals = [loaded, trainedMax].filter((n): n is number => typeof n === 'number' && n > 0);
  return vals.length ? Math.min(...vals) : 32_768;   // conservative default
}

// Task 13 fix pass — DiscoveredModel.totalSlots (capability-profile.ts) is fed
// by the SAME /props response effectiveContextWindow already reads for
// n_ctx, at the SAME "absent/zero/non-numeric means unknown" posture: a
// model-less router-mode /props carries NO slot field at all (measured
// 2026-09-04 on b10665), an older build may leave it undefined, and a literal
// 0 must never be read as "zero slots" any more than n_ctx's literal 0 means
// "zero context" above. Extracted as its own pure function (mirroring
// resolveEffectiveContext just above, for the identical reason: the n_ctx
// router-mode bug shipped once already because the parsing lived inline
// where no test could reach it).
export function resolveSlotCount(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** What chip this computer has. These two facts CANNOT change while the app is
 *  running — the graphics card does not get swapped mid-session — which is why
 *  they, and only they, are the part that gets cached (§A3).
 *
 *  Split out from the two card fields deliberately. An earlier version cached
 *  the finished answer instead, and got both fields wrong on the path every new
 *  user walks: the Local Models panel is where the Install button lives, so the
 *  panel is opened BEFORE anything is installed. The answer was computed then,
 *  against no engine, and never recomputed — so after installing, the card said
 *  "Processor only" on a machine that was using its graphics chip, and kept
 *  offering a switch to the build it had just switched to. Everything that can
 *  change (which engine is installed, whether the ROCm libraries have since
 *  been installed, what the engine reports about its devices) is now read fresh
 *  on every status(). */
export interface MachineChip { vendor: GpuVendor | null; gfxTarget: string | null; }

async function probeMachineChip(): Promise<MachineChip> {
  const gpu = await detectGpu();
  // Warm the ROCm prerequisite reading on this same deferred tick, so that
  // status() — which is synchronous — can read it for free afterwards. It only
  // matters on an AMD machine, and it shells out, so nowhere else pays for it.
  if (gpu.vendor === 'amd') checkRocmPrereqs();
  return { vendor: gpu.vendor, gfxTarget: gpu.gfxTarget };
}

/** The device the engine says it will run on, from the install's `.complete`
 *  marker (engine-acquisition writes it from `llama-server --list-devices`).
 *
 *  Read on EVERY status() rather than cached: it changes when the engine is
 *  installed, and again when the backend is switched, and it is a small file
 *  read — no subprocess — so there is nothing to defer.
 *
 *  Three answers, not two. `undefined` means "not known yet": no engine
 *  installed, or a marker written before the device list existed (T2 backfills
 *  those lazily). `null` means the engine looked and found no graphics chip.
 *  A string is the chip. Collapsing the first two into `null` is what would let
 *  the card assert "Processor only" about a machine it has not asked yet. */
function deviceNameOf(inst: InstalledEngine | null): string | null | undefined {
  if (!inst) return undefined;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(inst.dir, '.complete'), 'utf8')) as { devices?: unknown };
    if (!Array.isArray(marker.devices)) return undefined;   // no device list recorded yet
    return gpuDeviceName(marker.devices);
  } catch {
    return undefined;   // no marker, or unreadable — not an answer, an absence
  }
}


// ---------------------------------------------------------------------------
// Switching to a GPU build: what has to be TRUE before the switch is kept
// (design §A4). The whole point of this block is that a user who presses
// "Switch to ROCm" and lands on a build their machine cannot run must end up
// exactly where they started, told the truth about why. Every sentence below
// either quotes the engine's own words or states something we measured — never
// a guessed cause.
// ---------------------------------------------------------------------------

/** The device id each GPU build must actually report before we keep it. These
 *  are PREFIXES of the engine's own printed device id (`CUDA0`, `ROCm0`), not
 *  our EngineBackend names — engine-acquisition records `device.backend`
 *  verbatim from `llama-server --list-devices`.
 *
 *  Absent for vulkan / cpu / metal on purpose: the Vulkan install's fall back
 *  to the processor is by design (install() relies on it), so those builds are
 *  never refused for running on the CPU. */
const REQUIRED_DEVICE_PREFIX: Partial<Record<EngineBackend, string>> = { cuda: 'CUDA', rocm: 'ROCm' };

/** How each build is named to the user. The card and these sentences must say
 *  the same word for the same thing. */
const BACKEND_WORD: Partial<Record<EngineBackend, string>> = { cuda: 'CUDA', rocm: 'ROCm' };

/** The refusal a user reads when a GPU build is downloaded, found unusable and
 *  thrown away again. `detail` is the engine's own words — quoted where the
 *  engine produced a sentence, plain where it produced a list. */
function keptCurrentEngine(word: string, detail: string): string {
  return `Kept the current engine: the ${word} build found no graphics chip it can use — ${detail}. Nothing was changed.`;
}

/** Does the freshly installed build actually see a chip it can use?
 *
 *  Reads `devicesError` FIRST, and that ordering is the point (T2 handoff): a
 *  binary that would not START (a missing `libamdhip64.so.7`, a linker error)
 *  and a machine that genuinely has no matching graphics chip both leave the
 *  marker's device list empty, and they are completely different answers for
 *  the user. Flattening them into one sentence would tell someone whose ROCm
 *  libraries are simply missing that their graphics card is unsupported.
 *
 *  Returns null when the install may be kept — including for every non-GPU
 *  backend, which has nothing to prove here. */
export function backendDeviceRefusal(
  backend: EngineBackend,
  devices: EngineDevice[] | undefined,
  devicesError: string | undefined,
): string | null {
  const prefix = REQUIRED_DEVICE_PREFIX[backend];
  if (!prefix) return null;
  const word = BACKEND_WORD[backend] ?? backend;
  // The binary could not be asked at all. Quote it verbatim; the reason is in
  // its own text (a missing library, a timeout) and we do not paraphrase it.
  if (devicesError) {
    return `Kept the current engine: the ${word} build could not be asked which graphics chip it would use — "${devicesError}". Nothing was changed.`;
  }
  // No list AND no error: acquisition writes one or the other on every path, so
  // this is a marker we cannot read rather than a machine with no chip. Say the
  // absence, do not turn it into a claim about the hardware.
  if (devices === undefined) {
    return `Kept the current engine: the ${word} build could not be asked which graphics chip it would use — it recorded no device list. Nothing was changed.`;
  }
  if (devices.some((d) => typeof d?.backend === 'string' && d.backend.startsWith(prefix))) return null;
  // It answered, and what it answered has no matching device in it. The engine's
  // own words here are the device names it printed, so those are what we show.
  const listed = devices
    .map((d) => (typeof d?.name === 'string' ? d.name.trim() : ''))
    .filter(Boolean)
    .join(', ');
  return keptCurrentEngine(word, listed ? `it reported: ${listed}` : 'it reported no devices at all');
}

/** How long a 1-token load of the SMALLEST model on disk may take before we
 *  stop waiting. Generous — a cold read off a slow disk is minutes — but
 *  bounded, because without it a wedged build leaves the Switch button
 *  disabled with the download bar already gone and nothing else on screen.
 *  Overridable for tests only (`loadProbeTimeoutMs`); production never sets it. */
const LOAD_PROBE_TIMEOUT_MS = 10 * 60_000;

/** A duration in the units a reader would use for it. The verification load's
 *  cap is ten minutes in production and milliseconds under test, and neither
 *  reads correctly in the other's units. */
function describeDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} minutes`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)} seconds`;
  return `${ms} ms`;
}

/** What a failed verification load tells us. The distinction is the whole
 *  point: an engine that ANSWERS with an error is describing the model or the
 *  build, while an engine that cannot be reached at all is describing itself. */
interface LoadProbeFailure {
  kind: 'answered' | 'unreachable';
  message: string;
}

/** Wording that means "not enough memory", in the shapes llama.cpp, HIP and
 *  CUDA all use. Checked BEFORE anything else, because `ggml_cuda_error()`
 *  prints `CUDA error: <msg>` for EVERY checked failure it handles — out of
 *  memory included. Without this, a user whose model simply does not fit would
 *  have a perfectly good CUDA build deleted and be told it "found no graphics
 *  chip it can use", which is a cause we never established. */
const ALLOCATION_WORDING = ['out of memory', 'failed to allocate', 'cannot allocate', 'insufficient memory'];

/** The load failed because the BUILD cannot run on this chip, rather than
 *  because the model file is bad (design §A4).
 *
 *  Two shapes. The needles are the messages a wrong-architecture GPU build
 *  produces when it has no compiled kernel for the installed chip. The prefix
 *  regex catches the whole family in one go: ggml stamps every checked GPU
 *  failure with its backend's name, and THAT NAME IS NOT ALWAYS "CUDA" — the
 *  in-repo proof is T2's own device ids, where the HIP build reports `ROCm0`
 *  and not `CUDA0`; both come from the same upstream rename. Listing only
 *  CUDA's spelling would let `ROCm error: hipErrorNoDevice` through as a model
 *  problem, keep the switch, and blame the user's file — on exactly the
 *  backend this machine uses.
 *
 *  Anything else — a corrupt GGUF, an architecture the engine cannot read, a
 *  model too big for the memory — is a MODEL problem, and discarding a working
 *  engine over one broken file is the wrong trade. Matched case-insensitively
 *  because these strings reach us through several layers of error wrapping. */
const DEVICE_CLASS_LOAD_ERRORS = ['no kernel image', 'invalid device function', 'hiperror'];
const DEVICE_CLASS_ERROR_PREFIX = /(cuda|rocm|hip) error: /i;

export function isDeviceClassLoadError(text: string): boolean {
  const lower = text.toLowerCase();
  // Memory is not a verdict on the hardware, whichever vendor prefix it wears.
  if (ALLOCATION_WORDING.some((needle) => lower.includes(needle))) return false;
  if (DEVICE_CLASS_LOAD_ERRORS.some((needle) => lower.includes(needle))) return true;
  return DEVICE_CLASS_ERROR_PREFIX.test(text);
}

/** The cheapest complete model to prove the switch with — a 1-token load has to
 *  read the whole file into the graphics chip, so the smallest one costs the
 *  user the least waiting. Null when the cache holds nothing complete. */
export function smallestCompleteModel(models: EngineModel[]): EngineModel | null {
  let best: EngineModel | null = null;
  for (const m of models) {
    if (typeof m.sizeBytes !== 'number') continue;
    if (best === null || m.sizeBytes < (best.sizeBytes as number)) best = m;
  }
  return best;
}

/** The router's own message out of a failed completion. llama-server answers a
 *  load failure with `{"error":{"message":"…"}}`; a proxy or a crash can answer
 *  with anything at all, so the raw body is the last resort and the HTTP status
 *  is the one after that. Never invents a cause — if the server said nothing we
 *  say only what we know, which is the status code. */
export function routerErrorText(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const msg = typeof parsed?.error?.message === 'string' ? parsed.error.message
      : typeof parsed?.message === 'string' ? parsed.message
      : null;
    if (msg && msg.trim()) return msg.trim();
  } catch { /* not JSON — fall through to the raw body */ }
  const raw = body.trim();
  // A whole HTML error page in a FieldError is unreadable; one line of it is
  // still the server's own words.
  if (raw) return raw.split(/\r?\n/)[0].slice(0, 300);
  return `the engine answered HTTP ${status} with no message`;
}
// How often a queued settings change asks "is a reply still streaming?", and how
// long it waits before applying anyway. Ten minutes is the design's bound (§C2):
// long enough that no real reply is cut short, short enough that a stream which
// never releases its hold (a wedged model, a client that walked away) cannot
// leave a saved setting unapplied for the rest of the session.
const CONFIG_APPLY_POLL_MS = 1_000;
const CONFIG_APPLY_MAX_WAIT_MS = 10 * 60_000;

export class EngineManager extends EventEmitter {
  private acquisition: EngineAcquisition;
  private supervisor: EngineSupervisor | null = null;
  private supervisorBinary: string | null = null;
  private installing = false;
  // Saved settings changes not yet in force (see requestApply). Two flags, not
  // a job queue, so any number of changes made during one wait cost one action.
  private needsReload = false;
  private needsRestart = false;
  private applyDeadline = 0;                      // when the OLDEST pending change lands regardless
  private applyWaiter: Promise<void> | null = null;
  private configApplyError: string | null = null;
  // The same idea, one level down: per-MODEL settings changes that are saved but
  // not yet in force. A Set, not a queue, for the reason the two flags above are
  // flags — any number of saves to one model during one wait costs one apply.
  // model id -> the moment that model's change lands whether or not it is quiet.
  // PER ID, not one shared deadline: a shared one let a change saved nine
  // minutes into another model's wedged stream be swept in sixty seconds later
  // with NO idle check — cutting that model's reply after a fraction of a bound
  // that is supposed to be ten minutes. "The oldest change owns the deadline" is
  // about repeated saves to ONE model, and the map's first-write-wins does that.
  private pendingModelApplies = new Map<string, number>();
  private modelApplyWaiter: Promise<void> | null = null;
  /** The supervisor state we last acted on, so "the engine just came up" can be
   *  told from "the engine is still up" (see notePresetInForce). */
  private lastSupervisorState: string | null = null;

  constructor(
    private home: NativeHome,
    // Kept on the instance since §E3: the manifest backfill's curated-list
    // cache lives beside the app's other caches in here, and it is built
    // lazily — the first time a model on disk turns out to have no manifest.
    // (It used to be a plain param on purpose, to avoid a dead reference.)
    private userDataDir: string,
    private port: number,
    /** Test seams (spec §5: mocked subprocess + fetch). `probeChip` stands in
     *  for the graphics-chip probe so a test can drive its FAILURE path — the
     *  real one asks the machine, and a machine cannot be made to fail. */
    private opts: {
      fetchImpl?: typeof fetch;
      supervisorOpts?: Record<string, unknown>;
      probeChip?: () => Promise<MachineChip>;
      /** Test seam: the verification load's cap. A guard that has to wait out
       *  the real ten minutes is a guard that gets deleted. */
      loadProbeTimeoutMs?: number;
      /** Test seams for the settings-apply wait — a suite cannot spend ten real
       *  minutes proving that the bound exists. */
      configApplyPollMs?: number;
      configApplyMaxWaitMs?: number;
      /** Test seam: the save-time "is this a real llama-server option?" check.
       *  The real one SPAWNS the engine binary, which a unit test has none of. */
      checkFlags?: (opts: BinaryCheckOptions) => Promise<BinaryCheckResult>;
      /** Test seam: where §E3's backfill gets its curated list and its Hugging
       *  Face answers. The default reaches the real network, which is why every
       *  suite that plants a complete model on disk has to replace it. */
      backfillLookups?: BackfillLookups;
    } = {}
  ) {
    super();
    // The third argument matters: acquisition fills in the device list of an
    // engine installed before that list existed, in the background, because
    // status() is synchronous and cannot wait on a spawned process. status() is
    // also PULL-only, so without this push a user upgrading from an older build
    // would keep seeing the wrong "runs on" line until some unrelated engine
    // event happened to refetch it.
    this.acquisition = new EngineAcquisition(
      path.join(userDataDir, 'engine'), opts.fetchImpl, () => this.emit('status-changed'),
    );
  }

  /** §E3's backfill, built the first time a model on disk is found to have no
   *  manifest. Lazy on purpose: an app whose every download already carries one
   *  — which is every app from here on — never constructs it, never reads the
   *  curated cache, and never opens a socket. */
  private backfill: ManifestBackfill | null = null;

  private manifestBackfill(): ManifestBackfill {
    if (!this.backfill) {
      this.backfill = new ManifestBackfill(
        this.opts.backfillLookups ?? defaultBackfillLookups(this.userDataDir, this.opts.fetchImpl),
      );
    }
    return this.backfill;
  }

  /** Settles when the backfill pass in flight is over. For the tests, which
   *  must not tear their fixture down under a lookup that is still running. */
  backfillIdle(): Promise<void> {
    return this.backfill?.whenIdle() ?? Promise.resolve();
  }

  /** The usable install, resolved with the CONFIGURED backend preference so a
   *  leftover non-booting build (e.g. a vulkan dir after a CPU fallback) can't
   *  shadow the one that actually works (see EngineAcquisition.installed). */
  private currentInstall(): InstalledEngine | null {
    return this.acquisition.installed(readEngineConfig(this.home).backend ?? undefined);
  }

  /** The chip probe's answer, once. WHY it is not simply computed inside
   *  status(): finding out means ASKING THE MACHINE — running `nvidia-smi`, a
   *  PowerShell query against the display-driver registry, and `ldconfig` — and
   *  every one of those can take a moment, or a long moment if a graphics
   *  driver is wedged (the Windows probes are capped at four seconds EACH).
   *  status() is called on every engine event and on every status request from
   *  the screen, and it is synchronous, so doing that work inside it would
   *  freeze the whole window each time.
   *
   *  So: the first status() answers instantly with `backendOptions` simply
   *  absent, the asking happens on the next tick, and the 'status-changed' push
   *  delivers the answer a moment later. `chipProbing` makes it happen exactly
   *  once per app run — which is correct, because the chip cannot change.
   *
   *  The push MUST fire on the failure path too. It is the only thing that ever
   *  delivers that field, so a missed one leaves the card waiting forever for a
   *  second status that never comes — which looks exactly like a hung app. */
  private chip: MachineChip | null = null;
  private chipProbing = false;

  private warmChip(): void {
    if (this.chip || this.chipProbing) return;
    this.chipProbing = true;
    const probe = this.opts.probeChip ?? probeMachineChip;
    setImmediate(() => {
      void (async () => {
        try {
          this.chip = await probe();
        } catch {
          // A probe that throws still has to SETTLE: "no chip we recognise", so
          // the push below carries a real answer instead of nothing.
          this.chip = { vendor: null, gfxTarget: null };
        }
        this.chipProbing = false;
        // Deliberately outside the try/catch, and after the assignment: this one
        // line is what the card is waiting on, on both paths.
        this.emit('status-changed');
      })();
    });
  }

  /** Which faster builds to offer RIGHT NOW. Recomputed on every status() from
   *  the cached chip plus the two things that do change: which backend is
   *  installed (so a switch is never offered back to itself) and whether the
   *  ROCm libraries are present (the user may have just installed them — the
   *  card's "Check again" refreshes that same reading). Undefined until the
   *  chip probe has answered. */
  private currentBackendOptions(inst: InstalledEngine | null, cacheDir: string): BackendOption[] | undefined {
    const chip = this.chip;
    if (!chip) return undefined;
    // §A4: with no model on disk there is nothing for a switch to load, so the
    // last and most telling check cannot run. Say that on the row rather than
    // let the user read a successful switch as a fully proven one. Recomputed
    // per status() (a directory listing, the same one installedModels does) so
    // the note disappears by itself the moment a download lands.
    const note = scanGgufCache(cacheDir).length === 0
      ? 'Checked when your first model loads.'
      : undefined;
    return backendOptions({
      platform: process.platform,
      arch: process.arch,
      vendor: chip.vendor,
      gfxTarget: chip.gfxTarget,
      installedBackend: inst?.backend ?? null,
      // Free: the chip probe primed this cache on its own tick, and it is only
      // ever consulted on an AMD machine.
      rocmPrereqsSatisfied: chip.vendor === 'amd' ? checkRocmPrereqs().satisfied : false,
    // The note goes only on a row the user can actually press. A
    // 'needs-prereqs' row is already telling them to install AMD's software
    // first, and appending "Checked when your first model loads." to that reads
    // as two unrelated instructions in one line.
    }).map((o) => (note && o.state === 'ready' ? { ...o, note } : o));
  }

  /** The compute devices the installed engine reported at install time, exactly
   *  as its `.complete` marker recorded them (design §A2: `llama-server
   *  --list-devices`). The memory estimator scores a model against the FIRST
   *  GPU device's pool, which is the only number that says what this machine's
   *  graphics chip will really hold.
   *
   *  Null for an install whose marker predates that field — which is every
   *  install until the acquisition change ships. That is a fallback, not an
   *  error: fit-estimator.ts then scores against detected VRAM or total RAM and
   *  never claims a model "fits on your GPU" on evidence it does not have. */
  installedDevices(): unknown {
    const inst = this.currentInstall();
    if (!inst) return null;
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(inst.dir, '.complete'), 'utf8'));
      return marker?.devices ?? null;
    } catch { return null; }
  }

  /** The last reply we could actually measure. `undefined`, never a zero, until
   *  one has been: "0 read / 0 write per second" is a claim about the machine,
   *  and it would be on screen for every user who has not sent a message yet. */
  private lastReply: ReplyTimings | undefined;

  /** Called by ProviderRegistry's local fetch tap at the end of every local
   *  reply. The push is the whole point — status() is pull-only, so without it
   *  the card would keep last week's number until some unrelated engine event
   *  happened to refetch. */
  recordReply(timings: ReplyTimings | null): void {
    this.lastReply = timings ?? undefined;
    this.emit('status-changed');
  }

  status(): EngineStatus {
    const cfg = readEngineConfig(this.home);
    const inst = this.currentInstall();
    const supState = this.supervisor?.status() ?? 'stopped';
    this.warmChip();
    return {
      // Undefined (not []) until the chip probe has answered once. Both fields
      // are recomputed here rather than cached, so installing an engine or
      // switching backend is reflected in the very next status.
      backendOptions: this.currentBackendOptions(inst, cfg.cacheDir),
      deviceName: deviceNameOf(inst),
      // Both `undefined` until they have an answer, for the same reason
      // deviceName is: the card must not assert "nothing loaded" or a speed
      // about an engine it has not asked yet.
      loadedModelsBytes: this.supervisor?.loadedModelsBytes(),
      lastReply: this.lastReply,
      installed: inst !== null,
      installedVersion: inst?.version ?? null,
      pinnedVersion: ENGINE_VERSION,
      backend: inst?.backend ?? null,
      state: inst === null ? 'not-installed' : supState,
      errorMessage: supState === 'error'
        ? 'The engine crashed repeatedly and was stopped. Press "Restart engine" to try again.'
        : undefined,
      cacheDir: cfg.cacheDir,
      contextSize: cfg.contextSize,   // Plan C: the knob binds to this value
      port: this.port,
      speed: cfg.speed,
      // While true the card shows "Applies after the current reply" — the value
      // is saved, the engine has not picked it up yet.
      configApplyPending: this.applyWaiter !== null,
      // WHY the card cannot say "applies after the current reply" off
      // `configApplyPending` alone: that flag is true from the moment a change
      // is QUEUED, and on an idle machine the queue drains in a poll interval
      // with no reply anywhere in sight. Saying a reply is holding it up would
      // then be wrong more often than right, so the wait is reported for what
      // it is — the engine is genuinely busy — and the card words the two
      // cases differently.
      configApplyWaitingForReply: this.applyWaiter !== null && (this.supervisor?.busy() ?? false),
      configApplyError: this.configApplyError,
      // Only a RUNNING engine can answer this. `presetActive` is false while the
      // supervisor is stopped or starting, so reporting it unconditionally would
      // tell every user with a stopped engine that their per-model settings are
      // being ignored — which is a fact about a run that has not happened yet.
      modelSettingsInForce: supState === 'running' ? (this.supervisor?.presetInForce() ?? false) : undefined,
      // …and WHY, in the words of whatever refused them (design §J). Reported
      // beside the flag so the two can never disagree about which run they
      // describe.
      modelSettingsError: supState === 'running' ? (this.supervisor?.presetProblem() ?? null) : undefined,
    };
  }

  /** One engine-wide settings write (design §B, channel `engine:set-config`).
   *
   *  The VALUE is saved immediately — if the disk write fails, this call fails
   *  and the user is told. APPLYING it to the running engine is what waits:
   *  both paths below are queued behind `queueConfigApply`, so nothing here
   *  interrupts a reply the user is reading. */
  async setConfig(patch: { contextSize?: number; speed?: Partial<EngineSpeedSettings> }): Promise<void> {
    const wantsContext = patch.contextSize !== undefined;
    if (wantsContext && (!Number.isFinite(patch.contextSize) || (patch.contextSize as number) < 1024)) {
      throw new Error('Context length must be at least 1024 tokens.');
    }
    // Only the two booleans this app knows about are written. Anything else in
    // the patch is dropped rather than stored: config.json feeds the engine's
    // preset file, and a value nothing validates ends up on a command line.
    const speed: Partial<EngineSpeedSettings> = {};
    if (typeof patch.speed?.speculative === 'boolean') speed.speculative = patch.speed.speculative;
    if (typeof patch.speed?.compressCache === 'boolean') speed.compressCache = patch.speed.compressCache;
    const wantsSpeed = Object.keys(speed).length > 0;
    if (!wantsContext && !wantsSpeed) return;

    if (wantsContext) await updateEngineConfig(this.home, { contextSize: Math.floor(patch.contextSize as number) });
    if (wantsSpeed) await updateEngineSpeed(this.home, speed);
    this.emit('status-changed');   // the saved value is visible at once

    // A context change needs NO process restart: the value lives in the preset
    // file's [*] section, and `GET /models?reload=1` makes the router re-read it
    // (verified against the pinned binary, design §C2). A speed switch is a
    // command-line flag, so that one does need a fresh spawn.
    if (wantsContext) this.requestApply('reload');
    if (wantsSpeed) this.requestApply('restart');
  }

  /** Plan C (Amendment I): the context-length knob. Kept as a thin alias so the
   *  callers already wired to `engine:set-context` — the engine card, the remote
   *  browser shim, the WS handler, the Android stub list — keep working
   *  unchanged while new UI moves to `engine:set-config` (design §B). */
  async setContext(contextSize: number): Promise<void> {
    await this.setConfig({ contextSize });
  }

  /** Rewrite `~/.youcoded/engine/models.ini` from config.json + what is on disk.
   *
   *  The `[*]` section carries the engine-wide values a model is allowed to
   *  override (context length, auto-sleep), and one section per model carries
   *  that model's own. Sections are emitted ONLY for ids the cache scan found:
   *  a section for a deleted model resurrects it as a row that can never load. */
  private writeModelPresets(): void {
    const cfg = readEngineConfig(this.home);
    const filePath = presetFilePath(this.home.root);
    // A model whose saved change has NOT been applied yet keeps the section the
    // running engine is actually reading. WHY: this file is shared by every
    // model, and `?reload=1` unloads a model whose section CHANGED — so writing
    // a still-waiting model's new settings here, on somebody else's reload,
    // would unload it in the middle of the reply the wait exists to protect
    // (design §C2). Its old lines come out of the file already on disk.
    const held = new Map<string, readonly string[]>();
    const waiting = Object.keys(cfg.models).filter((id) => cfg.models[id].pendingApply === true);
    // `[*]` needs the SAME hold, and for the same reason. An engine-wide context
    // change is deferred too (setConfig writes config.json and queues the apply),
    // and `[*] ctx-size` is what every model with no section of its own
    // inherits — so rendering it from config here would let that queued change
    // ride out on somebody else's reload. A download finishing calls
    // refreshModels(), and the reply the user is reading dies mid-sentence with
    // nothing connecting it to the setting they changed. `needsReload` is
    // exactly "an engine-wide value is saved but not yet applied".
    const holdGlobal = this.needsReload;
    let existing = '';
    if (waiting.length > 0 || holdGlobal) {
      try { existing = fs.readFileSync(filePath, 'utf8'); } catch { existing = ''; } // no file yet = no section
    }
    if (waiting.length > 0) {
      const sections = parsePresetSections(existing);
      // NOTE what is NOT held here: a section the SPAWN omitted because the
      // engine refused it (T7's omitModelId). This render puts it back, so the
      // next reload 500s and the OTHER models' settings in that same write are
      // silently not applied until the next spawn. It degrades safely — the
      // engine keeps running on the presets it already has — but it is a real
      // hole, and the supervisor is the only thing that knows which id was
      // dropped.
      for (const id of waiting) held.set(id, sections.get(id) ?? []);
    }
    // Fall back to config when the file has no `[*] ctx-size` to hold — there is
    // then no engine reading a different number, so nothing can be cut.
    const onDiskContext = holdGlobal ? Number(presetGlobalValue(existing, 'ctx-size')) : NaN;
    const contents = renderPresetFile({
      contextSize: Number.isFinite(onDiskContext) && onDiskContext > 0 ? onDiskContext : cfg.contextSize,
      sleepIdleSeconds: SLEEP_IDLE_SECONDS,
      modelIds: scanGgufCache(cfg.cacheDir).map((m) => m.id),
      settings: cfg.models,
      preserve: held.size > 0 ? held : undefined,
    });
    writePresetFile(filePath, contents);
  }

  /** Ask the running router to re-read its preset file. No restart — the
   *  process keeps serving throughout.
   *
   *  This sends `?reload=1` ITSELF rather than going through refreshModels(),
   *  because refreshModels swallows every failure (its routerModelIds returns
   *  null on a non-ok response AND on a throw). A refused reload is exactly the
   *  failure that has to be reported: the engine keeps serving with the OLD
   *  settings and NOTHING looks wrong until the next spawn, so without a message
   *  the user's change simply never happened and they are never told. The
   *  message carries the engine's own status, never a guessed cause. */
  private async applyReload(): Promise<void> {
    if (!this.supervisor || this.supervisor.status() !== 'running') return; // its next boot reads the file
    const url = `http://127.0.0.1:${this.port}/models?reload=1`;
    const res = await (this.opts.fetchImpl ?? fetch)(url, { method: 'GET' });
    if (!res.ok) {
      const detail = res.statusText ? `${res.status} ${res.statusText}` : String(res.status);
      throw new Error(`The engine would not re-read its settings (HTTP ${detail}). It is still running with the previous ones.`);
    }
    // No second reload here: the supervisor's own model poll picks up anything
    // the reload unloaded within a tick, and a reload is a WRITE — sending two
    // for one change would reconcile the router twice.
    this.emit('status-changed');
  }

  /** Apply a speed switch: the flags are command-line arguments, so the engine
   *  has to be respawned to pick them up. `supervisorBinary = null` is REQUIRED
   *  (K6): rebuildSupervisor dedups on binaryPath, so without it the rebuild
   *  returns early and the OLD flags come straight back. An engine that was NOT
   *  running is left stopped — booting one nothing asked for would take a
   *  gigabyte of memory to apply a setting. */
  private async applySpeed(): Promise<void> {
    const wasRunning = this.supervisor?.status() === 'running';
    if (this.supervisor) { await this.supervisor.stop(); this.supervisorBinary = null; }
    if (wasRunning) {
      const inst = this.currentInstall();
      if (inst) {
        await this.rebuildSupervisor(inst);
        await this.supervisor!.ensureRunning();
      }
    }
    this.emit('status-changed');
  }

  /** Note that the engine needs a reload (a new context length) or a fresh spawn
   *  (a speed switch), and make sure exactly ONE waiter is watching for the
   *  moment it is safe to do it.
   *
   *  WHY the wait exists: EngineSupervisor.stop() has no in-flight guard, so
   *  restarting the engine the instant a switch is flipped SIGTERMs
   *  llama-server mid-answer and the streaming reply dies — the opposite of
   *  what the signed contract promises ("a model in use reloads on its next
   *  message").
   *
   *  WHY FLAGS RATHER THAN A QUEUE OF JOBS: every restart is a full model
   *  reload the user sits through. One job per call meant flipping a switch off
   *  and on again while a reply streamed cost TWO restarts for a net-zero
   *  change, and changing the context length and a switch together cost a
   *  restart plus a reload the restart then made pointless. Two flags collapse
   *  any number of changes made during one wait into one action.
   *
   *  WHY THE DEADLINE IS SET HERE, not where the waiting happens: it belongs to
   *  the CHANGE. Timed from the start of each job instead, the second change
   *  behind a stream that never ends would wait ten minutes AFTER the first one
   *  already waited ten — the design says ten minutes regardless. */
  private requestApply(kind: 'reload' | 'restart'): void {
    if (kind === 'reload') this.needsReload = true; else this.needsRestart = true;
    this.configApplyError = null;
    // An existing waiter keeps ITS deadline: that one is the oldest pending
    // change, and it is the one the bound is owed to.
    if (!this.applyWaiter) {
      this.applyDeadline = Date.now() + (this.opts.configApplyMaxWaitMs ?? CONFIG_APPLY_MAX_WAIT_MS);
      this.applyWaiter = this.drainApplies()
        .finally(() => { this.applyWaiter = null; this.emit('status-changed'); });
    }
    this.emit('status-changed');    // the "Applies after the current reply" footer
  }

  /** Wait for the engine to be free, then apply everything asked for since the
   *  wait began, in one pass. */
  private async drainApplies(): Promise<void> {
    const pollMs = this.opts.configApplyPollMs ?? CONFIG_APPLY_POLL_MS;
    while (this.supervisor?.busy() && Date.now() < this.applyDeadline) {
      await new Promise((resolve) => { const t = setTimeout(resolve, pollMs); t.unref?.(); });
    }
    // Taken together, and cleared BEFORE the work: a change made while the
    // engine is being restarted is a new change and gets its own waiter.
    const reload = this.needsReload;
    const restart = this.needsRestart;
    this.needsReload = false;
    this.needsRestart = false;
    try {
      if (reload) this.writeModelPresets();
      // A fresh process reads config.json AND the preset file on its way up, so
      // when both are pending the restart applies both — reloading a router
      // that is about to be torn down buys nothing and costs a reconciliation.
      if (restart) await this.applySpeed();
      else if (reload) await this.applyReload();
    } catch (err: any) {
      // The channel answered long ago, so there is nothing left to fail — the
      // real message goes on the status instead, never a guessed cause.
      this.configApplyError = err?.message ? String(err.message) : String(err);
    }
  }

  // ---- per-model settings (design §C1 / §C2) ------------------------------

  /** One model's settings as they are stored right now — including
   *  `pendingApply` (the dialog's "Applies after the current reply" footer) and
   *  `lastLoadError`. A model the user has never touched reads as every default,
   *  which is the same thing as having no entry at all. */
  modelSettings(modelId: string): StoredModelSettings {
    return modelSettingsFor(readEngineConfig(this.home).models, modelId);
  }

  /** Save one model's settings.
   *
   *  The VALUE is written immediately and the engine is left alone: the preset
   *  file is NOT rewritten here. WHY not — every `?reload=1` (a finished
   *  download, a delete, a refresh) makes the router diff its presets and unload
   *  every model whose section changed, so writing the file at save time would
   *  drop the model mid-reply, which is the one thing contract R26 promises will
   *  not happen. The change is marked `pendingApply` and lands when that model
   *  has no request in flight (design §C2).
   *
   *  `dismissMemoryWarning` is a SIGNAL, not a value: main stamps the record
   *  itself, because the number that has to be stored is the resolved effective
   *  context length and only main knows how the per-model setting and the
   *  engine-wide default combine. */
  async setModelSettings(
    // WHY the named shared type rather than the shape spelled out here: this is
    // the ONE patch every surface sends (preload, remote shim, WS server,
    // workbench fake). Spelled out in five places it drifts in four of them.
    modelId: string,
    patch: ModelSettingsWrite,
  ): Promise<StoredModelSettings> {
    if (typeof modelId !== 'string' || !modelId) throw new Error('A model settings save needs a model id.');
    const current = this.modelSettings(modelId);
    const clean: ModelSettingsPatch = {};

    if (patch.contextLength !== undefined) {
      if (patch.contextLength === null) clean.contextLength = null;
      else if (!Number.isFinite(patch.contextLength) || patch.contextLength < 1024) {
        // The engine-wide knob's own words — one floor, one sentence.
        throw new Error('Context length must be at least 1024 tokens.');
      } else clean.contextLength = Math.floor(patch.contextLength);
    }
    if (patch.keepLoaded !== undefined) {
      if (typeof patch.keepLoaded !== 'boolean') throw new Error('"Keep loaded" must be on or off.');
      clean.keepLoaded = patch.keepLoaded;
    }
    if (patch.gpuLayers !== undefined) {
      if (patch.gpuLayers === 'auto') clean.gpuLayers = 'auto';
      else if (typeof patch.gpuLayers === 'number' && Number.isFinite(patch.gpuLayers) && patch.gpuLayers >= 0) {
        clean.gpuLayers = Math.floor(patch.gpuLayers);
      } else throw new Error('Graphics-chip layers must be a whole number, or Auto.');
    }
    if (patch.extraFlags !== undefined) {
      if (typeof patch.extraFlags !== 'string') throw new Error('Extra engine options must be text.');
      const parsed = parseExtraFlags(patch.extraFlags);
      // The parser's message is the user's — it names the option they typed.
      if (!parsed.ok) throw new Error(parsed.message);
      // Shape is not enough: the router refuses to START on an option it does
      // not recognise, in ANY section, so a plausible typo saved here would take
      // every local model down at the next launch. Only the BINARY knows its own
      // option list, and only a non-zero exit rejects — a check that could not
      // reach a verdict accepts (design §C2, model-presets.checkFlagsAgainstBinary).
      if (patch.extraFlags !== current.extraFlags && parsed.entries.length > 0) {
        const binaryPath = this.currentInstall()?.binaryPath;
        if (binaryPath) {
          const check = this.opts.checkFlags ?? checkFlagsAgainstBinary;
          const verdict = await check({ binaryPath, modelId, entries: parsed.entries });
          if (!verdict.ok) throw new Error(verdict.message);
        }
      }
      clean.extraFlags = patch.extraFlags;
    }

    // Which of the four the ENGINE reads. A save that changes none of them (a
    // dismissal, or the same values saved twice) must not mark anything pending:
    // the apply ends in an unload, and unloading a model to re-read settings it
    // is already running is a load the user pays for and did not ask for.
    const engineFields = ['contextLength', 'keepLoaded', 'gpuLayers', 'extraFlags'] as const;
    const changesEngine = engineFields.some(
      (k) => clean[k] !== undefined && clean[k] !== current[k],
    );

    if (patch.dismissMemoryWarning !== undefined) {
      if (patch.dismissMemoryWarning) {
        // The RESOLVED effective length, computed from the settings as they will
        // stand after this save — never a number the renderer supplies, which
        // cannot know how the per-model value and the engine-wide default
        // combine. A wrong number here keeps the warning silenced for a model
        // that now needs four times the memory (design §D4).
        const cfg = readEngineConfig(this.home);
        const after = { ...cfg.models, [modelId]: { ...current, ...clean } };
        clean.memoryWarningDismissed = {
          at: Date.now(),
          contextLength: contextLengthFor(modelId, after, cfg.contextSize),
        };
      } else {
        clean.memoryWarningDismissed = null;
      }
    }

    if (changesEngine) clean.pendingApply = true;
    const saved = await updateModelSettings(this.home, modelId, clean);
    this.emit('status-changed');    // the saved value is visible at once
    if (changesEngine) this.noteModelApply(modelId);
    return saved;
  }

  /** How many requests naming this model are in flight right now.
   *
   *  THIS is the signal a per-model apply waits on, and neither of the two
   *  counts that already existed can stand in for it: `supervisor.busy()` is
   *  engine-wide (a reply to a DIFFERENT model would hold this one's settings
   *  hostage), and the session ref-count never drops while a chat tab is open on
   *  the model — so an apply keyed on that would wait for a moment that never
   *  comes (design §C2). No engine running means nothing is in flight. */
  private inFlightForModel(modelId: string): number {
    return this.supervisor?.inFlightFor(modelId) ?? 0;
  }

  /** Note that one model's saved settings are not in force yet, and make sure a
   *  waiter is watching for the moment that model goes quiet.
   *
   *  The deadline belongs to the OLDEST pending change (the same rule
   *  `requestApply` follows): timed from each save instead, a second save behind
   *  a reply that never ends would wait out the bound AFTER the first one
   *  already had, and the design says ten minutes regardless. */
  private noteModelApply(modelId: string): void {
    // First write wins: a second save to the SAME model joins the deadline the
    // first one bought. Resetting it here would mean a user who keeps adjusting
    // one model during a wedged reply never reaches the bound at all.
    if (!this.pendingModelApplies.has(modelId)) {
      this.pendingModelApplies.set(
        modelId, Date.now() + (this.opts.configApplyMaxWaitMs ?? CONFIG_APPLY_MAX_WAIT_MS),
      );
    }
    this.startModelApplyWaiter();
    this.emit('status-changed');
  }

  /** Exactly one waiter, ever. The restart at the end is for the seam between
   *  the drain loop's last check and this callback: a save that landed in there
   *  would otherwise sit pending with nobody watching for it. */
  private startModelApplyWaiter(): void {
    if (this.modelApplyWaiter || this.pendingModelApplies.size === 0) return;
    this.modelApplyWaiter = this.drainModelApplies().finally(() => {
      this.modelApplyWaiter = null;
      this.emit('status-changed');
      this.startModelApplyWaiter();
    });
  }

  /** Wait for each pending model to go quiet, applying the ones that are ready
   *  as they become ready. Bounded: once the oldest change's deadline passes,
   *  everything still pending lands regardless — a wedged stream that never
   *  releases its hold cannot park a saved setting for the rest of the session. */
  private async drainModelApplies(): Promise<void> {
    const pollMs = this.opts.configApplyPollMs ?? CONFIG_APPLY_POLL_MS;
    while (this.pendingModelApplies.size > 0) {
      const now = Date.now();
      const ready = [...this.pendingModelApplies]
        .filter(([id, deadline]) => now >= deadline || this.inFlightForModel(id) === 0)
        .map(([id]) => id);
      if (ready.length === 0) {
        await new Promise((resolve) => { const t = setTimeout(resolve, pollMs); t.unref?.(); });
        continue;
      }
      // Taken out of the set BEFORE the work, with no await in between: a save
      // made while these are being applied is a NEW change and gets its own
      // deadline, rather than riding this one's expiry with no wait at all.
      for (const id of ready) this.pendingModelApplies.delete(id);
      try {
        await this.applyModelSettings(ready);
      } catch (err: any) {
        // The save answered long ago, so there is nothing left to fail — the
        // real message goes on the status, never a guessed cause.
        this.configApplyError = err?.message ? String(err.message) : String(err);
      }
    }
  }

  /** Put these models' saved settings into force: clear their pending flags so
   *  the preset renders them from config, write the file, make the router
   *  re-read it, then unload each one so its next message loads it with the new
   *  settings (design §C2). */
  private async applyModelSettings(ids: readonly string[]): Promise<void> {
    // The flags come off FIRST, and that is what selects them: writeModelPresets
    // holds back every model that is STILL pending, so clearing is how a model
    // says "render me from config now".
    // This run's engine may never have opened the preset at all: T7 falls back
    // to the old command line when the file cannot be written or is refused. A
    // reload then cannot read these settings, and the unload after it would cost
    // the user a full model load for nothing. Leave the change PENDING and say
    // nothing new — the card already reports that per-model settings are not in
    // force this run (presetInForce()), and the next spawn is where they really
    // take effect. Removing them from the map above is what stops the waiter
    // spinning on a change it cannot land.
    if (this.supervisor?.status() === 'running' && !this.supervisor.presetInForce()) return;
    for (const id of ids) await updateModelSettings(this.home, id, { pendingApply: false });
    this.writeModelPresets();
    await this.applyReload();
    // The reload alone unloads a model whose section changed, but only for the
    // diff the router sees; the explicit unload is what makes the new settings
    // certain to be read on this model's next message.
    for (const id of ids) await this.unloadModel(id);
    this.emit('status-changed');
  }

  /** Pending changes for models that are idle RIGHT NOW, cleared and returned so
   *  the caller can fold them into a reload it was making anyway. A model that is
   *  busy is left pending — its section is held back by writeModelPresets, so the
   *  reload does not touch it (design §C2, "only for idle models"). */
  private async mergeIdlePendingSettings(): Promise<string[]> {
    const done: string[] = [];
    for (const id of [...this.pendingModelApplies.keys()]) {
      if (this.inFlightForModel(id) !== 0) continue;
      try {
        await updateModelSettings(this.home, id, { pendingApply: false });
        this.pendingModelApplies.delete(id);
        done.push(id);
      } catch { /* left pending — the waiter above tries again */ }
    }
    return done;
  }

  /** A fresh engine writes models.ini from config on its way up and reads it
   *  there, so once it is running with that file in force, every saved change IS
   *  applied and nothing is pending any more.
   *
   *  WHY this has to be said out loud: the flag lives in config.json, which
   *  outlives the process. Without this, a change saved during a reply and then
   *  picked up by the next app launch would leave `pendingApply` set for ever —
   *  the dialog would keep promising "Applies after the current reply", and the
   *  next reload would unload the model to apply settings it is already running.
   *
   *  Only on the TRANSITION into running: the engine emits status-changed while
   *  it is already up too, and acting on those would clear a flag the moment the
   *  user set it. And only when the preset is really in force — a boot that fell
   *  back to the command line is running WITHOUT these settings (T7). */
  private async notePresetInForce(): Promise<void> {
    const state = this.supervisor?.status() ?? null;
    if (state === this.lastSupervisorState) return;
    this.lastSupervisorState = state;
    if (state !== 'running' || !this.supervisor?.presetInForce()) return;
    let waiting: string[];
    try {
      const models = readEngineConfig(this.home).models;
      waiting = Object.keys(models).filter((id) => models[id].pendingApply === true);
    } catch { return; }   // unreadable config — the next spawn asks again
    if (waiting.length === 0) return;
    for (const id of waiting) this.pendingModelApplies.delete(id);
    for (const id of waiting) {
      try { await updateModelSettings(this.home, id, { pendingApply: false }); } catch { /* next spawn */ }
    }
    this.emit('status-changed');
  }

  /** Record why a model last failed to load, in the engine's own words, or clear
   *  it when the same model loads. Both of `lastLoadError`'s sources land here
   *  (design §C2). Writes NOTHING when the answer has not changed — this runs on
   *  every load, and rewriting config each time would churn a locked file. */
  private async noteLoadError(modelId: string, message: string | null): Promise<void> {
    let had: string | null;
    try { had = this.modelSettings(modelId).lastLoadError ?? null; } catch { return; }
    if (had === message) return;
    try { await updateModelSettings(this.home, modelId, { lastLoadError: message }); } catch { return; }
    this.emit('status-changed');
  }

  /** Install the pinned engine for this machine. Vulkan-first on win/linux
   *  with an automatic CPU fallback when the Vulkan build won't BOOT (spec
   *  §3.1) — the fallback is decided by a real verify-boot, not GPU sniffing.
   *  Progress rides the 'install-progress' event. */
  async install(): Promise<void> {
    if (this.installing) throw new Error('An engine install is already running.');
    this.installing = true;
    const onProgress = (p: EngineInstallProgress) => this.emit('install-progress', p);
    try {
      const cfg = readEngineConfig(this.home);
      const preferred = cfg.backend ?? defaultBackend(process.platform);
      const sel = selectInstallAsset(process.platform, process.arch, preferred);
      if (!sel) {
        throw new Error(`Local models are not available for this platform yet (${process.platform}/${process.arch}).`);
      }
      const { asset, backend } = sel;
      let bootedBackend: EngineBackend = backend;
      let installed: InstalledEngine;
      try {
        installed = await this.installAndVerify(asset, onProgress);
      } catch (bootErr) {
        // Vulkan build won't start (no/old driver, headless box) → one CPU
        // retry. Only reached when we started on vulkan; the missing-asset
        // drop in selectInstallAsset already used cpu when there was no choice.
        const cpuAsset = backend === 'vulkan' ? pickAsset(process.platform, process.arch, 'cpu') : null;
        if (!cpuAsset) throw bootErr;
        installed = await this.installAndVerify(cpuAsset, onProgress);
        bootedBackend = 'cpu';
      }
      // Record the booted backend when it differs from the platform default
      // (a missing-asset drop OR a vulkan→cpu boot fallback) so status()/
      // installed() resolve to the build that actually works — never the
      // leftover non-booting one. cfg is only touched AFTER a successful boot.
      if (bootedBackend !== defaultBackend(process.platform)) {
        await updateEngineConfig(this.home, { backend: bootedBackend });
      }
      // Only now, with a booted replacement in hand, is the old engine garbage.
      // installed() prefers the pinned version anyway, so anything else on disk
      // is unreachable weight rather than a fallback.
      this.acquisition.pruneOthers(installed);
      this.emit('status-changed');
    } catch (e: any) {
      onProgress({ kind: 'error', message: e?.message ?? String(e) });
      this.emit('status-changed');
      throw e;
    } finally {
      this.installing = false;
    }
  }

  /** Install an asset and prove it RUNS, undoing the install if it does not.
   *
   *  The undo is the whole point: acquisition.install() marks a directory complete
   *  and moves it into place before anything executes the binary, and installed()
   *  prefers the pinned version over every other — so a downloaded-but-unrunnable
   *  engine silently replaces a working one. Discarding it here restores the
   *  previous engine as the newest USABLE install, which is what installed()
   *  resolves to on the next call. The supervisor is dropped too: verifyBoot
   *  pointed it at the binary we just deleted. */
  private async installAndVerify(
    asset: EngineAsset, onProgress: (p: EngineInstallProgress) => void,
  ): Promise<InstalledEngine> {
    // Only an install THIS call created may be discarded. acquisition.install()
    // is idempotent — handed a version+backend already on disk it returns it
    // untouched — so pressing Install on the engine you are already running
    // reaches verifyBoot too, and a transient boot failure there (a busy port,
    // a driver hiccup) must not delete a build that has been working for weeks.
    const dir = this.acquisition.installDir(ENGINE_VERSION, asset.backend);
    const preexisting = fs.existsSync(path.join(dir, '.complete'));
    const installed = await this.acquisition.install(asset, onProgress);
    try {
      await this.verifyBoot(installed);
      return installed;
    } catch (bootErr) {
      if (!preexisting) {
        if (this.supervisor) { try { await this.supervisor.stop(); } catch { /* already dead */ } }
        this.supervisor = null;
        this.supervisorBinary = null;
        this.acquisition.discard(installed);
      }
      throw bootErr;
    }
  }

  /** Bring the engine up to the pinned version at app launch, in the background.
   *
   *  WHY automatic: a new model architecture only becomes runnable when llama.cpp
   *  learns to read it, and a user has no way to know that a model that "won't
   *  load" needs a newer engine. Holding everyone at the version they first
   *  installed makes every future model release look like a broken app.
   *
   *  Deliberately NOT a first install. With no engine on disk this returns
   *  immediately: pulling a few hundred MB on first launch, for a feature the user
   *  may never touch, is not ours to decide — that stays the Install button.
   *
   *  Never throws and never blocks startup. Every failure path (offline, metered,
   *  a build that will not boot here) leaves the working engine exactly as it was;
   *  the manual Update button in Settings is still there to retry. */
  async autoUpdateOnLaunch(): Promise<void> {
    try {
      const inst = this.currentInstall();
      if (!inst) return;                          // no engine yet — first install stays a user action
      if (inst.version === ENGINE_VERSION) return; // already current
      if (this.installing) return;                 // a manual install is already running
      // Swapping the binary stops the running engine, which unloads whatever model
      // is resident — minutes of reload for a large one. At launch nothing should
      // be running yet, but a session restored fast enough could have started it,
      // and the next launch will pick the update up anyway.
      if (this.supervisor && this.supervisor.status() !== 'stopped') return;
      await this.install();
      // Leave the engine exactly as this method found it: STOPPED. install()
      // deliberately leaves it running (someone who just pressed Install wants to
      // use it), but nobody asked for this one — and without the stop, the first
      // launch after an engine bump would silently start a llama-server that
      // previously only appeared on the first message. An unexplained new process
      // at startup is the kind of change a user cannot trace back to anything.
      if (this.supervisor) await this.supervisor.stop();
      this.emit('status-changed');
    } catch {
      // Swallowed on purpose: this is unattended background work the user did not
      // ask for, so it must never surface an error they cannot act on. install()
      // has already emitted an install-progress 'error' for anyone watching the
      // Settings card, and installAndVerify has restored the previous engine.
    }
  }

  /** Boot the engine once and wait for /health — proves the build runs on this
   *  machine. The engine is LEFT RUNNING (the user installed it to use it;
   *  idle shutdown reaps it if not). */
  private async verifyBoot(installed: InstalledEngine): Promise<void> {
    await this.rebuildSupervisor(installed);
    await this.supervisor!.ensureRunning();
  }

  /** Everything the supervisor's spawn needs, read from disk EACH time it asks.
   *
   *  `speed` and `models` are read straight off the engine section rather than
   *  through readEngineConfig, which validates only the three keys it has always
   *  had. Both are read defensively because this file is shared with the built
   *  app and can be edited by hand: a missing or malformed value means "the
   *  default", never a crash on the path that starts the engine.
   *
   *  Both speed switches default ON — that is what shipped before they were
   *  switchable, so a config file that predates them behaves exactly as before. */
  private spawnConfig(): EngineSpawnConfig {
    const cfg = readEngineConfig(this.home);
    const engine = (this.home.readJson('config.json') as { engine?: Record<string, any> } | null)?.engine;
    const speed = engine?.speed;
    const models = engine?.models;
    return {
      cacheDir: cfg.cacheDir,
      contextSize: cfg.contextSize,
      speed: {
        speculative: speed?.speculative !== false,
        compressCache: speed?.compressCache !== false,
      },
      models: models && typeof models === 'object' ? models : null,
    };
  }

  private async rebuildSupervisor(installed: InstalledEngine): Promise<void> {
    if (this.supervisor && this.supervisorBinary === installed.binaryPath) return;
    if (this.supervisor) await this.supervisor.stop();
    this.supervisor = new EngineSupervisor({
      binaryPath: installed.binaryPath,
      port: this.port,
      // A CALLBACK, not the values: the supervisor re-reads config.json at every
      // spawn, so changing a speed switch or the context length and restarting
      // now actually restarts with the new setting. Passing cfg.* here is what
      // used to freeze the old values into the object for its whole life.
      readConfig: () => this.spawnConfig(),
      presetPath: presetFilePath(this.home.root),
      fetchImpl: this.opts.fetchImpl,
      ...(this.opts.supervisorOpts ?? {}),
    });
    this.supervisorBinary = installed.binaryPath;
    // A brand-new supervisor has never been running, whatever the old one was.
    this.lastSupervisorState = null;
    // Fan out supervisor transitions so the EngineCard tracks crash/idle live.
    this.supervisor.on('status-changed', () => {
      void this.notePresetInForce();
      this.emit('status-changed');
    });
    // T7 drops the section of a model the engine refuses at startup so the OTHER
    // models can still run — which means that model never gets a router row to
    // fail on, and this event is the ONLY place its failure is visible. The
    // message is the engine's own sentence, quoted (design §C2).
    this.supervisor.on('preset-model-rejected', (e: { modelId: string; message: string }) => {
      void this.noteLoadError(e.modelId, e.message);
    });
    // The other source: a load that the router itself answered with an error.
    this.supervisor.on('model-load-result', (e: { modelId: string; ok: boolean; status: number | null; body: string }) => {
      const message = e.ok ? null
        : e.status === null
          // The request could not be made — say that, not a guess at why.
          ? (e.body || 'the engine could not be reached')
          : routerErrorText(e.status, e.body);
      void this.noteLoadError(e.modelId, message);
    });
    this.supervisor.on('crashed', (info) => this.emit('crashed', info));
    // Fan out per-model residency (load/sleep/unload) → the model-state
    // coordinator turns this into per-session banners (unloaded/loading UI).
    this.supervisor.on('models-changed', (models) => this.emit('models-changed', models));
  }

  /** Best-effort per-model unload — used when the last session bound to a model
   *  goes away (frees its memory immediately, ahead of the 5-min sleep). */
  async unloadModel(modelId: string): Promise<void> {
    if (!this.supervisor) return;
    await this.supervisor.unloadModel(modelId);
  }

  /** The last session bound to `modelId` closed. Frees its memory now — UNLESS
   *  the user asked to keep this model loaded, which is the whole point of that
   *  setting: closing a chat must not make the next message pay the full load
   *  again (design §C2). Kept apart from `unloadModel` deliberately, so an
   *  explicit "unload this model" still means it. */
  async releaseModel(modelId: string): Promise<void> {
    let keepLoaded = false;
    // Read inside a try: NativeHome rethrows a non-ENOENT read error, and this
    // runs from a session-teardown callback with nobody to report it to.
    // Unreadable config means "no setting I can see", i.e. today's behaviour.
    try { keepLoaded = this.modelSettings(modelId).keepLoaded; } catch { keepLoaded = false; }
    if (keepLoaded) return;
    await this.unloadModel(modelId);
  }

  /** Force a model resident (the [Reload Model] button). Boots the engine if
   *  needed, then warms the model so its state flips loading → loaded.
   *  ensureServable first: this is the pick-time safety net for a GGUF that
   *  reached --models-dir after the router booted (download finished with the
   *  app closed, a file copied in by hand, a refresh that failed). Without it
   *  the warm-up 400s and the user's first send is what tells them. */
  async loadModel(modelId: string): Promise<void> {
    const inst = this.currentInstall();
    if (!inst) throw new Error('The local engine is not installed yet.');
    await this.rebuildSupervisor(inst);
    await this.supervisor!.ensureServable(modelId);
    await this.supervisor!.loadModel(modelId);
  }

  /** Is a llama-server process running right now? Asked by "Add vision" (design
   *  §E4) before it unloads and polls: with no process there is nothing holding
   *  the model's file open and no router to ask, so both steps are skipped
   *  rather than spent waiting for an answer that can never come. */
  engineRunning(): boolean {
    return this.supervisor?.status() === 'running';
  }

  /** Requests naming this model in flight right now — the per-model count, which
   *  is what says a model is safe to take out from under (see
   *  EngineSupervisor.inFlightFor). Zero when there is no engine at all. */
  inFlightFor(modelId: string): number {
    return this.supervisor?.inFlightFor(modelId) ?? 0;
  }

  /** The router's own word on one model's residency; `null` = could not be
   *  determined, NEVER "unloaded" (EngineSupervisor.routerModelState). */
  async routerModelState(modelId: string): Promise<EngineModelState | null> {
    if (!this.supervisor) return null;
    return this.supervisor.routerModelState(modelId);
  }

  /** Make the running router re-scan --models-dir. Called after a download lands
   *  and after a delete, so the router's model set matches the disk. No-op when
   *  the engine is stopped — its next boot scans the dir anyway. */
  async refreshModels(): Promise<void> {
    if (!this.supervisor) return;
    // A pending settings change for a model that is IDLE right now rides along:
    // this call makes the router re-read its preset file anyway, so a change
    // that can land for free should. A model that is BUSY keeps its old section
    // (writeModelPresets holds it back) — this reload must not unload a model
    // mid-reply, which is the entire reason the pending flag exists (design §C2).
    const merged = await this.mergeIdlePendingSettings();
    try { this.writeModelPresets(); } catch { /* keep the file the engine already read */ }
    await this.supervisor.refreshModels();
    for (const id of merged) await this.unloadModel(id);
    this.emit('status-changed');
  }

  /** True when the router can actually SERVE `modelId` right now. Fails OPEN
   *  (see EngineSupervisor.ensureServable) — a false is a positive "the router
   *  listed its models and yours was not among them", safe to act on. */
  async ensureServable(modelId: string): Promise<boolean> {
    if (!this.supervisor) return true;
    return this.supervisor.ensureServable(modelId);
  }

  /** Live per-model residency for the create-time memory guard + coordinator. */
  async liveModels(): Promise<EngineModel[]> {
    const inst = this.currentInstall();
    if (!inst) return [];
    await this.rebuildSupervisor(inst);
    return this.supervisor!.listModels();
  }

  /** User-initiated recovery: clear the strike-out and boot fresh. */
  async restart(): Promise<void> {
    const inst = this.currentInstall();
    if (!inst) throw new Error('The local engine is not installed yet.');
    await this.rebuildSupervisor(inst);
    this.supervisor!.resetStrikes();
    await this.supervisor!.stop();
    await this.supervisor!.ensureRunning();
  }

  registryHook(): LocalEngineHook {
    return {
      installed: () => this.currentInstall() !== null,
      ensureRunning: async () => {
        const inst = this.currentInstall();
        if (!inst) {
          throw new Error('Local models need a one-time engine install — open Settings → Providers and press Install.');
        }
        await this.rebuildSupervisor(inst);
        return this.supervisor!.ensureRunning();
      },
      ensureServable: async (modelId: string) => this.ensureServable(modelId),
      recordReply: (timings) => this.recordReply(timings),
      // Bound lazily: the supervisor may not exist yet when the registry is
      // constructed; by the time the AI SDK fetches, ensureRunning built it.
      fetchImpl: () => (input: any, init?: any) => {
        if (!this.supervisor) return (this.opts.fetchImpl ?? fetch)(input, init);
        return this.supervisor.trackedFetch(input, init);
      },
    };
  }

  /** Local rows for ModelCatalog.get(). contextLength is the CONFIGURED -c —
   *  the engine truncates there regardless of the model's trained max, and
   *  HarnessSession sizes its history window from this number. */
  async catalogModels(): Promise<CatalogModel[]> {
    const inst = this.currentInstall();
    if (inst === null) return [];
    const cfg = readEngineConfig(this.home);
    await this.rebuildSupervisor(inst);
    const models = await this.supervisor!.listModels();
    return models.map((m) => {
      const row: CatalogModel = {
        id: m.id,
        providerId: 'local',
        // The id stays the raw first-part filename (that IS the engine's address
        // for the whole set); only the label drops the -00001-of-00004 marker, so
        // one split model reads as one model in the picker.
        label: stripSplitSuffix(m.id),
        contextLength: cfg.contextSize,
        local: { sizeBytes: m.sizeBytes ?? 0, quant: 'unknown', installed: true, state: m.state },
      };
      // Design §E5 — a local model that the router paired a projector with can
      // see images, and this is where the rest of the app finds that out: the
      // catalog row is what the session's vision resolver reads, exactly as it
      // already does for an OpenRouter row. Assigned CONDITIONALLY, like
      // model-catalog.ts's openrouterModels() does with the same field: when the
      // router was never asked (engine stopped, so listModels answered from the
      // disk scan) the answer is "don't know", and CatalogModel.supportsVision
      // must stay undefined rather than become a `false` a caller would read as
      // "this model cannot see" and quietly drop the user's attachment.
      if (m.inputModalities) row.supportsVision = m.inputModalities.includes('image');
      return row;
    });
  }

  /** The REAL context window HarnessSession should size its history + compaction
   *  from for a local model: the minimum of what llama-server actually loaded
   *  (its /props n_ctx) and the model's GGUF-trained max. This replaces trusting
   *  the configured -c blindly — a small model overflows if we size to a -c larger
   *  than its trained ceiling. Boots the engine if needed (single-flight; it would
   *  boot on the first send anyway) to read the live number. NEVER throws — a
   *  status read must not break session create; on any failure we return the same
   *  conservative default clampContextWindow uses.
   *
   *  Task 13 fix pass: also returns `totalSlots` (llama-server's total_slots) —
   *  the local concurrency cap needs this, and it lives in the exact same
   *  /props response this function already fetches. Folding it into this one
   *  return value (rather than a second method with its own fetch) is WHY
   *  reading both costs exactly one HTTP round trip: fix pass 2 threads this
   *  whole object straight through ipc-handlers.ts's single contextAndSlotsFor
   *  closure into NativeSessionHost — there is no separate slot-count call and
   *  no variable sharing one reading between two closures. */
  async effectiveContextWindow(modelId: string): Promise<{ contextLength: number; totalSlots: number | null }> {
    try {
      const inst = this.currentInstall();
      // Engine not installed yet → no live number to read; fall through to the
      // trained max (also null today) → conservative default. No engine means
      // no slot count either — totalSlots is unknown, not zero.
      if (!inst) return { contextLength: clampContextWindow(null, this.trainedContextFor(modelId)), totalSlots: null };
      await this.rebuildSupervisor(inst);
      await this.supervisor!.ensureRunning();
      // /props is a llama-server management endpoint at ROOT (not the /v1 OpenAI
      // namespace) — same 127.0.0.1:port convention as /models and /health. Plain
      // fetch, not trackedFetch: a status read must not bump the idle-shutdown clock.
      //
      // WHY `?model=` (fixed 2026-09-04, measured live on the pinned b10665 in
      // router mode): the router only describes a model's slots and context
      // when the request NAMES the model. A bare `/props` answers
      // `{model_path:"none", default_generation_settings.n_ctx: 0}` with no
      // slot field at all, so the app had been reading "unknown" for every
      // local model — which capability-profile.ts turns into a cap of ONE
      // helper at a time, while the engine actually had four slots. With the
      // model named, n_ctx is whatever the engine holds for THAT model: under
      // the app's real spawn (no `--parallel`, so b10665 turns on a unified KV
      // cache) that is the FULL `-c` shared by all slots — 16384 with 4 slots,
      // measured; only an explicit `--parallel N` splits it into `-c` / N. We
      // pass the engine's number through either way, never recompute it.
      //
      // WHY the status check first (2026-09-04 review, F1 + F4): on this build
      // `GET /props?model=<id>` is NOT a read — the router AUTOLOADS the named
      // model (`--models-autoload` defaults on; the supervisor passes no
      // `--no-models-autoload`) and blocks, with no timeout on this fetch,
      // until gigabytes are in RAM/VRAM. This method runs on every session
      // create / resume / model swap BEFORE the user has sent anything, and at
      // `--models-max 2` an autoload can evict the model a live conversation
      // is mid-way through using. A status read must never have that side
      // effect, so we ask `GET /models` (the supervisor's listModels — the same
      // fetch its model poll already makes, no `?reload=1`, which the engine
      // rule forbids as a write) and name the model ONLY when it is already
      // `loaded`. Everything else — `unloaded`, `sleeping` (naming a sleeping
      // model would wake it: same autoload, F4), `loading`, or a model the
      // router has never listed — takes the model-less `/props` master always
      // used: instant, n_ctx 0 → the configured -c below, no slot field →
      // totalSlots null → the conservative one-helper cap until the first
      // real send loads the model and a later read sees `loaded`.
      const models = await this.supervisor!.listModels();
      const resident = models.find((m) => m.id === modelId)?.state === 'loaded';
      const propsUrl = resident
        ? `http://127.0.0.1:${this.port}/props?model=${encodeURIComponent(modelId)}`
        : `http://127.0.0.1:${this.port}/props`;
      const res = await (this.opts.fetchImpl ?? fetch)(propsUrl, { method: 'GET' });
      const props: any = await res.json();
      // The field carrying the loaded context has drifted across llama.cpp builds
      // (default_generation_settings.n_ctx vs a top-level n_ctx) — read both.
      const loadedRaw = props?.default_generation_settings?.n_ctx ?? props?.n_ctx ?? null;
      // Task 13 fix pass: the slot count rides the SAME response body — see
      // resolveSlotCount's own comment for why an absent/zero/non-numeric
      // reading resolves to null ("unknown") rather than a guessed count.
      // WHY two names: the pinned b10665 calls it `total_slots` (there is no
      // `n_slots` key on that build — the old code read a field that never
      // existed, and its tests pinned the wrong name); `n_slots` stays as a
      // fallback for older llama.cpp builds a user may still be running.
      const totalSlots = resolveSlotCount(props?.total_slots ?? props?.n_slots);
      const trained = this.trainedContextFor(modelId);
      // Fall back to the -c WE spawned the server with, not a blind constant.
      //
      // WHY (found 2026-07-26 dogfooding): in `--models-dir` ROUTER mode — the
      // default — a model-less /props answers `{model_path: "none", n_ctx: 0}`,
      // and that is the URL this method sends whenever the model is not
      // already `loaded` (see the status check above). clampContextWindow discards any value <= 0,
      // so it fell through to its hardcoded 32_768 and every local session
      // believed it had half the window it was actually given. A read of
      // ROADMAP.md that fits comfortably in 64k then overflowed a phantom 32k
      // budget and killed the turn ("messages must not be empty").
      //
      // The configured contextSize is strictly better than a constant: it is the
      // exact number this app passed to llama-server on the command line, so it
      // is right whenever /props is merely UNINFORMATIVE. A live /props reading
      // still wins when present — it catches the case where the server clamped
      // our -c down to what the model or VRAM actually allowed.
      //
      // ADDRESSING this function's own doc comment above ("replaces trusting the
      // configured -c blindly — a small model overflows if we size to a -c larger
      // than its trained ceiling"): that concern is real but it does NOT argue for
      // the old behavior, because the constant it fell back to was 32_768 — itself
      // far larger than the 4k-trained model the warning describes. The old default
      // over-sized that model too; it just over-sized everything else DOWNWARD as
      // well. Three things bound the risk here:
      //   - the model-less /props (sent while the model is not resident) reports
      //     0. Once the model is loaded, the next read names it and the live
      //     n_ctx the engine holds for it wins — the full -c under the app's
      //     spawn, -c / slots only with an explicit --parallel — so any
      //     server-side clamp is respected.
      //   - effectiveContextForModel then clamps to the registry's documented
      //     maxContextWindow for every known family.
      //   - trainedContextFor() is inert today, so the "trained max" guard the
      //     comment relies on provides nothing either way. NOT for want of a
      //     parser any more — see its own comment below.
      // Closing the gap means handing this function the header reader's
      // contextLength, not guessing low.
      //
      // 2026-09-05 (§C3): the number to fall back on is THIS MODEL's configured
      // context length, not the engine-wide one — a model the user set to 128k
      // that happens to be asleep must not be sized as if it were on the
      // engine's 32k default. `contextLengthFor` is that resolution (per-model
      // setting ?? engine-wide) and lives with the estimator that also uses it.
      const cfg = readEngineConfig(this.home);
      const configured = contextLengthFor(modelId, cfg.models, cfg.contextSize);
      return { contextLength: resolveEffectiveContext(loadedRaw, configured, trained), totalSlots };
    } catch {
      // Same reasoning on the error path — prefer our own -c over a guess.
      // A failed read (network error, bad JSON, no supervisor) means the slot
      // count is unknown too — never guess a number here either.
      try {
        const cfg = readEngineConfig(this.home);
        return {
          contextLength: resolveEffectiveContext(null, contextLengthFor(modelId, cfg.models, cfg.contextSize), null),
          totalSlots: null,
        };
      } catch {
        return { contextLength: 32_768, totalSlots: null };
      }
    }
  }

  /** The model's GGUF-trained max context, if known. Returns null, so
   *  clampContextWindow falls back to the loaded /props value alone.
   *
   *  CORRECTED 2026-09-06 — the reader this was waiting for EXISTS. It used to
   *  say "nothing here parses the GGUF header yet"; `models/gguf-header.ts` now
   *  reads <arch>.context_length into `GgufHeader.contextLength` (cached in
   *  userData, probe-pinned by test-engine/probe-headers.mjs) and the memory
   *  estimator already depends on it. The only thing still missing is the wire:
   *  the cache scan (scanGgufCache → EngineModel) carries no trained-context
   *  field, so this function has nothing local to read. Anyone closing this gap
   *  should surface the existing reader's number here — a model whose file was
   *  trained smaller than the loaded context can then no longer be over-driven —
   *  and must NOT write a second parser. */
  private trainedContextFor(_modelId: string): number | null {
    return null;
  }

  /** Switch the engine to a GPU build, and REFUSE the switch unless the new
   *  build is proved to work on this machine (design §A4).
   *
   *  WHY this is so much more than "download it and record the choice": the
   *  download is 204 MB (Linux ROCm) to 612 MB (Windows CUDA), and the failure
   *  mode it guards is the worst one this feature has — a user takes the app's
   *  advice, and their local models silently stop working. So the switch is
   *  kept only after four things hold, in this order:
   *
   *    1. the marker's device list actually contains a CUDA/ROCm device
   *       (`devicesError` read FIRST, so "the binary would not start" never
   *        gets reported as "your graphics chip is unsupported"),
   *    2. the binary boots and answers /health (verifyBoot),
   *    3. a real 1-token load of the smallest model on disk does not fail with
   *       a device- or kernel-class error, and does not leave the engine
   *       unreachable,
   *    4. and only then is the choice written to config.json.
   *
   *  Any of 1-3 failing throws away the install THIS CALL created — never one
   *  that was already on disk (the same `preexisting` guard installAndVerify
   *  has: pressing Switch twice must not delete a build that has been working).
   *
   *  PINNING THE PREVIOUS ENGINE IS NOT OPTIONAL, and deleting the new
   *  directory is NOT enough on its own. Which engine is current is decided by
   *  `installed(preferBackend)`, and `preferBackend` is the config's `backend`
   *  — which is `null` for an ordinary user, because install() records it only
   *  when it differs from the platform default. With null, `installed()` falls
   *  through to raw `readdirSync` order, and `b10665-rocm` / `b10665-cuda` sort
   *  BEFORE `b10665-vulkan`. So any refused directory that survives makes the
   *  refused build the current engine while the message says "Nothing was
   *  changed" — and three routes leave one behind: a `preexisting` directory we
   *  must not delete, a `discard()` that returns false (Windows, holding the
   *  exe we just booted), and a quit or crash between the install and the
   *  config write, a window this task widened to "download 612 MB, boot, and
   *  load a whole model". Writing the CURRENT backend down BEFORE the download
   *  closes all three at once. */
  async setBackend(backend: EngineBackend): Promise<void> {
    const asset = pickAsset(process.platform, process.arch, backend);
    if (!asset) {
      throw new Error(`That backend is not available for this platform (${process.platform}/${process.arch}).`);
    }
    const onProgress = (p: EngineInstallProgress) => this.emit('install-progress', p);
    // The engine the user is running right now, named explicitly (see above).
    // Null only when nothing is installed at all, in which case there is no
    // previous engine for a leftover directory to shadow.
    let previous = this.currentInstall()?.backend ?? null;
    if (previous === backend) {
      // The build we are about to test is ALREADY what installed() selects,
      // which on a null config means readdir order picked it — a leftover
      // directory from an earlier attempt shadowing the engine the user is
      // really running. Pinning THAT would make the shadowing permanent, so
      // pin what they would otherwise be on instead.
      const fallback = this.acquisition.installed(defaultBackend(process.platform));
      previous = fallback && fallback.backend !== backend ? fallback.backend : null;
    }
    if (previous) await updateEngineConfig(this.home, { backend: previous });
    // Read BEFORE the install, because install() is idempotent: handed a
    // version+backend already on disk it returns it untouched, so afterwards
    // there is no way left to tell "I just made this" from "this was here".
    // It must ask the SAME question install() asks — a marker whose binary is
    // missing is not a usable install, and install() reinstalls over it, so
    // treating it as pre-existing would refuse to discard a directory this
    // call really did create.
    const preexisting = this.usableInstallExists(this.acquisition.installDir(ENGINE_VERSION, asset.backend));
    const installed = await this.acquisition.install(asset, onProgress);

    // 1. What does the build itself say it can run on?
    const deviceRefusal = backendDeviceRefusal(backend, installed.devices, installed.devicesError);
    if (deviceRefusal) {
      await this.undoSwitch(installed, preexisting, previous);
      throw new Error(deviceRefusal);
    }

    // 2. It boots. A build that will not start leaves the previous one in place.
    try {
      await this.verifyBoot(installed);
    } catch (bootErr) {
      await this.undoSwitch(installed, preexisting, previous);
      throw bootErr;
    }

    // 3. It really runs a model. A ROCm build compiled for other chips lists a
    //    ROCm device and boots perfectly — and then fails on the first token
    //    with "no kernel image is available for execution on the device". Only
    //    an actual load reaches that, which is why booting is not enough.
    const cacheDir = readEngineConfig(this.home).cacheDir;
    const model = smallestCompleteModel(scanGgufCache(cacheDir));
    // No model on disk: there is nothing to load, so the check is deferred
    // rather than failed. The card's faster-engine row says so in words
    // (currentBackendOptions' note) instead of implying we checked.
    const load = model ? await this.probeModelLoad(model.id) : null;
    if (load && load.kind === 'unreachable') {
      // The engine answered /health seconds ago and now cannot be reached at
      // all. A GPU build compiled for the wrong chip commonly ABORTS the child
      // rather than returning an error document, so silence here is evidence
      // about the build, not about the model file — and the safe direction is
      // the one this whole method exists for: put the user back where they
      // started.
      await this.undoSwitch(installed, preexisting, previous);
      throw new Error(
        `Kept the current engine: the ${BACKEND_WORD[backend] ?? backend} build stopped answering while loading a model `
        + `— "${load.message}". Nothing was changed.`
      );
    }
    if (load && isDeviceClassLoadError(load.message)) {
      await this.undoSwitch(installed, preexisting, previous);
      throw new Error(keptCurrentEngine(BACKEND_WORD[backend] ?? backend, `"${load.message}"`));
    }

    // 4. Every check that says anything about the BACKEND has passed.
    await updateEngineConfig(this.home, { backend });
    this.emit('status-changed');

    // A load error that is not device-class is a MODEL problem — a corrupt
    // file, an architecture this engine cannot read, a model too large for the
    // memory — and throwing away a working engine over one bad file would be
    // the wrong trade. The switch stands; the user is still told, because the
    // alternative is discovering it on their next message. Thrown, because a
    // thrown message is the only thing the card renders (its install-progress
    // line is cleared the moment the action settles).
    //
    // CAREFUL: throwing here means the IPC handler's `return engineManager
    // .status()` never runs, so the card's status comes ENTIRELY from the
    // 'status-changed' push emitted on the line above. Move or remove that
    // emit and the card keeps drawing the old backend under this message.
    if (load) {
      throw new Error(
        `Switched to ${BACKEND_WORD[backend] ?? backend}. The engine started and found your graphics chip, `
        + `but the model "${model!.id}" did not load — "${load.message}".`
      );
    }
  }

  /** The same question `EngineAcquisition.install()` asks before deciding a
   *  directory is already installed: a marker AND the binary it names. */
  private usableInstallExists(dir: string): boolean {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(dir, '.complete'), 'utf8')) as { binaryRelPath?: unknown };
      if (typeof marker.binaryRelPath !== 'string') return false;
      return fs.existsSync(path.join(dir, marker.binaryRelPath));
    } catch {
      return false;
    }
  }

  /** Put the machine back exactly as the switch found it.
   *
   *  TWO separate mechanisms, because neither is sufficient alone: the config
   *  is pinned back to the engine the user was running (the only thing that
   *  decides which install is current — see setBackend's comment), and the new
   *  directory is deleted, but ONLY when this call created it. */
  private async undoSwitch(
    installed: InstalledEngine, preexisting: boolean, previous: EngineBackend | null,
  ): Promise<void> {
    // First, and unconditionally: whatever happens to the directory, the engine
    // the user was running is the one that must come back.
    //
    // This is deliberately a SECOND write of the same value — setBackend
    // already pinned it before the download, and no mutation can tell the two
    // apart today (measured: deleting this line leaves the suite green,
    // because nothing between the two writes touches the config). It stays
    // because the first write exists to survive a CRASH and this one exists to
    // survive a future edit that writes the config mid-flow; losing either
    // silently makes the refused build the current engine.
    if (previous) await updateEngineConfig(this.home, { backend: previous });
    if (!preexisting) {
      // The supervisor is dropped ONLY when it is pointing at the binary being
      // deleted. On the device-check path nothing has touched it — it is still
      // the user's old, working engine, possibly mid-reply, and stop() has no
      // in-flight guard, so tearing it down there would kill a streaming answer
      // and unload the resident model under a message saying nothing changed.
      if (this.supervisor && this.supervisorBinary === installed.binaryPath) {
        try { await this.supervisor.stop(); } catch { /* already dead */ }
        this.supervisor = null;
        this.supervisorBinary = null;
      }
      this.acquisition.discard(installed);
    }
    // The card's own error line comes from the thrown message, but the STATUS
    // it is drawn around (which engine is installed, which switch is offered)
    // just changed back — and nothing else pushes that.
    this.emit('status-changed');
  }

  /** Ask the running engine to load a model for one token, and report what it
   *  said if it would not. Returns null when the load succeeded.
   *
   *  Three outcomes, not two. An engine that ANSWERS with an error is telling
   *  us something about the model or the build; an engine that cannot be
   *  reached at all is telling us about the build, and must never be filed as
   *  "the model is broken" — the difference decides whether the switch stands.
   *
   *  Deliberately awaited, unlike loadModel() — this is a verification, not a
   *  warm-up, and its whole value is the engine's error text. Routed through
   *  trackedFetch so the idle shutdown cannot reap the server mid-load (a large
   *  model takes minutes to read off disk), and bounded by its own timeout so a
   *  wedged build cannot leave the button disabled forever. */
  private async probeModelLoad(modelId: string): Promise<LoadProbeFailure | null> {
    const doFetch = this.supervisor ? this.supervisor.trackedFetch : (this.opts.fetchImpl ?? fetch);
    const timeoutMs = this.opts.loadProbeTimeoutMs ?? LOAD_PROBE_TIMEOUT_MS;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await doFetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false,
        }),
        signal: abort.signal,
      });
      if (res.ok) return null;
      return { kind: 'answered', message: routerErrorText(res.status, await res.text().catch(() => '')) };
    } catch (e: any) {
      // The request could not be made, or took longer than a model load ever
      // should. Report what actually happened — never a guess at why.
      const message = abort.signal.aborted
        ? `the engine did not finish loading a model within ${describeDuration(timeoutMs)}`
        : (e?.message ?? String(e)).trim() || 'the engine could not be reached';
      return { kind: 'unreachable', message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Plan C: installed models with quant metadata (spec §4.5). lastUsedAt +
   *  defaultForTier were CUT from v1 (Amendment 2026-07-14 G). */
  /** Every download in the cache dir, complete or not, with the state the Local
   *  Models screen renders. Unlike liveModels() this deliberately does NOT
   *  filter incomplete sets — Settings is where you act on them. */
  async installedModels(): Promise<InstalledLocalModel[]> {
    const cacheDir = readEngineConfig(this.home).cacheDir;
    // Undo any "Add vision" move a crash stopped half way, BEFORE reading the
    // rows — best-effort, exactly like the manifest healing further down. Left
    // alone, a model whose files are split between the cache dir and its own
    // folder shows up as two broken rows offering only Delete, and the sweep
    // below would throw away the record that says where it came from.
    for (const id of interruptedMoveIds(cacheDir)) {
      try { healInterruptedMove(cacheDir, id); } catch { /* best-effort — the rows still render */ }
    }
    const rows: InstalledLocalModel[] = [];
    // §E3: complete downloads with no manifest at all — everything installed
    // before this feature existed. Collected here and handed to the backfill
    // once, at the end; nothing in this function waits on it.
    const backfillable: BackfillCandidate[] = [];
    for (const d of scanLocalDownloads(cacheDir)) {
      const complete = isComplete(d);
      // A vision model's files AND its manifest live in the model's own folder
      // (design §E2), so every manifest call here is against the download's own
      // directory, not the cache dir.
      const dir = d.subdir === null ? cacheDir : path.join(cacheDir, d.subdir);
      const manifest = d.hasManifest ? readManifest(dir, d.firstFileName) : null;
      if (complete && d.hasManifest) {
        // WHY this no longer deletes: the manifest OUTLIVES the download now, so
        // one sitting beside a complete set is the normal, wanted state. Two
        // exceptions, both best-effort and never a reason to fail the list:
        // an unreadable fragment is swept, and a readable-but-unstamped manifest
        // is a crash between publishing the last file and stamping it, so it is
        // healed here rather than thrown away — it holds the only record of the
        // repo this model came from.
        if (!manifest) {
          try { removeManifest(dir, d.firstFileName); } catch { /* best-effort */ }
        } else if (!isManifestComplete(manifest)) {
          // "complete" here is isComplete(d) — the part count read off the
          // FILENAMES (…-00002-of-00003.gguf), not the manifest's own `files`
          // list. That stays safe because `files` still holds exactly one
          // quant's split parts: T15 added the vision projector as a SECOND LEG
          // of the download job, never as a member of `files`, and the cache
          // scan keeps it out of `partsPresent` for the same reason. A render
          // that lands mid-projector therefore stamps this manifest complete —
          // deliberately: the weights ARE complete, and a missing projector is
          // the `vision: 'available'` state, not an interrupted download.
          try { markManifestComplete(dir, d.firstFileName, Date.now()); } catch { /* best-effort */ }
        }
        // A manifest saying "we looked this model's repo up and found nothing",
        // old enough to be worth asking again — a search can answer 200 and
        // still be wrong. Everything else here is settled and never re-asked.
        // The clock comes from the backfill's own lookups when they are
        // injected, so a test can drive "a month later" without waiting one.
        // Everything about this decision has to read the SAME clock the record
        // was stamped from, or a fake one makes every miss look ancient.
        const nowForRecheck = this.opts.backfillLookups?.now() ?? Date.now();
        if (manifest && isStaleBackfillMiss(manifest, nowForRecheck)) {
          backfillable.push({
            dir, firstFileName: d.firstFileName, parts: d.partsDeclared, bytesPublished: d.bytesPublished,
          });
        }
      } else if (complete) {
        // A finished model with NO record of where it came from — a download
        // made before manifests existed. Without one the app can never tell
        // whether this model's publisher ships a vision file, so it could never
        // show the eye or offer "Add vision". §E3 looks that up once.
        backfillable.push({
          dir, firstFileName: d.firstFileName, parts: d.partsDeclared, bytesPublished: d.bytesPublished,
        });
      }
      // The row's "unfinished" facts come only from a manifest that is still
      // in flight; a stamped one describes a download that already landed.
      const unfinished = !complete && manifest != null && !isManifestComplete(manifest);
      // Everything this download occupies: published weights, the projector, and
      // any .partial. All three are what a delete removes, so all three are what
      // the delete confirmation has to name — including on a COMPLETE row, which
      // used to report published bytes only and therefore understated a model
      // whose projector was still sitting as a .partial beside it.
      const bytesOnDisk = d.bytesPublished + d.bytesPartial + d.visionBytes;
      if (!complete && bytesOnDisk === 0 && !unfinished) {
        // Only an unreadable manifest — or one stamped complete whose files are
        // gone — and no bytes: nothing to resume, nothing to delete, nothing to
        // show. Remove the leftover so it cannot accumulate.
        try { removeManifest(dir, d.firstFileName); } catch { /* best-effort */ }
        continue;
      }
      const parsed = parseGgufName(d.firstFileName);
      rows.push({
        id: d.modelId,
        // Bytes on disk. For an unfinished set that includes the .partial, so
        // the delete confirmation names what the user actually gives up.
        sizeBytes: bytesOnDisk,
        // The manifest's quant is the exact string Hugging Face used — the one
        // live progress events carry, so the renderer can match them to this row.
        quant: (unfinished ? manifest?.quant : undefined) ?? parsed?.quant ?? null,
        quantDescription: parsed ? quantDescription(parsed.quant) : null,
        parts: d.partsDeclared,
        status: complete ? 'complete' : unfinished ? 'unfinished' : 'untraceable',
        partsPresent: d.partsPresent,
        totalSizeBytes: unfinished ? manifest!.totalSizeBytes : null,
        // T15 FLIPS THIS: a complete row now reports its repo too, where it
        // used to report null. WHY it has to: a vision model's download has a
        // second leg (the projector), and the weights are complete before that
        // leg finishes — so for those seconds the row is 'complete' AND its
        // projector is still arriving. LocalModelsSection matches a live
        // download to a row on repo + quant; with null it matched nothing, so
        // the row showed no progress bar and offered "Add vision" for the very
        // file being fetched, and Delete would not have cancelled first.
        //
        // WHY the flip is safe here, which it would NOT have been on its own:
        // repo + quant determines the file set, hence the filename, hence the
        // model id — so a live download of this repo+quant IS this row. The one
        // layout that could have produced two rows sharing them (the same model
        // once flat and once in a folder) is refused where it would be created,
        // in ModelDownloader.start.
        repo: manifest?.repo ?? null,
        // The three vision states (design §E2). 'ready' is read off the DISK —
        // a published projector beside the weights is exactly what makes the
        // engine load this model with `--mmproj`. 'available' is read off the
        // MANIFEST — the repo ships a projector this copy does not have, which
        // is both "the download's second leg failed" and the crash-recovery
        // state, and both are answered by the same "Add vision" link.
        vision: d.hasProjector ? 'ready' : manifest?.visionFile ? 'available' : 'none',
        // What that eye costs: the projector on disk when it is here, else the
        // size the row's "Add vision (0.9 GB)" label has to quote.
        visionBytes: d.hasProjector ? d.visionBytes : manifest?.visionFile?.size ?? null,
      });
    }
    // Fire-and-forget, and only when there is something to look up: kick()
    // defers everything to a later tick and returns, so this list is never held
    // up by Hugging Face. The answers appear the next time the screen opens.
    if (backfillable.length > 0) this.manifestBackfill().kick(backfillable);
    return rows;
  }

  // noteModelUsed / setDefaultForTier were CUT from v1 (Amendment 2026-07-14 G).
  // Do NOT reintroduce until the model picker actually consumes a per-tier
  // default — a write-only stat would just be dead state.

  /** Plan C: delete a model (all parts). Best-effort /models/unload first so
   *  the router isn't serving a file we're removing; file deletion proceeds
   *  regardless (the router tolerates a vanished file on next request). */
  async deleteModel(id: string): Promise<void> {
    const cfg = readEngineConfig(this.home);
    if (this.supervisor?.status() === 'running') {
      try {
        await (this.opts.fetchImpl ?? fetch)(`http://127.0.0.1:${this.port}/models/unload`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: id }),
        });
      } catch { /* best-effort */ }
    }
    // A vision model IS its folder — weights, projector, manifest and any
    // .partial all live inside it, and the engine names the model by that
    // folder (design §E2). So one recursive remove is the whole delete, and it
    // needs no guesses about what is in there.
    const folder = path.join(cfg.cacheDir, id);
    let isFolderModel = false;
    try { isFolderModel = fs.statSync(folder).isDirectory(); } catch { /* flat model */ }
    if (isFolderModel) {
      fs.rmSync(folder, { recursive: true, force: true });
    } else {
      // A multi-part id points at part 00001 — delete every sibling part.
      const partMatch = /-(\d{5})-of-(\d{5})$/.exec(id);
      const names = partMatch
        ? Array.from({ length: Number(partMatch[2]) }, (_, i) =>
            `${id.replace(/-\d{5}-of-\d{5}$/, '')}-${String(i + 1).padStart(5, '0')}-of-${partMatch[2]}.gguf`)
        : [`${id}.gguf`];
      for (const name of names) {
        fs.rmSync(path.join(cfg.cacheDir, name), { force: true });
        fs.rmSync(path.join(cfg.cacheDir, `${name}.partial`), { force: true });
      }
      // The manifest describes files that no longer exist — remove it with them.
      removeManifest(cfg.cacheDir, `${id}.gguf`);
    }
    // The model's own settings go with it, or they would be inherited by a
    // re-download and meanwhile name a model that no longer exists. The queued
    // apply goes too: without this, the refreshModels() below would clear the
    // pending flag on the model we just removed and WRITE THE ENTRY BACK.
    this.pendingModelApplies.delete(id);
    try { await removeModelSettings(this.home, id); } catch { /* best-effort — the files are already gone */ }
    // Tell the router the file is gone, or it keeps advertising a model that
    // 400s on use — the delete-side twin of the post-download refresh.
    await this.refreshModels();
    this.emit('status-changed');
  }

  /** App-quit teardown — registered next to nativeHost.destroyAll(). */
  async stopAll(): Promise<void> {
    if (this.supervisor) await this.supervisor.stop();
  }
}
