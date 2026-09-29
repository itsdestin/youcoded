// platform.ts — the few things only the host operating system can do, handed to the core.
//
// WHY (2026-09-29 one-core R1): the assistant runtime (create-runtime.ts) must run without
// Electron so the same core can later run on the phone. Every Electron thing it used to
// reach for directly is listed here and nowhere else. Desktop passes electron-platform.ts;
// a test passes a plain fake. Anything NOT here is not something the core may do.
//
// Deliberately absent (checked against everything create-runtime.ts imports, 2026-09-29):
//   - dialogs / file pickers: no runtime object opens one; they are window-door handlers.
//   - the profile folder and app version: plain values (`userDataDir`, `appVersion`).
//   - pushing to windows: the core announces events, the door delivers them.
import type { SecretStorage } from './providers/recoverable-safe-storage';

export interface AskpassPaths {
  helperScriptRealpath: string;
  wrapperRealpath: string;
}

export interface Platform {
  /** Open a URL in the person's browser (OpenRouter sign-in). */
  openExternal(url: string): Promise<void>;
  /** Encrypt/decrypt API keys with the OS keychain. Electron: safeStorage (+ the Linux
   *  recovery helper). Must be cheap to hold: the keychain is only touched on a real
   *  read/write, never at construction. */
  secretStorage: SecretStorage;
  /** Where the sudo-password helper scripts live (dev tree vs packaged app), or null when
   *  they are genuinely absent. Never throws. */
  resolveAskpassPaths(): Promise<AskpassPaths | null>;
}
