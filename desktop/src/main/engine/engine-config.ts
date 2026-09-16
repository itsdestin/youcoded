// Engine section of ~/.youcoded/config.json (Phase 0 §1: the GGUF cache path is
// recorded in config.json). The engine VERSION pin deliberately lives in CODE
// (engine-pin.ts), not here.
//
// THE `engine` SECTION IS PER-MACHINE (corrected 2026-09-05, design §Storage).
// This comment used to call config.json "a syncable per-user file", which was
// never true of anything in here: nothing syncs this file today, and `cacheDir`
// (a path on THIS disk) and `backend` (the graphics chip THIS computer has)
// have always described one machine. The new `speed` and `models` keys are the
// same kind of value — how the engine runs on this computer — so they join it
// rather than starting a second file. The version pin's own reason for living
// in code is unchanged and stronger: a synced pin would tell machine B to trust
// a binary it never verified.
//
// All writes go through NativeHome's locked mutateJson (dev instance + built
// app share ~/.youcoded).
import * as path from 'path';
import * as os from 'os';
import { NativeHome } from '../native-home';
import type { EngineBackend, EngineSpeedSettings } from '../../shared/engine-types';
import type { StoredModelSettings } from '../../shared/model-manager-types';

const FILE = 'config.json';

export interface EngineConfig {
  cacheDir: string;              // LLAMA_CACHE — where GGUFs live
  backend: EngineBackend | null; // null = platform default (engine-pin defaultBackend)
  contextSize: number;           // -c for llama-server; inherited by every model instance
  /** The two engine-wide speed features (design §B). */
  speed: EngineSpeedSettings;
  /** Per-model settings, keyed by the router's model id (design §C1). Only ids
   *  the user has actually touched appear here; everything else is defaults. */
  models: Record<string, StoredModelSettings>;
}

// 32768 sits well above llama-server's 4096 default (the silent-truncation trap
// ADR 007 calls out in Ollama) without allocating the monster KV cache a
// 128k+ default would. User-tunable in Plan C's Local Models panel.
export const DEFAULT_CONTEXT_SIZE = 32768;

// Both speed features are ON by default (contract R4: "visible switches under
// Advanced on the engine card, both on by default"). A machine that cannot use
// one of them is not harmed by the flag — llama-server ignores a speculative
// draft it has no model for, and a quantised K cache is supported everywhere
// the app installs an engine.
export const DEFAULT_ENGINE_SPEED: EngineSpeedSettings = { speculative: true, compressCache: true };

// One untouched model. Every field is a "use the engine's own default" value, so
// a model with no entry at all and a model whose entry is this object behave
// identically — which is what makes a missing key mean "today's behaviour".
export const DEFAULT_MODEL_SETTINGS: StoredModelSettings = {
  contextLength: null,
  keepLoaded: false,
  gpuLayers: 'auto',
  extraFlags: '',
  memoryWarningDismissed: null,
};

export function defaultCacheDir(homedir: string = os.homedir()): string {
  // llama.cpp's own default when LLAMA_CACHE is unset — sharing it means models
  // the user already pulled with llama-cli/-hf appear in YouCoded and vice versa
  // (spec §4.4 / Phase 0 §1 "GGUF models" note).
  return path.join(homedir, '.cache', 'llama.cpp');
}

// Every member of EngineBackend, and the reason this list has to be complete:
// readEngineConfig drops a backend that is not in it and reports `null`, which
// the rest of the app reads as "on the platform default". So a backend missing
// here does not fail loudly — the user picks it, it saves, and the next launch
// silently runs Vulkan again. Kept honest by engine-config.test.ts, which
// round-trips one saved value per member and will not compile if a member is
// added to the type and not to that test.
const BACKENDS: ReadonlySet<string> = new Set(['vulkan', 'cpu', 'metal', 'cuda', 'rocm']);

/** The speed switches as stored, with every missing or malformed key replaced by
 *  its default. A half-written `{ speculative: false }` therefore keeps cache
 *  compression on rather than turning BOTH features off — a missing key means
 *  "never chosen", not "off". */
function readSpeed(raw: unknown): EngineSpeedSettings {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  return {
    speculative: typeof s?.speculative === 'boolean' ? s.speculative : DEFAULT_ENGINE_SPEED.speculative,
    compressCache: typeof s?.compressCache === 'boolean' ? s.compressCache : DEFAULT_ENGINE_SPEED.compressCache,
  };
}

/** One model's stored settings, validated field by field.
 *
 *  WHY every field is checked rather than trusted: this file is a plain JSON
 *  file in the user's home directory that a person can edit, an older build can
 *  have written, and a newer build can extend. A bad value here does not fail
 *  loudly — it is written into the engine's preset file and takes the engine
 *  down at its next spawn (see model-presets.ts), so anything that is not the
 *  shape we expect is dropped back to the default here, at the door. */
export function modelSettingsFor(
  modelsSection: unknown, modelId: string,
): StoredModelSettings {
  const models = modelsSection && typeof modelsSection === 'object'
    ? (modelsSection as Record<string, unknown>) : null;
  const raw = models?.[modelId];
  const e = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const ctx = typeof e?.contextLength === 'number' && Number.isFinite(e.contextLength) && e.contextLength > 0
    ? Math.floor(e.contextLength) : null;
  const layers = e?.gpuLayers === 'auto' ? 'auto' as const
    : typeof e?.gpuLayers === 'number' && Number.isFinite(e.gpuLayers) && e.gpuLayers >= 0
      ? Math.floor(e.gpuLayers) : DEFAULT_MODEL_SETTINGS.gpuLayers;
  // A dismissal is only usable with the context length it was made at — see
  // StoredModelSettings. A record missing that number is treated as no
  // dismissal, which asks the user again rather than silently swallowing a
  // warning about memory they may not have.
  const dismissed = e?.memoryWarningDismissed;
  const d = dismissed && typeof dismissed === 'object' ? (dismissed as Record<string, unknown>) : null;
  const dLen = typeof d?.contextLength === 'number' && Number.isFinite(d.contextLength) && d.contextLength > 0
    ? Math.floor(d.contextLength) : null;
  const dAt = typeof d?.at === 'number' && Number.isFinite(d.at) ? d.at : null;
  const out: StoredModelSettings = {
    contextLength: ctx,
    keepLoaded: e?.keepLoaded === true,
    gpuLayers: layers,
    extraFlags: typeof e?.extraFlags === 'string' ? e.extraFlags : DEFAULT_MODEL_SETTINGS.extraFlags,
    memoryWarningDismissed: dLen !== null && dAt !== null ? { at: dAt, contextLength: dLen } : null,
  };
  if (e?.pendingApply === true) out.pendingApply = true;
  // An empty string is treated as no error: it would render an empty "why it
  // failed" line in the dialog, which reads as a bug rather than as silence.
  if (typeof e?.lastLoadError === 'string' && e.lastLoadError.trim()) out.lastLoadError = e.lastLoadError;
  return out;
}

function readModels(raw: unknown): Record<string, StoredModelSettings> {
  const section = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const out: Record<string, StoredModelSettings> = {};
  if (!section) return out;
  for (const id of Object.keys(section)) out[id] = modelSettingsFor(section, id);
  return out;
}

export function readEngineConfig(home: NativeHome): EngineConfig {
  const cfg = home.readJson(FILE) as any;
  const e = cfg && typeof cfg === 'object' ? (cfg as any).engine : null;
  return {
    cacheDir: typeof e?.cacheDir === 'string' && e.cacheDir ? e.cacheDir : defaultCacheDir(),
    backend: typeof e?.backend === 'string' && BACKENDS.has(e.backend) ? (e.backend as EngineBackend) : null,
    contextSize: typeof e?.contextSize === 'number' && Number.isFinite(e.contextSize) && e.contextSize > 0
      ? Math.floor(e.contextSize) : DEFAULT_CONTEXT_SIZE,
    speed: readSpeed(e?.speed),
    models: readModels(e?.models),
  };
}

/** Drop one model's per-model settings from `engine.models` (design §E2 —
 *  deleteModel prunes it). WHY it matters: a section for a model that no longer
 *  exists renders a ghost row in the router's preset file that can never load
 *  and cannot be removed from the app (model-presets.ts says so), and a
 *  re-download of the same model would silently inherit the deleted copy's
 *  context length and flags. No-op when there is nothing to prune. */
export async function removeModelSettings(home: NativeHome, modelId: string): Promise<void> {
  await home.mutateJson(FILE, (cur) => {
    const file = (cur && typeof cur === 'object' ? cur : { v: 1 }) as any;
    const models = file?.engine?.models;
    if (!models || typeof models !== 'object' || !(modelId in models)) return file;
    delete models[modelId];
    return file;
  });
}

/** Merge a patch into the `engine` section, ONE LEVEL DEEP.
 *
 *  WARNING for whoever wires the per-model settings dialog: passing `models`
 *  here REPLACES the whole section, losing every model the patch does not
 *  mention. Nothing does that today (no shipped caller passes `models`), but a
 *  save that writes one model's settings needs a merging writer of its own, the
 *  way `updateEngineSpeed` below merges the speed object inside the lock. */
export async function updateEngineConfig(home: NativeHome, patch: Partial<EngineConfig>): Promise<void> {
  await home.mutateJson(FILE, (cur) => {
    // Preserve sibling top-level keys — config.json will grow other sections
    // (Plan C model stats, later phases). Only the engine object is merged.
    const file = (cur && typeof cur === 'object' ? cur : { v: 1 }) as any;
    if (typeof file.v !== 'number') file.v = 1;
    file.engine = { ...(file.engine ?? {}), ...patch };
    return file;
  });
}

/** What `updateModelSettings` accepts. Spelled out rather than
 *  `Partial<StoredModelSettings>` because two of the fields need a way to say
 *  "remove this": `pendingApply` is `true | undefined` on the stored shape, so a
 *  Partial of it has no value that means "the change has landed", and
 *  `lastLoadError` needs one that means "it loaded fine this time". `false` and
 *  `null` are those values; an ABSENT key still means "leave it alone". */
export type ModelSettingsPatch =
  Partial<Omit<StoredModelSettings, 'pendingApply' | 'lastLoadError'>>
  & { pendingApply?: boolean; lastLoadError?: string | null };

/** Merge a patch into ONE model's `engine.models[modelId]`, and hand back that
 *  model's settings as they now stand.
 *
 *  WHY this exists rather than `updateEngineConfig({ models })`: that merge is
 *  one level deep, so writing one model through it would REPLACE the whole
 *  `models` section and silently delete every other model's settings — the
 *  warning above updateEngineConfig is about exactly this call site. The merge
 *  happens INSIDE mutateJson, under the same lock as the write (the way
 *  updateEngineSpeed merges the speed object), so two windows saving different
 *  models at the same moment cannot lose one another's answer.
 *
 *  Everything is re-validated on the way out through modelSettingsFor, so a
 *  patch cannot put a shape in the file that the reader would later drop. */
export async function updateModelSettings(
  home: NativeHome, modelId: string, patch: ModelSettingsPatch,
): Promise<StoredModelSettings> {
  let result: StoredModelSettings = { ...DEFAULT_MODEL_SETTINGS };
  await home.mutateJson(FILE, (cur) => {
    const file = (cur && typeof cur === 'object' ? cur : { v: 1 }) as any;
    if (typeof file.v !== 'number') file.v = 1;
    const engine = (file.engine ?? {}) as any;
    const models = engine.models && typeof engine.models === 'object' ? engine.models : {};
    // Start from the VALIDATED current value, not the raw one: a half-written
    // field left by a hand edit is dropped here rather than carried forward.
    const merged: Record<string, unknown> = { ...modelSettingsFor(models, modelId) };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) merged[key] = value;
    }
    // The two "remove me" values. Written as absent keys rather than as `false`
    // / `null` so the file says only what is true of this model.
    if (merged.pendingApply !== true) delete merged.pendingApply;
    if (typeof merged.lastLoadError !== 'string' || !merged.lastLoadError.trim()) delete merged.lastLoadError;
    // A COMPUTED key, never `models[modelId] = …` on a fresh literal: model ids
    // are filenames, so `__proto__` is an id a user can create.
    const nextModels = { ...models, [modelId]: merged };
    file.engine = { ...engine, models: nextModels };
    result = modelSettingsFor(nextModels, modelId);
    return file;
  });
  return result;
}

/** Merge a PARTIAL speed patch into `engine.speed`.
 *
 *  WHY this is not just `updateEngineConfig({ speed })`: that merge is one level
 *  deep, so writing `{ speculative: false }` through it would replace the whole
 *  speed object and silently take cache compression down with it. The read side
 *  would then hand back the default for the key that vanished, so the user would
 *  see the switch they never touched flip back on by itself. The merge happens
 *  INSIDE mutateJson, under the same lock as the write, so two windows changing
 *  a switch at the same moment cannot lose one another's answer. */
export async function updateEngineSpeed(
  home: NativeHome, patch: Partial<EngineSpeedSettings>,
): Promise<void> {
  await home.mutateJson(FILE, (cur) => {
    const file = (cur && typeof cur === 'object' ? cur : { v: 1 }) as any;
    if (typeof file.v !== 'number') file.v = 1;
    const engine = (file.engine ?? {}) as any;
    file.engine = { ...engine, speed: { ...readSpeed(engine.speed), ...patch } };
    return file;
  });
}
