// pages.ts — the YouCoded Pages channels (pages:*), one table entry each, served to the computer's windows
// and to a phone. (The `pages:changed` PUSH, the service itself and its watchers stay in ipc-handlers.ts /
// pages/pages-service.ts: a change reaches every window and every phone, as before.)
//
// WHY (2026-09-30 one-core R3-7): ten ipcMain handlers in ipc-handlers.ts and ten phone `case`s in
// remote-server.ts, over the same service. A phone can do everything the computer's windows can with Pages,
// EXCEPT one thing, now declared in one place: pages:approve is told which door it came in through, and a
// phone may only REUSE a key already saved on this computer, never type a new one (design review 1,
// finding 13 — "no keys on the phone"; it used to be a rule in the renderer and a crafted socket message
// walked past it). pages:fetch runs HERE with this computer's credential; only the redacted answer travels.
//
// Each entry keeps the soft answer a phone's page was always given when the call fails
// (`remoteOnError`), because the Pages screens read those shapes (a list, `{ok:false,message}`, ...).
//
// WHY the live socket and camera video are here too (2026-10-05, HA-pages branch merged into one-core): they are
// ordinary request/answer channels, so each is one entry, run by both doors. What a table entry cannot say by itself,
// the owner (the calling window or phone, taken from the door never the request), the push of events back to that
// owner only, and "close when the window navigates/crashes/is destroyed or the phone drops", lives in
// pages/page-owner.ts; the events themselves are the `pages:socket-event` push (no entry). Both doors share caps,
// leases and redaction because they are the same PagesService.sockets / .videos.
//
// WHAT A PHONE SEES, before -> now: pages:list now also starts watching each project's Pages folder, as the
// computer's own list does (the phone's old list only read). Nothing else differs.
import { IPC } from '../../shared/backend-contract';
import { getPagesService } from '../pages/pages-service';
import type { SocketOwner } from '../pages/page-live-socket';
import { windowOwner, clientOwnerKey, type SenderLike } from '../pages/page-owner';
import { defineChannel, type MainChannelCtx, type MainChannelDef } from './channel-def';

const NOT_AVAILABLE = 'Pages are not available on this host.';
const msg = (e: unknown) => (e as Error)?.message ?? String(e);
const failure = (e: unknown) => ({ ok: false, error: msg(e) });
const str = (v: unknown) => String(v ?? '');
const socketFailure = (e: unknown) => ({ ok: false as const, message: msg(e) });
// A page's live socket / video belongs to the window or phone that opened it: the owner comes from the DOOR (the calling
// window's webContents, or this phone's connection), never from the request, so no caller can name someone else's.
// Null only if a door failed to say who is calling (never in practice; the handler then refuses rather than guess).
function ownerOf(svc: NonNullable<ReturnType<typeof getPagesService>>, ctx: MainChannelCtx): SocketOwner | null {
  if (ctx.door === 'remote') {
    if (!ctx.clientId || !ctx.remote) return null;
    return { key: clientOwnerKey(ctx.clientId), push: ctx.remote.pageSocketPush };
  }
  return ctx.sender ? windowOwner(svc, ctx.sender as SenderLike) : null;
}
const NO_OWNER = { ok: false as const, message: 'Could not tell which window is asking.' };

export const pagesChannels: MainChannelDef[] = [
  defineChannel({
    name: IPC.PAGES_LIST, kind: 'handle', remoteOnError: failure,
    handler: async () => {
      const svc = getPagesService();
      if (!svc) return [];
      svc.ensureWatching();
      return svc.listAndWatch();
    },
  }),
  defineChannel({
    name: IPC.PAGES_GET, kind: 'handle',
    remoteOnError: (e) => ({ ok: false, failure: { kind: 'unreadable', message: msg(e) } }),
    handler: async (p) => {
      const svc = getPagesService();
      return svc ? svc.store.get(str(p?.id)) : { ok: false, failure: { kind: 'unreadable', message: NOT_AVAILABLE } };
    },
  }),
  defineChannel({
    name: IPC.PAGES_SET_PINNED, kind: 'handle', remoteOnError: failure,
    handler: async (p) => (await getPagesService()?.store.setPinned(str(p?.id), !!p?.pinned)) ?? [],
  }),
  defineChannel({
    name: IPC.PAGES_SET_DATA, kind: 'handle',
    remoteOnError: (e) => ({ ok: false, message: msg(e) }),
    handler: async (p) => {
      const svc = getPagesService();
      return svc ? svc.store.setData(str(p?.id), p?.data) : { ok: false, message: NOT_AVAILABLE };
    },
  }),
  // `remote` is the whole of "no keys on the phone": the door that took the call says who is asking, never the payload.
  defineChannel({
    name: IPC.PAGES_APPROVE, kind: 'handle',
    remoteOnError: (e) => ({ ok: false, message: msg(e) }),
    // `addresses`: the address the person allowed per device line, re-checked in main (page-device-address.ts).
    handler: async (p, ctx) =>
      (await getPagesService()?.approve(str(p?.id), (p?.keys ?? {}) as Record<string, string>, { remote: ctx.door === 'remote', addresses: (p?.addresses ?? {}) as Record<string, string> }))
        ?? { ok: false as const, message: NOT_AVAILABLE },
  }),
  defineChannel({
    name: IPC.PAGES_REMOVE_CONNECTION, kind: 'handle', remoteOnError: failure,
    handler: async (p) => (await getPagesService()?.removeConnection(str(p?.id), str(p?.connectionId))) ?? [],
  }),
  defineChannel({
    name: IPC.PAGES_REFRESH, kind: 'handle', remoteOnError: failure,
    handler: async (p) => (await getPagesService()?.refresh(str(p?.id))) ?? [],
  }),
  defineChannel({
    name: IPC.PAGES_SAVED_KEYS, kind: 'handle', remoteOnError: failure,
    handler: async () => (await getPagesService()?.savedKeys()) ?? [],
  }),
  defineChannel({
    name: IPC.PAGES_DELETE_SAVED_KEY, kind: 'handle', remoteOnError: failure,
    handler: async (p) => (await getPagesService()?.deleteSavedKey(str(p?.service), str(p?.address))) ?? [],
  }),
  defineChannel({
    name: IPC.PAGES_FETCH, kind: 'handle',
    remoteOnError: (e) => ({ ok: false, reason: 'network', message: msg(e) }),
    handler: async (p) =>
      (await getPagesService()?.fetch(str(p?.id), p?.request ?? { url: '' }))
        ?? { ok: false as const, reason: 'network' as const, message: NOT_AVAILABLE },
  }),
  defineChannel({
    name: IPC.PAGES_SOCKET_OPEN, kind: 'handle', remoteOnError: socketFailure,
    handler: async (p, ctx) => {
      const svc = getPagesService();
      const owner = svc && ownerOf(svc, ctx);
      return !svc ? { ok: false as const, message: NOT_AVAILABLE } : owner ? svc.sockets.open(owner, p ?? {}) : NO_OWNER;
    },
  }),
  defineChannel({
    name: IPC.PAGES_SOCKET_SEND, kind: 'handle', remoteOnError: socketFailure,
    handler: async (p, ctx) => { const s = getPagesService(); const o = s && ownerOf(s, ctx); return !s ? { ok: false as const, message: NOT_AVAILABLE } : o ? s.sockets.send(o.key, p ?? {}) : NO_OWNER; },
  }),
  defineChannel({
    name: IPC.PAGES_SOCKET_CLOSE, kind: 'handle', remoteOnError: socketFailure,
    handler: async (p, ctx) => { const s = getPagesService(); const o = s && ownerOf(s, ctx); return !s ? { ok: false as const, message: NOT_AVAILABLE } : o ? s.sockets.close(o.key, p ?? {}) : NO_OWNER; },
  }),
  defineChannel({
    name: IPC.PAGES_SOCKET_PING, kind: 'handle', remoteOnError: socketFailure,
    handler: async (p, ctx) => { const s = getPagesService(); const o = s && ownerOf(s, ctx); return !s ? { ok: false as const, message: NOT_AVAILABLE } : o ? s.sockets.ping(o.key, p ?? {}) : NO_OWNER; },
  }),
  // Camera video: same owner rule; its events ride the same push (pages:socket-event).
  defineChannel({
    name: IPC.PAGES_VIDEO_START, kind: 'handle', remoteOnError: socketFailure,
    handler: async (p, ctx) => { const s = getPagesService(); const o = s && ownerOf(s, ctx); return !s ? { ok: false as const, message: NOT_AVAILABLE } : o ? s.videos.start(o, p ?? {}) : NO_OWNER; },
  }),
  defineChannel({
    name: IPC.PAGES_VIDEO_STOP, kind: 'handle', remoteOnError: socketFailure,
    handler: async (p, ctx) => { const s = getPagesService(); const o = s && ownerOf(s, ctx); return !s ? { ok: false as const, message: NOT_AVAILABLE } : o ? s.videos.stop(o.key, p ?? {}) : NO_OWNER; },
  }),
  defineChannel({
    name: IPC.PAGES_VIDEO_PING, kind: 'handle', remoteOnError: socketFailure,
    handler: async (p, ctx) => { const s = getPagesService(); const o = s && ownerOf(s, ctx); return !s ? { ok: false as const, message: NOT_AVAILABLE } : o ? s.videos.ping(o.key, p ?? {}) : NO_OWNER; },
  }),
];
