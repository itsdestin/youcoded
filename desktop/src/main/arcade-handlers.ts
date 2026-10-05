// arcade-handlers.ts
// The games arcade's scores (spec §6.1, §6.6); the arcade:* channels are table entries in main/ipc/game.ts.
// Structurally a sibling of social-handlers.ts: every call needs the account
// bearer token, so all of it lives in the main process — the token never
// crosses the contextBridge into the renderer bundle.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: format a score. Scores cross every
// boundary here as raw numbers. "31 pipes" and "12,480" are the words a
// PARTICULAR GAME uses, and they come from that game's entry in
// game-registry.ts, in the renderer. Keeping it that way means adding a game
// never touches this file, the IPC surface, or the Worker.

import type { MarketplaceAuthStore } from "./marketplace-auth-store";
import { createMarketplaceApiClient, MARKETPLACE_API_HOST } from "../renderer/state/marketplace-api-client";
import type { ApiResult } from "./marketplace-api-handlers";
import type { GameBoard, GameScoreRow, HeadToHead } from "../renderer/state/marketplace-api-client";
// Shared with social-handlers.ts / marketplace-api-handlers.ts so the renderer
// sees ONE ApiResult error contract across every authenticated namespace —
// `.status` has to survive the contextBridge for 401 to stay distinguishable
// from "the network is down".
import { wrap, makeClearSessionOn401 } from "./handler-utils";

/** What the renderer gets back for a board: the board itself, plus `cachedAt`
 *  set ONLY when this is a remembered copy served because the live fetch
 *  failed. The renderer words the staleness — main does not write user copy. */
export interface BoardResult {
  board: GameBoard;
  cachedAt: number | null;
}

/** The four operations, independent of HOW they were called. Both transports
 *  (Electron IPC and the remote-access WebSocket) run the same instance, so a
 *  remote browser shares the stale-board cache instead of keeping its own. */
export interface ArcadeOps {
  status(): Promise<ApiResult<Record<string, GameScoreRow>>>;
  leaderboard(game: string): Promise<ApiResult<BoardResult>>;
  submitScore(game: string, score: number): Promise<ApiResult<{ ok: true; best: number; best_at: number; runs: number; is_best: boolean }>>;
  records(game?: string): Promise<ApiResult<HeadToHead[]>>;
  clearCache(): void;
}

// Module-scope handle so remote-server.ts and the sign-out path in
// marketplace-api-handlers.ts can reach the SAME instance without threading it
// through their constructors — the same pattern social-handlers.ts uses for its
// presence socket. Only the most recent registration is retained.
let ops: ArcadeOps | null = null;

/** Build the operations over one auth store. Exported for tests, which need an
 *  instance without an Electron `ipcMain`. */
export function createArcadeOps(store: MarketplaceAuthStore): ArcadeOps {
  // One client across all four operations. getToken() is read lazily per
  // request, so signing out takes effect on the very next call.
  const client = createMarketplaceApiClient({
    host: MARKETPLACE_API_HOST,
    getToken: () => store.getToken(),
  });
  const clearSessionOn401 = makeClearSessionOn401(store, "arcade");

  /** A board we successfully fetched, kept so an outage degrades to a LABELLED
   *  stale board instead of an empty screen (§6.6). A leaderboard that empties
   *  itself when the network blips teaches the player their scores were lost,
   *  which is both alarming and untrue.
   *
   *  Memory is the right home: at most one entry per solo game, and a board
   *  surviving an app restart would be stale in a way the user could not
   *  explain to themselves ("why does it say I'm 2nd when I just opened it?"). */
  const boardCache = new Map<string, { board: GameBoard; at: number }>();

  return {
    // Every solo game I have played, keyed by game id. Signed out, this returns
    // { ok: false, status: 401 } WITHOUT a network call, and the renderer falls
    // back to the bests saved on this computer — playing offline never costs
    // you your score (§4.2).
    status: () => wrap(() => client.gameScores()).then(clearSessionOn401),

    // One game's friends leaderboard. On failure this falls back to the last
    // copy we held rather than surfacing an error: the leaderboard being down
    // must never look like the GAME being down (§4.2, §6.6).
    async leaderboard(game: string): Promise<ApiResult<BoardResult>> {
      const result = await wrap(() => client.gameBoard(game)).then(clearSessionOn401);
      if (result.ok) {
        boardCache.set(game, { board: result.value, at: Date.now() });
        return { ok: true, value: { board: result.value, cachedAt: null } };
      }
      // 401 is NOT an outage — it means signed out, and there is genuinely no
      // friends board to show. Serving a remembered board to a signed-out user
      // would show them other people's names after they signed out.
      if (result.status === 401) {
        boardCache.delete(game);
        return result;
      }
      const cached = boardCache.get(game);
      if (cached) return { ok: true, value: { board: cached.board, cachedAt: cached.at } };
      return result;
    },

    // Publish a finished run. The renderer has ALREADY saved it locally and
    // moved on by the time this resolves — this call failing is not the
    // player's problem and must never interrupt the end-of-run screen.
    submitScore: (game: string, score: number) =>
      wrap(() => client.submitGameScore(game, score)).then(clearSessionOn401),

    // Head-to-head records, optionally narrowed to one game.
    //
    // DELIBERATELY NOT CACHED, unlike leaderboard() above. The two look alike
    // but fail differently: a leaderboard is on screen DURING play, so an
    // outage that blanks it reads as "my scores are gone" — worth showing a
    // labelled old copy. A records list is only read on a screen the player
    // opened on purpose, where a stale "4-2" is a wrong FACT about a friend and
    // is worse than no number at all. Signed out or offline, the error goes
    // back untouched and the renderer paints nothing.
    //
    // Records outlive an unfriend by design: the Worker returns what actually
    // happened, and the caller shows only opponents still on its friends list.
    records: (game?: string) =>
      wrap(() => client.gameRecords(game)).then(clearSessionOn401),

    clearCache: () => boardCache.clear(),
  };
}

/** Build the arcade's operations over the account's auth store and remember them for the table entries.
 *  WHY (2026-10-01 one-core R3-8): the four arcade:* channels are table entries (main/ipc/game.ts) that reach the one
 *  instance through getArcadeOps(); nothing is registered with Electron here any more, so a hot reload simply replaces
 *  the instance (no removeHandler dance). */
export function initArcadeOps(store: MarketplaceAuthStore): void {
  ops = createArcadeOps(store);
}

/** The live instance, for the arcade table entries (main/ipc/game.ts). `null` before
 *  registration (minimal boots and tests) — callers must handle that rather
 *  than assume, which is why this returns the union instead of throwing. */
export function getArcadeOps(): ArcadeOps | null {
  return ops;
}

/** Drop every remembered board. Called on sign-out so the next person to sign
 *  in on this machine cannot be served the previous one's friends. */
export function clearArcadeCache(): void {
  ops?.clearCache();
}
