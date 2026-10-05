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
// WHAT A PHONE SEES, before -> now: pages:list now also starts watching each project's Pages folder, as the
// computer's own list does (the phone's old list only read). Nothing else differs.
import { IPC } from '../../shared/backend-contract';
import { getPagesService } from '../pages/pages-service';
import { defineChannel, type MainChannelDef } from './channel-def';

const NOT_AVAILABLE = 'Pages are not available on this host.';
const msg = (e: unknown) => (e as Error)?.message ?? String(e);
const failure = (e: unknown) => ({ ok: false, error: msg(e) });
const str = (v: unknown) => String(v ?? '');

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
    handler: async (p, ctx) =>
      (await getPagesService()?.approve(str(p?.id), (p?.keys ?? {}) as Record<string, string>, { remote: ctx.door === 'remote' }))
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
];
