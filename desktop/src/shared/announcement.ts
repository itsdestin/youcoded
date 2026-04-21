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
