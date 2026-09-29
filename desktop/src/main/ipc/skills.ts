// skills.ts — browsing, installing and organising skills, one body for both doors.
//
// WHY (2026-09-30 one-core R3-3): skills:* had a hand-written ipcMain.handle in ipc-handlers.ts AND
// a second, subtly different `case` in remote-server.ts for a phone. Before/after for a phone:
//   - list, list-marketplace, get-detail, search, get/set favourites, chips, overrides, create/delete
//     prompt, publish, share link, import from link, curated defaults, integration info, install,
//     install-many, apply-output-style: allowed before, allowed now (nothing widened).
//   - install: same (a newly installed plugin makes running chats reload their plugins).
//   - uninstall: the phone's copy had NO check for the plugins YouCoded ships with, and always said
//     "ok"; a phone could remove a bundled plugin. The computer refused ("bundled"). One body now,
//     so the phone is refused the same way and gets the real answer (FIX; narrower, not wider).
//   - set-favorite / set-chips / set-override / delete-prompt: the phone was told `{ok:true}`, the
//     computer got nothing back. Now both get nothing back (no screen reads it).
//   - get-featured and update: refused on a phone before; still refused (`remoteAllowed:false`).
// The provider and the session manager are built in registerIpcHandlers, so they arrive through
// bindSkillsDeps; a phone and the computer share the same two objects.
import { IPC } from '../../shared/backend-contract';
import { isBundledPlugin } from '../../shared/bundled-plugins';
import type { LocalSkillProvider } from '../skill-provider';
import type { SessionManager } from '../session-manager';
import { defineChannel, type MainChannelDef } from './channel-def';

interface SkillsDeps { skillProvider: LocalSkillProvider; sessionManager: Pick<SessionManager, 'broadcastReloadPlugins'> }
let deps: SkillsDeps | null = null;

/** Called once by registerIpcHandlers with the provider and session manager it was given. */
export function bindSkillsDeps(next: SkillsDeps): void { deps = next; }

/** The bound provider (also read by main/ipc/marketplace.ts). */
export function skillsDeps(): SkillsDeps {
  if (!deps) throw new Error('Skills are not ready yet.');
  return deps;
}

export const skillsChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.SKILLS_LIST, kind: 'handle', handler: () => skillsDeps().skillProvider.getInstalled() }),
  defineChannel({ name: IPC.SKILLS_LIST_MARKETPLACE, kind: 'handle', handler: (filters) => skillsDeps().skillProvider.listMarketplace(filters) }),
  defineChannel({ name: IPC.SKILLS_GET_DETAIL, kind: 'handle', handler: ({ id }) => skillsDeps().skillProvider.getSkillDetail(id) }),
  defineChannel({ name: IPC.SKILLS_SEARCH, kind: 'handle', handler: ({ query }) => skillsDeps().skillProvider.search(query) }),
  defineChannel({
    name: IPC.SKILLS_INSTALL, kind: 'handle',
    handler: async ({ id }) => {
      const { skillProvider, sessionManager } = skillsDeps();
      const result = await skillProvider.install(id);
      // Reload plugins so Claude Code discovers the new plugin. A short delay (inside
      // broadcastReloadPlugins) because firing at once races the prompt-ready state.
      if (result.status === 'installed' && result.type === 'plugin') sessionManager.broadcastReloadPlugins();
      return result;
    },
  }),
  defineChannel({
    name: IPC.SKILLS_UNINSTALL, kind: 'handle',
    handler: async ({ id }) => {
      // Defense-in-depth: the UI disables the button for bundled plugins; refuse here too so a
      // stale client, a direct call or a phone cannot bypass it.
      if (isBundledPlugin(id)) return { ok: false, error: 'bundled', type: 'plugin' } as const;
      const { skillProvider, sessionManager } = skillsDeps();
      const result = await skillProvider.uninstall(id);
      // Reload plugins so Claude Code drops the uninstalled plugin.
      if (result.type === 'plugin') sessionManager.broadcastReloadPlugins();
      return result;
    },
  }),
  defineChannel({ name: IPC.SKILLS_GET_FAVORITES, kind: 'handle', handler: () => skillsDeps().skillProvider.getFavorites() }),
  defineChannel({ name: IPC.SKILLS_SET_FAVORITE, kind: 'handle', handler: ({ id, favorited }) => skillsDeps().skillProvider.setFavorite(id, favorited) }),
  defineChannel({ name: IPC.SKILLS_GET_CHIPS, kind: 'handle', handler: () => skillsDeps().skillProvider.getChips() }),
  defineChannel({ name: IPC.SKILLS_SET_CHIPS, kind: 'handle', handler: ({ chips }) => skillsDeps().skillProvider.setChips(chips) }),
  defineChannel({ name: IPC.SKILLS_GET_OVERRIDE, kind: 'handle', handler: async ({ id }) => (await skillsDeps().skillProvider.getOverrides())[id] || null }),
  defineChannel({ name: IPC.SKILLS_SET_OVERRIDE, kind: 'handle', handler: ({ id, override }) => skillsDeps().skillProvider.setOverride(id, override) }),
  defineChannel({ name: IPC.SKILLS_CREATE_PROMPT, kind: 'handle', handler: (skill) => skillsDeps().skillProvider.createPromptSkill(skill) }),
  defineChannel({ name: IPC.SKILLS_DELETE_PROMPT, kind: 'handle', handler: ({ id }) => skillsDeps().skillProvider.deletePromptSkill(id) }),
  defineChannel({ name: IPC.SKILLS_PUBLISH, kind: 'handle', handler: ({ id }) => skillsDeps().skillProvider.publish(id) }),
  defineChannel({ name: IPC.SKILLS_GET_SHARE_LINK, kind: 'handle', handler: ({ id }) => skillsDeps().skillProvider.generateShareLink(id) }),
  defineChannel({ name: IPC.SKILLS_IMPORT_FROM_LINK, kind: 'handle', handler: ({ encoded }) => skillsDeps().skillProvider.importFromLink(encoded) }),
  defineChannel({ name: IPC.SKILLS_GET_CURATED_DEFAULTS, kind: 'handle', handler: () => skillsDeps().skillProvider.getCuratedDefaults() }),
  // The marketplace's hero and rails: refused on a phone before, still refused.
  defineChannel({ name: IPC.SKILLS_GET_FEATURED, kind: 'handle', remoteAllowed: false, handler: () => skillsDeps().skillProvider.getFeatured() }),
  defineChannel({ name: IPC.SKILLS_GET_INTEGRATION_INFO, kind: 'handle', handler: ({ id }) => skillsDeps().skillProvider.getIntegrationInfo(id) }),
  defineChannel({ name: IPC.SKILLS_INSTALL_MANY, kind: 'handle', handler: ({ ids }) => skillsDeps().skillProvider.installMany(ids ?? []) }),
  defineChannel({
    name: IPC.SKILLS_APPLY_OUTPUT_STYLE, kind: 'handle',
    handler: ({ styleId }) => { skillsDeps().skillProvider.applyOutputStyle(styleId); return { ok: true }; },
  }),
  // Re-download an installed plugin at its latest marketplace version. Refused on a phone before, still refused.
  defineChannel({
    name: IPC.SKILLS_UPDATE, kind: 'handle', remoteAllowed: false,
    handler: async ({ id }) => {
      const { skillProvider, sessionManager } = skillsDeps();
      const result = await skillProvider.update(id);
      // Reload plugins in active sessions so Claude Code picks up the updated code.
      if (result.ok) sessionManager.broadcastReloadPlugins();
      return result;
    },
  }),
];
