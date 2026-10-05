// The desktop window's side of the pages:* channels: the library, approvals,
// the one door (`pages:fetch`) and the live socket (`pages:socket-*`).
//
// WHY its own file: these handlers used to sit in ipc-handlers.ts, which is at
// its line budget. The remote host's twin is pages-remote.ts; the five places
// a channel must exist are listed in .claude/rules/ipc-bridge.md.
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { IPC } from '../../shared/types';
import { PAGE_SOCKET_CHANNELS, PAGE_VIDEO_CHANNELS, type PageFetchRequest, type PageSocketEvent } from '../../shared/pages-types';
import type { getPagesService } from './pages-service';
import type { PushResult } from './page-live-socket';

type Service = NonNullable<ReturnType<typeof getPagesService>>;

/** The part of a webContents this file touches (a test hands in its own). */
interface SenderLike {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once(event: 'destroyed', l: () => void): unknown;
  on(event: 'did-start-navigation', l: (d: { isMainFrame?: boolean; isSameDocument?: boolean }) => void): unknown;
  on(event: 'render-process-gone', l: () => void): unknown;
}

const watched = new Set<number>();

/** Close a window's sockets whenever the window can no longer be holding them:
 *  its page navigated (Ctrl+R included), its renderer crashed, or it was
 *  destroyed. Main-frame, cross-document navigation only — a page's own iframe
 *  or an in-page hash change must not close its sockets (unsaved-quit.ts has
 *  the same filter). Registered once per window, on its first socket call. */
function watchSender(svc: Service, sender: SenderLike): void {
  if (watched.has(sender.id)) return;
  watched.add(sender.id);
  const key = windowOwnerKey(sender.id);
  const gone = () => svc.closeOwner(key); // sockets AND videos
  sender.once('destroyed', () => { gone(); watched.delete(sender.id); });
  sender.on('did-start-navigation', (d) => { if (d?.isMainFrame && !d.isSameDocument) gone(); });
  sender.on('render-process-gone', gone);
}

const windowOwnerKey = (webContentsId: number): string => `window:${webContentsId}`;

export function registerPagesIpc(ipcMain: IpcMain, pagesService: Service): void {
  ipcMain.handle(IPC.PAGES_LIST, async () => { pagesService.ensureWatching(); return pagesService.listAndWatch(); });
  ipcMain.handle(IPC.PAGES_GET, async (_e, id: string) => pagesService.store.get(String(id ?? '')));
  ipcMain.handle(IPC.PAGES_SET_PINNED, async (_e, id: string, pinned: boolean) => pagesService.store.setPinned(String(id ?? ''), !!pinned));
  ipcMain.handle(IPC.PAGES_SET_DATA, async (_e, id: string, data: unknown) => pagesService.store.setData(String(id ?? ''), data));
  // Phase 2. `remote: false` here and `true` in pages-remote.ts is the whole
  // of "no keys on the phone" (design review 1, finding 13): a desktop window
  // may paste a key, a remote caller may only reuse one already saved. `addresses`: per device line (re-checked in main).
  ipcMain.handle(IPC.PAGES_APPROVE, async (_e, id: string, keys: Record<string, string>, addresses?: Record<string, string>) =>
    pagesService.approve(String(id ?? ''), keys ?? {}, { remote: false, addresses: addresses ?? {} }));
  ipcMain.handle(IPC.PAGES_REMOVE_CONNECTION, async (_e, id: string, connectionId: string) =>
    pagesService.removeConnection(String(id ?? ''), String(connectionId ?? '')));
  ipcMain.handle(IPC.PAGES_REFRESH, async (_e, id: string) => pagesService.refresh(String(id ?? '')));
  ipcMain.handle(IPC.PAGES_SAVED_KEYS, async () => pagesService.savedKeys());
  ipcMain.handle(IPC.PAGES_DELETE_SAVED_KEY, async (_e, service: string, address: string) =>
    pagesService.deleteSavedKey(String(service ?? ''), String(address ?? '')));
  ipcMain.handle(IPC.PAGES_FETCH, async (_e, id: string, req: PageFetchRequest) =>
    pagesService.fetch(String(id ?? ''), req ?? { url: '' }));

  // The live socket. The owner is `event.sender` — the window that asked —
  // never anything the caller says about itself, and events go to that window only.
  const ch = PAGE_SOCKET_CHANNELS;
  const ownerOf = (e: IpcMainInvokeEvent) => {
    const sender = e.sender as unknown as SenderLike;
    watchSender(pagesService, sender);
    return {
      key: windowOwnerKey(sender.id),
      push: (event: PageSocketEvent): PushResult => {
        // WHY try/catch: webContents.send can throw for a frame being torn down even after the
        // isDestroyed check, and this runs in timers and socket callbacks (an uncaught throw there
        // is a main-process crash). A failed push closes that one socket.
        try {
          if (sender.isDestroyed()) return 'gone';
          sender.send(ch.event, event);
          return 'sent';
        } catch { return 'gone'; }
      },
    };
  };
  ipcMain.handle(ch.open, (e, req) => pagesService.sockets.open(ownerOf(e), req ?? {}));
  ipcMain.handle(ch.send, (e, req) => pagesService.sockets.send(ownerOf(e).key, req ?? {}));
  ipcMain.handle(ch.close, (e, req) => pagesService.sockets.close(ownerOf(e).key, req ?? {}));
  ipcMain.handle(ch.ping, (e, req) => pagesService.sockets.ping(ownerOf(e).key, req ?? {}));
  // Camera video: same owner rule; its events ride the same push channel (pages:socket-event).
  const vid = PAGE_VIDEO_CHANNELS;
  ipcMain.handle(vid.start, (e, req) => pagesService.videos.start(ownerOf(e), req ?? {}));
  ipcMain.handle(vid.stop, (e, req) => pagesService.videos.stop(ownerOf(e).key, req ?? {}));
  ipcMain.handle(vid.ping, (e, req) => pagesService.videos.ping(ownerOf(e).key, req ?? {}));
}
