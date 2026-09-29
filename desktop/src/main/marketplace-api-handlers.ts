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

/** Shape returned by `marketplace:thumb` — the caller's new vote AND the plugin's
 *  new totals, so the button can move the number without re-fetching /stats. */
type Thumbs = { vote: "up" | "down" | null; thumbs_up: number; thumbs_down: number };

// ── Discriminated union returned by all API-calling handlers ─────────────────
// WHY: Custom Error fields (MarketplaceApiError.status) are dropped by
// structuredClone across the contextBridge. Returning a plain object preserves
// the status code so the renderer can distinguish install-gate (403) from
// generic errors (Task 7+).
export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

// Worker may return avatar_url: null (theoretical — GitHub always sets one);
// the store type uses a plain string, so normalize at this boundary.
// Accounts Phase 1: also carry display_name/handle so the stored profile reflects
// the account-native fields (both optional — pre-Phase-1 /auth/me omits them).
function toStoredUser(me: { id: string; login: string; avatar_url: string | null; display_name?: string; handle?: string | null }) {
  return { id: me.id, login: me.login, avatar_url: me.avatar_url ?? "", display_name: me.display_name, handle: me.handle ?? null };
}

// ── Channel list for double-registration guard ────────────────────────────────
const CHANNELS = [
  "account:start",
  "account:poll",
  "account:signed-in",
  "account:user",
  "account:refresh",
  "account:sign-out",
  "account:update-profile",
  "account:set-handle",
  "account:delete",
  "account:export",
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

  // ── Auth: device-code flow ────────────────────────────────────────────────
  // Renderer calls authStart to receive a user_code + auth_url. Main process
  // opens the URL in the system browser (renderer cannot call shell.openExternal).
  // Renderer then polls authPoll until status === "complete".
  ipcMain.handle("account:start", (): Promise<ApiResult<AuthStartResponse>> =>
    wrap(async () => {
      const out = await client.authStart();
      // Fix: openExternal can fail on some Linux sandboxes (Flatpak, no URL handler).
      // Non-fatal — renderer shows the auth_url so the user can copy-paste it.
      await shell.openExternal(out.auth_url).catch(err =>
        console.warn("[marketplace] openExternal failed; user must open URL manually:", err)
      );
      return out;
    })
  );

  ipcMain.handle("account:poll", (_e, { deviceCode }: { deviceCode: string }): Promise<ApiResult<AuthPollResponse>> =>
    wrap(async () => {
      const res = await client.authPoll(deviceCode);
      if (res.status === "complete") {
        // The Worker now returns the user profile alongside the token — store
        // both together so `user()` works immediately after sign-in. WHY: the
        // games lobby needs user.login as the player tag; storing only the
        // token left the profile null forever (the stuck-"Connecting…" bug).
        if (res.user) {
          store.setSession(res.token, toStoredUser(res.user));
        } else {
          store.setToken(res.token); // older Worker without `user` in the payload
        }
        // Tell the Worker what this machine already has. Until this ran, the
        // server only knew about installs made while signed in — so bundled
        // plugins (auto-installed at launch, never through the marketplace
        // client) and anything installed while signed out were invisible to it,
        // and the install gate refused votes on plugins the user demonstrably
        // has. Deliberately NOT awaited: sign-in must not wait on bookkeeping.
        void reconcileInstalls(store, installedSkillSource);
      }
      return res;
    })
  );

  // Auth state queries — local reads, plus a one-time lazy heal for `user`.
  ipcMain.handle("account:signed-in", () => !!store.getToken());
  ipcMain.handle("account:user", async () => {
    const cached = store.getUser();
    if (cached) return cached;
    // Heal path: a token stored before profile storage existed (pre-2026-07
    // sign-ins) has no user. Fetch it once from /auth/me and persist. On any
    // failure (offline, revoked session) return null — same as signed-out for
    // profile consumers; the token itself stays untouched.
    const token = store.getToken();
    if (!token) return null;
    try {
      const stored = toStoredUser(await client.authMe());
      store.setSession(token, stored);
      return stored;
    } catch (e) {
      // Fix: a 401 here means the stored token is dead server-side — clear the
      // local session so the UI flips to signed-out (same rationale as
      // clearSessionOn401 above). Any other failure (offline, parse) leaves the
      // token untouched and just returns null for this read.
      if (e instanceof MarketplaceApiError && e.status === 401) store.signOut();
      return null;
    }
  });
  // Force-revalidate the cached profile against /auth/me. Unlike account:user
  // (which only heals when the cache is empty), this ALWAYS re-fetches — so a
  // profile change made on another device (a rename, a newly-claimed @handle)
  // reaches this client without a sign-out/in cycle (knowledge-debt #8). Returns
  // the fresh user, or null when signed out / the session was 401-cleared.
  ipcMain.handle("account:refresh", async () => {
    const token = store.getToken();
    if (!token) return null;
    try {
      const stored = toStoredUser(await client.authMe());
      store.setSession(token, stored);
      return stored;
    } catch (e) {
      // A 401 means the stored token is dead server-side — clear the local
      // session so the UI flips to signed-out (same rationale as clearSessionOn401).
      // Any OTHER failure (offline, parse) leaves the token AND cached profile
      // untouched, and returns the cached user: a transient network blip must not
      // blank a signed-in UI (the renderer's focus/interval revalidation retries).
      if (e instanceof MarketplaceApiError && e.status === 401) {
        store.signOut();
        return null;
      }
      return store.getUser();
    }
  });

  // Sign-out now revokes server-side too (spec §1) — best-effort: if the
  // Worker is unreachable, the local clear still wins (never trap the user
  // signed-in). The 90-day expiry + prune cron mop up the orphaned row.
  ipcMain.handle("account:sign-out", async () => {
    try { await client.logout(); } catch { /* offline sign-out is fine */ }
    store.signOut();
    notifySignedOut(); // drop the presence socket so we don't linger online
    clearArcadeCache(); // and forget the cached friends leaderboard
  });

  // Update the account display name, then mirror the new value into the stored
  // profile so `account:user` reflects it without a round-trip to /auth/me.
  ipcMain.handle("account:update-profile", (_e, { displayName }: { displayName: string }): Promise<ApiResult<{ display_name: string }>> =>
    wrap(async () => {
      const out = await client.updateProfile(displayName);
      const user = store.getUser();
      // user-present implies token-present: setSession writes both, signOut clears both atomically
      if (user) store.setSession(store.getToken()!, { ...user, display_name: out.display_name });
      return out;
    }).then(clearSessionOn401)
  );

  // Claim/change the unique @handle, then mirror it into the stored profile.
  ipcMain.handle("account:set-handle", (_e, { handle }: { handle: string }): Promise<ApiResult<{ handle: string }>> =>
    wrap(async () => {
      const out = await client.setHandle(handle);
      const user = store.getUser();
      // user-present implies token-present: setSession writes both, signOut clears both atomically
      if (user) store.setSession(store.getToken()!, { ...user, handle: out.handle });
      return out;
    }).then(clearSessionOn401)
  );

  // Permanent hard-delete (Worker cascades all rows). Clear the local session
  // too — the token is dead server-side, so keeping it would only confuse the UI.
  ipcMain.handle("account:delete", (): Promise<ApiResult<void>> =>
    wrap(async () => {
      await client.deleteAccount();
      store.signOut();
      notifySignedOut(); // drop the presence socket on account deletion too
      clearArcadeCache(); // and forget the cached friends leaderboard
    }).then(clearSessionOn401)
  );

  // Export all account data (GET /auth/export → one big JSON object). Desktop
  // opens a native save dialog and writes the file pretty-printed. NOT wrapped in
  // ApiResult — the renderer discriminates the union without a try/catch: a
  // successful save returns { path }, a canceled dialog returns { canceled: true },
  // and a fetch failure returns { ok:false, status, error } (Android mirrors this
  // shape, writing to the public Downloads collection instead of a save dialog).
  ipcMain.handle("account:export", async (): Promise<
    { path: string } | { canceled: true } | { ok: false; status: number; error: string }
  > => {
    // WHY one try/catch around EVERYTHING: the renderer is promised a
    // discriminated union it can handle without try/catch. If the dialog or the
    // disk write (ENOSPC, EACCES) threw outside the catch, the invoke promise
    // would REJECT instead of returning the union — diverging from Android,
    // which catches its Downloads write. status:0 = local/non-API failure.
    try {
      const data = await client.exportData();
      const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: "Export account data",
        defaultPath: `youcoded-account-export-${stamp}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (canceled || !filePath) return { canceled: true };
      await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
      return { path: filePath };
    } catch (e) {
      if (e instanceof MarketplaceApiError) {
        if (e.status === 401) store.signOut(); // dead session → flip UI signed-out
        return { ok: false, status: e.status, error: e.message };
      }
      return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
    }
  });

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
