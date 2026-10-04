import { useEffect, type RefObject } from 'react';
import type { PagesBridge } from '../../../shared/pages-types';
import { createPageSocketHub } from './page-socket-host';

/** Listens for a page's live-socket messages while its frame is running.
 *  `docKey` is the document the frame was built from: a new document (or the
 *  frame going away — `active` false) ends this effect, and ending it
 *  disposes the hub, which closes every socket that frame opened. WHY the
 *  `e.source` check: every sandboxed frame in the app has origin 'null', so
 *  only the window that IS this page's frame may speak for it. */
export function usePageSockets(
  frameRef: RefObject<HTMLIFrameElement | null>,
  pageId: string | null,
  active: boolean,
  docKey: string | null,
  bridge: () => PagesBridge | undefined,
): void {
  useEffect(() => {
    if (!active || pageId === null) return;
    const hub = createPageSocketHub({
      pageId, bridge,
      post: (message) => { try { frameRef.current?.contentWindow?.postMessage(message, '*'); } catch { /* the frame went away */ } },
    });
    const onMessage = (e: MessageEvent) => {
      if (!e.source || e.source !== frameRef.current?.contentWindow) return;
      const d = e.data as { type?: unknown } | null;
      if (d && typeof d === 'object') hub.handleFrameMessage(d);
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); hub.dispose(); };
    // `bridge` and `frameRef` are stable for the life of the host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pageId, docKey]);
}
