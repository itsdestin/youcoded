import type { CatalogModel, ProviderType } from '../../shared/provider-types';
import type { ContextPreferences } from '../../shared/context-preferences';

// WHY approximate tiers: 250k retains Codex's 272k operating default. The 1M
// choice admits advertised windows up to 1.2M (the approved explanation), not
// unlimited growth into a multi-million-token model. Reply reserve and compaction
// margins remain owned by contextBudget(), not subtracted again here.
const STANDARD_CEILING = 272_000;
const LONG_CEILING = 1_200_000;

function windowSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Resolve an operating budget without changing the catalog's capability data.
 *  Unknown metadata stays unknown; model names and local-engine caps are not
 *  part of this policy. The provider TYPE matters, never its user-defined id. */
export function cloudContextLength(type: ProviderType | undefined, model: CatalogModel | undefined, preferences: ContextPreferences): number | null {
  const ordinary = windowSize(model?.contextLength);
  if (type !== 'chatgpt' && type !== 'openrouter') return ordinary;

  const isLong = preferences[type] === 'long';
  const maximum = type === 'chatgpt' ? windowSize(model?.maxContextLength) : ordinary;
  // Standard mode also respects a maximum smaller than the advertised default.
  // Older cached ChatGPT rows lack the maximum; never guess that they support 1M.
  const supported = isLong
    ? maximum ?? ordinary
    : ordinary === null ? maximum : maximum === null ? ordinary : Math.min(ordinary, maximum);
  return supported === null ? null : Math.min(supported, isLong ? LONG_CEILING : STANDARD_CEILING);
}
