// session-list-sync.ts — what a screen does with the computer's list of live conversations after it reconnects (one-core sync-fix3).
//
// WHY (sync-fix3 audit): a phone that was away is sent every live session again (`session:created`), which can only ADD pills, and it re-asks only the few
// conversations it watches. A conversation that ended, or was handed to another device, while the phone was away therefore kept its pill (with its last
// dot colour) until tapped. Pure functions so the rule is tested without mounting App.
import { useOnRemoteReconnect } from '../hooks/useOnRemoteReconnect';

/** The ids of pills this screen holds that the computer no longer lists. `keep` says which to leave alone (a pending hand-off tab is this screen's own; a
 *  conversation another device took over keeps its pill for the "moved" gate, which exists only because a push said so). */
export function endedSessionIds(
  current: ReadonlyArray<{ id: string }>,
  listed: unknown,
  keep: (id: string) => boolean,
): string[] {
  // Anything but a real list is "no answer", never "everything ended".
  if (!Array.isArray(listed)) return [];
  const live = new Set(listed.map((x: { id?: unknown }) => x?.id));
  return current.filter((s) => !keep(s.id) && !live.has(s.id)).map((s) => s.id);
}

/** A replayed `session:created` for a pill that already exists: only the name can have moved (a rename made while remote access was off never reached
 *  this screen). Returns the same array when nothing changed so React skips the render. */
export function withAnnouncedName<T extends { id: string; name?: string }>(prev: T[], info: { id: string; name?: string }): T[] {
  const known = prev.find((s) => s.id === info.id);
  if (!known || !info.name || known.name === info.name) return prev;
  return prev.map((s) => (s.id === info.id ? { ...s, name: info.name } : s));
}

/**
 * After a remote reconnect, ask the computer which conversations still exist and drop the pills for the rest. WHY a hook here and not inline in App
 * (sync-fix3): App.tsx is held to a line budget, and this carries its own reasoning. The reply and any later `session:created` arrive in order on the one
 * connection, so a conversation started after the list was built cannot be dropped by it. A failed ask changes nothing: the next reconnect asks again.
 */
export function useDropEndedSessionsOnReconnect(
  sessionsRef: { current: ReadonlyArray<{ id: string }> },
  movedRef: { current: ReadonlyMap<string, unknown> },
  remove: (id: string) => void,
): void {
  useOnRemoteReconnect(() => {
    const keep = (id: string) => String(id).startsWith('pending-handoff:') || movedRef.current.has(id);
    void (window.claude.session.list() as Promise<unknown>).then((list) => { for (const id of endedSessionIds(sessionsRef.current, list, keep)) remove(id); }).catch(() => {});
  });
}
