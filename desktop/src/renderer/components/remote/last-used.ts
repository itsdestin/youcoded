// WHY (Destin 2026-10-31): a paired device unused for 90 days is signed out, so the device list says when each
// was last used. Hidden while the device is online (in use right now) and when the computer has no date.
export function lastUsedText(online: boolean, lastSeenAt: number): string {
  if (online || !lastSeenAt) return '';
  return ` · Last used ${new Date(lastSeenAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}
