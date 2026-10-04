// The host side of a page's camera video (spec 2026-10-04, Part 2): what
// PageHost does between the page's `youcoded.video(...)` and main.
//
// WHY the host (outside the sandboxed frame) holds the peer connection: the
// frame's CSP blocks WebRTC on purpose, and the page must never see an SDP, a
// network candidate or the device. The host builds a receive-only peer
// connection, hands main the offer, plays what comes back into a muted <video>
// that is in the document but invisible, and gives the page only PICTURES
// (ImageBitmaps), one at a time, the next only after the page says it is done
// with the last. One hub per FRAME INSTANCE, like the socket hub: the frame
// going away, a new document, the window being hidden, 5 minutes, or main
// saying 'stopped' all end a video here.
import type { PageVideoCall, PageSocketEvent, PagesBridge } from '../../../shared/pages-types';
import {
  PAGE_VIDEO_ACK_MESSAGE, PAGE_VIDEO_EVENT_MESSAGE, PAGE_VIDEO_START_MESSAGE, PAGE_VIDEO_STOP_MESSAGE,
} from './page-theme';

export const VIDEO_PING_MS = 20_000;
/** Cap on waiting for ICE gathering before the offer goes (spec: 3 s). */
export const ICE_GATHER_CAP_MS = 3_000;
/** The app ends a video by itself after this (main does too). */
export const VIDEO_MAX_MS = 5 * 60_000;
/** A video that has an answer but no picture after this is stopped with a plain reason. */
const NO_PICTURE_MS = 15_000;
/** The watchdog: no frame callback for this long while the track is live → switch to the track processor. */
const STALL_MS = 3_000;
/** At most ~15 pictures a second go to the page (a gap just under 1/15 s), and never wider than this:
 *  a 1080p/30 camera must not cost a full-size copy 30 times a second per video. */
const MIN_FRAME_GAP_MS = 66;
const MAX_FRAME_WIDTH = 1280;
/** A camera that stays 'disconnected' this long is stopped with a plain reason (it may reconnect sooner). */
export const DISCONNECT_MS = 10_000;
/** Playing, but the camera has produced no picture for this long: stopped with a plain reason. */
export const QUIET_MS = 15_000;
const HIDDEN_WHY = 'paused while the page was hidden';
const MAX_LOCAL = 4;

type VideoState = 'starting' | 'playing' | 'stopped';

/** The slice of RTCPeerConnection / <video> the hub uses (a test hands in fakes). */
export interface PeerLike {
  addTransceiver(kind: 'audio' | 'video', init: { direction: 'recvonly' }): unknown;
  createDataChannel(label: string): unknown;
  createOffer(): Promise<{ type?: string; sdp?: string }>;
  setLocalDescription(d: { type?: string; sdp?: string }): Promise<void>;
  setRemoteDescription(d: { type: 'answer'; sdp: string }): Promise<void>;
  addIceCandidate(c: unknown): Promise<void>;
  close(): void;
  readonly localDescription: { sdp?: string } | null;
  readonly iceGatheringState: string;
  readonly connectionState: string;
  addEventListener(type: string, cb: (e: any) => void): void;
  removeEventListener(type: string, cb: (e: any) => void): void;
}
export interface VideoElLike {
  srcObject: unknown;
  muted: boolean;
  readyState: number;
  play(): Promise<void> | void;
  remove(): void;
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
}

export interface VideoHostDeps {
  createPeer: () => PeerLike;
  createVideoEl: () => VideoElLike;
  createBitmap: (source: unknown, opts?: { resizeWidth: number; resizeQuality: 'low' }) => Promise<ImageBitmap>;
  /** Present where the browser can read a track's frames without a <video> (Chromium): the fallback if the callback stalls. */
  createProcessor?: (track: unknown) => { read: () => Promise<{ done: boolean; value?: { close(): void } }>; cancel: () => void } | null;
}

function defaultDeps(): VideoHostDeps {
  return {
    createPeer: () => new RTCPeerConnection() as unknown as PeerLike,
    createVideoEl: () => {
      const el = document.createElement('video');
      el.muted = true; el.playsInline = true; el.autoplay = true;
      // WHY not display:none / off-screen: browsers may stop decoding a video nobody can
      // "see". A 2px fully transparent element in a corner is invisible and still decoded.
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1';
      document.body.appendChild(el);
      return el as unknown as VideoElLike;
    },
    createBitmap: (source, o) => (o ? createImageBitmap(source as ImageBitmapSource, o) : createImageBitmap(source as ImageBitmapSource)),
    createProcessor: (track) => {
      const P = (globalThis as any).MediaStreamTrackProcessor;
      if (!P) return null;
      const reader = new P({ track }).readable.getReader();
      return { read: () => reader.read(), cancel: () => { void reader.cancel().catch(() => {}); } };
    },
  };
}

interface Entry {
  mainId: string | null;
  /** Bumped at every start and stop: a late answer for an older start is dropped. */
  attempt: number;
  pc: PeerLike | null;
  el: VideoElLike | null;
  state: VideoState;
  remoteSet: boolean;
  queued: unknown[];
  /** Frame pump: the number of the frame the page still owes an ack for (0 = none). */
  outstanding: number;
  seq: number;
  /** When a picture last came from the camera (any frame, sent or not) and when a bitmap was last made. */
  lastFrameAt: number;
  lastBitmapAt: number;
  stopPump: (() => void) | null;
  timers: { max?: ReturnType<typeof setTimeout>; nopic?: ReturnType<typeof setTimeout>; stall?: ReturnType<typeof setInterval>; disc?: ReturnType<typeof setTimeout>; quiet?: ReturnType<typeof setInterval> };
}

export interface PageVideoHub {
  /** Returns true when the message was a video message (consumed). */
  handleFrameMessage(data: { type?: unknown; [k: string]: unknown }): boolean;
  dispose(): void;
}

export function createPageVideoHub(opts: {
  pageId: string;
  /** The frame instance's id: shared with the socket hub's, so main sees one frame. */
  frame: string;
  bridge: () => PagesBridge | undefined;
  /** Returns false when the message went nowhere (the frame is gone): the caller then closes what it was sending. */
  post: (message: unknown, transfer?: Transferable[]) => boolean | void;
  isHidden?: () => boolean;
  deps?: Partial<VideoHostDeps>;
}): PageVideoHub {
  const deps = { ...defaultDeps(), ...opts.deps };
  const local = new Map<string, Entry>();
  const byMain = new Map<string, string>();
  const hidden = opts.isHidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  let disposed = false;
  let starting = 0;
  /** Events main pushed for an id this hub has not been told yet (the push can beat the start's own answer). */
  const early = new Map<string, PageSocketEvent[]>();
  let pinger: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const call = (video: string): PageVideoCall => ({ page: opts.pageId, frame: opts.frame, video });
  const tell = (id: string, state: VideoState, why?: string) => {
    const e = local.get(id);
    if (e) e.state = state;
    opts.post({ type: PAGE_VIDEO_EVENT_MESSAGE, id, kind: 'state', state, ...(why ? { why } : {}) });
  };

  const syncPinger = () => {
    const wanted = !disposed && !hidden() && [...local.values()].some((e) => e.mainId !== null);
    if (!wanted) { if (pinger !== null) { clearInterval(pinger); pinger = null; } return; }
    if (pinger !== null) return;
    pinger = setInterval(() => {
      const b = opts.bridge();
      for (const [id, e] of [...local]) {
        if (e.mainId === null) continue;
        // WHY the answer is read: main answers {ok:false} for a video it has already ended without
        // telling us (it can finish silently), and ignoring that left a frozen picture for up to 5 minutes.
        void b?.videoPing?.(call(e.mainId))?.then((r) => {
          if (r && r.ok === false && local.get(id) === e) end(id, 'The video stopped.', { tellMain: false, tellPage: true });
        }).catch(() => { /* the next ping tries again */ });
      }
    }, VIDEO_PING_MS);
  };

  /** Release everything one video holds, locally. Does not talk to main. */
  const teardown = (e: Entry) => {
    e.attempt++;
    e.stopPump?.(); e.stopPump = null;
    for (const k of Object.keys(e.timers) as Array<keyof Entry['timers']>) { clearTimeout(e.timers[k] as any); clearInterval(e.timers[k] as any); e.timers[k] = undefined; }
    try { e.pc?.close(); } catch { /* already closed */ }
    e.pc = null;
    if (e.el) { try { e.el.srcObject = null; } catch { /* gone */ } try { e.el.remove(); } catch { /* gone */ } e.el = null; }
    e.queued = [];
  };
  /** End one video: locally, and in main unless main already ended it. */
  const end = (id: string, why: string | null, opts2: { tellMain: boolean; tellPage: boolean }) => {
    const e = local.get(id);
    if (!e) return;
    local.delete(id);
    const main = e.mainId; e.mainId = null;
    teardown(e);
    if (main !== null) { byMain.delete(main); if (opts2.tellMain) void opts.bridge()?.videoStop?.(call(main))?.catch(() => { /* gone */ }); }
    if (opts2.tellPage) opts.post({ type: PAGE_VIDEO_EVENT_MESSAGE, id, kind: 'state', state: 'stopped', ...(why ? { why } : {}) });
    syncPinger();
  };

  // ── The frame pump ──────────────────────────────────────────────────────
  // One picture out at a time: a bitmap is made only when none is waiting for
  // its ack, and one that cannot be sent (the video ended while it was being
  // made, the frame went away) is closed, never leaked.
  const send = async (id: string, e: Entry, source: unknown, release?: () => void) => {
    // A picture arrived from the camera, whether or not one is made from it (the quiet watchdog reads this).
    e.lastFrameAt = Date.now();
    if (e.outstanding !== 0 || disposed || local.get(id) !== e) { release?.(); return; }
    // WHY a minimum gap and a width cap, checked BEFORE a bitmap is made: a page that acks at once
    // and draws nothing must not cost the user a full-size copy of every frame of a fast camera.
    if (e.lastFrameAt - e.lastBitmapAt < MIN_FRAME_GAP_MS) { release?.(); return; }
    e.lastBitmapAt = e.lastFrameAt;
    const n = ++e.seq;
    e.outstanding = n;
    let bitmap: ImageBitmap;
    const s = source as { videoWidth?: number; displayWidth?: number; codedWidth?: number };
    const width = s.videoWidth || s.displayWidth || s.codedWidth || 0;
    try { bitmap = await deps.createBitmap(source, width > MAX_FRAME_WIDTH ? { resizeWidth: MAX_FRAME_WIDTH, resizeQuality: 'low' } : undefined); }
    catch { e.outstanding = 0; release?.(); return; }
    release?.();
    if (disposed || local.get(id) !== e || e.outstanding !== n) { bitmap.close(); if (e.outstanding === n) e.outstanding = 0; return; }
    if (e.state !== 'playing') {
      tell(id, 'playing');
      // WHY: after the first picture the no-picture timer is gone, so a camera that goes quiet would
      // otherwise show its last frame as 'playing' until the 5-minute limit.
      e.timers.quiet = setInterval(() => {
        if (Date.now() - e.lastFrameAt >= QUIET_MS) end(id, 'The camera stopped sending pictures.', { tellMain: true, tellPage: true });
      }, 1000);
    }
    if (e.timers.nopic) { clearTimeout(e.timers.nopic); e.timers.nopic = undefined; }
    // WHY the return value: posting to a frame that is gone does not throw, it does nothing, so the
    // bitmap would never be closed and the pump would wait for an ack that cannot come.
    let posted = false;
    try { posted = opts.post({ type: PAGE_VIDEO_EVENT_MESSAGE, id, kind: 'frame', n, bitmap }, [bitmap]) !== false; } catch { /* treated as not posted */ }
    if (!posted) { bitmap.close(); e.outstanding = 0; }
  };

  const startPump = (id: string, e: Entry, track: unknown) => {
    const el = e.el;
    if (!el) return;
    let lastCb = Date.now();
    let stopped = false;
    let usingProcessor = false;
    const cancels: Array<() => void> = [];
    e.stopPump = () => { stopped = true; for (const c of cancels.splice(0)) c(); };
    const rvfc = () => {
      if (stopped || usingProcessor) return;
      const handle = el.requestVideoFrameCallback!(() => { lastCb = Date.now(); void send(id, e, el); rvfc(); });
      cancels[0] = () => el.cancelVideoFrameCallback?.(handle);
    };
    const processor = (): boolean => {
      const proc = deps.createProcessor?.(track);
      if (!proc) return false;
      usingProcessor = true;
      cancels.push(() => proc.cancel());
      void (async () => {
        while (!stopped) {
          let r;
          try { r = await proc.read(); } catch { break; }
          if (r.done || !r.value) break;
          if (stopped) { try { r.value.close(); } catch { /* already closed */ } break; } // read just as we stopped: do not leave it open
          // A frame is closed (dropped) when one picture is already out.
          const frame = r.value;
          void send(id, e, frame, () => frame.close());
        }
      })();
      return true;
    };
    if (typeof el.requestVideoFrameCallback === 'function') {
      rvfc();
      // WHY a watchdog: a callback tied to a <video> may stall when the browser decides
      // nobody can see it. If that happens, read the track's frames directly instead.
      e.timers.stall = setInterval(() => {
        if (usingProcessor || stopped || Date.now() - lastCb < STALL_MS) return;
        cancels[0]?.();
        if (!processor()) rvfc();
      }, 1000);
    } else processor(); // no callback at all: the track reader is the only way (if absent, the no-picture timer ends it)
  };

  // ── Starting a video ────────────────────────────────────────────────────
  const waitForIce = (pc: PeerLike) => new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const done = () => { clearTimeout(cap); pc.removeEventListener('icegatheringstatechange', onChange); resolve(); };
    const onChange = () => { if (pc.iceGatheringState === 'complete') done(); };
    const cap = setTimeout(done, ICE_GATHER_CAP_MS);
    pc.addEventListener('icegatheringstatechange', onChange);
  });

  const applyEvent = (id: string, e: Entry, ev: PageSocketEvent) => {
    if (ev.kind === 'video-stopped') { end(id, ev.why || 'The video stopped.', { tellMain: false, tellPage: true }); return; }
    const pc = e.pc;
    if (!pc) return;
    const attempt = e.attempt;
    if (ev.kind === 'video-answer') {
      pc.setRemoteDescription({ type: 'answer', sdp: ev.answer }).then(async () => {
        if (e.attempt !== attempt) return;
        e.remoteSet = true;
        const q = e.queued; e.queued = [];
        for (const c of q) { try { await pc.addIceCandidate(c); } catch { /* one bad candidate is not the video */ } }
      }).catch(() => { if (e.attempt === attempt) end(id, 'The camera\'s answer could not be used.', { tellMain: true, tellPage: true }); });
    } else if (ev.kind === 'video-candidate') {
      let init: unknown;
      try { init = JSON.parse(ev.candidate); } catch { return; }
      if (!e.remoteSet) { if (e.queued.length < 64) e.queued.push(init); return; }
      void pc.addIceCandidate(init).catch(() => { /* ignore */ });
    }
  };

  const ensureSubscribed = () => {
    if (unsubscribe) return;
    unsubscribe = opts.bridge()?.onSocketEvent?.((ev: PageSocketEvent) => {
      if (disposed || (ev?.kind !== 'video-answer' && ev?.kind !== 'video-candidate' && ev?.kind !== 'video-stopped')) return;
      const id = byMain.get(ev.socket);
      if (!id) {
        // Main can push before the start's own reply reaches us: keep a few, but only while a start is in flight.
        if (starting > 0) { const list = early.get(ev.socket) ?? []; if (list.length < 64 && early.size < 16) { list.push(ev); early.set(ev.socket, list); } }
        return;
      }
      const e = local.get(id);
      if (e) applyEvent(id, e, ev);
    }) ?? null;
  };

  const begin = async (id: string, connection: string, target: string) => {
    const e = local.get(id);
    if (!e) return;
    const b = opts.bridge();
    if (!b?.videoStart) { end(id, 'This window cannot play camera video.', { tellMain: false, tellPage: true }); return; }
    ensureSubscribed();
    tell(id, 'starting');
    const attempt = ++e.attempt;
    const stale = () => disposed || local.get(id) !== e || e.attempt !== attempt;
    starting++;
    try {
      let offer: string;
      try {
        const pc = deps.createPeer();
        e.pc = pc;
        // Nest needs audio, video and a data channel named exactly this, or it refuses the offer.
        pc.addTransceiver('audio', { direction: 'recvonly' });
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.createDataChannel('dataSendChannel');
        pc.addEventListener('track', (ev: { track: unknown; streams?: unknown[] }) => {
          if (e.attempt !== attempt || !e.el) return;
          // A track arrives for audio and for video; only the picture matters.
          if ((ev.track as { kind?: string })?.kind !== 'video') return;
          const MS = (globalThis as any).MediaStream;
          e.el.srcObject = ev.streams?.[0] ?? (MS ? new MS([ev.track]) : null);
          void Promise.resolve(e.el.play()).catch(() => { /* muted autoplay is allowed; a refusal shows as no picture */ });
          startPump(id, e, ev.track);
        });
        pc.addEventListener('connectionstatechange', () => {
          if (e.attempt !== attempt) return;
          if (pc.connectionState === 'failed') { end(id, 'The video connection to the camera failed.', { tellMain: true, tellPage: true }); return; }
          // WHY a grace period: 'disconnected' often heals by itself within seconds, but a camera that
          // went away stays so, and only 'failed' used to end the video (the last frame stayed up).
          if (pc.connectionState === 'disconnected') {
            if (e.timers.disc === undefined) e.timers.disc = setTimeout(() => end(id, 'The connection to the camera was lost.', { tellMain: true, tellPage: true }), DISCONNECT_MS);
          } else if (e.timers.disc !== undefined) { clearTimeout(e.timers.disc); e.timers.disc = undefined; }
        });
        e.el = deps.createVideoEl();
        const created = await pc.createOffer();
        await pc.setLocalDescription(created);
        await waitForIce(pc);
        offer = pc.localDescription?.sdp ?? created.sdp ?? '';
        if (!offer) throw new Error('no offer');
      } catch {
        if (!stale()) end(id, 'The video could not be set up in this window.', { tellMain: false, tellPage: true });
        return;
      }
      if (stale()) return;
      let result;
      try { result = await b.videoStart({ page: opts.pageId, frame: opts.frame, connection, target, offer }); }
      catch { result = { ok: false as const, message: 'The video could not be started.' }; }
      if (stale()) {
        // The page stopped it, or the frame went away, while main was answering: main's video belongs to nobody.
        if (result.ok) void b.videoStop?.(call(result.video))?.catch(() => { /* gone */ });
        return;
      }
      if (!result.ok) { end(id, result.message, { tellMain: false, tellPage: true }); return; }
      e.mainId = result.video;
      byMain.set(result.video, id);
      e.timers.max = setTimeout(() => end(id, 'The video reached its 5-minute limit. Play again to keep watching.', { tellMain: true, tellPage: true }), VIDEO_MAX_MS);
      e.timers.nopic = setTimeout(() => end(id, 'The camera did not start playing.', { tellMain: true, tellPage: true }), NO_PICTURE_MS + ICE_GATHER_CAP_MS);
      syncPinger();
      const pending = early.get(result.video);
      early.delete(result.video);
      for (const ev of pending ?? []) { const cur = local.get(id); if (cur) applyEvent(id, cur, ev); }
    } finally { if (--starting === 0) early.clear(); }
  };

  const onVisibility = () => {
    if (disposed) return;
    // Hidden: stop on purpose, say why, and do NOT reopen on show — the card offers Play again.
    if (hidden()) for (const id of [...local.keys()]) end(id, HIDDEN_WHY, { tellMain: true, tellPage: true });
    syncPinger();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  return {
    handleFrameMessage(d) {
      const type = d.type;
      if (type !== PAGE_VIDEO_START_MESSAGE && type !== PAGE_VIDEO_STOP_MESSAGE && type !== PAGE_VIDEO_ACK_MESSAGE) return false;
      if (disposed) return true;
      const id = d.id;
      // Shape checks: the page's own script wrote these, so nothing is assumed.
      if (typeof id !== 'string' || !id || id.length > 64) return true;
      if (type === PAGE_VIDEO_START_MESSAGE) {
        if (local.has(id)) return true; // the page repeating itself: its handle already hears the answer
        // WHY answered: a silent ignore left the page's video 'starting' for good.
        if (local.size >= MAX_LOCAL) { opts.post({ type: PAGE_VIDEO_EVENT_MESSAGE, id, kind: 'state', state: 'stopped', why: `A page may play at most ${MAX_LOCAL} videos at once.` }); return true; }
        if (typeof d.connection !== 'string' || !d.connection || d.connection.length > 64 || typeof d.target !== 'string' || !d.target || d.target.length > 128) {
          opts.post({ type: PAGE_VIDEO_EVENT_MESSAGE, id, kind: 'state', state: 'stopped', why: 'That page asked for a video the app could not read.' });
          return true;
        }
        local.set(id, { mainId: null, attempt: 0, pc: null, el: null, state: 'starting', remoteSet: false, queued: [], outstanding: 0, seq: 0, lastFrameAt: 0, lastBitmapAt: -Infinity, stopPump: null, timers: {} });
        if (hidden()) { end(id, HIDDEN_WHY, { tellMain: false, tellPage: true }); return true; }
        void begin(id, d.connection, d.target);
        return true;
      }
      if (type === PAGE_VIDEO_STOP_MESSAGE) { end(id, null, { tellMain: true, tellPage: false }); return true; }
      // ack: counts only for the picture currently out, so a page cannot ack twice to get two at once.
      const e = local.get(id);
      if (e && typeof d.n === 'number' && d.n === e.outstanding) e.outstanding = 0;
      return true;
    },
    dispose() {
      if (disposed) return;
      // WHY the page is told: the hub can end while the page's document lives on, and a card left 'playing' shows a frozen picture for good.
      for (const id of [...local.keys()]) end(id, 'This page is not on screen any more, so its video stopped.', { tellMain: true, tellPage: true });
      disposed = true;
      if (pinger !== null) { clearInterval(pinger); pinger = null; }
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe?.(); unsubscribe = null;
      local.clear(); byMain.clear(); early.clear();
    },
  };
}
