// account.ts — the YouCoded account (sign-in, profile, export), one body for both doors.
//
// WHY (2026-09-30 one-core R3-2): the ten account:* handlers lived inside
// registerMarketplaceApiHandlers, and remote-server.ts kept its own two-line copies of
// signed-in / user. Before/after for a phone:
//   - signed-in: same answer as before (is a token stored).
//   - user: the phone used to get only the CACHED profile; the computer's body also heals an
//     empty cache by asking /auth/me. One body now, so a phone gets the healed profile too. (A
//     dead session found while healing signs the computer out, as it already did for the computer.)
//   - start, poll, refresh, sign-out, update-profile, set-handle, delete, export: a phone was
//     refused. Kept exactly (`remoteAllowed:false`): they open a browser here, change who this
//     computer is signed in as, or open a save dialog here.
// The token, the API client and the store are built by registerMarketplaceApiHandlers in main.ts
// startup, so the handlers reach them through bindAccountDeps; before that runs they answer
// "signed out" (the same fallback remote-server had when no store was injected).
import fs from 'fs';
import { dialog, shell } from 'electron';
import { IPC } from '../../shared/backend-contract';
import type { ApiResult } from '../../shared/account-types';
import type { MarketplaceAuthStore } from '../marketplace-auth-store';
import { MarketplaceApiError, type createMarketplaceApiClient } from '../../renderer/state/marketplace-api-client';
import { wrap, makeClearSessionOn401 } from '../handler-utils';
import { notifySignedOut } from '../social-handlers';
import { clearArcadeCache } from '../arcade-handlers';
import { reconcileInstalls, type InstalledSkillSource } from '../install-reconcile';
import { defineChannel, type MainChannelDef } from './channel-def';

type Client = ReturnType<typeof createMarketplaceApiClient>;
interface AccountDeps {
  store: MarketplaceAuthStore;
  client: Client;
  installedSkillSource: InstalledSkillSource | null;
  clearSessionOn401: <T>(r: ApiResult<T>) => ApiResult<T>;
}
let deps: AccountDeps | null = null;

/** Called once by registerMarketplaceApiHandlers with the objects it builds. */
export function bindAccountDeps(next: { store: MarketplaceAuthStore; client: Client; installedSkillSource: InstalledSkillSource | null }): void {
  deps = { ...next, clearSessionOn401: makeClearSessionOn401(next.store, 'marketplace') };
}

function need(): AccountDeps {
  if (!deps) throw new Error('The account is not ready yet.');
  return deps;
}

// Worker may return avatar_url: null (GitHub always sets one); the store type uses a plain string.
// Accounts Phase 1: also carry display_name/handle (both optional on a pre-Phase-1 /auth/me).
function toStoredUser(me: { id: string; login: string; avatar_url: string | null; display_name?: string; handle?: string | null }) {
  return { id: me.id, login: me.login, avatar_url: me.avatar_url ?? '', display_name: me.display_name, handle: me.handle ?? null };
}

export const accountChannels: MainChannelDef[] = [
  // Device-code sign-in: main opens the browser (the renderer cannot call shell.openExternal).
  defineChannel({
    name: IPC.ACCOUNT_START, kind: 'handle', remoteAllowed: false,
    handler: () => wrap(async () => {
      const { client } = need();
      const out = await client.authStart();
      // openExternal can fail on some Linux sandboxes (Flatpak). Non-fatal: the renderer shows the URL.
      await shell.openExternal(out.auth_url).catch((err) =>
        console.warn('[marketplace] openExternal failed; user must open URL manually:', err));
      return out;
    }),
  }),
  defineChannel({
    name: IPC.ACCOUNT_POLL, kind: 'handle', remoteAllowed: false,
    handler: ({ deviceCode }) => wrap(async () => {
      const { client, store, installedSkillSource } = need();
      const res = await client.authPoll(deviceCode);
      if (res.status === 'complete') {
        // The Worker returns the profile alongside the token: store both so user() works at once
        // (the games lobby needs user.login as the player tag).
        if (res.user) store.setSession(res.token, toStoredUser(res.user));
        else store.setToken(res.token); // older Worker without `user`
        // Tell the Worker what this machine already has, so the install gate accepts votes on
        // plugins the user demonstrably has. Deliberately NOT awaited: sign-in must not wait.
        void reconcileInstalls(store, installedSkillSource);
      }
      return res;
    }),
  }),
  // "No store yet" reports signed-out rather than hanging (what remote-server always did).
  defineChannel({ name: IPC.ACCOUNT_SIGNED_IN, kind: 'handle', handler: () => !!deps?.store.getToken() }),
  defineChannel({
    name: IPC.ACCOUNT_USER, kind: 'handle',
    handler: async () => {
      if (!deps) return null;
      const { store, client } = deps;
      const cached = store.getUser();
      if (cached) return cached;
      // Heal path: a token stored before profile storage existed has no user. Fetch it once from
      // /auth/me and persist. Any failure returns null; the token stays untouched.
      const token = store.getToken();
      if (!token) return null;
      try {
        const stored = toStoredUser(await client.authMe());
        store.setSession(token, stored);
        return stored;
      } catch (e) {
        // 401 = the token is dead server-side: clear the local session so the UI flips to signed-out.
        if (e instanceof MarketplaceApiError && e.status === 401) store.signOut();
        return null;
      }
    },
  }),
  // Force-revalidate the cached profile against /auth/me so a change made on another device
  // reaches this client without a sign-out/in (knowledge-debt #8).
  defineChannel({
    name: IPC.ACCOUNT_REFRESH, kind: 'handle', remoteAllowed: false,
    handler: async () => {
      const { store, client } = need();
      const token = store.getToken();
      if (!token) return null;
      try {
        const stored = toStoredUser(await client.authMe());
        store.setSession(token, stored);
        return stored;
      } catch (e) {
        // 401 = dead session. Any OTHER failure keeps the token and cached profile: a network
        // blip must not blank a signed-in UI.
        if (e instanceof MarketplaceApiError && e.status === 401) { store.signOut(); return null; }
        return store.getUser();
      }
    },
  }),
  // Sign-out revokes server-side too, best-effort: if the Worker is unreachable the local clear still wins.
  defineChannel({
    name: IPC.ACCOUNT_SIGN_OUT, kind: 'handle', remoteAllowed: false,
    handler: async () => {
      const { store, client } = need();
      try { await client.logout(); } catch { /* offline sign-out is fine */ }
      store.signOut();
      notifySignedOut(); // drop the presence socket so we don't linger online
      clearArcadeCache(); // and forget the cached friends leaderboard
    },
  }),
  defineChannel({
    name: IPC.ACCOUNT_UPDATE_PROFILE, kind: 'handle', remoteAllowed: false,
    handler: ({ displayName }) => {
      const { store, client, clearSessionOn401 } = need();
      return wrap(async () => {
        const out = await client.updateProfile(displayName);
        const user = store.getUser();
        // user-present implies token-present: setSession writes both, signOut clears both
        if (user) store.setSession(store.getToken()!, { ...user, display_name: out.display_name });
        return out;
      }).then(clearSessionOn401);
    },
  }),
  defineChannel({
    name: IPC.ACCOUNT_SET_HANDLE, kind: 'handle', remoteAllowed: false,
    handler: ({ handle }) => {
      const { store, client, clearSessionOn401 } = need();
      return wrap(async () => {
        const out = await client.setHandle(handle);
        const user = store.getUser();
        if (user) store.setSession(store.getToken()!, { ...user, handle: out.handle });
        return out;
      }).then(clearSessionOn401);
    },
  }),
  // Permanent hard-delete (the Worker cascades). Clear the local session too.
  defineChannel({
    name: IPC.ACCOUNT_DELETE, kind: 'handle', remoteAllowed: false,
    handler: () => {
      const { store, client, clearSessionOn401 } = need();
      return wrap(async () => {
        await client.deleteAccount();
        store.signOut();
        notifySignedOut();
        clearArcadeCache();
      }).then(clearSessionOn401);
    },
  }),
  // Export all account data. NOT an ApiResult: the renderer tells { path } / { canceled } / { ok:false } apart.
  defineChannel({
    name: IPC.ACCOUNT_EXPORT, kind: 'handle', desktopOnly: true,
    handler: async () => {
      const { store, client } = need();
      // One try/catch around EVERYTHING: the renderer is promised a union it handles without try/catch
      // (a disk-full write must not reject instead). status:0 = local/non-API failure.
      try {
        const data = await client.exportData();
        const stamp = new Date().toISOString().slice(0, 10);
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: 'Export account data',
          defaultPath: `youcoded-account-export-${stamp}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (canceled || !filePath) return { canceled: true as const };
        await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        return { path: filePath };
      } catch (e) {
        if (e instanceof MarketplaceApiError) {
          if (e.status === 401) store.signOut(); // dead session: flip UI signed-out
          return { ok: false as const, status: e.status, error: e.message };
        }
        return { ok: false as const, status: 0, error: e instanceof Error ? e.message : String(e) };
      }
    },
  }),
];
