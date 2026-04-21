import fs from 'fs';
import path from 'path';
import os from 'os';
import { log } from './logger';
import { isExpired, type Announcement } from '../shared/announcement';

/**
 * Announcement Service
 *
 * Fetches the first non-comment line from youcoded's announcements.txt
 * (repo root) and caches it at ~/.claude/.announcement-cache.json for the
 * status bar widget and the terminal statusline.
 *
 * Format on the wire (first non-# line wins):
 *   YYYY-MM-DD: message         -> expires at that date
 *   message                     -> never expires
 *   (empty or comments only)    -> no announcement
 *
 * Lifecycle bugs this service is responsible for preventing:
 *   - Fetch-time expiry filter: past-date lines are treated as empty so
 *     already-stale content never lands in the cache.
 *   - Clear propagation: when the remote file is empty, we *write* a
 *     cleared cache ({ message: null, fetched_at }) rather than returning
 *     without touching disk. This is what lets the status bar pill
 *     disappear within the refresh interval instead of lingering.
 *
 * Called on app launch and every 1h while running.
 */

const ANNOUNCEMENTS_URL =
  'https://raw.githubusercontent.com/itsdestin/youcoded/master/announcements.txt';
const CACHE_PATH = path.join(os.homedir(), '.claude', '.announcement-cache.json');
const TMP_PATH = `${CACHE_PATH}.tmp`;
const REFRESH_MS = 60 * 60 * 1000; // 1 hour

function writeAtomic(data: Announcement): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  try {
    fs.writeFileSync(TMP_PATH, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP_PATH, CACHE_PATH);
  } catch (e) {
    try { fs.unlinkSync(TMP_PATH); } catch { /* best-effort cleanup */ }
    throw e;
  }
}

// Returns { message, expires? } for a valid unexpired line, or null for
// empty/comments-only/expired input. Callers treat null as "clear the cache."
function parseAnnouncement(text: string): { message: string; expires?: string } | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const dateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2}): (.+)$/);
    if (dateMatch) {
      const expires = dateMatch[1];
      // Fetch-time expiry filter: already-past dates are treated as empty.
      // Prevents a freshly-fetched stale entry from ever entering the cache.
      if (isExpired(expires)) return null;
      return { message: dateMatch[2].trim(), expires };
    }
    return { message: trimmed };
  }
  return null;
}

/**
 * Fetch announcements once. Network failure or non-200 leaves the existing
 * cache intact (users don't lose announcements on going offline). An empty
 * or all-expired remote file writes a cleared cache so the status bar
 * pill disappears within the refresh interval.
 */
export async function fetchAnnouncement(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(ANNOUNCEMENTS_URL);
  } catch {
    return; // offline / DNS failure — leave cache alone
  }
  if (!response.ok) return;

  const text = await response.text();
  const parsed = parseAnnouncement(text);

  const cache: Announcement = parsed
    ? {
        message: parsed.message,
        fetched_at: new Date().toISOString(),
        ...(parsed.expires ? { expires: parsed.expires } : {}),
      }
    : {
        // Clear-propagation write. null (vs. undefined) distinguishes
        // "explicitly cleared" from "no cache file yet" on the reader side.
        message: null,
        fetched_at: new Date().toISOString(),
      };

  try {
    writeAtomic(cache);
    log('INFO', 'Announcements', 'Cache updated', {
      cleared: cache.message === null,
      hasExpiry: !!cache.expires,
    });
  } catch (e) {
    log('ERROR', 'Announcements', 'Cache write failed', { error: String(e) });
  }
}

let refreshTimer: NodeJS.Timeout | null = null;

/**
 * Kick off the first fetch immediately and schedule a 1h refresh loop. Safe
 * to call more than once; subsequent calls reset the timer.
 */
export function startAnnouncementService(): void {
  stopAnnouncementService();
  fetchAnnouncement().catch(e =>
    log('ERROR', 'Announcements', 'Initial fetch threw', { error: String(e) }),
  );
  refreshTimer = setInterval(() => {
    fetchAnnouncement().catch(e =>
      log('ERROR', 'Announcements', 'Scheduled fetch threw', { error: String(e) }),
    );
  }, REFRESH_MS);
  // Don't keep the event loop alive just for this — app shutdown shouldn't wait.
  refreshTimer.unref?.();
}

export function stopAnnouncementService(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// Exposed for tests
export const __test = { parseAnnouncement };
