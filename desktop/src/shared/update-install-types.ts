// Shared types for the in-app update installer.
// Consumed by: desktop/src/main/update-installer.ts, desktop/src/main/ipc-handlers.ts,
// desktop/src/main/preload.ts, desktop/src/renderer/remote-shim.ts,
// desktop/src/renderer/components/UpdatePanel.tsx,
// app/src/main/kotlin/.../runtime/UpdateInstallerStub.kt (mirror).
//
// Keep in sync with the Kotlin stub's error code enum — see parity test in tests/update-install-ipc.test.ts.

export type UpdateInstallErrorCode =
  | 'spawn-failed'          // spawn() threw or child exited non-zero within 2s
  | 'file-missing'          // download file does not exist on disk
  | 'appimage-not-writable' // EACCES/EPERM replacing a root-owned AppImage
  | 'dmg-corrupt'           // `open -W` exited non-zero on macOS
  | 'unsupported-platform'  // platform/arch combination we don't handle
  | 'remote-unsupported'    // attempted from a remote-browser session
  | 'network-failed'        // download failed mid-stream
  | 'disk-full'             // ENOSPC during write
  | 'url-rejected'          // failed HTTPS / domain allowlist check
  | 'busy'                  // another download is already active (different URL)
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
  | { success: true; quitPending: false; fallback: 'browser' }   // .deb / missing-APPIMAGE: shell.openExternal, app keeps running
  | { success: false; error: UpdateInstallErrorCode };

export interface UpdateCachedDownload {
  filePath: string;
  version: string;
}
