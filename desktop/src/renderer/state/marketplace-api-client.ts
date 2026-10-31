// Typed fetch wrapper for the YouCoded marketplace Cloudflare Worker backend.
// Lives in renderer/ because the same React bundle runs on both desktop and Android —
// fetch calls go directly to the Worker (CORS allowlist covers both platforms).
// No IPC needed for read endpoints; write endpoints gate on token which callers supply via getToken().

// WHY: Moved to its own domain so Cloudflare's cache and rate limiter apply; the old workers.dev address still answers for older app versions.
export const MARKETPLACE_API_HOST = "https://api.youcoded.ai";

export class MarketplaceApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface AuthStartResponse {
  device_code: string;
  user_code: string;
  auth_url: string;
  expires_in: number;
}

// Signed-in user's profile as returned by GET /auth/me (Worker accounts Phase 1 shape).
export interface AuthMeResponse {
  id: string;
  login: string;              // GitHub login (player-tag continuity)
  display_name: string;       // account-native display name (Worker accounts Phase 1)
  avatar_url: string | null;
  handle: string | null;      // unique @handle, null until the user claims one
}

// `user` on completion: the Worker returns the profile alongside the token so
// clients can store both atomically (games player tag needs `login`).
// Optional because a Worker deployed before 2026-07 omits it.
export type AuthPollResponse =
  | { status: "pending" }
  | { status: "complete"; token: string; user?: AuthMeResponse };

export interface StatsResponse {
  generated_at: number;
  // thumbs_up / thumbs_down: marketplace overhaul (2026-08-27) — one-tap
  // feedback replaces star ratings. Optional until the Worker ships them; the
  // UI shows nothing (not "0%") when they are absent.
  plugins: Record<string, { installs: number; review_count: number; rating: number; thumbs_up?: number; thumbs_down?: number }>;
  // installs: marketplace overhaul Task 22 — theme download counts. Optional
  // because an older Worker does not report it; the card then shows no count
  // rather than a misleading "0".
  themes: Record<string, { likes: number; installs?: number }>;
}

// One comment on a plugin — GET /comments/:plugin_id (marketplace overhaul,
// no Worker route yet; the workbench answers it from fixtures).
export interface CommentEntry {
  id: string;
  user_id: string;
  user_login: string;
  user_avatar_url: string;
  text: string;
  /** Unix timestamp in seconds */
  created_at: number;
}

// Shape of a single rating entry from GET /ratings/:plugin_id
export interface RatingEntry {
  /** Composite key: "<user_id>:<plugin_id>" */
  id: string;
  /** GitHub user id string, e.g. "github:123456" */
  user_id: string;
  user_login: string;
  user_avatar_url: string;
  stars: number;
  review_text: string | null;
  /** Unix timestamp in seconds */
  created_at: number;
}

export interface ListRatingsResponse {
  ratings: RatingEntry[];
}

export interface PostRatingInput {
  plugin_id: string;
  stars: 1 | 2 | 3 | 4 | 5;
  review_text?: string;
}

// ── Social graph (accounts Phase 2) — snake_case wire shapes from GET/POST /social/* ──
// A minimal public card. handle/avatar_url may be null (handle unclaimed;
// GitHub always sets an avatar, but the column is nullable so we mirror it).
export interface SocialUserCard {
  id: string;
  display_name: string;
  handle: string | null;
  avatar_url: string | null;
}
// GET /social/friends returns a bare array of these (card + presence + friends-since).
export interface FriendRow extends SocialUserCard {
  last_seen_at: number | null;
  created_at: number; // friendship row timestamp (friends-since), NOT account age
}
// ── Games arcade (spec §6.1) — snake_case wire shapes from GET/POST /games/* ──
// Scores cross the wire as RAW NUMBERS. How a game WORDS its score ("31 pipes",
// "12,480") comes from that game's own entry in game-registry.ts, so the Worker
// never has to learn a game's vocabulary and adding a game needs no deploy.
/** My own best in one game. `GET /games/scores` returns these keyed by game id,
 *  containing only games I have actually played. */
export interface GameScoreRow {
  best: number;
  best_at: number;   // unix seconds, when the best was set
  runs: number;
}
/** One row of a friends leaderboard. `rank` is computed by the Worker so every
 *  client agrees on the tie rule (earliest to reach the score wins it). */
export interface GameBoardEntry extends SocialUserCard {
  best_score: number;
  best_at: number;
  rank: number;
  is_you: boolean;
}
/** `you` is called out separately from `entries` so "you, alone" and "you have
 *  no score yet" are distinguishable without the client scanning the list. */
export interface GameBoard {
  game: string;
  you: GameBoardEntry | null;
  entries: GameBoardEntry[];
}
/** My record against ONE opponent in ONE game, from my point of view — so
 *  `wins` is MY wins. `GET /games/records` returns a bare array of these.
 *
 *  Records deliberately SURVIVE an unfriend: the Worker reports what actually
 *  happened, and the client paints a row only for people currently on the
 *  friends list. So a caller must join this to its own friends list rather than
 *  assume every `opponent_id` here is someone to display. */
export interface HeadToHead {
  opponent_id: string;
  game: string;
  wins: number;
  losses: number;
  draws: number;
  last_played_at: number; // unix seconds, the most recent settled match
}

// GET /social/requests returns this object (both directions), NOT a bare array.
export interface RequestsPayload {
  incoming: Array<{ id: string; from: SocialUserCard; created_at: number }>;
  outgoing: Array<{ id: string; to: SocialUserCard; created_at: number }>;
}
// GET /social/blocks returns a bare array of these (owner-only view).
export interface BlockRow extends SocialUserCard {
  created_at: number; // when I blocked them
}

export interface MarketplaceApiClient {
  getStats(): Promise<StatsResponse>;
  /** `loopbackPort`: where this computer listens for the sign-in secret (main/signin-loopback.ts). */
  authStart(loopbackPort?: number): Promise<AuthStartResponse>;
  authPoll(deviceCode: string, loopbackSecret?: string): Promise<AuthPollResponse>;
  /** Resolve the current session token to the signed-in user's profile. */
  authMe(): Promise<AuthMeResponse>;
  /** Update the account display name. Returns the stored value. */
  updateProfile(displayName: string): Promise<{ display_name: string }>;
  /** Claim/change the unique @handle. Returns the normalized handle. Throws MarketplaceApiError (400 invalid / 409 taken). */
  setHandle(handle: string): Promise<{ handle: string }>;
  /** Permanently delete the account (hard delete + cascade on the Worker). */
  deleteAccount(): Promise<void>;
  /** Invalidate the current session token server-side. */
  logout(): Promise<void>;
  postInstall(pluginId: string): Promise<void>;
  postRating(input: PostRatingInput): Promise<{ hidden: boolean }>;
  deleteRating(pluginId: string): Promise<void>;
  toggleThemeLike(themeId: string): Promise<{ liked: boolean }>;
  postReport(input: { rating_user_id: string; rating_plugin_id: string; reason?: string }): Promise<void>;
  /** Fetch all visible ratings for a plugin. Unauthenticated; newest-first, LIMIT 50.
   *  Pass an AbortSignal to cancel in-flight requests on unmount or refresh. */
  listRatings(pluginId: string, signal?: AbortSignal): Promise<ListRatingsResponse>;

  // ── Marketplace overhaul (2026-08-27) — thumbs + comments. Both auth'd; thumbs
  //    additionally require a prior install (same rule as ratings today, so
  //    strangers can't game the number). ──
  /** `total` is the full visible count; the list itself is capped at the 50
   *  most recent. Optional because the Worker and the app deploy separately —
   *  an older Worker sends only `comments`, and the app must not break on it. */
  listComments(pluginId: string, signal?: AbortSignal): Promise<{ comments: CommentEntry[]; total?: number }>;
  postComment(input: { plugin_id: string; text: string }): Promise<{ ok: true; id: string; hidden: boolean }>;
  /** Reconcile: report EVERY plugin the client currently has, in one call.
   *  Idempotent server-side and never moves `installed_at`. */
  postInstalls(pluginIds: string[]): Promise<{ ok: true; recorded: number }>;
  /** `null` clears the user's vote. Returns the plugin's NEW totals so the caller
   *  can move the number on the spot — /stats is served max-age=300 and cannot
   *  answer that question for up to five minutes after the write. */
  setThumb(input: { plugin_id: string; value: 'up' | 'down' | null }): Promise<{ ok: true; vote: 'up' | 'down' | null; thumbs_up: number; thumbs_down: number }>;
  /** The caller's own vote AND the plugin's current totals. Both, because the
   *  page would otherwise show a lit thumb beside a stale "No votes yet". */
  getThumb(pluginId: string): Promise<{ vote: 'up' | 'down' | null; thumbs_up: number; thumbs_down: number }>;

  // ── Social graph (accounts Phase 2). All auth'd. The Worker 404s an unknown or
  //    blocked handle (indistinguishable — no enumeration oracle), 429s on caps,
  //    and 400s a self-request; those surface as MarketplaceApiError.status so the
  //    handler layer can forward the code to the UI. ──
  /** Exact-match handle lookup → one card. Throws 404 (unknown/blocked), 429 (cap). */
  lookupHandle(handle: string): Promise<SocialUserCard>;
  /** Send a friend request by handle. { status:"friends" } if already friends or the
   *  target had a pending request to me (mutual-accept). Throws 404/400/429. */
  sendRequest(handle: string): Promise<{ status: "pending" | "friends" }>;
  /** Both directions of my pending requests. */
  listRequests(): Promise<RequestsPayload>;
  /** Accept an incoming request (recipient only; 404 otherwise). */
  acceptRequest(id: string): Promise<void>;
  /** Decline an incoming request (silent — sender is never notified). */
  declineRequest(id: string): Promise<void>;
  /** Cancel an outgoing request I sent. */
  cancelRequest(id: string): Promise<void>;
  /** My friends (card + last_seen_at + friends-since). */
  listFriends(): Promise<FriendRow[]>;
  /** Remove a friend by their account id (silent). */
  unfriend(userId: string): Promise<void>;
  /** Block a user by account id (severs friendship + clears requests both ways). */
  block(userId: string): Promise<void>;
  /** Remove a block by account id. */
  unblock(userId: string): Promise<void>;
  /** My block list (owner-only view). */
  listBlocks(): Promise<BlockRow[]>;
  /** Full account data export (GET /auth/export) — one large JSON object. */
  exportData(): Promise<unknown>;

  // ── Games arcade (spec §6.1). All auth'd: both boards are friends-only, so
  //    there is deliberately no public read. ──
  /** Every solo game I have played, keyed by game id. `{}` if I've played none. */
  gameScores(): Promise<Record<string, GameScoreRow>>;
  /** One game's friends leaderboard, ranked, including me. */
  gameBoard(game: string): Promise<GameBoard>;
  /** Publish a finished run. Keeps the best, counts the run either way;
   *  `is_best` is the one fact the end-of-run screen can't work out itself. */
  submitGameScore(game: string, score: number): Promise<{ ok: true; best: number; best_at: number; runs: number; is_best: boolean }>;
  /** Every head-to-head record I hold, one row per (opponent, game). Optionally
   *  narrowed to a single game. Read once and joined to the friends list, so a
   *  friend row can show "7-2 at chess" without a call per friend. */
  gameRecords(game?: string): Promise<HeadToHead[]>;
}

export function createMarketplaceApiClient(opts: {
  host: string;
  getToken: () => string | null;
}): MarketplaceApiClient {
  const { host, getToken } = opts;

  // signal is threaded through only for endpoints that need cancellation (e.g. listRatings).
  // Other methods can opt-in later without changing callers.
  async function request<T>(path: string, init: RequestInit & { auth?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string>) };
    if (init.auth) {
      const token = getToken();
      if (!token) throw new MarketplaceApiError(401, "not signed in");
      headers.Authorization = `Bearer ${token}`;
    }
    // Remove the custom 'auth' flag before passing to fetch (not a standard RequestInit field)
    const { auth: _auth, ...fetchInit } = init;
    const res = await fetch(`${host}${path}`, { ...fetchInit, headers });
    // 202 Accepted is used for poll-pending responses — treat as success with { status: "pending" }
    if (res.status === 202) return { status: "pending" } as T;
    if (!res.ok) {
      // Fix: the Worker's 400/409 errors (Hono HTTPException, e.g. "that handle is
      // taken") arrive as text/plain with the message as the raw body — NOT JSON
      // {message}. The old res.json() path threw on those and fell back to
      // res.statusText, which is EMPTY over HTTP/2 on Cloudflare, so every such
      // error reached the UI with a blank message. Read the body as text once,
      // then accept either shape: JSON {message} or the raw text itself.
      const raw = await res.text().catch(() => "");
      let message = "";
      try {
        const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown };
        if (typeof parsed?.message === "string") message = parsed.message;
        // Fix: the Worker's JSON 500s use `{ ok: false, error }` (app.onError),
        // not `{ message }` — extract `error` so those don't reach the UI blank.
        else if (typeof parsed?.error === "string") message = parsed.error;
      } catch {
        // Not JSON — plain-text body; the raw text fallback below covers it.
      }
      if (!message) message = raw.trim();
      if (!message) message = `request failed (status ${res.status})`;
      throw new MarketplaceApiError(res.status, message);
    }
    // Success path: tolerate empty bodies (204 No Content endpoints) by returning {}
    return (await res.json().catch(() => ({}))) as T;
  }

  return {
    getStats: () => request<StatsResponse>("/stats", { method: "GET" }),
    authStart: (loopbackPort) =>
      request<AuthStartResponse>("/auth/github/start", {
        method: "POST",
        ...(loopbackPort !== undefined ? { body: JSON.stringify({ loopback_port: loopbackPort }) } : {}),
      }),
    authPoll: (device_code, loopbackSecret) =>
      request<AuthPollResponse>("/auth/github/poll", {
        method: "POST",
        body: JSON.stringify(loopbackSecret ? { device_code, loopback_secret: loopbackSecret } : { device_code }),
      }),
    authMe: () => request<AuthMeResponse>("/auth/me", { method: "GET", auth: true }),
    updateProfile: (display_name) =>
      request<{ display_name: string }>("/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ display_name }),
        auth: true,
      }),
    setHandle: (handle) =>
      request<{ handle: string }>("/auth/handle", {
        method: "PUT",
        body: JSON.stringify({ handle }),
        auth: true,
      }),
    // Void endpoints: 204 No Content. request() tolerates empty bodies (res.json().catch → {}),
    // so the same pattern as postInstall/deleteRating works — discard the return.
    deleteAccount: async () => {
      await request("/auth/account", { method: "DELETE", auth: true });
    },
    logout: async () => {
      // WHY: best-effort revoke must not hang sign-out for minutes on a blackholed
      // connection — bound it to 5s so a dead endpoint can't freeze the UI. The
      // handler already swallows the resulting timeout/abort rejection —
      // AbortSignal.timeout() rejects with a TimeoutError DOMException, not an
      // AbortError — so offline sign-out is fine.
      await request("/auth/logout", { method: "POST", auth: true, signal: AbortSignal.timeout(5000) });
    },
    postInstall: async (plugin_id) => {
      await request("/installs", { method: "POST", body: JSON.stringify({ plugin_id }), auth: true });
    },
    postRating: (input) =>
      request<{ hidden: boolean }>("/ratings", {
        method: "POST",
        body: JSON.stringify(input),
        auth: true,
      }),
    deleteRating: async (plugin_id) => {
      await request(`/ratings/${encodeURIComponent(plugin_id)}`, { method: "DELETE", auth: true });
    },
    toggleThemeLike: (theme_id) =>
      request<{ liked: boolean }>(`/themes/${encodeURIComponent(theme_id)}/like`, {
        method: "POST",
        auth: true,
      }),
    postReport: async (input) => {
      await request("/reports", { method: "POST", body: JSON.stringify(input), auth: true });
    },
    // Unauthenticated — public read endpoint, no Authorization header needed.
    // signal allows callers to cancel mid-flight on unmount or refreshKey change.
    listRatings: (plugin_id, signal?) =>
      request<ListRatingsResponse>(`/ratings/${encodeURIComponent(plugin_id)}`, { method: "GET", signal }),
    listComments: (plugin_id, signal?) =>
      request<{ comments: CommentEntry[]; total?: number }>(`/comments/${encodeURIComponent(plugin_id)}`, { method: "GET", signal }),
    postInstalls: (plugin_ids) =>
      request<{ ok: true; recorded: number }>("/installs", { method: "POST", body: JSON.stringify({ plugin_ids }), auth: true }),
    postComment: (input) =>
      request<{ ok: true; id: string; hidden: boolean }>("/comments", { method: "POST", body: JSON.stringify(input), auth: true }),
    setThumb: (input) =>
      request<{ ok: true; vote: 'up' | 'down' | null; thumbs_up: number; thumbs_down: number }>("/thumbs", { method: "POST", body: JSON.stringify(input), auth: true }),
    getThumb: (plugin_id) =>
      request<{ vote: 'up' | 'down' | null; thumbs_up: number; thumbs_down: number }>(`/thumbs/${encodeURIComponent(plugin_id)}`, { method: "GET", auth: true }),

    // ── Social graph (accounts Phase 2). All auth'd; path params URL-encoded. The
    //    action endpoints (accept/decline/cancel/unfriend/block/unblock) return
    //    { ok: true }; we discard it (async wrapper) since only success matters. ──
    lookupHandle: (handle) =>
      request<SocialUserCard>(`/social/users/${encodeURIComponent(handle)}`, { method: "GET", auth: true }),
    sendRequest: (handle) =>
      request<{ status: "pending" | "friends" }>("/social/requests", {
        method: "POST",
        body: JSON.stringify({ handle }),
        auth: true,
      }),
    listRequests: () =>
      request<RequestsPayload>("/social/requests", { method: "GET", auth: true }),
    acceptRequest: async (id) => {
      await request(`/social/requests/${encodeURIComponent(id)}/accept`, { method: "POST", auth: true });
    },
    declineRequest: async (id) => {
      await request(`/social/requests/${encodeURIComponent(id)}/decline`, { method: "POST", auth: true });
    },
    cancelRequest: async (id) => {
      await request(`/social/requests/${encodeURIComponent(id)}`, { method: "DELETE", auth: true });
    },
    listFriends: () =>
      request<FriendRow[]>("/social/friends", { method: "GET", auth: true }),
    unfriend: async (userId) => {
      await request(`/social/friends/${encodeURIComponent(userId)}`, { method: "DELETE", auth: true });
    },
    // Body is snake_case { user_id } — the Worker reads body.user_id (POST /social/blocks).
    block: async (userId) => {
      await request("/social/blocks", { method: "POST", body: JSON.stringify({ user_id: userId }), auth: true });
    },
    unblock: async (userId) => {
      await request(`/social/blocks/${encodeURIComponent(userId)}`, { method: "DELETE", auth: true });
    },
    listBlocks: () =>
      request<BlockRow[]>("/social/blocks", { method: "GET", auth: true }),
    exportData: () =>
      request<unknown>("/auth/export", { method: "GET", auth: true }),

    // ── Games arcade (spec §6.1). Game ids are URL-encoded like every other
    //    path param here; the Worker rejects an id that isn't a known solo game
    //    rather than inventing an empty board for it. ──
    gameScores: () =>
      request<Record<string, GameScoreRow>>("/games/scores", { method: "GET", auth: true }),
    gameBoard: (game) =>
      request<GameBoard>(`/games/scores/${encodeURIComponent(game)}`, { method: "GET", auth: true }),
    submitGameScore: (game, score) =>
      request<{ ok: true; best: number; best_at: number; runs: number; is_best: boolean }>("/games/scores", {
        method: "POST",
        body: JSON.stringify({ game, score }),
        auth: true,
      }),
    // `game` is a QUERY param here, not a path segment — the Worker filters the
    // flat array server-side. Omitted entirely when absent so the URL stays
    // `/games/records`, never `/games/records?game=` (which would filter to the
    // empty-string game and always return nothing).
    gameRecords: (game) =>
      request<HeadToHead[]>(
        game ? `/games/records?game=${encodeURIComponent(game)}` : "/games/records",
        { method: "GET", auth: true },
      ),
  };
}
