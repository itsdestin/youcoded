// The host side of a page's live socket (spec 2026-10-04, Part 1): what
// PageHost does between the page's `youcoded.socket(...)` and main.
//
// One hub per FRAME INSTANCE (PageHost creates one when a page's frame starts
// and disposes it when the frame goes away or its document changes). The hub:
//   · shape-checks everything the page says (strings only, at most 64 KB);
//   · keeps the page's own socket ids apart from main's — the page never
//     learns, and can never name, a main id; an event naming an id the hub has
//     no mapping for resolves nothing;
//   · closes every socket when disposed (frame unmount / srcDoc change);
//   · pauses while the window is hidden: closes in main, tells the page
//     'paused', and opens again when visible (one rate-gate slot). Pings (the
//     lease) run only while visible, so a throttled background tab is never
//     mistaken for a dead page and a hidden one holds nothing open.
import type { PageSocketCall, PageSocketEvent, PageSocketState, PagesBridge } from '../../../shared/pages-types';
import {
  PAGE_SOCKET_CLOSE_MESSAGE, PAGE_SOCKET_EVENT_MESSAGE, PAGE_SOCKET_OPEN_MESSAGE, PAGE_SOCKET_SEND_MESSAGE,
} from './page-theme';

/** The lease ping: main closes a socket nobody pinged for 60 s. */
export const SOCKET_PING_MS = 20_000;
const MAX_SEND_BYTES = 64_000;
const MAX_URL_CHARS = 2048;
const MAX_ID_CHARS = 64;
/** Main caps a page at 2; a few more here is only so the page gets a plain
 *  refusal from main rather than the hub silently ignoring it. */
const MAX_LOCAL = 8;

interface Entry {
  url: string;
  mainId: string | null;
  state: PageSocketState;
  /** Bumped on every open and close, so an answer for an older attempt is dropped. */
  attempt: number;
}

export interface PageSocketHub {
  /** Returns true when the message was a socket message (consumed). */
  handleFrameMessage(data: { type?: unknown; [k: string]: unknown }): boolean;
  dispose(): void;
}

export function createPageSocketHub(opts: {
  pageId: string;
  bridge: () => PagesBridge | undefined;
  /** Post one event to the page's frame (the frame instance this hub belongs to). */
  post: (message: unknown) => void;
  isHidden?: () => boolean;
}): PageSocketHub {
  // WHY unguessable-enough and per hub: main checks it with the page id and
  // its own record of the caller, so a frame instance can use only its sockets.
  const frame = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `f${Math.random().toString(36).slice(2)}${Date.now()}`;
  const local = new Map<string, Entry>();
  const byMain = new Map<string, string>();
  const hidden = opts.isHidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  let disposed = false;
  let pinger: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const call = (): PageSocketCall => ({ page: opts.pageId, frame });
  const tell = (id: string, state: PageSocketState, why?: string) => {
    const e = local.get(id);
    if (e) e.state = state;
    opts.post({ type: PAGE_SOCKET_EVENT_MESSAGE, id, kind: 'state', state, ...(why ? { why } : {}) });
  };

  const stopPinger = () => { if (pinger !== null) { clearInterval(pinger); pinger = null; } };
  const syncPinger = () => {
    const wanted = !disposed && !hidden() && [...local.values()].some((e) => e.mainId !== null);
    if (!wanted) { stopPinger(); return; }
    if (pinger !== null) return;
    pinger = setInterval(() => {
      const b = opts.bridge();
      for (const e of local.values()) if (e.mainId !== null) void b?.socketPing?.({ ...call(), socket: e.mainId })?.catch(() => { /* the next ping tries again */ });
    }, SOCKET_PING_MS);
  };

  const ensureSubscribed = () => {
    if (unsubscribe) return;
    unsubscribe = opts.bridge()?.onSocketEvent?.((ev: PageSocketEvent) => {
      // Only an id this hub made a mapping for: anything else (another frame's
      // socket, a stale one, a forged one) is not ours and resolves nothing.
      const id = byMain.get(ev?.socket);
      if (!id || disposed) return;
      const e = local.get(id);
      if (!e) return;
      if (ev.kind === 'state') {
        if (ev.state === 'closed') { byMain.delete(ev.socket); e.mainId = null; e.state = 'closed'; syncPinger(); }
        tell(id, ev.state, ev.why);
        if (ev.state === 'closed') local.delete(id);
      } else if (ev.kind === 'messages' && Array.isArray(ev.texts)) {
        opts.post({ type: PAGE_SOCKET_EVENT_MESSAGE, id, kind: 'messages', texts: ev.texts });
      }
    }) ?? null;
  };

  /** Ask main for the connection. Used on the page's open and after a hidden pause. */
  const connect = async (id: string) => {
    const e = local.get(id);
    if (!e) return;
    const b = opts.bridge();
    if (!b?.socketOpen) { tell(id, 'closed', 'This window cannot open live connections.'); local.delete(id); return; }
    ensureSubscribed();
    const attempt = ++e.attempt;
    tell(id, 'connecting');
    let result;
    try { result = await b.socketOpen({ ...call(), url: e.url }); }
    catch { result = { ok: false as const, message: 'The live connection could not be started.' }; }
    const now = local.get(id);
    // The page closed it, the frame went away, or a newer attempt began while we waited:
    // the socket main just made belongs to nobody, so it is closed again at once.
    if (disposed || !now || now.attempt !== attempt) {
      if (result.ok) void b.socketClose?.({ ...call(), socket: result.socket })?.catch(() => { /* gone */ });
      return;
    }
    if (!result.ok) { tell(id, 'closed', result.message); local.delete(id); return; }
    now.mainId = result.socket;
    byMain.set(result.socket, id);
    syncPinger();
  };

  const closeMain = (e: Entry) => {
    const main = e.mainId;
    e.mainId = null;
    e.attempt++;
    if (main === null) return;
    byMain.delete(main);
    void opts.bridge()?.socketClose?.({ ...call(), socket: main })?.catch(() => { /* gone */ });
  };

  const onVisibility = () => {
    if (disposed) return;
    if (hidden()) {
      // Hidden: nothing stays open behind a window nobody can see.
      for (const [id, e] of local) {
        if (e.state === 'closed') continue;
        closeMain(e);
        tell(id, 'paused', 'The window is hidden.');
      }
    } else {
      for (const [id, e] of local) if (e.state === 'paused') void connect(id);
    }
    syncPinger();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  return {
    handleFrameMessage(d) {
      const type = d.type;
      if (type !== PAGE_SOCKET_OPEN_MESSAGE && type !== PAGE_SOCKET_SEND_MESSAGE && type !== PAGE_SOCKET_CLOSE_MESSAGE) return false;
      if (disposed) return true;
      const id = d.id;
      // Shape checks: the page's own script wrote these, so nothing is assumed.
      if (typeof id !== 'string' || !id || id.length > MAX_ID_CHARS) return true;
      if (type === PAGE_SOCKET_OPEN_MESSAGE) {
        if (local.has(id) || local.size >= MAX_LOCAL || typeof d.url !== 'string' || d.url.length > MAX_URL_CHARS) return true;
        local.set(id, { url: d.url, mainId: null, state: 'connecting', attempt: 0 });
        if (hidden()) tell(id, 'paused', 'The window is hidden.'); else void connect(id);
        return true;
      }
      const e = local.get(id);
      if (!e) return true; // an id this frame never opened resolves nothing
      if (type === PAGE_SOCKET_CLOSE_MESSAGE) {
        local.delete(id);
        closeMain(e);
        syncPinger();
        return true;
      }
      // send: only when open, only a string, at most 64 KB.
      if (e.state !== 'open' || e.mainId === null || typeof d.text !== 'string' || new TextEncoder().encode(d.text).length > MAX_SEND_BYTES) return true;
      void opts.bridge()?.socketSend?.({ ...call(), socket: e.mainId, text: d.text })?.catch(() => { /* main refuses what it must; the page learns from state */ });
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopPinger();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe?.(); unsubscribe = null;
      for (const e of local.values()) closeMain(e);
      local.clear(); byMain.clear();
    },
  };
}
