import fs from 'fs';
import path from 'path';
import os from 'os';
import { log } from './logger';

/**
 * Announcement Service (decomposition v3, §9.1)
 *
 * Replaces the legacy hooks/announcement-fetch.js — announcements are now
 * owned by the app, not by a toolkit hook. Fetches the first non-comment
 * line from the youcoded-core repo's announcements.txt and caches it at
 * ~/.claude/.announcement-cache.json so session-start.sh (or the app's
 * session preamble, post-decomposition) can inject it.
 *
 * Format on the wire (one per line, first non-# wins):
 *   YYYY-MM-DD: message         → expires at that date
 *   message                      → never expires
 *
 * Called on app launch and once every 24h while running.
 */

const ANNOUNCEMENTS_URL =
  'https://raw.githubusercontent.com/itsdestin/youcoded-core/master/announcements.txt';
const CACHE_PATH = path.join(os.homedir(), '.claude', '.announcement-cache.json');
const TMP_PATH = `${CACHE_PATH}.tmp`;
const REFRESH_MS = 24 * 60 * 60 * 1000; // 24 hours

interface AnnouncementCache {
  message: string;
  fetched_at: string;
  expires?: string;
}

function writeAtomic(data: AnnouncementCache): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  try {
    fs.writeFileSync(TMP_PATH, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP_PATH, CACHE_PATH);
  } catch (e) {
    try { fs.unlinkSync(TMP_PATH); } catch { /* best-effort cleanup */ }
    throw e;
  }
}

function parseAnnouncement(text: string): { message: string; expires?: string } | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Date-prefixed lines: YYYY-MM-DD: message (expires that date)
    const dateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2}): (.+)$/);
    if (dateMatch) return { message: dateMatch[2].trim(), expires: dateMatch[1] };
    return { message: trimmed };
  }
  return null;
}

/**
 * Fetch announcements once. Failure (offline, DNS, non-200) leaves the
 * existing cache intact — users don't see stale announcements cleared just
 * because they went offline.
 */
export async function fetchAnnouncement(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(ANNOUNCEMENTS_URL);
  } catch {
    return; // offline or DNS failure — leave cache alone
  }
  if (!response.ok) return;

  const text = await response.text();
  const parsed = parseAnnouncement(text);
  if (!parsed) return;

  const cache: AnnouncementCache = {
    message: parsed.message,
    fetched_at: new Date().toISOString(),
  };
  if (parsed.expires) cache.expires = parsed.expires;

  try {
    writeAtomic(cache);
    log('INFO', 'Announcements', 'Cache updated', { hasExpiry: !!parsed.expires });
  } catch (e) {
    log('ERROR', 'Announcements', 'Cache write failed', { error: String(e) });
  }
}

let refreshTimer: NodeJS.Timeout | null = null;

/**
 * Kick off the first fetch immediately and schedule a 24h refresh loop. Safe
 * to call more than once; subsequent calls reset the timer.
 */
export function startAnnouncementService(): void {
  stopAnnouncementService();
  fetchAnnouncement().catch(e => log('ERROR', 'Announcements', 'Initial fetch threw', { error: String(e) }));
  refreshTimer = setInterval(() => {
    fetchAnnouncement().catch(e => log('ERROR', 'Announcements', 'Scheduled fetch threw', { error: String(e) }));
  }, REFRESH_MS);
  // Don't keep the event loop alive just for this — app shutdown shouldn't wait
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
