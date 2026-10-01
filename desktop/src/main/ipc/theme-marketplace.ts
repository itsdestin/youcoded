// theme-marketplace.ts — the theme registry (browse, install, publish), for the computer's windows.
//
// WHY (2026-09-30 one-core R3-3): registered in ipc-handlers.ts; a phone had no case for any of
// them and was told "not available over remote access". Kept exactly: every entry is
// `remoteAllowed:false` (installing or publishing a theme changes this computer).
// WHY list and detail are open now (2026-10-01 one-core R6-1; Destin, 2026-09-30: "a phone may browse the theme
// marketplace. Yes."): they only READ the public theme registry. Everything that installs, removes, updates,
// publishes or draws a share picture for a theme stays refused to a phone; he approved browsing, not those.
import fs from 'fs';
import { IPC } from '../../shared/backend-contract';
import type { ThemeMarketplaceProvider } from '../theme-marketplace-provider';
import { userThemeDir, userThemeManifest, THEMES_DIR } from '../theme-watcher';
import { generateThemePreview } from '../theme-preview-generator';
import path from 'path';
import { defineChannel, type MainChannelDef } from './channel-def';

let provider: ThemeMarketplaceProvider | null = null;

/** Called once by registerIpcHandlers with the provider it builds (it shares the skills config store). */
export function bindThemeMarketplace(next: ThemeMarketplaceProvider): void { provider = next; }

function themes(): ThemeMarketplaceProvider {
  if (!provider) throw new Error('The theme marketplace is not ready yet.');
  return provider;
}

export const themeMarketplaceChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.THEME_MARKETPLACE_LIST, kind: 'handle', handler: (filters) => themes().listThemes(filters) }),
  defineChannel({ name: IPC.THEME_MARKETPLACE_DETAIL, kind: 'handle', handler: ({ slug }) => themes().getThemeDetail(slug) }),
  defineChannel({ name: IPC.THEME_MARKETPLACE_INSTALL, kind: 'handle', remoteAllowed: false, handler: ({ slug }) => themes().installTheme(slug) }),
  defineChannel({ name: IPC.THEME_MARKETPLACE_UNINSTALL, kind: 'handle', remoteAllowed: false, handler: ({ slug }) => themes().uninstallTheme(slug) }),
  // Re-install a theme at the same slug, overwriting its files.
  defineChannel({ name: IPC.THEME_MARKETPLACE_UPDATE, kind: 'handle', remoteAllowed: false, handler: ({ slug }) => themes().updateTheme(slug) }),
  defineChannel({ name: IPC.THEME_MARKETPLACE_PUBLISH, kind: 'handle', remoteAllowed: false, handler: ({ slug }) => themes().publishTheme(slug) }),
  // Publish-lifecycle: button state (draft / in-review / published-current / published-drift / unknown)
  // for a user-authored theme, resolved on each detail open.
  defineChannel({ name: IPC.THEME_MARKETPLACE_RESOLVE_PUBLISH_STATE, kind: 'handle', remoteAllowed: false, handler: ({ slug }) => themes().resolvePublishStateForSlug(slug) }),
  // Manual refresh: drop the in-memory registry cache and return a fresh listing in one round-trip.
  defineChannel({
    name: IPC.THEME_MARKETPLACE_REFRESH_REGISTRY, kind: 'handle', remoteAllowed: false,
    handler: () => { themes().invalidateRegistryCache(); return themes().listThemes(); },
  }),
  defineChannel({
    name: IPC.THEME_MARKETPLACE_GENERATE_PREVIEW, kind: 'handle', remoteAllowed: false,
    handler: async ({ slug }) => {
      try {
        const manifestPath = path.resolve(userThemeManifest(slug));
        if (!manifestPath.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
        const previewPath = await generateThemePreview(userThemeDir(slug), manifest);
        // Verify the file really landed on disk — if the generator returned a path but writeFile
        // silently failed, the share sheet would render a broken-image icon. Better to return null
        // and fall back to the swatch.
        const stat = await fs.promises.stat(previewPath).catch(() => null);
        if (!stat || stat.size < 150) {
          console.warn(`[IPC] Preview file missing/tiny after generation: slug=${slug} path=${previewPath} size=${stat?.size ?? 'missing'}`);
          return null;
        }
        return previewPath;
      } catch (err: any) {
        console.warn(`[IPC] Failed to generate theme preview: slug=${slug} err=${err?.message ?? err}`);
        return null;
      }
    },
  }),
];
