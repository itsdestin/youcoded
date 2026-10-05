// prefs-types.ts — the shapes of the small per-install preference stores that both doors serve
// (saved folders, session defaults, model modes). Moved out of main/ by one-core R3-1 so the
// backend contract (shared/) can name them without importing main/.
import type { ModelChoice } from '../renderer/components/model/ModelPicker';

/** One row of ~/.claude/youcoded-folders.json. */
export interface SavedFolder {
  path: string;
  nickname: string;
  addedAt: number;
  // Local-only description. A plain folder has nothing to sync it to — the
  // synced equivalent lives in the project registry (project-registry.ts).
  description?: string | null;
}

/** A row of the new-session folder picker: a saved folder, or a synced project shown beside them. */
export interface PickerFolder extends SavedFolder {
  exists: boolean;
  managed?: true;
}

/** ~/.claude/youcoded-defaults.json over the built-in defaults. */
export interface SessionDefaults {
  skipPermissions: boolean;
  model: string;
  projectFolder: string;
  // `startModel` — Assistant settings Q-3a (2026-09-05): one default across every provider.
  // Optional because installs that only ever set the Claude alias (`model`) have no such
  // field; `model` stays the fallback and is kept in step on a Claude pick.
  startModel?: ModelChoice;
  startModelLabel?: { provider: string; model: string };
  /** The permission-override block; merged key by key on every save. */
  permissionOverrides?: Record<string, unknown>;
}

/** ~/.claude/youcoded-model-modes.json: the /fast and /effort state. */
export interface ModelModes {
  fast: boolean;
  effort: string;
}
