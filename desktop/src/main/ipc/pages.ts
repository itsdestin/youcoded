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
import { windowOwner, windowOwnerKey, clientOwnerKey, type SenderLike } from '../pages/page-owner';
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
/** The caller's owner key, without watching the window (approve only needs the name). */
function ownerKeyOf(ctx: MainChannelCtx): string | undefined {
  if (ctx.door === 'remote') return ctx.clientId ? clientOwnerKey(ctx.clientId) : undefined;
  return ctx.sender ? windowOwnerKey((ctx.sender as SenderLike).id) : undefined;
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
      (await getPagesService()?.approve(str(p?.id), (p?.keys ?? {}) as Record<string, string>, {
        remote: ctx.door === 'remote', addresses: (p?.addresses ?? {}) as Record<string, string>,
        // `folders`: a Choose folder token per folder line, spendable only by the window that chose it.
        folders: (p?.folders ?? {}) as Record<string, string>, ownerKey: ownerKeyOf(ctx),
      }))
        ?? { ok: false as const, message: NOT_AVAILABLE },
  }),
  defineChannel({
    name: IPC.PAGES_REMOVE_CONNECTION, kind: 'handle', remoteOnError: failure,
    handler: async (p) => (await getPagesService()?.removeConnection(str(p?.id), str(p?.connectionId))) ?? [],
  }),
  // "Open this website?" (pages-finish step 1). Both doors: a phone records "Don't ask
  // again" too (Destin, 2026-10-24), and opens the address itself (`open: false`) so it
  // appears on the phone, never on this computer's screen.
  defineChannel({
    name: IPC.PAGES_OPEN_WEBSITE, kind: 'handle',
    remoteOnError: (e) => ({ ok: false as const, message: msg(e), pages: [] }),
    handler: async (p, ctx) =>
      (await getPagesService()?.openWebsite(str(p?.id), str(p?.url), p?.remember === true, ctx.door === 'remote' ? false : p?.open !== false))
        ?? { ok: false as const, message: NOT_AVAILABLE, pages: [] },
  }),
  defineChannel({
    name: IPC.PAGES_FORGET_OPEN_SITE, kind: 'handle', remoteOnError: failure,
    handler: async (p) => (await getPagesService()?.forgetOpenSite(str(p?.id), str(p?.site))) ?? [],
  }),
  // A page's files (pages-finish step 2). The caller is the DOOR's (window or phone), never the
  // request's, so a handle or an ask belongs to the screen that got it. A phone gets an `ask` for
  // YouCoded's own chooser instead of an Open window, and its listing (pages:list-folder) is
  // answered only while that ask waits. Choosing or changing a page's folder shows the computer's
  // Choose folder window, so those two are desktop only.
  defineChannel({
    name: IPC.PAGES_FILES, kind: 'handle',
    remoteOnError: (e) => ({ ok: false as const, op: 'read' as const, code: 'FAILED' as const, message: msg(e) }),
    handler: async (p, ctx) => {
      const svc = getPagesService();
      const owner = svc && ownerOf(svc, ctx);
      const op = p?.request?.op ?? 'read';
      if (!svc) return { ok: false as const, op, code: 'UNSUPPORTED' as const, message: NOT_AVAILABLE };
      if (!owner) return { ok: false as const, op, code: 'FAILED' as const, message: NO_OWNER.message };
      return svc.files.call({ ownerKey: owner.key, remote: ctx.door === 'remote', sender: ctx.sender }, str(p?.id), (p?.request ?? {}) as never);
    },
  }),
  defineChannel({
    name: IPC.PAGES_CHOOSE_FOLDER, kind: 'handle', desktopOnly: true,
    handler: async (_p, ctx) => {
      const svc = getPagesService();
      const owner = svc && ownerOf(svc, ctx);
      return svc && owner ? svc.files.chooseFolder({ ownerKey: owner.key, remote: false, sender: ctx.sender }) : { ok: false as const, message: NOT_AVAILABLE };
    },
  }),
  defineChannel({
    name: IPC.PAGES_SET_FOLDER, kind: 'handle', desktopOnly: true,
    handler: async (p, ctx) => {
      const svc = getPagesService();
      const owner = svc && ownerOf(svc, ctx);
      return svc && owner ? svc.setFolder(str(p?.id), str(p?.connectionId), str(p?.token), owner.key) : [];
    },
  }),
  defineChannel({
    name: IPC.PAGES_FORGET_FILE, kind: 'handle', remoteOnError: failure,
    handler: async (p) => (await getPagesService()?.forgetFile(str(p?.id), str(p?.connectionId), str(p?.fileId))) ?? [],
  }),
  defineChannel({
    name: IPC.PAGES_LIST_FOLDER, kind: 'handle', remoteOnError: (e) => ({ ok: false as const, message: msg(e) }),
    handler: async (p, ctx) => {
      const svc = getPagesService();
      const owner = svc && ownerOf(svc, ctx);
      if (!svc || !owner) return { ok: false as const, message: NOT_AVAILABLE };
      return svc.files.listForAsk({ ownerKey: owner.key, remote: ctx.door === 'remote' }, str(p?.id), str(p?.ask), str(p?.folder));
    },
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
  // Plaid (finance dashboard): a bank sign-in opens a browser on THIS computer, so a phone never reaches it.
  defineChannel({
    name: IPC.PAGES_PLAID, kind: 'handle', desktopOnly: true,
    handler: async (p) =>
      (await getPagesService()?.plaid(str(p?.id), p?.request))
        ?? { ok: false as const, op: 'status' as const, code: 'UNAVAILABLE', message: NOT_AVAILABLE },
  }),
  // Programs a page runs from its own folder (spec 2026-10-16). Desktop only: a program runs with this computer
  // account's full access, and widening what a PHONE may call is Destin's decision (phone-open-channels.json),
  // so a phone is refused until he says otherwise. The owner (calling window) comes from the door, never the
  // request, so closing that window stops what it started and one window cannot stop another's.
  defineChannel({
    name: IPC.PAGES_RUN_PROGRAM, kind: 'handle', desktopOnly: true,
    handler: async (p, ctx) => {
      const svc = getPagesService();
      const owner = svc && ownerOf(svc, ctx);
      if (!svc) return { ok: false as const, reason: NOT_AVAILABLE };
      return owner ? svc.runProgram(owner.key, str(p?.id), str(p?.file), typeof p?.input === 'string' ? p.input : '') : { ok: false as const, reason: NO_OWNER.message };
    },
  }),
  defineChannel({
    name: IPC.PAGES_STOP_PROGRAMS, kind: 'handle', desktopOnly: true,
    handler: async (p, ctx) => {
      const svc = getPagesService();
      const owner = svc && ownerOf(svc, ctx);
      return svc && owner ? svc.stopPrograms(owner.key, str(p?.id)) : { ok: true as const };
    },
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
