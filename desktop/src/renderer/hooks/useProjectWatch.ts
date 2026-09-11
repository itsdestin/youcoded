// Subscribe this renderer to external file-change events for a project root
// while the calling component is mounted. The watcher itself lives in main
// (artifacts/project-watcher.ts) and is refcounted per renderer, so multiple
// hosts (SessionDrawer + ProjectView) can hold overlapping subscriptions
// cheaply. Events arrive via artifacts.onChanged with by:'external'.
//
// Failure-tolerant by design: on Android the channel returns
// not-implemented (the shim REJECTS the promise for unsupported channels),
// which degrades to "no live refresh" — the pane still works, it just does
// not react to outside edits.
import { useEffect } from 'react';
import { REMOTE_RECONNECTED_EVENT } from '../remote-events';

export function useProjectWatch(projectRoot: string | null | undefined): void {
  useEffect(() => {
    if (!projectRoot) return;
    const api = (window.claude as any).artifacts;
    if (!api?.watchProject) return;
    let unwatchNeeded = true;
    const subscribe = () => Promise.resolve(api.watchProject(projectRoot)).catch(() => { unwatchNeeded = false; });
    void subscribe();
    // Over remote access the host keys the subscription by SOCKET, and a
    // reconnect is a new socket — the old subscription died with the old one.
    // Without this the phone's file list stopped updating after the first
    // drop and never said so (contract row R12). The desktop never fires the
    // event, so this is inert there.
    const onReconnected = () => { void subscribe(); };
    window.addEventListener(REMOTE_RECONNECTED_EVENT, onReconnected);
    return () => {
      window.removeEventListener(REMOTE_RECONNECTED_EVENT, onReconnected);
      // A failed watch still registered nothing in main worth keeping, but an
      // unwatch for it is harmless — main ignores unknown roots. Only skip when
      // the platform rejected the channel outright.
      if (!unwatchNeeded) return;
      Promise.resolve(api.unwatchProject?.(projectRoot)).catch(() => { /* platform without watcher */ });
    };
  }, [projectRoot]);
}
