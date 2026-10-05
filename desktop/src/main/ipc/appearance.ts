// appearance.ts — themes and appearance: theme:list / read-file / write-file, appearance:get / set, the favourite
// themes, and the live theme relay (appearance:broadcast), one body for both doors.
//
// WHY (2026-10-01 one-core R3-8): these were an ipcMain handler in ipc-handlers.ts / main.ts for the computer's windows
// and a `case` in remote-server.ts for a phone. What differed between the copies, and what the entries now do:
//   - theme:read-file: the computer's copy REJECTED on a bad or missing theme; the phone's answered `{ ok:false, error }`.
//     The entry throws, and declares the phone's soft answer (`remoteOnError`) so a phone still gets the same two sentences.
//   - theme:write-file and appearance:favorite-theme were the computer's alone: the phone door refuses them from the table
//     with the same "not available over remote access" answer the old default gave.
//   - appearance:get / appearance:set: the computer read and wrote the file with blocking calls; one async body now.
//   - appearance:broadcast: a window's change goes to every OTHER window and every phone; a phone's change goes to every
//     OTHER phone (held for a phone still catching up) and every window. The two audiences are exactly as before.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/backend-contract';
import { listUserThemes, userThemeDir, userThemeManifest, THEMES_DIR } from '../theme-watcher';
import { defineChannel, type MainChannelDef } from './channel-def';

// Security: strict slug format to prevent path traversal before path.resolve. A leading underscore is allowed for
// reserved internal slugs (e.g. _preview, used by the theme builder).
export const SAFE_SLUG_RE = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/;
const INVALID_SLUG = 'Invalid theme slug';

const appearancePrefPath = () => path.join(os.homedir(), '.claude', 'youcoded-appearance.json');

/** The theme favourites live in the skill config store, which main builds; handed over by ipc-handlers.ts. */
interface ThemeFavorites { getThemeFavorites(): string[]; setThemeFavorite(slug: string, favorited: boolean): void }
let favorites: ThemeFavorites | null = null;
export function bindAppearance(store: ThemeFavorites): void { favorites = store; }

export const appearanceChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.THEME_LIST, kind: 'handle', handler: () => listUserThemes() }),

  // Reading a theme file is bridged for a phone and nothing else under `theme:` is: the phone already learns which theme
  // the computer is on (appearance:get hands it the slug), and could not find out what that slug means. Read-only, with
  // the two guards the computer always had: a plain slug, and a resolved path still inside the themes folder.
  defineChannel({
    name: IPC.THEME_READ_FILE, kind: 'handle',
    // Not installed on this computer: the phone keeps the theme it has rather than being handed a fallback it did not choose.
    remoteOnError: (error) => ({ ok: false as const, error: (error as Error)?.message === INVALID_SLUG ? INVALID_SLUG : 'Theme not found' }),
    handler: async ({ slug }) => {
      if (!SAFE_SLUG_RE.test(String(slug ?? ''))) throw new Error(INVALID_SLUG);
      const manifestPath = path.resolve(userThemeManifest(slug));
      if (!manifestPath.startsWith(THEMES_DIR + path.sep)) throw new Error(INVALID_SLUG);
      return fs.promises.readFile(manifestPath, 'utf-8');
    },
  }),

  // Writing a theme stays the computer's, like every other change to the host.
  defineChannel({
    name: IPC.THEME_WRITE_FILE, kind: 'handle', remoteAllowed: false,
    handler: async ({ slug, content }) => {
      if (!SAFE_SLUG_RE.test(slug)) throw new Error(INVALID_SLUG);
      const themeDir = path.resolve(userThemeDir(slug));
      if (!themeDir.startsWith(THEMES_DIR + path.sep)) throw new Error(INVALID_SLUG);
      await fs.promises.mkdir(path.join(themeDir, 'assets'), { recursive: true });
      await fs.promises.writeFile(path.join(themeDir, 'manifest.json'), content, 'utf-8');
    },
  }),

  // ── Appearance preference persistence (~/.claude/youcoded-appearance.json) ──
  defineChannel({
    name: IPC.APPEARANCE_GET, kind: 'handle',
    handler: async () => {
      try { return JSON.parse(await fs.promises.readFile(appearancePrefPath(), 'utf8')); } catch { return null; }
    },
  }),
  defineChannel({
    name: IPC.APPEARANCE_SET, kind: 'handle',
    handler: async (prefs) => {
      try {
        let existing: Record<string, unknown> = {};
        try { existing = JSON.parse(await fs.promises.readFile(appearancePrefPath(), 'utf8')); } catch { /* first write */ }
        await fs.promises.mkdir(path.dirname(appearancePrefPath()), { recursive: true });
        await fs.promises.writeFile(appearancePrefPath(), JSON.stringify({ ...existing, ...prefs }));
        return true;
      } catch { return false; }
    },
  }),

  // Theme favourites — parallel to skills:set-favorite. Drives the Appearance panel's favourites-only list.
  defineChannel({
    name: IPC.APPEARANCE_GET_FAVORITE_THEMES, kind: 'handle',
    handler: () => favorites?.getThemeFavorites() ?? [],
  }),
  defineChannel({
    name: IPC.APPEARANCE_FAVORITE_THEME, kind: 'handle', remoteAllowed: false,
    handler: ({ slug, favorited }) => {
      if (!favorites) throw new Error('theme favourites are not ready');
      favorites.setThemeFavorite(slug, favorited);
      // Tell the peer windows so ThemeContext re-reads without a polled fetch (the existing appearance pipe).
      try {
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.APPEARANCE_SYNC, { themeFavoritesChanged: Date.now() });
      } catch { /* best-effort broadcast */ }
      return favorites.getThemeFavorites();
    },
  }),

  // A theme or display change made in one place reaches every other: a window tells its peer windows (and, since a phone
  // read the theme once at page load and kept it, the phones); a phone tells the other phones and the windows
  // (Destin, 2026-09-11: "dev is on meadow mist and remote chose golden daybreak"). ThemeProvider applies a received change
  // without re-broadcasting, so nothing loops. Fire-and-forget on both doors.
  defineChannel({
    name: IPC.APPEARANCE_BROADCAST, kind: 'on',
    handler: (prefs, ctx) => {
      if (ctx.remote) {
        if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return;
        ctx.remote.sendToWindows(IPC.APPEARANCE_SYNC, prefs);
        ctx.remote.relayToOthers({ type: IPC.APPEARANCE_SYNC, payload: prefs }, { queueWhileRestoring: true });
        return;
      }
      // WHY BrowserWindow is the delivery authority here: buddy floaters do not own sessions, so filtering through
      // session-peer registry entries could leave their independent ThemeProvider on its launch theme.
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents.id === ctx.sender?.id) continue;
        win.webContents.send(IPC.APPEARANCE_SYNC, prefs);
      }
      ctx.desktop?.sendToPhones({ type: IPC.APPEARANCE_SYNC, payload: prefs });
    },
  }),
];
