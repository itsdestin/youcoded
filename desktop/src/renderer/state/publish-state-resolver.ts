// publish-state-resolver.ts
// Pure function: converts registry entry + PR signals + local hash → PublishState.
// This is the single authoritative place for "what state is this theme in?" logic.
// All UI consumers should read from this function rather than implementing their own checks.

import type { ThemeRegistryEntry, PublishState } from '../../shared/theme-marketplace-types';

export interface PRRef { number: number; url: string }

export interface ResolverInputs {
  registryEntry: ThemeRegistryEntry | null;
  openPR: PRRef | null;
  recentlyMergedPR: PRRef | null;
  localHash: string;
  /** When set, all other inputs are ignored and we return `unknown`. */
  degradedReason?: string;
}

const MARKETPLACE_BASE = 'https://github.com/itsdestin/destinclaude-themes/tree/main/themes';

export function resolvePublishState(inputs: ResolverInputs): PublishState {
  // Degraded mode: gh CLI unavailable or unauthenticated — we can't trust PR state.
  if (inputs.degradedReason) {
    return { kind: 'unknown', reason: inputs.degradedReason };
  }

  // An in-flight or just-merged PR always wins — it's the most recent intent.
  // recentlyMergedPR bridges the post-merge / pre-CI window where the registry
  // hasn't been updated yet but the PR is closed.
  const pendingPR = inputs.openPR ?? inputs.recentlyMergedPR;
  if (pendingPR) {
    return { kind: 'in-review', prNumber: pendingPR.number, prUrl: pendingPR.url };
  }

  if (inputs.registryEntry) {
    const marketplaceUrl = `${MARKETPLACE_BASE}/${inputs.registryEntry.slug}`;
    // Legacy registry entries with no contentHash are treated as matching —
    // never surface a drift state caused by missing data rather than real changes.
    const matches =
      !inputs.registryEntry.contentHash ||
      inputs.registryEntry.contentHash === inputs.localHash;
    return matches
      ? { kind: 'published-current', marketplaceUrl }
      : { kind: 'published-drift', marketplaceUrl };
  }

  // No registry hit, no PR — theme exists only locally.
  return { kind: 'draft' };
}
