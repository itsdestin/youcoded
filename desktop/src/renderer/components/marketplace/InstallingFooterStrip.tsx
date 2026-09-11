// Docked footer strip that lists in-flight skill/theme installs, uninstalls and
// updates. Visible iff something is in flight or recently failed. Uses theme tokens
// (.layer-surface + accent) so no hardcoded colors. Respects safe-area-inset-bottom
// for Android.
import { useMarketplace, installTrackingKey, type InstallOp } from '../../state/marketplace-context';
import { plainMessage } from '../../utils/ipc-error';

// WHY a word per operation (error inventory 2026-09-10, false message 14): this strip
// printed "Installing" and "Failed to install {label}" for every entry, so a failed
// UNINSTALL or UPDATE was announced as a failed install of something the user was
// removing or already had.
const IN_FLIGHT: Record<InstallOp, string> = { install: 'Installing', uninstall: 'Uninstalling', update: 'Updating' };
const FAILED: Record<InstallOp, string> = { install: "Couldn't install", uninstall: "Couldn't uninstall", update: "Couldn't update" };

function labelForKey(
  key: string,
  skillEntries: { id: string; displayName?: string }[],
  themeEntries: { slug: string; name?: string }[],
): string {
  // Built with the same helper the writer uses, so the prefix this splits on
  // can never drift out from under it.
  const skillPrefix = installTrackingKey('skill', '');
  const themePrefix = installTrackingKey('theme', '');
  if (key.startsWith(skillPrefix)) {
    const id = key.slice(skillPrefix.length);
    return skillEntries.find(s => s.id === id)?.displayName ?? id;
  }
  if (key.startsWith(themePrefix)) {
    const slug = key.slice(themePrefix.length);
    return themeEntries.find(t => t.slug === slug)?.name ?? slug;
  }
  return key;
}

export default function InstallingFooterStrip() {
  const mp = useMarketplace();
  const keys = Array.from(mp.installingIds);
  const errorKeys = Array.from(mp.installError.keys()).filter(k => !mp.installingIds.has(k));
  if (keys.length === 0 && errorKeys.length === 0) return null;

  const inflight = keys
    .map(k => `${IN_FLIGHT[mp.installOps.get(k) ?? 'install']} ${labelForKey(k, mp.skillEntries, mp.themeEntries)}`)
    .join(', ');

  return (
    <div
      className="layer-surface fixed left-0 right-0 bottom-0 border-t border-edge-dim px-4 py-2 flex flex-col gap-1 text-sm"
      style={{ zIndex: 60, paddingBottom: 'max(env(safe-area-inset-bottom), 0.5rem)' }}
      role="status"
      aria-live="polite"
    >
      {keys.length > 0 && (
        <div className="flex items-center gap-2 text-fg-2">
          <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span>{inflight}</span>
        </div>
      )}
      {errorKeys.map(k => {
        const err = mp.installError.get(k)!;
        const label = labelForKey(k, mp.skillEntries, mp.themeEntries);
        return (
          <div key={k} className="text-xs text-red-500 border border-red-500/40 bg-red-500/10 rounded px-2 py-1">
            {FAILED[err.op]} {label}: {plainMessage(err.message, 'no reason was given')}
          </div>
        );
      })}
    </div>
  );
}
