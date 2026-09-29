// marketplace.ts — the marketplace's packages, per-entry config, file viewer and its signed-in
// write endpoints (install report, ratings, votes, comments, reports), one body for both doors.
//
// WHY (2026-09-30 one-core R3-3): the first five were hand-written in ipc-handlers.ts and the last
// eight in marketplace-api-handlers.ts; a phone had no case for any of them and was told "not
// available over remote access". Kept exactly: all thirteen are `remoteAllowed:false`. The eight
// write endpoints spend THIS computer's YouCoded sign-in (a phone must not rate or comment as the
// owner), and packages/config/cache describe what is installed on this computer. Widening any of
// them is the owner's decision, not something a move grants.
// The token, the API client and the skill source come from the account family's bindAccountDeps
// (built by registerMarketplaceApiHandlers), the provider from bindSkillsDeps.
import { IPC, type MarketplaceThumbs } from '../../shared/backend-contract';
import { getConfig as getMarketplaceConfig, setConfig as setMarketplaceConfig } from '../marketplace-config-store';
import { readComponent } from '../marketplace-file-reader';
import { reconcileInstalls } from '../install-reconcile';
import { wrap } from '../handler-utils';
import { getAccountDeps } from './account';
import { skillsDeps } from './skills';
import { defineChannel, type MainChannelDef } from './channel-def';

/** The vote AND the plugin's new totals: the renderer moves the number from THIS response rather than
 *  re-fetching /stats, which is served max-age=300 and could not show the new count for five minutes. */
const thumbs = (r: MarketplaceThumbs): MarketplaceThumbs => ({ vote: r.vote, thumbs_up: r.thumbs_up, thumbs_down: r.thumbs_down });

export const marketplaceChannels: MainChannelDef[] = [
  // Which versions are installed (update detection) and the on-disk component paths (uninstall cascade).
  defineChannel({ name: IPC.MARKETPLACE_GET_PACKAGES, kind: 'handle', remoteAllowed: false, handler: () => skillsDeps().skillProvider.configStore.getPackages() }),
  // Per-entry config: ~/.claude/youcoded-config/<id>.json, only for entries that declare a configSchema.
  defineChannel({ name: IPC.MARKETPLACE_GET_CONFIG, kind: 'handle', remoteAllowed: false, handler: ({ id }) => getMarketplaceConfig(id) }),
  defineChannel({
    name: IPC.MARKETPLACE_SET_CONFIG, kind: 'handle', remoteAllowed: false,
    handler: ({ id, values }) => { setMarketplaceConfig(id, values); return { ok: true as const }; },
  }),
  // User-initiated cache bust: the next fetchIndex/getFeatured refetches.
  defineChannel({ name: IPC.MARKETPLACE_INVALIDATE_CACHE, kind: 'handle', remoteAllowed: false, handler: async () => { await skillsDeps().skillProvider.invalidateCache(); } }),
  // In-app file viewer: a plugin's SKILL.md / command / agent file, local copy first, else GitHub.
  defineChannel({
    name: IPC.MARKETPLACE_READ_COMPONENT, kind: 'handle', remoteAllowed: false,
    handler: async (args) => {
      try {
        return await readComponent(args, () => skillsDeps().skillProvider.listMarketplace());
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  }),
  // ── Write endpoints, wrapped in ApiResult so the caller keeps the HTTP status (a custom Error's
  // fields do not survive the trip across the bridge). All go through main because the sign-in token lives here.
  defineChannel({
    name: IPC.MARKETPLACE_INSTALL, kind: 'handle', remoteAllowed: false,
    handler: ({ pluginId }) => wrap(async () => {
      const { client, store, installedSkillSource } = getAccountDeps();
      await client.postInstall(pluginId);
      // Report what the machine ACTUALLY has now, not just the clicked id: one install can land several
      // votable pages, and the Worker refuses a vote on any id it has no install row for. Deliberately
      // not awaited: this is bookkeeping, and the install already succeeded.
      void reconcileInstalls(store, installedSkillSource);
    }),
  }),
  defineChannel({ name: IPC.MARKETPLACE_RATE, kind: 'handle', remoteAllowed: false, handler: (input) => wrap(() => getAccountDeps().client.postRating(input)) }),
  defineChannel({ name: IPC.MARKETPLACE_RATE_DELETE, kind: 'handle', remoteAllowed: false, handler: ({ pluginId }) => wrap(() => getAccountDeps().client.deleteRating(pluginId)) }),
  defineChannel({ name: IPC.MARKETPLACE_THUMB, kind: 'handle', remoteAllowed: false, handler: (input) => wrap(async () => thumbs(await getAccountDeps().client.setThumb(input))) }),
  // The totals come back WITH the vote: returning only `vote` once produced a lit thumb beside "No votes yet".
  defineChannel({ name: IPC.MARKETPLACE_THUMB_GET, kind: 'handle', remoteAllowed: false, handler: ({ plugin_id }) => wrap(async () => thumbs(await getAccountDeps().client.getThumb(plugin_id))) }),
  defineChannel({
    name: IPC.MARKETPLACE_COMMENT, kind: 'handle', remoteAllowed: false,
    handler: (input) => wrap(async () => { const r = await getAccountDeps().client.postComment(input); return { id: r.id, hidden: r.hidden }; }),
  }),
  defineChannel({ name: IPC.MARKETPLACE_THEME_LIKE, kind: 'handle', remoteAllowed: false, handler: ({ themeId }) => wrap(() => getAccountDeps().client.toggleThemeLike(themeId)) }),
  defineChannel({ name: IPC.MARKETPLACE_REPORT, kind: 'handle', remoteAllowed: false, handler: (input) => wrap(() => getAccountDeps().client.postReport(input)) }),
];
