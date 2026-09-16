// Engine-layer shapes — Phase 1 Plan B (spec 2026-07-10-phase1-engine-providers-design.md §3).
// Shared between main and renderer; keep free of Node/Electron imports.

// 'rocm' added 2026-09-05 (local-engine upgrades, questions deck Q-1): upstream ships
// ROCm builds for Linux x64 and Windows x64 since b10665.
export type EngineBackend = 'vulkan' | 'cpu' | 'metal' | 'cuda' | 'rocm';

export type EngineRunState = 'not-installed' | 'stopped' | 'starting' | 'running' | 'error';

/** A faster engine build the card may offer (S-1: shown ONLY when the matching
 *  graphics chip was detected in main — never a blind "Switch to CUDA" on every
 *  Windows PC). `needs-prereqs` = the chip is there but the system software the
 *  build loads at runtime is not (Linux ROCm); the card then shows the install
 *  guide (Q-1 pick a) instead of switching. */
export interface BackendOption {
  backend: EngineBackend;
  label: string;                     // 'Switch to CUDA (faster on NVIDIA)'
  state: 'ready' | 'needs-prereqs';
  /** An extra sentence the card appends to the row's description, when main
   *  knows something the renderer cannot. Today there is exactly one: with no
   *  model downloaded yet, the switch can be checked only as far as the engine
   *  starting — the real proof is a model actually loading on the new build
   *  (design §A4), so the row says "Checked when your first model loads."
   *  rather than implying the whole check ran. */
  note?: string;
}

/** What is missing before a backend can be installed, and how to get it.
 *  `command` is the one line for THIS Linux flavour, and is null for two very
 *  different reasons that `reason` tells apart — see below. */
export interface EnginePrereqs {
  backend: EngineBackend;
  satisfied: boolean;
  distro: string | null;             // 'Arch Linux', 'Ubuntu 24.04', …
  command: string | null;            // 'sudo pacman -S rocm-hip-runtime hipblas rocblas'
  docsUrl: string;
  explainer: string;                 // one plain sentence: what the software is
  /** WHY a `command` is absent, so the card never says the wrong thing:
   *  - 'needs-amd-repo' — we know exactly which Linux this is, and its packages
   *    come from AMD's own repository, which has to be registered first. There
   *    is no honest one-liner for that, so the guide is the answer.
   *  - 'unknown-distro' — we could not identify the system at all.
   *  Telling an Ubuntu user we could not recognise their Linux, right after
   *  naming it as 'Ubuntu 24.04', reads as the app being broken. Absent when
   *  `command` is present or the check is satisfied. */
  reason?: 'needs-amd-repo' | 'unknown-distro';
}

/** The two engine-wide speed features (Q-4 pick a: visible under Advanced, on by
 *  default). Changing either restarts the engine. */
export interface EngineSpeedSettings {
  speculative: boolean;              // --spec-default
  compressCache: boolean;            // --cache-type-k q8_0
}

/** How fast one finished reply ran, read off llama-server's final streamed
 *  frame (`timings.prompt_per_second` / `timings.predicted_per_second`).
 *  'prompt' is how fast it READ the conversation, 'generate' how fast it WROTE
 *  the answer — the two numbers the engine card's fact line shows.
 *
 *  EITHER may be absent, and the card then shows only the other. A prompt that
 *  came entirely out of the prefix cache has no reading work to time, so the
 *  engine can report a prompt rate of zero for a reply whose WRITE rate is
 *  perfectly good — throwing that away would blank the whole line over the half
 *  we could not measure. A reading with neither number is not a reading at all
 *  and never reaches here. */
export interface ReplyTimings {
  promptPerSecond?: number;
  generatePerSecond?: number;
}

export interface EngineStatus {
  installed: boolean;
  installedVersion: string | null;   // e.g. 'b9986' once installed
  pinnedVersion: string;             // what engine-pin.ts currently wants (differs after a pin bump)
  backend: EngineBackend | null;     // backend of the installed build
  state: EngineRunState;
  errorMessage?: string;             // plain language; present when state === 'error'
  cacheDir: string;                  // where GGUF models live (LLAMA_CACHE)
  contextSize: number;               // configured -c (Plan C context-length knob reads this)
  port: number;
  // ---- 2026-09-05 local-engine upgrades (all optional: an older main omits them) ----
  /** The device the engine reports it will run on ('AMD Radeon 8060S Graphics'),
   *  from `llama-server --list-devices` at install/verify time. Null = CPU only. (S-4) */
  deviceName?: string | null;
  /** Σ `sizeBytes` of the engine's **`loaded`** rows only — never `sleeping`
   *  ones. A slept model has had its memory FREED (that is what
   *  --sleep-idle-seconds does); counting it would tell the user gigabytes are
   *  in use that the machine has already got back (R1-14). `undefined` = the
   *  engine has not been asked yet, which is not the same as "nothing loaded".
   *  (S-4) */
  loadedModelsBytes?: number;
  /** Speed of the most recent reply: prompt reading and generation, per second.
   *  Absent until a reply has actually been measured — never a zero standing in
   *  for "we don't know yet". (S-4) */
  lastReply?: ReplyTimings | null;
  /** Faster builds this machine could switch to. Empty = nothing to offer. (S-1) */
  backendOptions?: BackendOption[];
  speed?: EngineSpeedSettings;
  /** A change is saved but has not reached the engine yet, because a reply is
   *  still streaming. The panel shows "Applies after the current reply" while
   *  this is true (design §B/§C2). */
  configApplyPending?: boolean;
  /** …and the reply really is what it is waiting for. `configApplyPending` alone
   *  is also true for a change queued on a completely idle machine, which
   *  applies a moment later with no reply involved — so the card words those two
   *  differently instead of telling most users to wait for a reply nobody is
   *  reading. */
  configApplyWaitingForReply?: boolean;
  /** The REAL failure text if applying a saved change went wrong — never a
   *  guessed cause. Null/absent = nothing went wrong. WHY it needs its own
   *  field: the setting is written and the channel has already answered by the
   *  time the change is applied, so a failure here has no call to fail. */
  configApplyError?: string | null;
  /** False when the RUNNING engine started without its per-model settings file,
   *  so every model is on the engine-wide settings for this run (T7's fallback,
   *  `EngineSupervisor.presetInForce()`).
   *
   *  WHY it has to reach the card: the fallback exists so a settings file the
   *  engine cannot use produces a working engine instead of a dead one — but
   *  silently. Without this field a user whose per-model context length and
   *  extra flags are being ignored sees a normal, running engine and no
   *  explanation at all.
   *
   *  `undefined` means the question does not apply (the engine is not running,
   *  or an older main never answered it) — never "not in force". */
  modelSettingsInForce?: boolean;
  /** Why they are not in force, in the OS's or the engine's OWN words — the
   *  error from writing the file, or the engine's startup sentence about it
   *  (design §J). Null = they are in force, or nothing legible was available and
   *  the card says so without inventing a cause. */
  modelSettingsError?: string | null;
}

export type EngineInstallProgress =
  | { kind: 'download'; receivedBytes: number; totalBytes: number | null }
  | { kind: 'verify' }
  | { kind: 'unpack' }
  | { kind: 'done'; version: string; backend: EngineBackend }
  | { kind: 'error'; message: string };

/** Per-model residency, read from GET /models `status.value` (llama-server b9992).
 *  'sleeping' = auto-slept by --sleep-idle-seconds (memory freed, wakes on next
 *  request). 'unloaded' = not resident (never loaded, LRU-evicted, or a cache
 *  scan while the engine is off). See docs/engine-dependencies.md. */
export type EngineModelState = 'unloaded' | 'loading' | 'loaded' | 'sleeping';

/** One GGUF the engine can serve — from GET /models when running, else a cache scan. */
export interface EngineModel {
  id: string;              // what /v1/chat/completions expects in its "model" field
  sizeBytes: number | null;
  loaded: boolean;         // convenience: state === 'loaded'. False from a cache scan.
  state: EngineModelState; // 'unloaded' when derived from a cache scan (engine not running)
  /** While state === 'loading': bytes of the model resident in RAM so far (the
   *  model child's VmRSS, monotonic + clamped to sizeBytes) — drives the "N GB /
   *  M GB" progress bar. Undefined off Linux or when not loading. */
  loadedBytes?: number;
  /** What kinds of input the ROUTER says this model accepts, straight off
   *  `GET /models`'s `architecture.input_modalities` (design §E5). `['text']`
   *  for an ordinary model; `['text','image']` once llama-server paired an
   *  `mmproj-*.gguf` beside it — which is how the rest of the app learns that a
   *  local model can actually look at an attached picture.
   *
   *  `undefined` means NOBODY ASKED THE ROUTER, not "text only": a row that came
   *  from the engine-off disk scan (or from the post-boot union inside
   *  listModels) has no modality data at all. Callers must degrade to "don't
   *  know" there — never to a guessed `false`. */
  inputModalities?: string[];
}
