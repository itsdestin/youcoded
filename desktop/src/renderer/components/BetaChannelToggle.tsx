// desktop/src/renderer/components/BetaChannelToggle.tsx
//
// The "Get beta builds" switch. Desktop only — Android updates through the Play
// Store or a sideloaded APK, so there is no channel to choose there.
//
// WHY it can start ON without the user having touched it (Destin, 2026-09-13):
// an install that has never been asked inherits the answer its own build
// implies, so someone who deliberately installed 1.3.0-beta.77 keeps being
// offered newer betas. GitHub's /releases/latest hides pre-releases, so without
// that default every beta tester silently stops receiving beta updates. Main
// decides — `effective` is what the next check will use; this only renders it.
//
// WHY it lives in its own file (Destin's deck answer, S-1, 2026-09-13): it is
// shown in TWO places — Settings → Development, and the version pill's update
// popup beside the changelog — and a second copy is how the Development list
// ended up with two versions of itself, only one of which users ever saw.
import React, { useEffect, useState } from 'react';
import { Toggle } from './SettingsPanel';
import { SettingRow } from './ui';

/** Shared state hook, so the two surfaces cannot drift in what they report. */
function useBetaChannel(): [boolean | null, () => void] {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    // WHY the capability check and not just a .catch: on Android, over remote,
    // and on any host predating this channel the method is simply absent, and
    // calling through it throws synchronously rather than rejecting. Both this
    // and the catch below are load-bearing — one covers "no method", the other
    // "method refuses".
    const api = window.claude?.update as
      | { getBetaChannel?: () => Promise<{ effective: boolean }> }
      | undefined;
    if (typeof api?.getBetaChannel !== 'function') return;
    api.getBetaChannel()
      .then((s) => { if (!cancelled) setEnabled(s.effective); })
      // A host that refuses it; leaving the row unrendered is right — an "off"
      // switch would claim a setting that isn't there.
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const flip = () => {
    if (enabled === null) return;
    const next = !enabled;
    setEnabled(next);  // optimistic
    window.claude.update.setBetaChannel(next)
      .then((s) => setEnabled(s.effective))
      .catch(() => setEnabled(!next));  // revert on failure
  };

  return [enabled, flip];
}

// Two lengths, because the 'nav' density TRUNCATES its description to one line:
// the full sentence lost "Full releases always win…" mid-word, which is the half
// that answers "will this strand me on a beta?". The list row gets the short one
// and the update popup — where you are actually deciding whether to take a build,
// and where nothing truncates — gets the whole thing.
const DESCRIPTION =
  'Offers pre-release versions as updates. Full releases always win over a beta of the same version.';
const DESCRIPTION_SHORT = 'Offers pre-release versions as updates';

/**
 * The one row. `separated` adds a rule above it for the update popup, where it
 * follows the changelog rather than a list of other settings; `icon` is passed
 * in Development, where it is one card among four that all carry one.
 *
 * It stays a <SettingRow variant="item"> in both places rather than a compact
 * hand-rolled variant: a label with a switch beside it IS a SettingRow, and
 * the ast-grep rule `no-hand-rolled-setting-row-toggle` (youcoded-dev
 * scripts/ast-grep/rules/) is the guard that keeps it that way.
 */
export function BetaChannelRow(
  { separated, icon, variant = 'item' }:
    { separated?: boolean; icon?: React.ReactNode; variant?: 'nav' | 'item' } = {},
) {
  const [enabled, flip] = useBetaChannel();
  // Don't render until we know the state — avoids a visible OFF → ON flicker,
  // and renders nothing at all where the host has no channel to offer.
  if (enabled === null) return null;
  return (
    <SettingRow
      // Nothing when it sits in a list that already spaces its own rows
      // (Destin, 2026-09-13: "remove the header/copy, leave just the card thing").
      className={separated ? 'mt-4 pt-4 border-t border-edge-dim' : undefined}
      // 'nav' in Development, so it wears the same card as the four rows above
      // it — the icon column there is a fixed 32px and 'item' does not reserve
      // it, which left this one card's icon and text out of line with them.
      variant={variant}
      icon={icon}
      title="Get beta builds"
      description={variant === 'nav' ? DESCRIPTION_SHORT : DESCRIPTION}
      control={<Toggle enabled={enabled} onToggle={flip} label="Get beta builds" />}
    />
  );
}
