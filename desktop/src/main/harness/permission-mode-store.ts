// The permission mode a user picked for each native conversation, remembered
// across close/resume and app restarts, in ~/.youcoded/permission-modes.json.
//
// WHY this exists: the mode used to live only in memory, so every resume
// silently fell back to the preset's default — a Coder conversation the user
// had set to "Ask first" came back on "Auto-edit" and edited files unasked.
//
// WHY a separate file keyed by session id (not the transcript header, not a
// file beside the transcript): the transcript is append-only and synced to
// other devices, so rewriting its first line risks the whole conversation and
// would publish this device's permission posture everywhere; and the app moves
// transcript files between project folders when a folder is renamed
// (slug-repair), which would strand a file sitting next to one. Keyed by id,
// this survives both. It is per-machine on purpose: another computer resuming
// the same conversation starts from the preset default, and says so on the chip.
//
// Writes go through NativeHome.mutateJson (the dev instance and the built app
// share ~/.youcoded, so the file lock is mandatory — native-home invariant).
import type { NativeHome } from '../native-home';
import type { NativePermissionMode } from '../../shared/permission-types';

const FILE = 'permission-modes.json';
const VALID: readonly NativePermissionMode[] = ['ask', 'auto-edit', 'full-auto'];
type ModeFile = { v: 1; modes: Record<string, NativePermissionMode> };

function modesOf(raw: unknown): Record<string, NativePermissionMode> {
  const modes = (raw as Partial<ModeFile> | null)?.modes;
  return modes && typeof modes === 'object' && !Array.isArray(modes) ? { ...modes } : {};
}

export class PermissionModeStore {
  constructor(private home: NativeHome) {}

  /** The saved mode for this conversation, or null when none was ever chosen
   *  here. A hand-edited or corrupt value reads as null — the caller then uses
   *  the preset default, never a guessed mode. */
  get(sessionId: string): NativePermissionMode | null {
    let raw: unknown;
    // readJson rethrows non-ENOENT I/O errors; an unreadable file must not
    // stop a conversation from resuming, it just means "nothing saved".
    try { raw = this.home.readJson(FILE); } catch { return null; }
    const mode = modesOf(raw)[sessionId];
    return VALID.includes(mode) ? mode : null;
  }

  /** `latest` is read INSIDE the file lock. WHY: two quick chip clicks start
   *  two saves that can take the lock in either order; writing the value
   *  captured at call time could let the older click land last, and a
   *  restart would then restore a mode the user had already left. */
  async set(sessionId: string, latest: () => NativePermissionMode): Promise<void> {
    await this.home.mutateJson(FILE, (current) => ({
      v: 1,
      modes: { ...modesOf(current), [sessionId]: latest() },
    } satisfies ModeFile));
  }
}
