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
/** A refusal when a hidden window shows again (the rate gate may be full after quick hide/show
 *  cycles) is not the end: stay 'paused' and ask again after this wait, a few times. */
export const RESUME_RETRY_MS = 15_000;
const RESUME_RETRIES = 4;

interface Entry {
  url: string;
  mainId: string | null;
  state: PageSocketState;
  /** Bumped on every open and close, so an answer for an older attempt is dropped. */
  attempt: number;
  /** Reopen-after-hidden refusals so far, and the timer for the next try. */
  retries: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

export interface PageSocketHub {
  /** This frame instance's id (the video hub of the same frame uses it too). */
  readonly frame: string;
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
  // WHY (same as the video hub): main can push an event for a socket (a quick 'closed' after a refused
  // login or ECONNREFUSED) BEFORE the open call's own reply tells us its id. Dropping it left the page's
  // handle 'connecting' for good. Kept only while an open is in flight, a few per id, and replayed once mapped.
  const early = new Map<string, PageSocketEvent[]>();
  let opening = 0;

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
      for (const [id, e] of [...local]) {
        if (e.mainId === null) continue;
        // WHY the answer is read: main answers {ok:false} for a socket it already ended without a push we saw,
        // and ignoring that left the page's handle 'open' for good. Same as the video hub.
        void b?.socketPing?.({ ...call(), socket: e.mainId })?.then((r) => {
          if (r && r.ok === false && local.get(id) === e && e.mainId !== null && !disposed) {
            byMain.delete(e.mainId); e.mainId = null; e.state = 'closed'; local.delete(id); syncPinger();
            opts.post({ type: PAGE_SOCKET_EVENT_MESSAGE, id, kind: 'state', state: 'closed', why: 'The live connection ended.' });
          }
        }).catch(() => { /* the next ping tries again */ });
      }
    }, SOCKET_PING_MS);
  };

  const ensureSubscribed = () => {
    if (unsubscribe) return;
    unsubscribe = opts.bridge()?.onSocketEvent?.((ev: PageSocketEvent) => {
      // Only an id this hub made a mapping for: anything else (another frame's
      // socket, a stale one, a forged one) is not ours and resolves nothing.
      if (disposed) return;
      const id = byMain.get(ev?.socket);
      if (!id) {
        if (opening > 0 && typeof ev?.socket === 'string') { const list = early.get(ev.socket) ?? []; if (list.length < 64 && early.size < 16) { list.push(ev); early.set(ev.socket, list); } }
        return;
      }
      applyEvent(id, ev);
    }) ?? null;
  };
  const applyEvent = (id: string, ev: PageSocketEvent) => {
    const e = local.get(id);
    if (!e) return;
    if (ev.kind === 'state') {
      if (ev.state === 'closed') { byMain.delete(ev.socket); e.mainId = null; e.state = 'closed'; syncPinger(); }
      tell(id, ev.state, ev.why);
      if (ev.state === 'closed') local.delete(id);
    } else if (ev.kind === 'messages' && Array.isArray(ev.texts)) {
      opts.post({ type: PAGE_SOCKET_EVENT_MESSAGE, id, kind: 'messages', texts: ev.texts });
    }
  };

  /** Ask main for the connection. Used on the page's open and after a hidden pause (`resume`). */
  const connect = async (id: string, resume = false) => {
    const e = local.get(id);
    if (!e) return;
    if (e.retryTimer !== null) { clearTimeout(e.retryTimer); e.retryTimer = null; }
    const b = opts.bridge();
    if (!b?.socketOpen) { tell(id, 'closed', 'This window cannot open live connections.'); local.delete(id); return; }
    ensureSubscribed();
    const attempt = ++e.attempt;
    tell(id, 'connecting');
    let result;
    opening++;
    try { result = await b.socketOpen({ ...call(), url: e.url }); }
    catch { result = { ok: false as const, message: 'The live connection could not be started.' }; }
    try {
      const now = local.get(id);
      // The page closed it, the frame went away, or a newer attempt began while we waited:
      // the socket main just made belongs to nobody, so it is closed again at once.
      if (disposed || !now || now.attempt !== attempt) {
        if (result.ok) void b.socketClose?.({ ...call(), socket: result.socket })?.catch(() => { /* gone */ });
        return;
      }
      if (!result.ok) {
        // WHY not closed on a resume: this socket worked before the window was hidden, and a refusal now
        // (the opening-rate limit after a few quick hide/show cycles) is usually momentary. Stay paused and
        // try again; only a first open, or several refusals in a row, is the end.
        if (resume && ++now.retries <= RESUME_RETRIES) {
          tell(id, 'paused', result.message);
          now.retryTimer = setTimeout(() => { now.retryTimer = null; if (!disposed && local.get(id) === now && now.state === 'paused' && !hidden()) void connect(id, true); }, RESUME_RETRY_MS);
          return;
        }
        tell(id, 'closed', result.message); local.delete(id); return;
      }
      now.retries = 0;
      now.mainId = result.socket;
      byMain.set(result.socket, id);
      syncPinger();
      // Replay what main pushed before we knew this socket's id (it may include its 'closed').
      const pending = early.get(result.socket);
      early.delete(result.socket);
      for (const ev of pending ?? []) applyEvent(id, ev);
    } finally { if (--opening === 0) early.clear(); }
  };


  const closeMain = (e: Entry) => {
    const main = e.mainId;
    e.mainId = null;
    e.attempt++;
    if (e.retryTimer !== null) { clearTimeout(e.retryTimer); e.retryTimer = null; }
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
      for (const [id, e] of local) if (e.state === 'paused') void connect(id, true);
    }
    syncPinger();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  return {
    frame,
    handleFrameMessage(d) {
      const type = d.type;
      if (type !== PAGE_SOCKET_OPEN_MESSAGE && type !== PAGE_SOCKET_SEND_MESSAGE && type !== PAGE_SOCKET_CLOSE_MESSAGE) return false;
      if (disposed) return true;
      const id = d.id;
      // Shape checks: the page's own script wrote these, so nothing is assumed.
      if (typeof id !== 'string' || !id || id.length > MAX_ID_CHARS) return true;
      if (type === PAGE_SOCKET_OPEN_MESSAGE) {
        // A reused id is the page repeating itself: its live handle already hears the answer, so it is ignored.
        if (local.has(id)) return true;
        // WHY answered: ignoring these left the page's handle 'connecting' for good, waiting on an event
        // that would never come. Every other refused open is answered the same way (as 'closed', with why).
        if (local.size >= MAX_LOCAL) { tell(id, 'closed', `A page may keep at most ${MAX_LOCAL} live connections open.`); return true; }
        if (typeof d.url !== 'string' || d.url.length > MAX_URL_CHARS) { tell(id, 'closed', 'That page asked for a live connection the app could not read.'); return true; }
        local.set(id, { url: d.url, mainId: null, state: 'connecting', attempt: 0, retries: 0, retryTimer: null });
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
      // WHY the page is told: the hub can end while the page's document lives on (a hidden-but-mounted
      // frame, a view that closes and reopens), and a handle left 'open' sends into nothing for good.
      // Posting into a frame that is already gone does nothing.
      for (const [id, e] of local) if (e.state !== 'closed') opts.post({ type: PAGE_SOCKET_EVENT_MESSAGE, id, kind: 'state', state: 'closed', why: 'This page is not on screen any more, so its live connection was closed.' });
      stopPinger();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe?.(); unsubscribe = null;
      for (const e of local.values()) closeMain(e);
      local.clear(); byMain.clear();
    },
  };
}
