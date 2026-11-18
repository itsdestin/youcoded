/**
 * backup-availability.ts — which kinds of extra backup this device can actually run, in one place.
 *
 * WHY (backup fixes 2026-11-18): each screen guessed for itself. The setup wizard offered Google Drive on a phone
 * (which has no rclone, so setup could only fail or try to install it), the Backup & sync card's inline picker had no
 * check at all (Drive and iCloud on every device), and GitHub was "offered" on a phone where it copied nothing yet
 * reported finished. Every picker and every row now asks here.
 *
 *   - GitHub: gone everywhere (computers removed it earlier; a phone never had the tools).
 *   - Google Drive: not on a phone running its OWN backend. A phone paired to a computer drives the computer's
 *     backup, so it keeps Drive (`deviceNoun() === 'phone'` is exactly "Android app AND its own backend").
 *   - iCloud: only where an iCloud Drive client exists — a Mac or Windows computer (Linux and Android have none).
 */
import { deviceNoun, isAndroid } from '../platform';

export type DesktopOS = 'mac' | 'windows' | 'linux' | 'other';

/** The computer's operating system, read from the page, so prerequisite hints can name the right steps. */
export function detectDesktopOS(): DesktopOS {
  const ua = (navigator.userAgent || '').toLowerCase();
  const platform = (navigator.platform || '').toLowerCase();
  if (platform.includes('mac') || ua.includes('mac os')) return 'mac';
  if (platform.includes('win') || ua.includes('windows')) return 'windows';
  if (platform.includes('linux') || ua.includes('linux')) return 'linux';
  return 'other';
}

/** The Android app talking to its own backend on the phone (not one paired to a computer). */
export function onOwnPhone(): boolean {
  return deviceNoun() === 'phone';
}

/** Is this kind of backup offered to start here? */
export function backupTypeOffered(type: 'drive' | 'github' | 'icloud'): boolean {
  if (type === 'github') return false;
  if (type === 'drive') return !onOwnPhone();
  return !isAndroid() && detectDesktopOS() !== 'linux';
}

/** Why an EXISTING entry of this type can never copy anything here, or null when it can. */
export function backupEntryNotice(type: 'drive' | 'github' | 'icloud'): 'github-gone' | 'drive-phone' | null {
  if (type === 'github') return 'github-gone';
  if (type === 'drive' && onOwnPhone()) return 'drive-phone';
  return null;
}

/** The row's one-line status and its notice sentence for an entry that can never copy anything here.
 *  WHY the computer's sentence is kept word for word (backup fixes 2026-11-18): only a phone needed a new one — "on
 *  computers" would be wrong there — and a computer's screen must not change. */
export function backupEntryText(notice: 'github-gone' | 'drive-phone'): { status: string; body: string } {
  if (notice === 'drive-phone') {
    return { status: 'Not available on this phone', body: "Google Drive backup needs a computer. Nothing is copied from this phone. What's already on Google Drive stays there." };
  }
  return onOwnPhone()
    ? { status: 'No longer supported', body: "GitHub backups are no longer supported, so nothing is copied here. What's already on GitHub stays there." }
    : { status: 'No longer supported', body: "GitHub backups are no longer supported on computers, so nothing is copied here. What's already on GitHub stays there." };
}

/** Sign in again for a Google Drive backup that is already saved: keep its entry, point it at the connection the sign-in
 *  made only if that is a different name. Throws (its words are shown on the sign-in page) if the backup has gone.
 *  WHY (backup fixes 2026-11-18, item 4): the wizard used to save a NEW entry here and leave the broken one failing. */
export async function reconnectDriveBackend(
  claude: any,
  backend: { id: string; config?: Record<string, string> },
  remoteName: string,
): Promise<void> {
  // Checked against the live list first, so a backup removed meanwhile is never brought back.
  const live = (await claude.sync.getStatus())?.backends?.some((b: { id: string }) => b.id === backend.id);
  if (!live) throw new Error('That backup was removed, so there is nothing to sign in again.');
  if (remoteName !== (backend.config?.rcloneRemote || 'gdrive')) {
    await claude.sync.updateBackend(backend.id, { config: { rcloneRemote: remoteName } });
  }
}
