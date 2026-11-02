import { BUNDLED_PLUGIN_PINS, type BundledPluginPin } from '../shared/bundled-plugin-pins';
import { isNewerVersion } from '../shared/version-compare';

// WHY (2026-10 security audit, item 24): built-in plugins are installed from the exact
// commit this app release was built with (shared/bundled-plugin-pins.ts), never from
// "whatever is newest on GitHub". This file holds the pure decisions; plugin-installer.ts
// does the git work.

/** File written inside an installed built-in plugin recording which pinned commit it came from. */
export const PIN_MARKER_FILE = '.youcoded-pinned-commit';

export function getBundledPin(id: string): BundledPluginPin | undefined {
  return Object.prototype.hasOwnProperty.call(BUNDLED_PLUGIN_PINS, id) ? BUNDLED_PLUGIN_PINS[id] : undefined;
}

export type BundledSyncPlan = 'upgrade' | 'keep-newer' | 'unchanged';

/**
 * What to do with an ALREADY-INSTALLED built-in plugin at launch.
 *  - installed version older than the pin       -> upgrade to the pinned commit
 *  - installed version NEWER than the pin       -> keep it. The user got it from an earlier
 *    app build that was not pinned (or a later one); downgrading would be a surprise and
 *    reinstalling every launch would loop. It is replaced once an app release pins a newer one.
 *  - same version, but not known to be the pinned commit (no marker: every install made before
 *    pinning existed, or a different commit) -> reinstall ONCE from the pin; the marker then
 *    makes later launches a no-op.
 *  - same version and marker matches            -> nothing to do.
 * Versions that are not plain numbers compare as "different = newer" in isNewerVersion, so
 * the pin wins; after the swap the versions are equal, so there is no repeat.
 */
export function planBundledSync(args: {
  installedVersion: string | null;
  installedMarker: string | null;
  pin: Pick<BundledPluginPin, 'commit'>;
  pinnedVersion: string | null;
}): BundledSyncPlan {
  const { installedVersion, installedMarker, pin, pinnedVersion } = args;
  if (isNewerVersion(installedVersion ?? undefined, pinnedVersion ?? undefined)) return 'upgrade';
  if (installedVersion && pinnedVersion && installedVersion !== pinnedVersion) return 'keep-newer';
  return installedMarker === pin.commit ? 'unchanged' : 'upgrade';
}
