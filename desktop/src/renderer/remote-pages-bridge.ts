// The remote shim's `window.claude.pages`: the same shape as preload's, over
// the shim's WebSocket. Moved out of remote-shim.ts (at its line budget) when
// the live socket arrived.
//
// WHY the shim tracks live sockets itself: a socket lives on the computer, and
// when THIS browser's connection to the computer drops, the computer closes
// every socket this client owned (its drop() handler) and cannot tell us. So the
// shim tells the page side the truth — each live socket reports 'closed'.
import type { PageSocketEvent, PagesBridge } from '../shared/pages-types';

type Invoke = (type: string, payload?: any) => Promise<any>;
type Listen = (channel: string, cb: (...args: any[]) => void) => (...args: any[]) => void;
type Unlisten = (channel: string, cb: (...args: any[]) => void) => void;

export function createRemotePagesBridge(invoke: Invoke, addListener: Listen, removeListener: Unlisten) {
  const live = new Set<string>();
  const socketSubs = new Set<(e: PageSocketEvent) => void>();
  const tell = (e: PageSocketEvent) => { for (const cb of [...socketSubs]) { try { cb(e); } catch { /* one listener's error is not another's */ } } };

  const bridge: PagesBridge = {
    list: () => invoke('pages:list'),
    get: (id: string) => invoke('pages:get', { id }),
    setPinned: (id: string, pinned: boolean) => invoke('pages:set-pinned', { id, pinned }),
    setData: (id: string, data: unknown) => invoke('pages:set-data', { id, data }),
    onChanged: (cb: (pages: any[]) => void) => {
      const handler = addListener('pages:changed', (pages: any) => cb(pages));
      return () => removeListener('pages:changed', handler);
    },
    // Phase 2. Approving from here may only REUSE a key already saved on the
    // desktop; the host refuses pasted key material from a remote caller, so
    // the rule holds even if this file is bypassed entirely.
    approve: (id: string, keys: Record<string, string>, addresses?: Record<string, string>) => invoke('pages:approve', { id, keys, addresses }),
    removeConnection: (id: string, connectionId: string) => invoke('pages:remove-connection', { id, connectionId }),
    refresh: (id: string) => invoke('pages:refresh', { id }),
    savedKeys: () => invoke('pages:saved-keys'),
    deleteSavedKey: (service: string, address: string) => invoke('pages:delete-saved-key', { service, address }),
    // The request runs on the desktop, with the desktop's credential; only
    // the redacted answer crosses the socket.
    fetch: (id: string, request: any) => invoke('pages:fetch', { id, request }),
    socketOpen: async (req) => {
      const r = await invoke('pages:socket-open', req);
      if (r?.ok) live.add(r.socket);
      return r;
    },
    socketSend: (req) => invoke('pages:socket-send', req),
    socketClose: (req) => { live.delete(req.socket); return invoke('pages:socket-close', req); },
    socketPing: (req) => invoke('pages:socket-ping', req),
    // Camera video: the same route; its events arrive on the socket-event push.
    videoStart: async (req) => {
      const r = await invoke('pages:video-start', req);
      if (r?.ok) live.add(r.video);
      return r;
    },
    videoStop: (req) => { live.delete(req.video); return invoke('pages:video-stop', req); },
    videoPing: (req) => invoke('pages:video-ping', req),
    onSocketEvent: (cb) => { socketSubs.add(cb); return () => { socketSubs.delete(cb); }; },
  };

  return {
    bridge,
    /** A `pages:socket-event` push from the computer. */
    push(event: PageSocketEvent): void {
      if ((event?.kind === 'state' && event.state === 'closed') || event?.kind === 'video-stopped') live.delete(event.socket);
      tell(event);
    },
    /** This browser's connection to the computer dropped. */
    connectionLost(): void {
      // Sockets and videos share this set; a video id starts with "lv_" (page-live-video.ts).
      for (const socket of [...live]) tell(socket.startsWith('lv_') ? { socket, kind: 'video-stopped', why: 'Lost the connection to your computer.' } : { socket, kind: 'state', state: 'closed', why: 'Lost the connection to your computer.' });
      live.clear();
    },
  };
}
