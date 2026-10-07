// The last channels to enter the table: document comments, themes and appearance, favourites and the arcade, zoom, the small
// phone singles, the shell pieces, windows / detach / buddy, integrations, remote-access administration, voice, social and the
// transcript replays. The generic checks (channel-table-families.test.ts) already prove every entry runs ONE handler for both doors;
// channel-table-complete.test.ts proves nothing hand-written is left. This file pins what those cannot see: exactly who may call
// what, the refusals a phone gets (byte for byte), and the places the two doors legitimately differ.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const windows: Array<{ id: number; sends: Array<[string, unknown]>; isDestroyed: () => boolean }> = [];
vi.mock('electron', () => {
  const BrowserWindow: any = vi.fn();
  BrowserWindow.getAllWindows = () => windows.map((w: any) => ({ isDestroyed: w.isDestroyed, webContents: w.webContents ?? { id: w.id, send: (c: string, p: unknown) => w.sends.push([c, p]) } }));
  BrowserWindow.fromWebContents = () => null;
  return {
    app: { relaunch: vi.fn(), exit: vi.fn(), dock: undefined },
    BrowserWindow,
    dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn() },
    nativeImage: {},
    shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    systemPreferences: {},
    powerSaveBlocker: { start: vi.fn(), stop: vi.fn() },
    webContents: { getAllWebContents: () => [], fromId: () => null },
    utilityProcess: { fork: vi.fn() },
  };
});

import { CHANNEL_TABLE, findChannel, serveRemoteChannel } from '../src/main/ipc/channel-table';
import { HOST_ADMIN_REFUSAL, bindRemoteAdmin } from '../src/main/ipc/remote-admin';
import { bindWindow } from '../src/main/ipc/window';
import { bindUi } from '../src/main/ipc/ui';
import { bindAppearance } from '../src/main/ipc/appearance';
import { bindBuddy } from '../src/main/ipc/buddy';

const NEW_FAMILY = /^(docComments|theme|appearance|favorites|game|arcade|zoom|platform|commands|ui|system|terminal|app|performance|attention|shell|dialog|clipboard|window|detach|buddy|integrations|remote|voice|social):|^(session:(detach|drag|drop|replay)|transcript:replay)/;
const NEW_NAMES = ['ui:action', 'remote:attention-changed'];
// Not part of this group: window:close-request pushes and friends are pushes (no entry), remote:* below is only what the group moved.
const inGroup = (name: string) => (NEW_FAMILY.test(name) || NEW_NAMES.includes(name)) && !['session:destroyed'].includes(name);
const entries = CHANNEL_TABLE.filter((d) => inGroup(d.name));
const phoneOpen = (d: (typeof entries)[number]) => !d.desktopOnly && d.remoteAllowed !== false;

const desktopCtx = (extra: any = {}): any => ({ door: 'desktop', runtime: null, broadcast: vi.fn(), ...extra });
const phoneCtx = (extra: any = {}): any => ({ door: 'remote', runtime: null, broadcast: vi.fn(), ...extra });
const unsupported = (name: string) => ({ ok: false, error: `This feature isn't available over remote access yet (${name}).`, unsupported: true });
const phone = (name: string, payload: unknown, ctx: any = phoneCtx()) => serveRemoteChannel(findChannel(name)!, payload, ctx);

beforeEach(() => { windows.length = 0; });

describe('which of the last channels a phone may call: exactly what it could before', () => {
  it('the table holds every channel of the group', () => {
    // 12 docComments + 3 theme + 5 appearance + 2 favorites + 2 game + 4 arcade + 4 zoom + platform + commands + 2 ui action + system +
    // terminal + app:restart + 2 performance + 3 attention + 4 shell + 3 dialog + clipboard + 10 window (minimize maximize close
    // traffic-light icon get-id get-directory answer-close open-detached focus-and-switch) + detach:claim-pending + 8 detach/drag
    // + 17 buddy (buddy:mascot-hit joined with the taskbar-icon buddy, 2026-10-02) + 6 integrations + 12 remote admin + 9 voice (two desktop-only vocabulary channels) + 14 social
    expect(entries.length).toBe(129);
  });

  it('exactly these are open to a phone; everything else is refused from the table', () => {
    expect(entries.filter(phoneOpen).map((d) => d.name).sort()).toEqual([
      'appearance:broadcast', 'appearance:get', 'appearance:get-favorite-themes', 'appearance:set',
      'arcade:leaderboard', 'arcade:records', 'arcade:status', 'arcade:submit-score',
      'commands:list',
      'docComments:add', 'docComments:delete', 'docComments:delete-reply', 'docComments:edit', 'docComments:edit-reply', 'docComments:list',
      'docComments:move', 'docComments:reopen', 'docComments:reply', 'docComments:resolve', 'docComments:unwatch', 'docComments:watch',
      'favorites:get', 'favorites:set', 'game:getIncognito', 'game:setIncognito',
      'platform:get',
      'remote:detect-tailscale', 'remote:devices:list', 'remote:get-client-count', 'remote:get-client-list', 'remote:get-config', 'remote:status',
      'theme:list', 'theme:read-file',
      'ui:action',
      'zoom:get', 'zoom:in', 'zoom:out', 'zoom:reset',
    ]);
  });

  it('the four host-administration channels carry the refusal, the rest of the computer-only ones the standard answer', () => {
    const adminRefused = ['remote:devices:rename', 'remote:devices:unpair', 'remote:set-config', 'remote:set-password'];
    for (const d of entries.filter((e) => !phoneOpen(e))) {
      if (adminRefused.includes(d.name)) expect(d.refusal, d.name).toEqual({ kind: 'reply', payload: { ok: false, error: HOST_ADMIN_REFUSAL } });
      else expect(d.refusal, d.name).toBeUndefined();
    }
    expect(entries.filter((d) => d.refusal).map((d) => d.name).sort()).toEqual(adminRefused);
  });

  it('a refused channel never runs its handler for a phone, and answers the old words', async () => {
    for (const def of entries.filter((d) => !phoneOpen(d))) {
      const original = def.handler;
      const ran = vi.fn(() => ({ ok: true }));
      def.handler = ran;
      try {
        const answer = await serveRemoteChannel(def, {}, phoneCtx());
        if (def.refusal?.kind === 'reply') expect(answer).toEqual({ reply: true, payload: def.refusal.payload });
        else expect(answer, def.name).toEqual({ reply: true, payload: unsupported(def.name) });
        expect(ran, `${def.name} ran for a phone`).not.toHaveBeenCalled();
      } finally { def.handler = original; }
    }
  });
});

describe('remote administration: the refusals are kept byte for byte, and disconnect-client stays unlisted', () => {
  it('set-password, set-config, rename and unpair answer { ok:false, error: "Change this on the computer itself." }', async () => {
    for (const name of ['remote:set-password', 'remote:set-config', 'remote:devices:rename', 'remote:devices:unpair']) {
      expect(await phone(name, {})).toEqual({ reply: true, payload: { ok: false, error: 'Change this on the computer itself.' } });
    }
  });

  it('remote:disconnect-client has NO entry, so it falls to the door\'s unsupported answer, a different answer from the refusal', () => {
    expect(findChannel('remote:disconnect-client')).toBeUndefined();
    expect(HOST_ADMIN_REFUSAL).toBe('Change this on the computer itself.');
  });

  it('install-tailscale and auth-tailscale were never bridged and still get the standard answer', async () => {
    for (const name of ['remote:install-tailscale', 'remote:auth-tailscale']) {
      expect(await phone(name, undefined)).toEqual({ reply: true, payload: unsupported(name) });
    }
  });

  it('reading the configuration stays answered, from the host this phone is on', async () => {
    const host = {
      config: { toSafeObject: () => ({ port: 9900 }), port: 9900 }, getClientCount: () => 2, getClientList: () => [{ id: 'a' }],
      getStatus: () => ({ state: 'running' }), getDeviceList: () => [{ id: 'd1' }],
    };
    const ctx = phoneCtx({ remote: { host } });
    expect(await phone('remote:get-config', undefined, ctx)).toEqual({ reply: true, payload: { port: 9900, clientCount: 2 } });
    expect(await phone('remote:get-client-count', undefined, ctx)).toEqual({ reply: true, payload: 2 });
    expect(await phone('remote:status', undefined, ctx)).toEqual({ reply: true, payload: { state: 'running' } });
  });

  it('the device list is a bare list for the computer\'s window and { devices } for a phone, as before', async () => {
    const host = { config: { toSafeObject: () => ({}), port: 1 }, getClientCount: () => 0, getClientList: () => [], getStatus: () => ({}), getDeviceList: () => [{ id: 'd1' }] };
    expect(await phone('remote:devices:list', undefined, phoneCtx({ remote: { host } }))).toEqual({ reply: true, payload: { devices: [{ id: 'd1' }] } });
    // The computer's door reads the server main handed over; with none, an empty list.
    bindRemoteAdmin({ config: { port: 1, toSafeObject: () => ({}) } as any, server: undefined, applyKeepAwake: () => {} });
    expect(await findChannel('remote:devices:list')!.handler(undefined, desktopCtx())).toEqual([]);
  });
});

describe('window, detach, buddy, voice, social and the rest are the computer\'s own', () => {
  it('every one is desktop-only except the phone-open list above', () => {
    const computerOnly = entries.filter((d) => !phoneOpen(d) && !d.refusal).map((d) => d.name);
    for (const name of ['window:minimize', 'window:get-id', 'detach:claim-pending', 'session:detach-live', 'session:drop-resolve', 'buddy:show', 'buddy:capture-desktop', 'buddy:install-helper', 'dialog:open-file', 'shell:open-external', 'clipboard:save-image',
      'integrations:install', 'voice:start', 'voice:audio', 'social:list-friends', 'social:presence-send', 'performance:set-config', 'app:restart',
      'attention:report', 'terminal:get-screen-text', 'system:notify-stack-state', 'ui:action:broadcast']) {
      expect(computerOnly, name).toContain(name);
    }
  });

  it('the on/handle shape of the hot drag and pointer channels is unchanged', () => {
    for (const name of ['session:drag-window-move', 'session:drag-started', 'session:drag-ended', 'session:drag-dropped', 'session:drag-adopt',
      'buddy:move-mascot', 'buddy:drag-ended', 'buddy:mascot-hit', 'voice:audio', 'attention:report', 'window:open-detached', 'window:focus-and-switch', 'appearance:broadcast']) {
      expect(findChannel(name)?.kind, name).toBe('on');
    }
    for (const name of ['session:detach-live', 'session:drop-resolve', 'buddy:show', 'detach:claim-pending']) expect(findChannel(name)?.kind, name).toBe('handle');
  });
});

describe('themes and appearance', () => {
  it('a phone reading a theme that is not installed, or named badly, gets the two soft sentences it always got', async () => {
    expect(await phone('theme:read-file', { slug: '../../etc/hostname' })).toEqual({ reply: true, payload: { ok: false, error: 'Invalid theme slug' } });
    expect(await phone('theme:read-file', { slug: 'definitely-not-installed' })).toEqual({ reply: true, payload: { ok: false, error: 'Theme not found' } });
    expect(await phone('theme:read-file', {})).toEqual({ reply: true, payload: { ok: false, error: 'Invalid theme slug' } });
  });

  it('the computer rejects on a bad slug, as its window always saw', async () => {
    await expect(Promise.resolve().then(() => findChannel('theme:read-file')!.handler({ slug: '../x' }, desktopCtx()))).rejects.toThrow('Invalid theme slug');
  });

  it('a theme change from a window reaches the other windows and every phone; one from a phone reaches the windows and the OTHER phones', async () => {
    windows.push({ id: 1, sends: [], isDestroyed: () => false }, { id: 2, sends: [], isDestroyed: () => false }, { id: 3, sends: [], isDestroyed: () => true });
    const sendToPhones = vi.fn();
    findChannel('appearance:broadcast')!.handler({ theme: 'meadow-mist' }, desktopCtx({ sender: { id: 1 }, desktop: { sendToPhones } }));
    expect(windows[0].sends).toEqual([]);
    expect(windows[1].sends).toEqual([['appearance:sync', { theme: 'meadow-mist' }]]);
    expect(windows[2].sends).toEqual([]);
    expect(sendToPhones).toHaveBeenCalledWith({ type: 'appearance:sync', payload: { theme: 'meadow-mist' } });

    const sendToWindows = vi.fn(); const relayToOthers = vi.fn();
    await phone('appearance:broadcast', { theme: 'golden' }, phoneCtx({ remote: { sendToWindows, relayToOthers } }));
    expect(sendToWindows).toHaveBeenCalledWith('appearance:sync', { theme: 'golden' });
    expect(relayToOthers).toHaveBeenCalledWith({ type: 'appearance:sync', payload: { theme: 'golden' } }, { queueWhileRestoring: true });
    // A payload that is not an object is ignored.
    sendToWindows.mockClear(); relayToOthers.mockClear();
    await phone('appearance:broadcast', 'midnight', phoneCtx({ remote: { sendToWindows, relayToOthers } }));
    expect(sendToWindows).not.toHaveBeenCalled();
    expect(relayToOthers).not.toHaveBeenCalled();
  });

  it('favourite themes: a phone reads them, only the computer sets one', async () => {
    const set = vi.fn();
    bindAppearance({ getThemeFavorites: () => ['a'], setThemeFavorite: set });
    expect(await phone('appearance:get-favorite-themes', undefined)).toEqual({ reply: true, payload: ['a'] });
    expect(await phone('appearance:favorite-theme', { slug: 'a', favorited: true })).toEqual({ reply: true, payload: unsupported('appearance:favorite-theme') });
    expect(set).not.toHaveBeenCalled();
  });

  it('appearance:set merges into the one file both doors read', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-appearance-'));
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      expect(await findChannel('appearance:get')!.handler(undefined, desktopCtx())).toBeNull();
      expect(await findChannel('appearance:set')!.handler({ theme: 'a' }, desktopCtx())).toBe(true);
      expect((await phone('appearance:set', { font: 'x' })).reply && true).toBe(true);
      expect(await findChannel('appearance:get')!.handler(undefined, desktopCtx())).toEqual({ theme: 'a', font: 'x' });
    } finally { spy.mockRestore(); fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe('the small singles', () => {
  it('a phone\'s screen action reaches the other phones (not itself) and the computer\'s windows; a window\'s reaches every phone', async () => {
    const relayToOthers = vi.fn(); const emitUiAction = vi.fn(); const sendToPhones = vi.fn();
    bindUi({ getCommands: async () => [], emitUiAction });
    await phone('ui:action', { type: 'go' }, phoneCtx({ remote: { relayToOthers } }));
    expect(relayToOthers).toHaveBeenCalledWith({ type: 'ui:action', payload: { type: 'go' } });
    expect(emitUiAction).toHaveBeenCalledWith({ type: 'go' });
    findChannel('ui:action:broadcast')!.handler({ type: 'back' }, desktopCtx({ desktop: { sendToPhones } }));
    expect(sendToPhones).toHaveBeenCalledWith({ type: 'ui:action', payload: { type: 'back' } });
  });

  it('the phone-only ui:action is not registered with Electron on the computer', () => {
    expect(findChannel('ui:action')!.remoteOnly).toBe(true);
  });

  it('favourites are read in both shapes: the bare list a window sends and the { favorites } a phone sends', async () => {
    const file = path.join(os.homedir(), '.claude', 'youcoded-favorites.json');
    fs.rmSync(file, { force: true });
    expect(await phone('favorites:set', { favorites: ['chess'] })).toEqual({ reply: true, payload: true });
    expect(await findChannel('favorites:get')!.handler(undefined, desktopCtx())).toEqual(['chess']);
    expect(await findChannel('favorites:set')!.handler(['flappy'], desktopCtx())).toBe(true);
    expect((await phone('favorites:get', undefined)).reply).toBe(true);
    expect(await findChannel('favorites:get')!.handler(undefined, desktopCtx())).toEqual(['flappy']);
    fs.rmSync(file, { force: true });
  });

  it('platform:get answers the computer\'s platform on both doors', async () => {
    expect(await phone('platform:get', undefined)).toEqual({ reply: true, payload: process.platform });
  });

  it('the arcade says so when the host has no scores service, instead of throwing', async () => {
    expect(await phone('arcade:status', undefined)).toEqual({ reply: true, payload: { ok: false, status: 0, message: 'Game scores are unavailable on this host.' } });
  });

  it('zoom keeps each door\'s own window: the computer zooms its main window, a phone the first open window', async () => {
    const mk = (start: number) => { let level = start; return { level: () => level, win: { isDestroyed: () => false, webContents: { getZoomLevel: () => level, setZoomLevel: (l: number) => { level = l; } } } as any }; };
    // No window anywhere: both answer 100.
    bindWindow({ getMainWindow: () => null });
    expect(await phone('zoom:get', undefined)).toEqual({ reply: true, payload: 100 });
    expect(await findChannel('zoom:get')!.handler(undefined, desktopCtx())).toBe(100);
    // The main window is gone (its last session was torn off) but another window is open: the phone still zooms, the computer's door still answers 100.
    const survivor = mk(0);
    windows.push({ id: 5, sends: [], isDestroyed: () => false, ...({ webContents: survivor.win.webContents } as any) });
    bindWindow({ getMainWindow: () => ({ isDestroyed: () => true }) as any });
    expect(await phone('zoom:in', undefined)).toEqual({ reply: true, payload: Math.round(Math.pow(1.2, 0.5) * 100) });
    expect(survivor.level()).toBe(0.5);
    expect(await findChannel('zoom:in')!.handler(undefined, desktopCtx())).toBe(100);
    // The main window is alive: the computer's door zooms it (clamped at the top), reset answers 100.
    const main = mk(4.9);
    bindWindow({ getMainWindow: () => main.win });
    expect(await findChannel('zoom:in')!.handler(undefined, desktopCtx())).toBe(Math.round(Math.pow(1.2, 5) * 100));
    expect(await findChannel('zoom:reset')!.handler(undefined, desktopCtx())).toBe(100);
    expect(main.level()).toBe(0);
  });
});

describe('document comments: one body, both doors', () => {
  it('a missing path is refused the same way for a phone as for a window (a phone used to send "" and carry on)', async () => {
    for (const name of ['docComments:list', 'docComments:add', 'docComments:watch', 'docComments:unwatch']) {
      expect(await phone(name, {})).toEqual({ reply: true, payload: { ok: false, error: 'missing-field', field: 'path' } });
      expect(await findChannel(name)!.handler({}, desktopCtx())).toEqual({ ok: false, error: 'missing-field', field: 'path' });
    }
  });

  it('a folder the app does not show is refused for a phone; a folder of an open session is known', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-doc-root-')));
    try {
      const refused = await phone('docComments:list', { path: 'a.md', projectRoot: dir }, phoneCtx({ remote: { sessionRoots: () => [] } }));
      expect(refused).toEqual({ reply: true, payload: { ok: false, error: 'unknown-project-root' } });
      const known = await phone('docComments:list', { path: 'a.md', projectRoot: dir }, phoneCtx({ remote: { sessionRoots: () => [dir] } }));
      expect(known).toEqual({ reply: true, payload: { ok: true, comments: [] } });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a phone that never watched can unwatch quietly; one that did drops only its own id', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-doc-watch-')));
    try {
      const remote = (id: number | undefined) => ({ sessionRoots: () => [dir], docCommentsSubscriberId: () => id ?? -1, currentDocCommentsId: () => id });
      expect(await phone('docComments:unwatch', { path: 'a.md', projectRoot: dir }, phoneCtx({ remote: remote(undefined) }))).toEqual({ reply: true, payload: { ok: true } });
      const watched = await phone('docComments:watch', { path: 'a.md', projectRoot: dir }, phoneCtx({ remote: remote(-7) }));
      expect(watched.reply && (watched as any).payload.ok).toBe(true);
      expect(await phone('docComments:unwatch', { path: 'a.md', projectRoot: dir }, phoneCtx({ remote: remote(-7) }))).toEqual({ reply: true, payload: { ok: true } });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the buddy keeps its consent gate', () => {
  const status = { needed: true, supported: true, installed: false };
  const helper = (refusal: string | null) => ({
    refresh: vi.fn(async () => status), showRefusal: vi.fn(() => refusal), install: vi.fn(), remove: vi.fn(),
  });
  const manager = () => ({ show: vi.fn(), hide: vi.fn(), toggleChat: vi.fn(), dismiss: vi.fn(), dragEnded: vi.fn(), setViewedSession: vi.fn(),
    getViewedSession: vi.fn(() => 's1'), moveMascotFromPointer: vi.fn(), setMascotHit: vi.fn(), getStatus: vi.fn(() => ({ dismissed: false, visible: true })), captureWindows: vi.fn(() => []), chatWebContents: vi.fn() });

  it('buddy:show re-reads the helper status and refuses with the gate\'s words, never showing the buddy', async () => {
    const m = manager(); const h = helper('The buddy needs its KDE helper on this desktop, and the helper is not running.');
    bindBuddy({ buddyManager: m as any, helper: h as any });
    expect(await findChannel('buddy:show')!.handler(undefined, desktopCtx())).toEqual({ ok: false, reason: 'The buddy needs its KDE helper on this desktop, and the helper is not running.' });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.showRefusal).toHaveBeenCalledWith(status);
    expect(m.show).not.toHaveBeenCalled();
  });

  it('buddy:show passes only the two known styles on, and buddy:mascot-hit tells the window manager whether the pointer is on him', async () => {
    const m = manager();
    bindBuddy({ buddyManager: m as any, helper: helper(null) as any });
    const show = findChannel('buddy:show')!;
    await show.handler({ style: 'tray' }, desktopCtx());
    await show.handler({ style: 'floating' }, desktopCtx());
    await show.handler({ style: 'sideways' }, desktopCtx());
    await show.handler(undefined, desktopCtx());
    expect(m.show.mock.calls.map((c: unknown[]) => c[0])).toEqual(['tray', 'floating', undefined, undefined]);
    const hit = findChannel('buddy:mascot-hit')!;
    expect(hit.kind).toBe('on');
    hit.handler({ over: true }, desktopCtx());
    hit.handler({ over: 'yes' }, desktopCtx());
    expect(m.setMascotHit.mock.calls).toEqual([[true], [false]]);
  });

  it('buddy:show shows the buddy when the gate lets it through, and the install/remove calls re-read the status after a change', async () => {
    const m = manager(); const h = helper(null);
    bindBuddy({ buddyManager: m as any, helper: h as any });
    expect(await findChannel('buddy:show')!.handler(undefined, desktopCtx())).toEqual({ ok: true });
    expect(m.show).toHaveBeenCalledTimes(1);
    h.install.mockResolvedValueOnce({ ok: true }); h.refresh.mockClear();
    expect(await findChannel('buddy:install-helper')!.handler(undefined, desktopCtx())).toEqual({ ok: true });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    h.remove.mockResolvedValueOnce({ ok: false, error: 'nope' }); h.refresh.mockClear();
    expect(await findChannel('buddy:remove-helper')!.handler(undefined, desktopCtx())).toEqual({ ok: false, error: 'nope' });
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
