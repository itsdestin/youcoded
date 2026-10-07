// Who "owns" a live page socket or camera video, for the two doors of the pages:socket-* / pages:video-* channels
// (table entries in main/ipc/pages.ts).
//
// WHY this file exists (2026-10-05 one-core merge of the HA-pages branch): master moved every pages:* request into
// the ONE channel table, which both doors run. A live socket adds two things a table entry cannot say by itself:
//   1. an OWNER: the calling window (desktop door) or the calling phone (remote door). It is read from the door's
//      own context (event.sender / the phone's socket), NEVER from the request, so one window or phone can never
//      send to, ping, close or hear another's socket;
//   2. a lifetime: sockets and videos close when the window navigates, crashes or is destroyed, or when the phone's
//      connection drops (remote-server.ts calls closeOwner with clientOwnerKey on every real drop).
// The handlers stay in the table; only this ownership plumbing lives here.
import WebSocket from 'ws';
import { PAGE_SOCKET_CHANNELS, type PageSocketEvent } from '../../shared/pages-types';
import { LIVE_LIMITS, type PushResult, type SocketOwner } from './page-live-socket';
import type { getPagesService } from './pages-service';

type Service = NonNullable<ReturnType<typeof getPagesService>>;

/** The part of a window's webContents this file touches (a test hands in its own). */
export interface SenderLike {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once(event: 'destroyed', l: () => void): unknown;
  on(event: 'did-start-navigation', l: (d: { isMainFrame?: boolean; isSameDocument?: boolean }) => void): unknown;
  on(event: 'render-process-gone', l: () => void): unknown;
}

const windowOwnerKey = (webContentsId: number): string => `window:${webContentsId}`;
export const clientOwnerKey = (clientId: string): string => `client:${clientId}`;

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

/** The owner for a call from a computer window. Events go to that window only. */
export function windowOwner(svc: Service, sender: SenderLike): SocketOwner {
  watchSender(svc, sender);
  return {
    key: windowOwnerKey(sender.id),
    push: (event: PageSocketEvent): PushResult => {
      // WHY try/catch: webContents.send can throw for a frame being torn down even after the
      // isDestroyed check, and this runs in timers and socket callbacks (an uncaught throw there
      // is a main-process crash). A failed push closes that one socket.
      try {
        if (sender.isDestroyed()) return 'gone';
        sender.send(PAGE_SOCKET_CHANNELS.event, event);
        return 'sent';
      } catch { return 'gone'; }
    },
  };
}

/** The part of a phone's connection the push needs. */
export interface RemotePagesClient {
  id: string;
  ws: Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send'>;
}

/** Push one socket event to ONE remote client. Deliberately not broadcast()
 *  (another client's socket is not theirs to see) and not the restore queue
 *  (a live feed is not something to replay later). A client that has stopped
 *  reading loses this socket — the caller closes it — never its connection. */
export function sendToClient(client: RemotePagesClient, event: PageSocketEvent): PushResult {
  if (client.ws.readyState !== WebSocket.OPEN) return 'gone';
  // WHY the closing frame is let through a backlog: a socket closed because the phone is slow must still be able
  // to say so (one tiny frame), or the page never learns it is closed.
  const closing = (event.kind === 'state' && event.state === 'closed') || event.kind === 'video-stopped';
  if (!closing && client.ws.bufferedAmount > LIVE_LIMITS.remoteBacklogBytes) return 'backed-up';
  // WHY try/catch: this runs inside timers and socket callbacks, where a throw is an uncaught exception
  // in the main process. A client that cannot be written to is gone as far as this socket is concerned.
  try { client.ws.send(JSON.stringify({ type: PAGE_SOCKET_CHANNELS.event, payload: event })); } catch { return 'gone'; }
  return 'sent';
}
