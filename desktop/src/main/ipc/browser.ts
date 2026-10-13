// browser.ts — the Browser's channels (spec docs/active/specs/2026-10-13-assistant-browser-design.md).
//
// Every entry is desktopOnly: the browser runs on this computer, and its live
// picture and controls are not sent to phones in this release (a phone's
// remote-shim rejects these; capabilities.assistantBrowser is false there).
//
// Frames go ONLY to the window(s) that asked to watch a conversation, never
// broadcast (performance rule 4: reach only subscribed windows). A window that
// closes stops watching. State changes are small and infrequent, so every
// window hears them (any window may show that conversation's card).
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/backend-contract';
import type { BrowserFrame, BrowserInfo, BrowserSessionState, MyChromeCheck, PromptAnswer } from '../../shared/browser-types';
import { getBrowserClient } from '../assistant-browser/browser-electron';
import { defineChannel, type MainChannelDef } from './channel-def';

type Sender = { id: number; isDestroyed?(): boolean; send?(channel: string, ...args: any[]): void; once?(event: string, listener: () => void): unknown };

/** sessionId → windows watching its picture. */
const watchers = new Map<string, Map<number, Sender>>();
/** Conversations whose picture the WORKER is streaming. A window may start
 *  watching before the browser runs; the stream starts when it does. */
const streaming = new Set<string>();
let wired = false;

function startStream(sessionId: string): void {
  if (streaming.has(sessionId)) return;
  streaming.add(sessionId);
  void getBrowserClient().command({ cmd: 'watch', sessionId }).catch(() => streaming.delete(sessionId));
}

function wire(): void {
  if (wired) return;
  wired = true;
  const client = getBrowserClient();
  client.on('state', (state: BrowserSessionState) => {
    if (state.run !== 'running') streaming.delete(state.sessionId);
    else if (watchers.has(state.sessionId)) startStream(state.sessionId);
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.BROWSER_STATE_CHANGED, state);
  });
  client.on('frame', (frame: BrowserFrame) => {
    const ws = watchers.get(frame.sessionId);
    if (!ws) return;
    for (const s of ws.values()) if (!s.isDestroyed?.()) s.send?.(IPC.BROWSER_FRAME, frame);
  });
  client.on('info-changed', () => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.BROWSER_INFO_CHANGED);
  });
}

function unwatchSender(sessionId: string, senderId: number): void {
  const ws = watchers.get(sessionId);
  if (!ws) return;
  ws.delete(senderId);
  if (!ws.size) {
    watchers.delete(sessionId);
    streaming.delete(sessionId);
    getBrowserClient().commandIfAlive({ cmd: 'unwatch', sessionId });
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v || v.length > 200) throw new TypeError(`${field} must be a short string`);
  return v;
}

const ANSWERS: readonly PromptAnswer[] = ['allow_chat', 'allow_always', 'once', 'no', 'done', 'cant', 'download'];

export const browserChannels: MainChannelDef[] = [
  defineChannel({
    name: IPC.BROWSER_STATE, kind: 'handle', desktopOnly: true,
    // WHY cachedState when the worker isn't up: a panel asking about a
    // conversation must never START the browser's worker just to hear "nothing".
    handler: async (payload) => {
      wire();
      const sessionId = str(payload?.sessionId, 'sessionId');
      const client = getBrowserClient();
      if (!client.alive) return client.cachedState(sessionId);
      return client.command<BrowserSessionState>({ cmd: 'state', sessionId });
    },
  }),
  defineChannel({
    name: IPC.BROWSER_INFO, kind: 'handle', desktopOnly: true,
    handler: () => { wire(); return getBrowserClient().command<BrowserInfo>({ cmd: 'info' }); },
  }),
  defineChannel({
    name: IPC.BROWSER_WATCH, kind: 'handle', desktopOnly: true,
    handler: async (payload, ctx) => {
      wire();
      const sessionId = str(payload?.sessionId, 'sessionId');
      const sender = ctx.sender as Sender | undefined;
      if (!sender) return false;
      let ws = watchers.get(sessionId);
      if (!ws) { ws = new Map(); watchers.set(sessionId, ws); }
      if (!ws.has(sender.id)) {
        ws.set(sender.id, sender);
        sender.once?.('destroyed', () => unwatchSender(sessionId, sender.id));
      }
      // Only start a picture for a browser that's already running — watching
      // must never launch a browser by itself.
      if (getBrowserClient().alive && getBrowserClient().cachedState(sessionId)?.run === 'running') startStream(sessionId);
      return true;
    },
  }),
  defineChannel({
    name: IPC.BROWSER_UNWATCH, kind: 'handle', desktopOnly: true,
    handler: (payload, ctx) => {
      const sessionId = str(payload?.sessionId, 'sessionId');
      if (ctx.sender) unwatchSender(sessionId, ctx.sender.id);
      return true;
    },
  }),
  defineChannel({
    name: IPC.BROWSER_FRAME_ACK, kind: 'on', desktopOnly: true,
    handler: (payload) => { getBrowserClient().commandIfAlive({ cmd: 'ack', sessionId: str(payload?.sessionId, 'sessionId') }); },
  }),
  defineChannel({
    name: IPC.BROWSER_ANSWER, kind: 'handle', desktopOnly: true,
    handler: async (payload) => {
      const answer = payload?.answer;
      if (!ANSWERS.includes(answer)) throw new TypeError('Unknown answer');
      const client = getBrowserClient();
      if (!client.alive) return false;
      return client.command<boolean>({ cmd: 'answer', sessionId: str(payload.sessionId, 'sessionId'), promptId: str(payload.promptId, 'promptId'), answer });
    },
  }),
  defineChannel({
    name: IPC.BROWSER_OPEN_WINDOW_FOR_HANDOFF, kind: 'handle', desktopOnly: true,
    handler: (payload) => getBrowserClient().command<boolean>({ cmd: 'open-window-for-handoff', sessionId: str(payload?.sessionId, 'sessionId') }),
  }),
  defineChannel({
    name: IPC.BROWSER_SET_SHOW_WINDOW, kind: 'handle', desktopOnly: true,
    handler: (payload) => {
      if (typeof payload?.show !== 'boolean') throw new TypeError('show must be true or false');
      wire();
      return getBrowserClient().command<BrowserInfo>({ cmd: 'set-show-window', show: payload.show });
    },
  }),
  defineChannel({
    name: IPC.BROWSER_UPDATE_SETTINGS, kind: 'handle', desktopOnly: true,
    // Validated in the worker (browser-settings.ts validatePatch) — one place.
    handler: (payload) => { wire(); return getBrowserClient().command<BrowserInfo>({ cmd: 'update-settings', patch: payload }); },
  }),
  defineChannel({
    name: IPC.BROWSER_REMOVE_SITE, kind: 'handle', desktopOnly: true,
    handler: (payload) => getBrowserClient().command<BrowserInfo>({ cmd: 'remove-site', host: str(payload?.host, 'host') }),
  }),
  defineChannel({
    name: IPC.BROWSER_CLEAR_SIGNINS, kind: 'handle', desktopOnly: true,
    handler: () => getBrowserClient().command<BrowserInfo>({ cmd: 'clear-signins' }),
  }),
  defineChannel({
    name: IPC.BROWSER_STOP, kind: 'handle', desktopOnly: true,
    handler: async () => {
      const client = getBrowserClient();
      if (!client.alive) return true;
      return client.command<boolean>({ cmd: 'stop' });
    },
  }),
  defineChannel({
    name: IPC.BROWSER_CLOSE_SESSION, kind: 'handle', desktopOnly: true,
    handler: async (payload) => {
      const client = getBrowserClient();
      if (!client.alive) return true;
      return client.command<boolean>({ cmd: 'close-session', sessionId: str(payload?.sessionId, 'sessionId'), forget: false });
    },
  }),
  defineChannel({
    name: IPC.BROWSER_DOWNLOAD, kind: 'handle', desktopOnly: true,
    handler: () => { wire(); return getBrowserClient().command<BrowserInfo>({ cmd: 'download' }); },
  }),
  defineChannel({
    name: IPC.BROWSER_CANCEL_DOWNLOAD, kind: 'handle', desktopOnly: true,
    handler: async () => {
      const client = getBrowserClient();
      if (!client.alive) return true;
      return client.command<boolean>({ cmd: 'cancel-download' });
    },
  }),
  defineChannel({
    name: IPC.BROWSER_CHECK_MY_CHROME, kind: 'handle', desktopOnly: true,
    handler: () => getBrowserClient().command<MyChromeCheck>({ cmd: 'check-my-chrome' }),
  }),
];

/** Called once at startup so state pushes reach windows from the first tool call. */
export function wireBrowserPushes(): void { wire(); }
