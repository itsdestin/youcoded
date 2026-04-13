// marketplace-api-handlers.ts
// IPC handler registration for marketplace auth flow and write endpoints.
// All operations requiring the bearer token live here in the main process —
// tokens never cross the contextBridge into the renderer bundle.

import { ipcMain, shell } from "electron";
import type { MarketplaceAuthStore } from "./marketplace-auth-store";
import { createMarketplaceApiClient, MarketplaceApiError, MARKETPLACE_API_HOST } from "../renderer/state/marketplace-api-client";
import type { PostRatingInput, AuthStartResponse, AuthPollResponse } from "../renderer/state/marketplace-api-client";

// ── Discriminated union returned by all API-calling handlers ─────────────────
// WHY: Custom Error fields (MarketplaceApiError.status) are dropped by
// structuredClone across the contextBridge. Returning a plain object preserves
// the status code so the renderer can distinguish install-gate (403) from
// generic errors (Task 7+).
export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

async function wrap<T>(run: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    if (e instanceof MarketplaceApiError) return { ok: false, status: e.status, message: e.message };
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, message }; // status:0 = non-API error (network, parse, etc.)
  }
}

// ── Channel list for double-registration guard ────────────────────────────────
const CHANNELS = [
  "marketplace:auth:start",
  "marketplace:auth:poll",
  "marketplace:auth:signed-in",
  "marketplace:auth:user",
  "marketplace:auth:sign-out",
  "marketplace:install",
  "marketplace:rate",
  "marketplace:rate:delete",
  "marketplace:theme:like",
  "marketplace:report",
] as const;

export function registerMarketplaceApiHandlers(store: MarketplaceAuthStore): void {
  // WHY: ipcMain.handle throws on re-registration. Clear prior handlers so
  // hot-reload dev sessions (scripts/run-dev.sh) don't crash on reload.
  for (const ch of CHANNELS) ipcMain.removeHandler(ch);

  // Create one client instance shared across all handlers.
  // getToken() is called lazily per-request so sign-out takes effect immediately.
  const client = createMarketplaceApiClient({
    host: MARKETPLACE_API_HOST,
    getToken: () => store.getToken(),
  });

  // ── Auth: device-code flow ────────────────────────────────────────────────
  // Renderer calls authStart to receive a user_code + auth_url. Main process
  // opens the URL in the system browser (renderer cannot call shell.openExternal).
  // Renderer then polls authPoll until status === "complete".
  ipcMain.handle("marketplace:auth:start", (): Promise<ApiResult<AuthStartResponse>> =>
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

  ipcMain.handle("marketplace:auth:poll", (_e, deviceCode: string): Promise<ApiResult<AuthPollResponse>> =>
    wrap(async () => {
      const res = await client.authPoll(deviceCode);
      if (res.status === "complete") {
        store.setToken(res.token);
        // TODO(Task 5): fetch /user from GitHub once that endpoint is available,
        // or decode user info from the JWT. For now only the token is stored;
        // user profile is populated lazily when the signed-in check fires.
      }
      return res;
    })
  );

  // Auth state queries — pure local reads, no API call, return plain values.
  ipcMain.handle("marketplace:auth:signed-in", () => !!store.getToken());
  ipcMain.handle("marketplace:auth:user", () => store.getUser());
  ipcMain.handle("marketplace:auth:sign-out", () => store.signOut());

  // ── Write endpoints ───────────────────────────────────────────────────────
  // Wrapped in ApiResult so the renderer preserves HTTP status across the
  // contextBridge (structuredClone drops custom Error fields).

  ipcMain.handle("marketplace:install", (_e, pluginId: string): Promise<ApiResult<void>> =>
    wrap(() => client.postInstall(pluginId))
  );

  ipcMain.handle("marketplace:rate", (_e, input: PostRatingInput): Promise<ApiResult<{ hidden: boolean }>> =>
    wrap(() => client.postRating(input))
  );

  ipcMain.handle("marketplace:rate:delete", (_e, pluginId: string): Promise<ApiResult<void>> =>
    wrap(() => client.deleteRating(pluginId))
  );

  ipcMain.handle("marketplace:theme:like", (_e, themeId: string): Promise<ApiResult<{ liked: boolean }>> =>
    wrap(() => client.toggleThemeLike(themeId))
  );

  ipcMain.handle("marketplace:report", (
    _e,
    input: { rating_user_id: string; rating_plugin_id: string; reason?: string },
  ): Promise<ApiResult<void>> =>
    wrap(() => client.postReport(input))
  );
}
