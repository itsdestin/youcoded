// The one-line summary of Backup & sync's "Additional backups" when it is folded into a row on a phone
// (card #213, density-review D-4). WHY its own file: SyncPanel.tsx is at its line budget.
type Backend = { label: string; syncEnabled: boolean; lastError?: string | null; lastPushEpoch?: number | null };

/** What the closed row says: where the extra copy goes and how it is doing, "Off", or which destination has a problem. */
export function additionalBackupsSummary(list: readonly Backend[], masterOn: boolean, anyError: boolean): string {
  const paused = list.filter(b => !b.syncEnabled).length;
  if (!masterOn) return list.length > 0 ? `Off · ${paused} paused` : 'Off';
  if (list.length === 0) return 'On · pick where the copy goes';
  if (anyError) return `Problem with ${(list.find(b => b.lastError != null) ?? list[0]).label}`;
  const first = list[0];
  return `${first.label}${list.length > 1 ? ` + ${list.length - 1} more` : ''}${first.lastPushEpoch ? `, backed up ${timeAgo(first.lastPushEpoch)}` : ''}`;
}

/** "5m ago" — moved here from SyncPanel.tsx (line budget) with the summary that also uses it. */
export function timeAgo(epoch: number): string {
  const seconds = Math.floor(Date.now() / 1000 - epoch);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
