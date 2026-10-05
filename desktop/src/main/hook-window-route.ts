// hook-window-route.ts — which windows a Claude Code hook event reaches (one-core sync-fix3 review).
//
// A hook event has always gone to the window that OWNS the session (else the main window), never to a buddy chat that merely watches it. That
// left a gap once the buddy chat began to draw open ask cards from its fill (session:open): a card answered or expired in the owner window was never
// told to the buddy, so it stayed on screen as a live question. The END of an ask is therefore also delivered to the watchers; the START stays
// owner-only, exactly as before (the buddy is handed asks that are already open by its fill).
/** The hook events that END an ask: a card on any screen showing it must clear (or, for an expiry, be kept/closed by the screen's own rule). */
const ASK_ENDINGS = new Set(['PermissionResolved', 'PermissionExpired', 'PasswordResolved']);

/** Window ids (webContents ids) to deliver `event` to: the owner (or the fallback main window), plus the watchers when the event ends an ask. */
export function hookWindowTargets(
  event: { type?: string } | null | undefined,
  ownerOrMain: number | null,
  watchers: Iterable<number>,
): number[] {
  const out: number[] = ownerOrMain == null ? [] : [ownerOrMain];
  if (event?.type && ASK_ENDINGS.has(event.type)) for (const w of watchers) if (!out.includes(w)) out.push(w);
  return out;
}
