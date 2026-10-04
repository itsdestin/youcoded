// The remote host's side of the pages:* channels (a phone or browser over
// remote access): the same PagesService the desktop windows use, so a remote
// browser sees the same library, approvals and live sockets.
//
// WHY its own file: these cases lived in remote-server.ts, which is at its line
// budget. remote-server.ts calls handlePagesMessage() first for any `pages:*`
// type and keeps only the client bookkeeping (drop → closeOwner).
import WebSocket from 'ws';
import { getPagesService } from './pages-service';
import { PAGE_SOCKET_CHANNELS, type PageFetchRequest, type PageSocketEvent } from '../../shared/pages-types';
import { LIVE_LIMITS, type PushResult } from './page-live-socket';

/** The part of a remote client this file needs. */
export interface RemotePagesClient {
  id: string;
  ws: Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send'>;
}

export const clientOwnerKey = (clientId: string): string => `client:${clientId}`;

/** Push one socket event to ONE remote client. Deliberately not broadcast()
 *  (another client's socket is not theirs to see) and not the restore queue
 *  (a live feed is not something to replay later). A client that has stopped
 *  reading loses this socket — the caller closes it — never its connection. */
export function sendToClient(client: RemotePagesClient, event: PageSocketEvent): PushResult {
  if (client.ws.readyState !== WebSocket.OPEN) return 'gone';
  if (client.ws.bufferedAmount > LIVE_LIMITS.remoteBacklogBytes) return 'backed-up';
  client.ws.send(JSON.stringify({ type: PAGE_SOCKET_CHANNELS.event, payload: event }));
  return 'sent';
}

/** Answers one `pages:*` request. Returns false for a type that is not ours. */
export async function handlePagesMessage(
  client: RemotePagesClient, type: string, payload: any, respond: (payload: unknown) => void,
): Promise<boolean> {
  const svc = getPagesService();
  const none = { ok: false, message: 'Pages are not available on this host.' };
  const owner = () => ({ key: clientOwnerKey(client.id), push: (e: PageSocketEvent) => sendToClient(client, e) });
  try {
    switch (type) {
      case 'pages:list': respond(await svc?.store.list() ?? []); break;
      case 'pages:get':
        respond(svc ? await svc.store.get(String(payload?.id ?? '')) : { ok: false, failure: { kind: 'unreadable', message: none.message } });
        break;
      case 'pages:set-pinned': respond(await svc?.store.setPinned(String(payload?.id ?? ''), !!payload?.pinned) ?? []); break;
      case 'pages:set-data': respond(svc ? await svc.store.setData(String(payload?.id ?? ''), payload?.data) : none); break;
      // Pages Phase 2. `remote: true` below is the enforcement point for "no
      // keys on the phone" (design review 1, finding 13): it was a renderer
      // rule, and a crafted socket message walked straight past it. Reusing a
      // key already saved on this computer is still allowed. pages:fetch runs
      // HERE, with this computer's credential; only the redacted answer travels.
      case 'pages:approve':
        respond(await svc?.approve(String(payload?.id ?? ''), (payload?.keys ?? {}) as Record<string, string>, { remote: true, addresses: (payload?.addresses ?? {}) as Record<string, string> }) ?? none);
        break;
      case 'pages:remove-connection': respond(await svc?.removeConnection(String(payload?.id ?? ''), String(payload?.connectionId ?? '')) ?? []); break;
      case 'pages:refresh': respond(await svc?.refresh(String(payload?.id ?? '')) ?? []); break;
      case 'pages:saved-keys': respond(await svc?.savedKeys() ?? []); break;
      case 'pages:delete-saved-key': respond(await svc?.deleteSavedKey(String(payload?.service ?? ''), String(payload?.address ?? '')) ?? []); break;
      case 'pages:fetch':
        respond(await svc?.fetch(String(payload?.id ?? ''), (payload?.request ?? { url: '' }) as PageFetchRequest) ?? { ok: false, reason: 'network', message: none.message });
        break;
      // The live socket: the owner is THIS client, so another client (or a
      // forged id) can never send to, close or hear a socket it did not open.
      case 'pages:socket-open': respond(svc ? await svc.sockets.open(owner(), payload ?? {}) : none); break;
      case 'pages:socket-send': respond(svc ? svc.sockets.send(clientOwnerKey(client.id), payload ?? {}) : none); break;
      case 'pages:socket-close': respond(svc ? svc.sockets.close(clientOwnerKey(client.id), payload ?? {}) : none); break;
      case 'pages:socket-ping': respond(svc ? svc.sockets.ping(clientOwnerKey(client.id), payload ?? {}) : none); break;
      default: return false;
    }
  } catch (err: any) {
    // Same shapes the individual cases used to answer with.
    const message = err?.message ?? String(err);
    if (type === 'pages:fetch') respond({ ok: false, reason: 'network', message });
    else if (type === 'pages:get') respond({ ok: false, failure: { kind: 'unreadable', message } });
    else if (type === 'pages:list' || type === 'pages:set-pinned' || type === 'pages:remove-connection' || type === 'pages:refresh' || type === 'pages:saved-keys' || type === 'pages:delete-saved-key') respond({ ok: false, error: message });
    else respond({ ok: false, message });
  }
  return true;
}
