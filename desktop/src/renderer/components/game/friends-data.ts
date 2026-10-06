// friends-data.ts
// Pure helpers for the friends list UI (Task 8, spec §6). Kept free of React and
// IPC so the ordering + status-label logic is unit-testable in isolation — the
// same pure-core / IO-shell split used by local-theme-synthesizer.ts. `nowMs` is
// injected (callers pass Date.now()) so the coarsening ladder is deterministic.

import type { OnlineUser } from '../../state/game-types';

export interface FriendRowData {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  lastSeenAt: number | null;
  online: OnlineUser | null; // live presence entry when connected, else null
}

// Shape of a server friends row (marketplace-api-client FriendRow). Declared
// structurally here rather than imported so this stays a leaf module.
interface ServerFriend {
  id: string;
  display_name: string;
  handle: string | null;
  avatar_url: string | null;
  last_seen_at: number | null;
}

/**
 * Merge the server friends list with live presence, online first.
 * Within each group (online / offline) friends are name-sorted (locale compare).
 */
export function mergeFriends(friends: ServerFriend[], online: OnlineUser[]): FriendRowData[] {
  const liveById = new Map(online.map((u) => [u.id, u]));
  return friends
    .map((f) => ({
      id: f.id,
      name: f.display_name,
      handle: f.handle,
      avatarUrl: f.avatar_url,
      lastSeenAt: f.last_seen_at,
      online: liveById.get(f.id) ?? null,
    }))
    // online-first: online rows get sort-key 0, offline 1; ties break on name.
    .sort((a, b) => (a.online ? 0 : 1) - (b.online ? 0 : 1) || a.name.localeCompare(b.name));
}

/**
 * Plain-word status — never glyphs (workspace rule). Live presence wins over
 * lastSeenAt; otherwise the "last seen" string coarsens as the gap grows.
 */
export function statusLabel(row: FriendRowData, nowMs: number): string {
  if (row.online) return row.online.status === 'in-game' ? 'In game' : 'Online';
  if (!row.lastSeenAt) return 'Offline';
  // Clamp at 0 so negative clock skew (a friend's lastSeenAt slightly in the
  // future) reads as 'Active just now' rather than a nonsensical negative gap.
  const mins = Math.max(0, Math.floor(nowMs / 1000 / 60 - row.lastSeenAt / 60));
  if (mins < 2) return 'Active just now';
  if (mins < 60) return `Last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Last seen ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `Last seen ${days}d ago`;
  return `Last seen ${new Date(row.lastSeenAt * 1000).toLocaleDateString()}`;
}

/**
 * Which of the panel's connection states is showing (games-social round 2, GS-12:
 * "a clear difference between the incognito state, pc internet off state, and game
 * server broken/unreachable state"). One answer, read by the friends card AND the game
 * tiles, so the two can never disagree.
 *
 *  - `offline`    the computer reports no network connection (useNetworkOnline). Wins
 *                 over everything: going online or retrying cannot help until it returns.
 *  - `incognito`  your own choice — hidden from friends. Since round 5 this device still
 *                 RECEIVES friends' presence over a hidden connection (presence-socket.ts).
 *  - `server`     the presence connection reported an error while the computer is online.
 *                 Said as "Can't reach the game server" — WHERE it failed, not why.
 *  - `connecting` the second before the socket opens.
 *  - `online`     connected.
 */
export type SocialState = 'offline' | 'incognito' | 'server' | 'connecting' | 'online';

export function socialState(s: { networkOnline: boolean; incognito?: boolean; connected: boolean; partyError: string | null }): SocialState {
  if (!s.networkOnline) return 'offline';
  // A server failure outranks incognito now that incognito keeps a (hidden) connection open
  // (round 5): if that connection fails, the problem is what to show.
  if (s.partyError) return 'server';
  if (s.incognito) return 'incognito';
  return s.connected ? 'online' : 'connecting';
}

/** What each state puts on the Connect 4 / Chess tiles, and whether it greys them. The
 *  friends card says the rest itself (round 3: an error card for offline / server down, the
 *  status pill for incognito). */
export const SOCIAL_STATE_COPY: Record<Exclude<SocialState, 'online'>, { tile: string; greysVersus: boolean }> = {
  offline: { tile: 'No internet connection', greysVersus: true },
  incognito: { tile: "You're incognito", greysVersus: false },
  server: { tile: "Can't reach the game server", greysVersus: true },
  connecting: { tile: 'Connecting…', greysVersus: false },
};
