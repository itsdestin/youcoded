// The status bar's Git Branch chip text. Kept apart from StatusBar.tsx so it can be tested on its own.
/**
 * "youcoded-dev/session/work-cards" → "youcoded-dev · work-cards" for the Git Branch chip.
 * WHY (Destin, 2026-10-16: "sessions/blahblah is not a useful tag"): the repo goes first, and the generic
 * "session/" prefix every worktree branch carries is dropped; prefixes that say something (feat/, fix/) stay.
 * The hover keeps the full "repo/branch".
 */
export function gitChipLabel(label: string): string {
  const slash = label.indexOf('/');
  if (slash < 0) return label;
  const repo = label.slice(0, slash);
  const branch = label.slice(slash + 1).replace(/^session\//, '');
  return `${repo} · ${branch}`;
}
