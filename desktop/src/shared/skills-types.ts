// skills-types.ts — request/response shapes of the skills:*, marketplace:* and
// theme-marketplace:* channels.
//
// WHY (2026-09-30 one-core R3-3): these answers were typed `any` / `void` in preload, the phone
// shim and the window.claude type (install said Promise<void> while main returned a result
// object), and written a fourth time inside remote-server's cases. The channel table's rows
// (backend-contract.ts ChannelTypes) and window.claude now read this one file; the providers keep
// returning their own shapes and the compiler checks the handlers in main/ipc/ against these.
import type { FeaturedData, PackageInfo } from './types';

/** What installing one skill/plugin reports. (Moved from main/plugin-installer.ts, which re-exports it.) */
export type InstallResult =
  // `commit` is the exact upstream sha the install landed on, present only when
  // the catalog listed one (see pinToCommit). The package record stores it so the
  // Update check can tell "the repo moved" from "the author bumped the version".
  | { status: 'installed'; type?: 'plugin' | 'prompt'; commit?: string }
  | { status: 'already_installed'; via: string; type?: 'plugin' | 'prompt' }
  | { status: 'failed'; error: string; type?: 'plugin' | 'prompt' }
  | { status: 'installing'; type?: 'plugin' | 'prompt' };

/** A removed plugin/prompt, or the refusal for one the app ships with (`bundled`). */
export type SkillUninstallResult = { type: 'plugin' | 'prompt' } | { ok: false; error: 'bundled'; type: 'plugin' };

export interface SkillUpdateResult { ok: boolean; newVersion?: string; error?: string; missingRequiredFields?: string[] }

export interface SkillIntegrationInfo {
  optionalIntegrations: Array<{
    capability: string;
    installed: boolean;
    providerPackageId?: string;
    whenAvailable?: string;
    whenUnavailable?: string;
  }>;
  provides: Array<{ capability: string; description: string; skill: string }>;
}

export type SkillInstallManyResult = Array<{ id: string; status: string; error?: string }>;

export type SkillFeatured = FeaturedData;
export type MarketplacePackages = Record<string, PackageInfo>;

/** `marketplace:read-component`: the file's text, or why it could not be read. */
export type MarketplaceComponentResult =
  | { content: string; source: 'local' | 'remote'; path: string }
  | { error: string };
export type MarketplaceComponentKind = 'skill' | 'command' | 'agent';

/** Theme marketplace answers. */
export type ThemeInstallResult = { status: 'installed' | 'failed'; error?: string };
export type ThemeUninstallResult = { status: 'uninstalled' | 'failed'; error?: string };
export type ThemeUpdateResult = { ok: boolean; newVersion?: string; error?: string };
export type ThemePublishResult = { prUrl: string; prNumber: number };
