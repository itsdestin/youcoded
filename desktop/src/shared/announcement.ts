// Shared announcement types + helpers. Used by both main (fetcher) and
// renderer (status bar). Lives in src/shared/ so no Node-only imports.

export interface Announcement {
  message: string | null;
  fetched_at: string;
  expires?: string;
}

// Today's date in YYYY-MM-DD, local time, zero-padded. Matches the
// announcements.txt prefix format so string comparison works.
function todayYYYYMMDD(): string {
  const d = new Date();
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

// True when a dated announcement should no longer be shown. An announcement
// with expires == today is still visible; it drops off at local midnight.
// Undefined/null/empty expires means "no expiry" — never expired.
export function isExpired(expires: string | null | undefined): boolean {
  if (!expires) return false;
  return expires < todayYYYYMMDD();
}

// WHY (2026-10 security audit SC-8): the announcement text comes from a file on
// GitHub and is printed RAW by the terminal statusline. A terminal escape
// sequence inside it could retitle the window, draw a fake link or (in some
// terminals) write the clipboard. We remove ANSI/OSC escape sequences first
// (so their payload text goes too), then every remaining control character
// (C0, DEL, C1) and the invisible text-direction overrides, and cap the length.
// Plain words, punctuation, emoji and non-English text are untouched.
export const MAX_ANNOUNCEMENT_LENGTH = 300;
export function sanitizeAnnouncementText(input: string): string {
  return String(input ?? '')
    // OSC: ESC ] ... terminated by BEL or ESC \ (or end of text if unterminated)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    // 8-bit OSC introducer (U+009D) up to its terminator
    .replace(/\u009d[^\u0007\u009c]*(?:\u0007|\u009c)?/g, '')
    // CSI: ESC [ params intermediates final
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, '')
    // DCS / SOS / PM / APC strings: ESC P|X|^|_ ... ESC \
    .replace(/\u001b[PX^_][^\u001b]*(?:\u001b\\)?/g, '')
    // any other two-character escape
    .replace(/\u001b[@-_]/g, '')
    // whatever control characters are left, plus bidi overrides/isolates
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ANNOUNCEMENT_LENGTH);
}
