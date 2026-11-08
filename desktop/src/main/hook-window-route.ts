// hook-window-route.ts — which windows a Claude Code hook event reaches.
//
// A hook event always goes to the window that OWNS the session (else the main window). The buddy chat that WATCHES the
// session gets it too — the start of an ask as well as its end.
//
// WHY the start too (buddy rebuild, 2026-10-25; buddy-rebuild-questions#S-2 "questions and permission requests appear
// in the buddy as soon as they appear in the main window"): until now only the END of an ask reached the watcher (one-core
// sync-fix3), and the buddy saw a NEW ask only when its fill (session:open) next ran — i.e. after reopening it. A buddy
// sitting open on a conversation never showed the question Claude had just asked. Every screen that draws the card has to
// be told it exists; whichever screen answers, the end of the ask still reaches all of them and clears the rest.
//
// Non-ask hook events reach the watcher too: its listener (useBuddyFeed → applyHookEvent) ignores every type it does not
// draw, exactly as the owner window's does.

/** Window ids (webContents ids) to deliver `event` to: the owner (or the fallback main window), then every watcher. */
export function hookWindowTargets(
  event: { type?: string } | null | undefined,
  ownerOrMain: number | null,
  watchers: Iterable<number>,
): number[] {
  const out: number[] = ownerOrMain == null ? [] : [ownerOrMain];
  if (!event?.type) return out;
  for (const w of watchers) if (!out.includes(w)) out.push(w);
  return out;
}
