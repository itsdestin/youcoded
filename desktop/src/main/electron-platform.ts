// electron-platform.ts — the desktop app's Platform: Electron on the other end of each call.
// The ONLY file besides main.ts / ipc-handlers.ts / the OS-facing modules that hands Electron
// objects to the core. See platform.ts for what the core may ask of the host.
import fs from 'fs';
import path from 'path';
import { app, shell, BrowserWindow } from 'electron';
import { getSecretStorage } from './providers/secret-storage';
import type { Platform, AskpassPaths } from './platform';
import type { SecretStorage } from './providers/recoverable-safe-storage';

// WHY moved here (2026-09-29 one-core R1): this is Electron-only knowledge (app.isPackaged, getAppPath), and the
// admin-password startup the runtime runs needs it through Platform.resolveAskpassPaths.
// ipc-handlers.ts re-exports it, so the tests and callers that import it from there are unchanged.
/** admin-password design §2.1/§11 tasks 5+review: the ONE resolver for both
 *  askpass paths, so `SUDO_ASKPASS` (the wrapper) and `helperScriptRealpath`
 *  (the verifier's argv[1] check, `askpass.cjs`) can never drift apart —
 *  T5-1 shipped with SUDO_ASKPASS pointed at `askpass.cjs` directly (no
 *  execute bit, no shebang: sudo's execve() of it fails outright, and even
 *  fixing that by making askpass.cjs itself executable would silently
 *  delete the wrapper's `env -i` scrub, the actual control against a
 *  command-supplied `NODE_OPTIONS` reaching the verified helper — design
 *  review 1, D1). `wrapperRealpath` is resolved as a SIBLING of
 *  `helperScriptRealpath`'s own real directory (never re-derived from `base`
 *  independently), so the two can never name files in different directories.
 *  dev is the worktree files under `desktop/scripts/askpass/`
 *  (`app.getAppPath()` is `desktop/` itself in dev, where `package.json`
 *  lives); packaged is `process.resourcesPath/app.asar.unpacked/scripts/
 *  askpass/` (electron-builder.yml's `asarUnpack: scripts/**\/*`). Returns
 *  null (never throws) when either file genuinely isn't there — the caller
 *  logs plainly and skips the whole feature, exactly like a failed
 *  self-test (design §2.2: "no fallback to a self-reported pid").
 *
 *  T5-3: async (`fs.promises.realpath`) — a startup-only `fs.*Sync` call
 *  needs no `main-blocking-calls.allowlist.json` entry (that list may only
 *  shrink, `.claude/rules/performance.md` rule 1) when the async form is
 *  just as easy at this one call site. */
export async function resolveAskpassPaths(): Promise<AskpassPaths | null> {
  const rel = path.join('scripts', 'askpass', 'askpass.cjs');
  try {
    // Test doubles for `app` (many suites construct a minimal fake) may
    // lack `getAppPath`/`isPackaged` entirely — never let that throw before
    // this feature has a chance to be genuinely unavailable, exactly like a
    // missing file below.
    const base = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', rel) : path.join(app.getAppPath(), rel);
    const helperScriptRealpath = await fs.promises.realpath(base);
    const wrapperRealpath = await fs.promises.realpath(path.join(path.dirname(helperScriptRealpath), 'youcoded-askpass'));
    return { helperScriptRealpath, wrapperRealpath };
  } catch {
    return null;
  }
}

export function createElectronPlatform(): Platform {
  // WHY a lazy forwarding object rather than `getSecretStorage()` up front: the old
  // SecretsStore resolved the keychain adapter only on a real read/write ("not while
  // constructing stores during app startup"). Forwarding on each call keeps that exactly.
  const secretStorage: SecretStorage = {
    isEncryptionAvailable: () => getSecretStorage().isEncryptionAvailable(),
    encryptString: (value) => getSecretStorage().encryptString(value),
    decryptString: (value) => getSecretStorage().decryptString(value),
  };
  return {
    openExternal: (url) => shell.openExternal(url),
    secretStorage,
    resolveAskpassPaths,
  };
}

/** Sync-space events to every window (moved from sync-spaces/service.ts, 2026-09-29 one-core R1, so
 *  that file no longer imports Electron). Each window is isolated: one closing window must not stop
 *  the rest, exactly as the inline loop was. */
export function sendSyncEventToWindows(e: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('syncspaces:event', e); } catch { /* window closing */ }
  }
}
