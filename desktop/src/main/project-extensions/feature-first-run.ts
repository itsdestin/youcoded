// desktop/src/main/project-extensions/feature-first-run.ts
//
// featureFirstRunAt (T6 review F1 fix, technical design §2 rewrite) — a
// per-device, NEVER-synced timestamp: the first time a build with the
// project skills/tools feature ran on THIS device. It replaces the removed
// `resolveProjectAddedAt`/folder-`addedAt` reference as the lower bound
// resolve.ts's `defaultPluginOn` compares an install against. A project
// folder's `addedAt` has no relationship to when a plugin was installed into
// it (an install can happen years after the folder was added, which is
// exactly the shape that turned a working plugin off — see resolve.ts's own
// header). This feature's own rollout instant does: only an install that
// happened AFTER this feature could possibly exist on this device is a "new
// download" the start-off rule should ever catch.
//
// Written ONCE, asynchronously, at app startup (main.ts, before any IPC
// handler that could trigger seeding — project-extensions:get, session
// creation — is registered). Stored under ~/.youcoded/ (NativeHome), its OWN
// file — not a field inside project-extensions.local.json's per-project map
// — because it describes the DEVICE, not any one project, and must never be
// folded/merged the way a project's record is.
//
// "Unknown -> before -> on" (design §2): a home that can't be written or read
// (disk full, permissions) must never turn a working plugin off. Every caller
// treats `undefined` as "before featureFirstRunAt", i.e. defaultPluginOn's
// installed-after-seed rule simply never fires.
import { NativeHome } from '../native-home';

const FEATURE_FIRST_RUN_FILE = 'project-extensions-feature.local.json';

function parseFeatureFirstRunAt(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = (raw as Record<string, unknown>).featureFirstRunAt;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Record featureFirstRunAt once, if absent — "earliest wins": once a value is
 * on disk this never moves it later, so two app instances racing at startup
 * (or a later build re-running this same startup step) always converge on
 * whichever timestamp landed first. Returns the stored value (the one this
 * call just wrote, or the earlier one already there).
 *
 * Never throws: a startup step that can take the app down with it is worse
 * than a rule that resolves as "unknown" (-> everything stays on) for one
 * more launch. Call this BEFORE registering any IPC handler that could
 * trigger seeding (main.ts runs it alongside the other startup chores, ahead
 * of registerIpcHandlers/createWindow).
 */
export async function ensureFeatureFirstRunAt(home: NativeHome, now: number = Date.now()): Promise<number | undefined> {
  try {
    let result: number | undefined;
    await home.mutateJson(FEATURE_FIRST_RUN_FILE, (raw) => {
      const existing = parseFeatureFirstRunAt(raw);
      if (existing !== undefined) { result = existing; return raw; } // already recorded — no-op, no clock churn
      result = now;
      return { featureFirstRunAt: now };
    });
    return result;
  } catch {
    return undefined; // unknown — resolve.ts's rule treats this as "before", i.e. everything stays on
  }
}

/**
 * Read-only lookup for the seeding/availability rule (resolve.ts's
 * defaultPluginOn, reached via store.ts's ensureSeeded and
 * resolveAvailability). Missing/unreadable/corrupt file, or one written by a
 * future build in a shape this one can't parse, all read as `undefined` — the
 * same "unknown -> on" fallback as a failed write.
 */
export async function readFeatureFirstRunAt(home: NativeHome): Promise<number | undefined> {
  try {
    return parseFeatureFirstRunAt(await home.readJsonAsync(FEATURE_FIRST_RUN_FILE));
  } catch {
    return undefined;
  }
}
