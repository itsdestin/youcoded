// The friends list and its requests, for the two screens that show people: the
// friends panel at the top of the Games list and a game's lobby.
//
// WHY its own hook (games-social redesign, redesign backlog row 11): until now
// only the lobby showed friends, so the fetch, the "a request I sent was just
// accepted" refetch and the per-row in-flight guards lived inside GameLobby.tsx.
// Destin moved the social side (friends, requests, add a friend) up to the Games
// list and left the lobby with people, scores and Challenge — both need the same
// list. The two screens are never on screen together (the shell shows the list OR
// a game), so each fetches on mount; no shared store is needed for one reader at
// a time.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useGameState } from '../../state/game-context';
import { useAccount } from '../../state/account-context';
import { mergeFriends } from './friends-data';
import type { FriendRow, RequestsPayload } from '../../state/marketplace-api-client';

// Local mirror of the renderer/main ApiResult shape (useIpc.ts declares it but
// doesn't export it — keeping a copy avoids importing across that boundary).
export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

export function useFriends() {
  const state = useGameState();
  // Self-exclusion keys on the ACCOUNT ID — display names aren't unique.
  const { user } = useAccount();
  const myId = user?.id ?? null;

  const [friends, setFriends] = useState<FriendRow[] | null>(null);
  const [requests, setRequests] = useState<RequestsPayload | null>(null);
  // Per-row error strings keyed by request/friend id (rendered under the row).
  const [rowError, setRowError] = useState<Record<string, string>>({});
  // Ids with a mutation in flight — their row buttons are disabled. The ref is
  // the synchronous double-fire guard (state alone can lag a fast double-tap);
  // the state copy drives the disabled rendering.
  const pendingRowsRef = useRef<Set<string>>(new Set());
  const [pendingRows, setPendingRows] = useState<Set<string>>(new Set());

  // Fetch both lists in parallel; called on mount and after every mutation.
  const refresh = useCallback(async () => {
    const [fr, rq] = await Promise.all([
      window.claude.social.listFriends(),
      window.claude.social.listRequests(),
    ]);
    if (fr.ok) setFriends(fr.value);
    if (rq.ok) setRequests(rq.value);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Refresh when presence shows an online user who ISN'T a known friend yet — a
  // request I sent was just accepted (the server pokes visibility ahead of my
  // list refetch). friendIdsRef avoids re-running purely on the friends array
  // reference changing, so this can't tight-loop.
  const friendIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    friendIdsRef.current = new Set((friends ?? []).map((f) => f.id));
  }, [friends]);
  useEffect(() => {
    const hasUnknownOnline = state.onlineUsers.some(
      (u) => u.id !== myId && !friendIdsRef.current.has(u.id),
    );
    if (hasUnknownOnline) void refresh();
  }, [state.onlineUsers, myId, refresh]);

  // Shared mutation runner for accept/decline/cancel/unfriend/block: on failure
  // stash a plain sentence under the row; on success clear it and refresh.
  const runMutation = useCallback(async (
    fn: () => Promise<ApiResult<unknown>>,
    key: string,
    fallback = 'Something went wrong. Try again.',
  ) => {
    if (pendingRowsRef.current.has(key)) return;
    pendingRowsRef.current.add(key);
    setPendingRows((prev) => new Set(prev).add(key));
    try {
      const res = await fn();
      if (!res.ok) {
        setRowError((prev) => ({ ...prev, [key]: res.message || fallback }));
        return;
      }
      setRowError((prev) => { const next = { ...prev }; delete next[key]; return next; });
      await refresh();
    } finally {
      pendingRowsRef.current.delete(key);
      setPendingRows((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, [refresh]);

  return {
    merged: mergeFriends(friends ?? [], state.onlineUsers),
    incoming: requests?.incoming ?? [],
    outgoing: requests?.outgoing ?? [],
    loaded: friends !== null,
    refresh,
    runMutation,
    pendingRows,
    rowError,
  };
}
