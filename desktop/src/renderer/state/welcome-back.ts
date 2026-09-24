// Welcome back (design: docs/active/design/2026-09-24-welcome-back/ in the
// workspace). On a cold start, the conversations that were open in the strip
// when YouCoded last closed are offered back on one screen.
//
// The list itself lives in the main process, per install, never synced
// (S-device: "each computer only offers back its own sessions"). These helpers
// are the renderer's side of it plus the pure pieces a batch resume needs.
import type { ModelBinding } from '../../shared/provider-types';
import type { PortableModelRef } from '../../shared/types';
import { claudeAliasForModelId } from '../../shared/model-ids';

// main/preload/remote-shim all carry the two channels now (design §3), so
// window.claude.session is fully typed — no `as any` needed.
const sessionApi = () => window.claude?.session;

/** Ids that were open at the last shutdown. Empty when there is nothing to
 *  offer, or on a build/platform with no such list (Android, today). */
export async function fetchReopenList(): Promise<string[]> {
  try {
    const ids = await sessionApi()?.reopenList?.();
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch {
    // A failed read only means no Welcome back screen this launch; the
    // sessions are all still in Resume Session.
    return [];
  }
}

/** Forget these ids so the screen does not come back for them next launch. */
export async function forgetReopenList(ids: readonly string[]): Promise<void> {
  try { await sessionApi()?.forgetReopen?.([...ids]); } catch { /* next launch re-offers them; harmless */ }
}

interface ProviderLike { id: string; type: string }
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
  const match = catalog.find((m) => {
    const p = providers.find((row) => row.id === m.providerId);
    return !!p && p.type === ref.providerType && m.id === ref.modelId;
  });
  return match ? { providerId: match.providerId, modelId: match.id } : null;
}

/** The Claude model a batch resume launches a Claude Code row on: the one it
 *  last ran on when that maps to an alias, else the app default — the rule the
 *  Resume browser's own form applies (ResumeOptions.tsx modelForRow). */
export function claudeModelFor(ref: PortableModelRef | undefined, fallback: string | undefined): string {
  return (ref ? claudeAliasForModelId(ref.modelId) : null) || fallback || 'sonnet';
}
