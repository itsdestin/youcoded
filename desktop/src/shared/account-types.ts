// account-types.ts — request/response shapes of the YouCoded account channels (account:*).
//
// WHY (2026-09-30 one-core R3-2): the same shapes were typed inline in the window.claude
// type and again inside main/marketplace-api-handlers.ts. The channel table's rows and the
// window.claude members now read this file. The two API shapes are type-only imports from the
// renderer's API client (the same precedent backend-contract.ts already follows for the social
// cards): erased at build, nothing crosses the process boundary at runtime.
import type { AuthStartResponse, AuthPollResponse } from '../renderer/state/marketplace-api-client';
import type { MarketplaceUser } from '../main/marketplace-auth-store';

export type { AuthStartResponse, AuthPollResponse, MarketplaceUser };

/** A call that can fail with a status the caller words for the person (kept plain so it survives structuredClone). */
export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

/** Export all account data: { path } on save, { canceled: true } on cancel, { ok:false } on error. Not an ApiResult. */
export type AccountExportResult = { path: string } | { canceled: true } | { ok: false; status: number; error: string };
