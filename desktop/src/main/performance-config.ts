import fs from 'fs';
import os from 'os';
import path from 'path';

// Persisted alongside youcoded-remote.json and youcoded-favorites.json in
// ~/.claude/ so it survives app reinstalls. This file is the single source of
// truth for performance prefs that main needs before the renderer is ready.
let configPath = path.join(os.homedir(), '.claude', 'youcoded-performance.json');

// Test seam — lets tests redirect reads/writes to a temp dir without touching
// the real ~/.claude/ directory. Production code must NOT call this.
export function _setConfigPathForTesting(p: string) {
  configPath = p;
}

export interface PerformanceConfig {
  preferPowerSaving: boolean;
  // The full parsed object (all keys, including unknown ones not in this
  // interface). Kept so writeConfig can merge only the keys it knows about
  // while preserving any future keys added by a newer app version.
  raw: Record<string, unknown>;
}

// Synchronous read because it must complete before app.whenReady() returns;
// at that point we apply the Chromium GPU switch which must happen before the
// first BrowserWindow opens. Tiny file + single startup call — no perf concern.
// Failures are silently swallowed and fall back to preferPowerSaving:false,
// which is the "safe" default (force-high-performance GPU).
export function loadConfigSync(): PerformanceConfig {
  let raw: Record<string, unknown> = {};
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(text);
    // Guard against a valid-JSON-but-wrong-shape file (e.g. an array or null).
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (err: unknown) {
    // ENOENT on first launch is completely normal — no warning needed.
    // Anything else (malformed JSON, permission denied) is worth a warning,
    // but we still fall back to defaults rather than crashing at startup.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[performance-config] failed to read', configPath, err);
    }
  }
  // Strict boolean coercion: only the literal true is accepted. Any other
  // value (string "yes", number 1, undefined, null) becomes false.
  const preferPowerSaving = raw.preferPowerSaving === true;
  return { preferPowerSaving, raw };
}

// Merge-writes a single key update into the on-disk file, preserving any
// unknown keys so future app versions don't lose data they wrote. Creates the
// directory and file if they don't exist yet.
export function writeConfig(next: { preferPowerSaving: boolean }): void {
  // Read current raw first so we can merge rather than overwrite.
  const current = loadConfigSync();
  const merged = { ...current.raw, preferPowerSaving: next.preferPowerSaving };
  const dir = path.dirname(configPath);
  // recursive:true is a no-op if the directory already exists.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Module-level cache — populated once by main.ts after app.whenReady().
// Stored here (not in main.ts) so ipc-handlers.ts, remote-server.ts, and any
// other main-process module can import them without creating circular deps.
// ---------------------------------------------------------------------------

// The GPU list string from Electron's app.getGPUInfo('complete').gpuDevice[].
// Set once at startup; never mutated after that.
let cachedGpuList: string[] = [];
// True when cachedGpuList has more than one entry — drives the "hide toggle
// on single-GPU systems" rule in the renderer.
let cachedMultiGpu = false;
// Which value was actually applied to Chromium at launch. May differ from the
// current pref if the user changed it mid-session; the IPC handler surfaces
// this to show a "restart required" hint in the UI.
let appliedAtLaunch = false;

export function setAppliedAtLaunch(value: boolean) { appliedAtLaunch = value; }
export function getAppliedAtLaunch(): boolean { return appliedAtLaunch; }

export function setCachedGpu(list: string[]) {
  cachedGpuList = list;
  cachedMultiGpu = list.length > 1;
}

export function getCachedGpu(): { multiGpuDetected: boolean; gpuList: string[] } {
  return { multiGpuDetected: cachedMultiGpu, gpuList: cachedGpuList };
}
