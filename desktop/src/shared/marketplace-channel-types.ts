// marketplace-channel-types.ts — the request/response rows of the skills:*, marketplace:*,
// theme-marketplace:* and first-run:* channels (one-core R3-3).
//
// WHY a file of its own (2026-09-30 one-core R3-3): backend-contract.ts's ChannelTypes grows by a
// family per run and passed the 1500-line default; this family's rows live here and ChannelTypes
// extends them, so a channel's row is still found by name through ChannelTypes.
import type { ApiResult } from './account-types';
import type { SkillEntry, SkillDetailView, SkillFilters, ChipConfig, MetadataOverride } from './types';
import type {
  InstallResult, SkillUninstallResult, SkillUpdateResult, SkillIntegrationInfo, SkillInstallManyResult,
  SkillFeatured, MarketplacePackages, MarketplaceComponentResult, MarketplaceComponentKind,
  ThemeInstallResult, ThemeUninstallResult, ThemeUpdateResult, ThemePublishResult,
} from './skills-types';
import type { ThemeMarketplaceFilters, ThemeRegistryEntryWithStatus, PublishState } from './theme-marketplace-types';
import type { FirstRunState, NativeKeyService, SetupDownloadStatus } from './first-run-types';
import type { CuratedModel } from './model-manager-types';

/** `marketplace:thumb` and `:thumb:get`: the caller's vote AND the plugin's new totals. */
export interface MarketplaceThumbs { vote: 'up' | 'down' | null; thumbs_up: number; thumbs_down: number }

export interface MarketplaceChannelTypes {
  // skills:* — browsing, installing and organising skills (one-core R3-3). A phone may use all of these
  // except get-featured and update (refused, as before).
  'skills:list': { request: void; response: SkillEntry[] };
  'skills:list-marketplace': { request: SkillFilters | undefined; response: SkillEntry[] };
  'skills:get-detail': { request: { id: string }; response: SkillDetailView };
  'skills:search': { request: { query: string }; response: SkillEntry[] };
  'skills:install': { request: { id: string }; response: InstallResult };
  'skills:uninstall': { request: { id: string }; response: SkillUninstallResult };
  'skills:get-favorites': { request: void; response: string[] };
  'skills:set-favorite': { request: { id: string; favorited: boolean }; response: void };
  'skills:get-chips': { request: void; response: ChipConfig[] };
  'skills:set-chips': { request: { chips: ChipConfig[] }; response: void };
  'skills:get-override': { request: { id: string }; response: MetadataOverride | null };
  'skills:set-override': { request: { id: string; override: MetadataOverride }; response: void };
  'skills:create-prompt': { request: Omit<SkillEntry, 'id'>; response: SkillEntry };
  'skills:delete-prompt': { request: { id: string }; response: void };
  'skills:publish': { request: { id: string }; response: { prUrl: string } };
  'skills:get-share-link': { request: { id: string }; response: string };
  'skills:import-from-link': { request: { encoded: string }; response: SkillEntry };
  'skills:get-curated-defaults': { request: void; response: string[] };
  'skills:get-featured': { request: void; response: SkillFeatured };
  'skills:get-integration-info': { request: { id: string }; response: SkillIntegrationInfo };
  'skills:install-many': { request: { ids: string[] }; response: SkillInstallManyResult };
  'skills:apply-output-style': { request: { styleId: string }; response: { ok: boolean } };
  'skills:update': { request: { id: string }; response: SkillUpdateResult };
  // marketplace:* — packages, per-entry config, the file viewer and the signed-in write endpoints.
  'marketplace:get-packages': { request: void; response: MarketplacePackages };
  'marketplace:get-config': { request: { id: string }; response: Record<string, unknown> };
  'marketplace:set-config': { request: { id: string; values: Record<string, unknown> }; response: { ok: true } };
  'marketplace:invalidate-cache': { request: void; response: void };
  'marketplace:read-component': { request: { pluginId: string; kind: MarketplaceComponentKind; name: string }; response: MarketplaceComponentResult };
  'marketplace:install': { request: { pluginId: string }; response: ApiResult<void> };
  'marketplace:rate': { request: { plugin_id: string; stars: 1 | 2 | 3 | 4 | 5; review_text?: string }; response: ApiResult<{ hidden: boolean }> };
  'marketplace:rate:delete': { request: { pluginId: string }; response: ApiResult<void> };
  'marketplace:thumb': { request: { plugin_id: string; value: 'up' | 'down' | null }; response: ApiResult<MarketplaceThumbs> };
  'marketplace:thumb:get': { request: { plugin_id: string }; response: ApiResult<MarketplaceThumbs> };
  'marketplace:comment': { request: { plugin_id: string; text: string }; response: ApiResult<{ id: string; hidden: boolean }> };
  'marketplace:theme:like': { request: { themeId: string }; response: ApiResult<{ liked: boolean }> };
  'marketplace:report': { request: { rating_user_id: string; rating_plugin_id: string; reason?: string }; response: ApiResult<void> };
  // theme-marketplace:* — the theme registry (one-core R3-3). A phone is refused all of these.
  'theme-marketplace:list': { request: ThemeMarketplaceFilters | undefined; response: ThemeRegistryEntryWithStatus[] };
  'theme-marketplace:detail': { request: { slug: string }; response: ThemeRegistryEntryWithStatus | null };
  'theme-marketplace:install': { request: { slug: string }; response: ThemeInstallResult };
  'theme-marketplace:uninstall': { request: { slug: string }; response: ThemeUninstallResult };
  'theme-marketplace:update': { request: { slug: string }; response: ThemeUpdateResult };
  'theme-marketplace:publish': { request: { slug: string }; response: ThemePublishResult };
  'theme-marketplace:generate-preview': { request: { slug: string }; response: string | null };
  'theme-marketplace:resolve-publish-state': { request: { slug: string }; response: PublishState };
  'theme-marketplace:refresh-registry': { request: void; response: ThemeRegistryEntryWithStatus[] };
  // first-run:* — the setup wizard and the band above the message box (one-core R3-3). Computer only.
  // first-run:state is ALSO the name of the push that carries state changes; the push stays in main.ts.
  'first-run:state': { request: void; response: FirstRunState | { currentStep: 'COMPLETE' } };
  'first-run:retry': { request: void; response: void };
  'first-run:start-auth': { request: { mode: FirstRunState['authMode'] }; response: void };
  'first-run:submit-api-key': { request: { key: string; service?: NativeKeyService }; response: void };
  'first-run:cancel-auth': { request: void; response: void };
  'first-run:skip': { request: void; response: void };
  'first-run:local-setup': { request: void; response: { suggested: CuratedModel | null } | null };
  'first-run:connect-local-app': { request: { baseUrl: string; name: string }; response: { ok: boolean; message?: string } };
  'first-run:local-download': { request: void; response: SetupDownloadStatus | null };
  'first-run:resume-local-download': { request: void; response: void };
}

type C = MarketplaceChannelTypes;

// window.claude members for these families. Every marketplace call is refused on a phone; a phone
// answers all of firstRun locally.
export interface SkillsBridge {
  list: () => Promise<C['skills:list']['response']>;
  listMarketplace: (filters?: import('./types').SkillFilters) => Promise<C['skills:list-marketplace']['response']>;
  getDetail: (id: string) => Promise<C['skills:get-detail']['response']>;
  search: (query: string) => Promise<C['skills:search']['response']>;
  install: (id: string) => Promise<C['skills:install']['response']>;
  uninstall: (id: string) => Promise<C['skills:uninstall']['response']>;
  getFavorites: () => Promise<string[]>;
  setFavorite: (id: string, favorited: boolean) => Promise<void>;
  getChips: () => Promise<import('./types').ChipConfig[]>;
  setChips: (chips: import('./types').ChipConfig[]) => Promise<void>;
  getOverride: (id: string) => Promise<import('./types').MetadataOverride | null>;
  setOverride: (id: string, override: import('./types').MetadataOverride) => Promise<void>;
  createPrompt: (skill: C['skills:create-prompt']['request']) => Promise<import('./types').SkillEntry>;
  deletePrompt: (id: string) => Promise<void>;
  publish: (id: string) => Promise<{ prUrl: string }>;
  getShareLink: (id: string) => Promise<string>;
  importFromLink: (encoded: string) => Promise<import('./types').SkillEntry>;
  getCuratedDefaults: () => Promise<string[]>;
  getFeatured: () => Promise<C['skills:get-featured']['response']>;
  getIntegrationInfo: (id: string) => Promise<C['skills:get-integration-info']['response']>;
  installMany: (ids: string[]) => Promise<C['skills:install-many']['response']>;
  applyOutputStyle: (styleId: string) => Promise<{ ok: boolean }>;
  update: (id: string) => Promise<C['skills:update']['response']>;
}

export interface MarketplaceBridge {
  getPackages: () => Promise<C['marketplace:get-packages']['response']>;
  getConfig: (id: string) => Promise<C['marketplace:get-config']['response']>;
  setConfig: (id: string, values: Record<string, unknown>) => Promise<C['marketplace:set-config']['response']>;
  invalidateCache: () => Promise<void>;
  readComponent: (args: C['marketplace:read-component']['request']) => Promise<C['marketplace:read-component']['response']>;
}

export interface FirstRunBridge {
  getState: () => Promise<C['first-run:state']['response']>;
  retry: () => Promise<void>;
  startAuth: (mode: FirstRunState['authMode']) => Promise<void>;
  submitApiKey: (key: string, service?: string) => Promise<void>;
  cancelAuth: () => Promise<void>;
  skip: () => Promise<void>;
  localSetup: () => Promise<C['first-run:local-setup']['response']>;
  connectLocalApp: (baseUrl: string, name: string) => Promise<C['first-run:connect-local-app']['response']>;
  localDownload: () => Promise<C['first-run:local-download']['response']>;
  resumeLocalDownload: () => Promise<void>;
  onStateChanged: (cb: (state: any) => void) => any;
}

