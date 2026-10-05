// marketplace-api-handlers.ts
// Builds the marketplace API client (the sign-in token lives here in the main process — it never
// crosses the contextBridge into the renderer bundle) and hands it to the channel table.
//
// WHY (2026-09-30 one-core R3-3): the eight marketplace write handlers that lived here (install
// report, rate, rate:delete, thumb, thumb:get, comment, theme:like, report) are table entries now
// (main/ipc/marketplace.ts), like the account handlers before them (main/ipc/account.ts). What
// stays is the one job the table cannot do: constructing the client from THIS store.

import type { MarketplaceAuthStore } from "./marketplace-auth-store";
import { createMarketplaceApiClient, MARKETPLACE_API_HOST } from "../renderer/state/marketplace-api-client";
import type { InstalledSkillSource } from "./install-reconcile";
import { bindAccountDeps } from "./ipc/account";

// ── Discriminated union returned by all API-calling handlers ─────────────────
// WHY: Custom Error fields (MarketplaceApiError.status) are dropped by
// structuredClone across the contextBridge. Returning a plain object preserves
// the status code so the renderer can distinguish install-gate (403) from
// generic errors (Task 7+).
export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

// WHY (2026-09-29 one-core R2): every request from a window is now ONE object ({ sessionId, text }, not (sessionId, text)) — the same object the phone sends, so one handler can serve both doors and two same-typed arguments can no longer be swapped unnoticed. tests/wire-shape-parity.test.ts checks these keys against preload's.
export function registerMarketplaceApiHandlers(
  store: MarketplaceAuthStore,
  // Optional so existing callers/tests keep working; without it the sign-in
  // reconcile reports plugin directories only and skill-level pages stay gated.
  installedSkillSource: InstalledSkillSource | null = null,
): void {
  // One client instance shared across all handlers. getToken() is called lazily per-request so
  // sign-out takes effect immediately.
  const client = createMarketplaceApiClient({
    host: MARKETPLACE_API_HOST,
    getToken: () => store.getToken(),
  });

  // The account and marketplace channels (main/ipc/account.ts, main/ipc/marketplace.ts) reach the
  // store, client and skill source through this bind; they are registered with the rest of the table.
  bindAccountDeps({ store, client, installedSkillSource });
}
