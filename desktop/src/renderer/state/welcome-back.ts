// Welcome back (design: docs/active/design/2026-09-24-welcome-back/ in the
// workspace). On a cold start, the conversations that were open in the strip
// when YouCoded last closed are offered back on one screen.
//
// The list itself lives in the main process, per install, never synced
// (S-device: "each computer only offers back its own sessions"). These helpers
// are the renderer's side of it plus the pure pieces a batch resume needs.
import type { ModelBinding } from '../../shared/provider-types';
import type { PortableModelRef, ReopenEntry } from '../../shared/types';

// main/preload/remote-shim all carry the two channels now (design §3), so
// window.claude.session is fully typed — no `as any` needed.
const sessionApi = () => window.claude?.session;

/** Conversations that were open at the last shutdown, each with whether it ran
 *  with Skip permissions on. Empty when there is nothing to offer, or on a
 *  build/platform with no such list (Android, today). */
export async function fetchReopenList(): Promise<ReopenEntry[]> {
  try {
    const rows: unknown = await sessionApi()?.reopenList?.();
    if (!Array.isArray(rows)) return [];
    // WHY a bare string is still accepted: it is the list's older shape (ids
    // only), read as Skip permissions off — the safe reading.
    return rows.flatMap((r): ReopenEntry[] => {
      if (typeof r === 'string') return [{ id: r, skipPermissions: false }];
      if (r && typeof r === 'object' && typeof (r as ReopenEntry).id === 'string') {
        return [{ id: (r as ReopenEntry).id, skipPermissions: (r as ReopenEntry).skipPermissions === true }];
      }
      return [];
    });
  } catch {
    // A failed read only means no Welcome back screen this launch; the
    // sessions are all still in Resume session.
    return [];
  }
}

/** Forget these ids so the screen does not come back for them next launch. */
export async function forgetReopenList(ids: readonly string[]): Promise<void> {
  try { await sessionApi()?.forgetReopen?.([...ids]); } catch { /* next launch re-offers them; harmless */ }
}

interface ProviderLike { id: string; type: string; label?: string; enabled?: boolean; ready?: boolean }
interface CatalogLike { id: string; providerId: string }

/** The model a native conversation last ran on, as a binding on THIS device —
 *  the same match ModelPicker's prefill makes (provider type + model id).
 *  Null when that model is not set up here; the caller then leaves the row for
 *  a manual Resume, which asks (Q-model: reuse, and fall back to asking). */
export function resolveNativeBinding(
  ref: PortableModelRef | undefined,
  providers: readonly ProviderLike[],
  catalog: readonly CatalogLike[],
): ModelBinding | null {
  if (!ref) return null;
  if (ref.providerType === 'openai-compatible') {
    // WHY: a custom model may have been typed (no catalog row to match). Reuse only an unambiguous saved endpoint name;
    // choosing a different endpoint (or one of two identically named endpoints) could send private history to the wrong server.
    const matches = providers.filter(p => p.type === ref.providerType && p.label === ref.providerLabel);
    const p = matches.length === 1 ? matches[0] : undefined;
    return p?.enabled === true && p.ready === true ? { providerId: p.id, modelId: ref.modelId } : null;
  }
  const match = catalog.find((m) => {
    const p = providers.find((row) => row.id === m.providerId);
    return !!p && p.type === ref.providerType && m.id === ref.modelId;
  });
  return match ? { providerId: match.providerId, modelId: match.id } : null;
}
