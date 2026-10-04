import { useEffect, type RefObject } from 'react';
import type { PagesBridge } from '../../../shared/pages-types';
import { createPageSocketHub } from './page-socket-host';
import { createPageVideoHub, type VideoHostDeps } from './page-video-host';

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
    // Camera video for the same frame instance (page-video-host.ts): it ends with
    // the hub, so a frame going away stops its videos exactly as it closes its sockets.
    const video = createPageVideoHub({
      pageId, frame: hub.frame, bridge,
      // The workbench's fake backend may bring a pretend peer and frame source (no real camera there);
      // the real bridges never set this.
      deps: bridge()?.videoPlayback as Partial<VideoHostDeps> | undefined,
      // WHY a boolean: postMessage to a frame that is gone does nothing and does not throw; the video
      // hub needs to know, to close the picture it was about to hand over.
      post: (message, transfer) => {
        const w = frameRef.current?.contentWindow;
        if (!w) return false;
        try { w.postMessage(message, '*', transfer); return true; } catch { return false; }
      },
    });
    const onMessage = (e: MessageEvent) => {
      if (!e.source || e.source !== frameRef.current?.contentWindow) return;
      const d = e.data as { type?: unknown } | null;
      if (d && typeof d === 'object' && !hub.handleFrameMessage(d)) video.handleFrameMessage(d);
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); hub.dispose(); video.dispose(); };
    // `bridge` and `frameRef` are stable for the life of the host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pageId, docKey]);
}
