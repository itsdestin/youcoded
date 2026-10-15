// app-signals.ts — the two things ipc-handlers.ts used to import from main.ts.
//
// WHY (2026-10-14, Android clean rebuild P1): ipc-handlers imported `setPermissionOverrides` and
// `forgetSessionAttention` straight from main.ts, and main.ts starts the whole Electron app at module
// scope. That made the backend's wiring impossible to load without launching a desktop window, so the
// headless backend (headless/headless-boot.ts, which runs inside the Android app) could not use it.
// Both now live here: the overrides cache is plain data, and attention forgetting is a hook main.ts
// fills in (the attention aggregator feeds the desktop buddy, which a phone does not have).
import { PERMISSION_OVERRIDES_DEFAULT, type PermissionOverrides } from '../shared/types';

// In-memory cache of the user's permission overrides, loaded from the defaults file and updated by
// prefs-service (through the sink ipc-handlers installs) whenever defaults:set is called.
let permissionOverrides: PermissionOverrides = { ...PERMISSION_OVERRIDES_DEFAULT };

/** Called on startup and after each defaults:set. */
export function setPermissionOverrides(overrides: Partial<PermissionOverrides>): void {
  permissionOverrides = { ...PERMISSION_OVERRIDES_DEFAULT, ...overrides };
}

/** The cache the auto-approve check reads on every permission ask. */
export function getPermissionOverrides(): PermissionOverrides {
  return permissionOverrides;
}

let forgetAttention: (sessionId: string) => void = () => {};

/** main.ts installs its attention aggregator's forget; the headless backend leaves the no-op. */
export function setForgetSessionAttention(fn: (sessionId: string) => void): void {
  forgetAttention = fn;
}

/** Called by ipc-handlers.ts on session-exit (see main.ts forgetSessionAttention for the WHY). */
export function forgetSessionAttention(sessionId: string): void {
  forgetAttention(sessionId);
}
