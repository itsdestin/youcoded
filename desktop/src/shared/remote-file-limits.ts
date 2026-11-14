// Preview ceilings for a file opened from a PHONE over remote access.
//
// WHY they are smaller than the desktop's (EDIT_MAX_BYTES 3 MB, read-binary 50 MB):
// over the phone a file is one download through Tailscale into a browser tab, held as
// base64 and again as bytes. A 50 MB PDF froze the screen for many seconds and ate
// mobile data — Destin picked "smaller on the phone" on the 2026-09-10 questions deck
// (Q-6: text to 1 MB, images and PDFs to 10 MB). Above these the host answers
// `{ ok: false, error: 'too-large', sizeBytes }` and the phone shows the file's name,
// size and a Download button instead of a preview (Q-8).
//
// Shared between the host (remote-server.ts decides whether to send the bytes) and the
// workbench mock (so the too-large card is reviewable without a real 24 MB file).
import { formatBytes } from './format-bytes';

export const REMOTE_TEXT_PREVIEW_MAX_BYTES = 1 * 1024 * 1024;
export const REMOTE_BINARY_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

/** "24.0 MB", "812 KB", "3 B" — for the too-big card and the download row. */
export function formatFileSize(bytes: number): string {
  // 1000-based (card #143, Destin 2026-11-12). trimZero: "10 MB", not "10.0 MB" — a limit reads as a
  // person's number, a measurement keeps one decimal ("24.3 MB"). Tester U13, 2026-09-10.
  return formatBytes(bytes, { kbDecimals: 0, trimZero: true });
}
