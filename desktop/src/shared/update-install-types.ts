// Shared types for the in-app update installer.
// Consumed by: desktop/src/main/update-installer.ts, desktop/src/main/ipc-handlers.ts,
// desktop/src/main/preload.ts, desktop/src/renderer/remote-shim.ts,
// desktop/src/renderer/components/UpdatePanel.tsx,
// app/src/main/kotlin/.../runtime/UpdateInstallerStub.kt (mirror).
//
// The Kotlin stub has NO per-code enum — it only ever returns "not-supported"
// (UpdateInstallerStub.kt), because updates are desktop-only. So adding a code
// here needs NO Kotlin change. The parity test (tests/update-install-ipc.test.ts)
// pins the IPC CHANNEL surface, not the error codes.

export type UpdateInstallErrorCode =
  | 'spawn-failed'          // spawn() threw or child exited non-zero within 2s
  | 'file-missing'          // download file does not exist on disk
  | 'appimage-not-writable' // EACCES/EPERM replacing a root-owned AppImage
  | 'dmg-corrupt'           // `open -W` exited non-zero on macOS
  | 'unsupported-platform'  // platform/arch combination we don't handle
  | 'install-cancelled'     // Linux package install: the password prompt was dismissed
  | 'install-failed'        // Linux package install: the package manager itself refused
  | 'remote-unsupported'    // attempted from a remote-browser session
  | 'network-failed'        // download failed mid-stream
  | 'disk-full'             // ENOSPC during write
  | 'url-rejected'          // failed HTTPS / domain allowlist check
  | 'busy'                  // another download is already active (different URL)
  | 'verify-failed'         // manifest/hash/size/version mismatch — corrupt download, retry once
  | 'signature-invalid'     // manifest signature didn't verify — do NOT retry, do NOT offer browser
  | 'not-supported';        // Android stub's universal error

export interface UpdateDownloadResult {
  jobId: string;
  filePath: string;
  bytesTotal: number;
}

export interface UpdateProgressEvent {
  jobId: string;
  bytesReceived: number;
  bytesTotal: number;  // 0 if Content-Length was absent
  percent: number;     // 0-100, or -1 if bytesTotal unknown
}

export type UpdateLaunchResult =
  | { success: true; quitPending: true }                         // installer spawned, app.quit() scheduled
  | { success: true; quitPending: false; fallback: 'browser' }   // missing-APPIMAGE: shell.openExternal, app keeps running
  // Linux package install with no way to ask for a password (no polkit agent):
  // the file is downloaded and `command` finishes the job in a terminal.
  | { success: true; quitPending: false; fallback: 'manual'; command: string; filePath: string }
  // `command` rides along on a failed package install so the UI can offer the
  // same manual finish instead of a dead end.
  | { success: false; error: UpdateInstallErrorCode; command?: string };

export interface UpdateCachedDownload {
  filePath: string;
  version: string;
}

// WHY (2026-09-30 one-core R3-2): the beta-channel answer and the changelog answer were typed
// inline in the window.claude type; the channel table's rows now share these.
/** `betaChannel` is the saved answer (null = never chosen); `effective` is what the next check uses. */
export interface UpdateBetaChannelState { betaChannel: boolean | null; effective: boolean }
export interface UpdateChangelogResult {
  markdown: string | null;
  entries: Array<{ version: string; date?: string; body: string }>;
  fromCache: boolean;
  error?: boolean;
}
