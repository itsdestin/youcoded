// marketplace-api-handlers.ts
// IPC handler registration for marketplace auth flow and write endpoints.
// All operations requiring the bearer token live here in the main process —
// tokens never cross the contextBridge into the renderer bundle.

import { ipcMain, shell, dialog } from "electron";
import fs from "fs";
import type { MarketplaceAuthStore } from "./marketplace-auth-store";
import { createMarketplaceApiClient, MarketplaceApiError, MARKETPLACE_API_HOST } from "../renderer/state/marketplace-api-client";
import type { PostRatingInput, AuthStartResponse, AuthPollResponse } from "../renderer/state/marketplace-api-client";
// wrap + the 401-clear closure are shared with social-handlers.ts via
// handler-utils.ts so the error contract can't drift between the two modules.
import { wrap, makeClearSessionOn401 } from "./handler-utils";
// Signing out / deleting the account must also drop the main-owned presence
// WebSocket (Task 6) — otherwise it lingers connected after the token is
// cleared until its next server interaction. Type-only import of ApiResult
// keeps social-handlers → this module a pure type edge; the value edge here is
// one-way (this → social-handlers) so there's no runtime import cycle.
import { notifySignedOut } from "./social-handlers";
// Sign-out must also forget any remembered games leaderboard, or the next
// person to sign in on this machine could be served the previous one's friends.
import { clearArcadeCache } from "./arcade-handlers";
import { reconcileInstalls, type InstalledSkillSource } from "./install-reconcile";
import { bindAccountDeps } from "./ipc/account";

/** Shape returned by `marketplace:thumb` — the caller's new vote AND the plugin's
 *  new totals, so the button can move the number without re-fetching /stats. */
type Thumbs = { vote: "up" | "down" | null; thumbs_up: number; thumbs_down: number };

// ── Discriminated union returned by all API-calling handlers ─────────────────
// WHY: Custom Error fields (MarketplaceApiError.status) are dropped by
// structuredClone across the contextBridge. Returning a plain object preserves
// the status code so the renderer can distinguish install-gate (403) from
// generic errors (Task 7+).
export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

// ── Channel list for double-registration guard ────────────────────────────────
const CHANNELS = [
  "marketplace:install",
  "marketplace:rate",
  "marketplace:rate:delete",
  "marketplace:thumb",
  "marketplace:thumb:get",
  "marketplace:comment",
  "marketplace:theme:like",
  "marketplace:report",
] as const;

// WHY (2026-09-29 one-core R2): every request from a window is now ONE object ({ sessionId, text }, not (sessionId, text)) — the same object the phone sends, so one handler can serve both doors and two same-typed arguments can no longer be swapped unnoticed. tests/wire-shape-parity.test.ts checks these keys against preload's.
export function registerMarketplaceApiHandlers(
  store: MarketplaceAuthStore,
  // Optional so existing callers/tests keep working; without it the sign-in
  // reconcile reports plugin directories only and skill-level pages stay gated.
  installedSkillSource: InstalledSkillSource | null = null,
): void {
  // WHY: ipcMain.handle throws on re-registration. Clear prior handlers so
  // hot-reload dev sessions (scripts/run-dev.sh) don't crash on reload.
  for (const ch of CHANNELS) ipcMain.removeHandler(ch);

  // Create one client instance shared across all handlers.
  // getToken() is called lazily per-request so sign-out takes effect immediately.
  const client = createMarketplaceApiClient({
    host: MARKETPLACE_API_HOST,
    getToken: () => store.getToken(),
  });

  // Shared 401-reaction (see handler-utils.ts for the full WHY): a dead session
  // server-side clears the local token so the UI flips to signed-out.
  const clearSessionOn401 = makeClearSessionOn401(store, "marketplace");

  // WHY (2026-09-30 one-core R3-2): the ten account:* handlers (sign-in, profile, export) moved
  // to the channel table (main/ipc/account.ts) so a phone and the computer share one body. They
  // need this function's store, client and skill source, so they are handed over here.
  bindAccountDeps({ store, client, installedSkillSource });

  // ── Write endpoints ───────────────────────────────────────────────────────
  // Wrapped in ApiResult so the renderer preserves HTTP status across the
  // contextBridge (structuredClone drops custom Error fields).

  ipcMain.handle("marketplace:install", (_e, { pluginId }: { pluginId: string }): Promise<ApiResult<void>> =>
    wrap(async () => {
      await client.postInstall(pluginId);
      // Marketplace overhaul Task 18: report what the machine ACTUALLY has now,
      // not just the id the user clicked. One install can land several votable
      // pages — a plugin's skills each get their own page, and clicking a bundle
      // member installs the whole bundle — and the Worker refuses a vote on any
      // id it has no install row for. Without this, those pages stayed
      // un-votable until the next launch re-ran the reconcile. Deliberately not
      // awaited: this is bookkeeping, and the install already succeeded.
      void reconcileInstalls(store, installedSkillSource);
    })
  );

  ipcMain.handle("marketplace:rate", (_e, input: PostRatingInput): Promise<ApiResult<{ hidden: boolean }>> =>
    wrap(() => client.postRating(input))
  );

  ipcMain.handle("marketplace:rate:delete", (_e, { pluginId }: { pluginId: string }): Promise<ApiResult<void>> =>
    wrap(() => client.deleteRating(pluginId))
  );

  // Marketplace overhaul (spec §1.7): one-tap vote and comment. Both go through
  // main because the sign-in token lives here — the renderer's own API client is
  // built with `getToken: () => null` and can never authenticate.
  ipcMain.handle("marketplace:thumb", (_e, input: { plugin_id: string; value: "up" | "down" | null }): Promise<ApiResult<Thumbs>> =>
    wrap(async () => {
      const r = await client.setThumb(input);
      // Pass the totals through: the renderer moves the number from THIS
      // response rather than re-fetching /stats, which is served max-age=300
      // and so could not show the new count for five minutes.
      return { vote: r.vote, thumbs_up: r.thumbs_up, thumbs_down: r.thumbs_down };
    })
  );

  ipcMain.handle("marketplace:thumb:get", (_e, { plugin_id: pluginId }: { plugin_id: string }): Promise<ApiResult<Thumbs>> =>
    wrap(async () => {
      const r = await client.getThumb(pluginId);
      // Totals come back WITH the vote. Returning only `vote` is what produced a
      // lit thumb beside "No votes yet" on reopen: the vote was fresh from the
      // server while the count fell back to the /stats snapshot taken at app
      // start, which predates the vote (and /stats is max-age=300, so it cannot
      // be refreshed into agreeing).
      return { vote: r.vote, thumbs_up: r.thumbs_up, thumbs_down: r.thumbs_down };
    })
  );

  ipcMain.handle("marketplace:comment", (_e, input: { plugin_id: string; text: string }): Promise<ApiResult<{ id: string; hidden: boolean }>> =>
    wrap(async () => {
      const r = await client.postComment(input);
      return { id: r.id, hidden: r.hidden };
    })
  );

  ipcMain.handle("marketplace:theme:like", (_e, { themeId }: { themeId: string }): Promise<ApiResult<{ liked: boolean }>> =>
    wrap(() => client.toggleThemeLike(themeId))
  );

  ipcMain.handle("marketplace:report", (
    _e,
    input: { rating_user_id: string; rating_plugin_id: string; reason?: string },
  ): Promise<ApiResult<void>> =>
    wrap(() => client.postReport(input))
  );
}
