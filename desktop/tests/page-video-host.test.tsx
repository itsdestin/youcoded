// @vitest-environment jsdom
// The host side of a page's camera video: what PageHost does between the
// page's `youcoded.video(...)` and main. Everything real here except the
// browser's own peer connection, <video> and bitmap maker, which are scripted
// fakes (no camera, no network, no sleeping: fake timers and explicit "frame
// arrives" calls drive every step).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createPageVideoHub, DISCONNECT_MS, ICE_GATHER_CAP_MS, QUIET_MS, VIDEO_MAX_MS, VIDEO_PING_MS, type PeerLike, type VideoElLike, type VideoHostDeps } from '../src/renderer/components/pages/page-video-host';
import { usePageSockets } from '../src/renderer/components/pages/use-page-sockets';
import type { PageSocketEvent } from '../src/shared/pages-types';

const START = { type: 'youcoded:video:start', id: 'v1', connection: 'ha', target: 'camera.living_room' };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

class FakePeer implements PeerLike {
  transceivers: Array<[string, unknown]> = [];
  channels: string[] = [];
  remote: Array<{ type: string; sdp: string }> = [];
  candidates: unknown[] = [];
  closed = false;
  localDescription: { sdp?: string } | null = null;
  iceGatheringState = 'complete';
  connectionState = 'new';
  private listeners = new Map<string, Array<(e: any) => void>>();
  addTransceiver(kind: 'audio' | 'video', init: { direction: 'recvonly' }) { this.transceivers.push([kind, init]); }
  createDataChannel(label: string) { this.channels.push(label); }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async setLocalDescription(d: { sdp?: string }) { this.localDescription = { sdp: `${d.sdp} +ice` }; }
  async setRemoteDescription(d: { type: 'answer'; sdp: string }) { this.remote.push(d); }
  async addIceCandidate(c: unknown) { this.candidates.push(c); }
  close() { this.closed = true; }
  addEventListener(t: string, cb: (e: any) => void) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), cb]); }
  removeEventListener(t: string, cb: (e: any) => void) { this.listeners.set(t, (this.listeners.get(t) ?? []).filter((x) => x !== cb)); }
  emit(t: string, e: any = {}) { (this.listeners.get(t) ?? []).forEach((cb) => cb(e)); }
}
class FakeEl implements VideoElLike {
  srcObject: unknown = null; videoWidth = 640; muted = true; readyState = 4; removed = false; plays = 0;
  cb: (() => void) | null = null; cancelled = 0;
  play() { this.plays++; }
  remove() { this.removed = true; }
  requestVideoFrameCallback = (cb: () => void) => { this.cb = cb; return 1; };
  cancelVideoFrameCallback = () => { this.cancelled++; this.cb = null; };
  /** A new picture is ready. */
  frame() { const cb = this.cb; this.cb = null; cb?.(); }
}
interface Bitmap { id: number; closed: boolean; close(): void }

function rig(extra: Partial<VideoHostDeps> = {}) {
  let n = 0;
  const listeners = new Set<(e: PageSocketEvent) => void>();
  const bridge = {
    videoStart: vi.fn(async () => ({ ok: true as const, video: `lv${++n}` })),
    videoStop: vi.fn(async () => ({ ok: true as const })),
    videoPing: vi.fn(async () => ({ ok: true as const })),
    onSocketEvent: vi.fn((cb: (e: PageSocketEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; }),
  };
  const peers: FakePeer[] = [];
  const els: FakeEl[] = [];
  const bitmaps: Bitmap[] = [];
  const bitmapOpts: unknown[] = [];
  const posted: any[] = [];
  const transfers: unknown[][] = [];
  const deferred: Array<() => void> = [];
  let hold = false;
  const deps: Partial<VideoHostDeps> = {
    createPeer: () => { const p = new FakePeer(); peers.push(p); return p; },
    createVideoEl: () => { const e = new FakeEl(); els.push(e); return e; },
    createBitmap: (_src, o) => new Promise((resolve) => {
      bitmapOpts.push(o);
      const b: Bitmap = { id: bitmaps.length + 1, closed: false, close() { this.closed = true; } };
      bitmaps.push(b);
      if (hold) deferred.push(() => resolve(b as unknown as ImageBitmap)); else resolve(b as unknown as ImageBitmap);
    }),
    ...extra,
  };
  const hub = createPageVideoHub({
    pageId: 'personal:home', frame: 'f1', bridge: () => bridge as any, deps,
    post: (m, t) => { posted.push(m); transfers.push(t ?? []); },
  });
  return {
    hub, bridge, peers, els, bitmaps, bitmapOpts, posted, transfers,
    push: (e: PageSocketEvent) => listeners.forEach((l) => l(e)),
    holdBitmaps: (on: boolean) => { hold = on; },
    releaseBitmaps: () => deferred.splice(0).forEach((f) => f()),
    states: () => posted.filter((m) => m.kind === 'state').map((m) => (m.why ? [m.state, m.why] : [m.state])),
    frames: () => posted.filter((m) => m.kind === 'frame'),
  };
}
/** Start a video and bring it to the point a picture can arrive. */
async function playing(r: ReturnType<typeof rig>) {
  r.hub.handleFrameMessage(START);
  await flush();
  r.push({ socket: 'lv1', kind: 'video-answer', answer: 'v=0 answer' });
  await flush();
  const pc = r.peers[0];
  const track = { kind: 'video' };
  pc.emit('track', { track: { kind: 'audio' }, streams: [{ audio: true }] });
  pc.emit('track', { track, streams: [{ video: true }] });
  return { pc, el: r.els[0], track };
}

let visibility: 'visible' | 'hidden' = 'visible';
function setVisibility(v: 'visible' | 'hidden') { visibility = v; document.dispatchEvent(new Event('visibilitychange')); }
/** Time moves only when a test says so (the pump spaces pictures by the clock). */
const tick = (ms = 100) => vi.setSystemTime(Date.now() + ms);
/** Let `ms` pass with the camera sending a picture every 5 seconds (a camera that is alive). */
async function alive(r: ReturnType<typeof rig>, ms: number) {
  for (let t = 0; t < ms; t += 5_000) { await vi.advanceTimersByTimeAsync(5_000); r.els[0].frame(); }
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => { vi.useRealTimers(); });

describe('starting a video', () => {
  it('builds a receive-only peer with the data channel Nest needs, sends main only the offer, and tells the page it is starting', async () => {
    const r = rig();
    expect(r.hub.handleFrameMessage(START)).toBe(true);
    await flush();
    const pc = r.peers[0];
    expect(pc.transceivers).toEqual([['audio', { direction: 'recvonly' }], ['video', { direction: 'recvonly' }]]);
    expect(pc.channels).toEqual(['dataSendChannel']);
    expect(r.bridge.videoStart).toHaveBeenCalledWith({ page: 'personal:home', frame: 'f1', connection: 'ha', target: 'camera.living_room', offer: 'v=0 offer +ice' });
    expect(r.states()).toEqual([['starting']]);
    // The page is never given main's id, an offer or an answer.
    expect(JSON.stringify(r.posted)).not.toMatch(/lv1|offer|answer/);
    r.hub.dispose();
  });

  it('waits for the network-address gathering to finish but never more than 3 seconds', async () => {
    vi.useFakeTimers();
    const r = rig({ createPeer: () => { const p = new FakePeer(); p.iceGatheringState = 'gathering'; r.peers.push(p); return p; } });
    r.hub.handleFrameMessage(START);
    await vi.advanceTimersByTimeAsync(ICE_GATHER_CAP_MS - 1);
    expect(r.bridge.videoStart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(r.bridge.videoStart).toHaveBeenCalledTimes(1);
    r.hub.dispose();
  });

  it('refuses a message with a bad shape and a video it already has', async () => {
    const r = rig();
    for (const bad of [{ ...START, id: '' }, { ...START, id: 'x'.repeat(65) }, { ...START, connection: 3 }, { ...START, target: '' }, { ...START, target: 'c'.repeat(129) }]) r.hub.handleFrameMessage(bad);
    await flush();
    expect(r.bridge.videoStart).not.toHaveBeenCalled();
    r.hub.handleFrameMessage(START); r.hub.handleFrameMessage(START);
    await flush();
    expect(r.bridge.videoStart).toHaveBeenCalledTimes(1);
    expect(r.hub.handleFrameMessage({ type: 'youcoded:socket:open' })).toBe(false);
    r.hub.dispose();
  });

  it('answers a start it will not make with "stopped" and a reason, so the page never waits forever', async () => {
    const r = rig();
    r.hub.handleFrameMessage({ ...START, id: 'bad1', connection: 3 });
    expect(r.posted.at(-1)).toMatchObject({ id: 'bad1', kind: 'state', state: 'stopped', why: expect.stringContaining('could not read') });
    r.hub.handleFrameMessage({ ...START, id: 'bad2', target: 'c'.repeat(129) });
    expect(r.posted.at(-1)).toMatchObject({ id: 'bad2', state: 'stopped' });
    for (let i = 0; i < 4; i++) r.hub.handleFrameMessage({ ...START, id: `k${i}` });
    r.hub.handleFrameMessage({ ...START, id: 'fifth' });
    expect(r.posted.at(-1)).toMatchObject({ id: 'fifth', state: 'stopped', why: expect.stringContaining('at most 4') });
    r.hub.dispose();
  });

  it('tells the page each live video has stopped when the hub ends', async () => {
    const r = rig();
    r.hub.handleFrameMessage(START);
    await flush();
    r.posted.length = 0;
    r.hub.dispose();
    expect(r.posted).toEqual([expect.objectContaining({ id: 'v1', kind: 'state', state: 'stopped', why: expect.stringContaining('not on screen') })]);
  });

  it('tells the page plainly when main refuses, and cleans up', async () => {
    const r = rig();
    r.bridge.videoStart.mockResolvedValueOnce({ ok: false as any, message: 'No camera by that name.' } as any);
    r.hub.handleFrameMessage(START);
    await flush();
    expect(r.states()).toEqual([['starting'], ['stopped', 'No camera by that name.']]);
    expect(r.peers[0].closed).toBe(true);
    expect(r.els[0].removed).toBe(true);
    r.hub.dispose();
  });

  it('applies the answer, holds candidates until it is set, and ignores a malformed one', async () => {
    const r = rig();
    r.hub.handleFrameMessage(START);
    await flush();
    r.push({ socket: 'lv1', kind: 'video-candidate', candidate: '{"candidate":"candidate:1 1 udp 1 192.168.4.9 5 typ host"}' });
    r.push({ socket: 'lv1', kind: 'video-candidate', candidate: 'not json' });
    expect(r.peers[0].candidates).toEqual([]);
    r.push({ socket: 'lv1', kind: 'video-answer', answer: 'v=0 answer' });
    await flush();
    expect(r.peers[0].remote).toEqual([{ type: 'answer', sdp: 'v=0 answer' }]);
    expect(r.peers[0].candidates).toEqual([{ candidate: 'candidate:1 1 udp 1 192.168.4.9 5 typ host' }]);
    r.push({ socket: 'lv1', kind: 'video-candidate', candidate: '{"candidate":"candidate:2 1 udp 1 192.168.4.10 5 typ host"}' });
    await flush();
    expect(r.peers[0].candidates).toHaveLength(2);
    r.hub.dispose();
  });

  it('keeps events main pushes before the start\'s own reply reaches the host', async () => {
    const r = rig();
    r.bridge.videoStart.mockImplementationOnce(async () => {
      // The push beats the reply.
      r.push({ socket: 'lv1', kind: 'video-answer', answer: 'v=0 early answer' });
      return { ok: true as const, video: 'lv1' };
    });
    r.hub.handleFrameMessage(START);
    await flush();
    expect(r.peers[0].remote).toEqual([{ type: 'answer', sdp: 'v=0 early answer' }]);
    r.hub.dispose();
  });

  it('ignores events for an id it never mapped', async () => {
    const r = rig();
    await playing(r);
    r.push({ socket: 'lv99', kind: 'video-stopped', why: 'forged' });
    expect(r.states().flat()).not.toContain('forged');
    r.hub.dispose();
  });

  it('puts the picture in a muted, playing element and only the video track', async () => {
    const r = rig();
    const { el } = await playing(r);
    expect(el.srcObject).toEqual({ video: true });
    expect(el.plays).toBe(1);
    expect(el.muted).toBe(true);
    r.hub.dispose();
  });
});

describe('the frame pump: one picture at a time, and none left open', () => {
  it('sends a picture, tells the page it is playing, and sends the next only after the page acks that one', async () => {
    const r = rig();
    const { el } = await playing(r);
    el.frame();
    await flush();
    expect(r.frames()).toHaveLength(1);
    expect(r.frames()[0]).toMatchObject({ type: 'youcoded:video:event', id: 'v1', kind: 'frame', n: 1 });
    expect(r.states()).toEqual([['starting'], ['playing']]);
    // The bitmap is TRANSFERRED to the frame, not copied.
    expect(r.transfers[r.posted.indexOf(r.frames()[0])]).toEqual([r.bitmaps[0]]);
    // More frames arrive while the page is still drawing: none is made.
    el.frame(); await flush(); el.frame(); await flush();
    expect(r.bitmaps).toHaveLength(1);
    // A wrong or repeated ack changes nothing; the right one lets the next through.
    r.hub.handleFrameMessage({ type: 'youcoded:video:ack', id: 'v1', n: 5 });
    r.hub.handleFrameMessage({ type: 'youcoded:video:ack', id: 'v9', n: 1 });
    el.frame(); await flush();
    expect(r.bitmaps).toHaveLength(1);
    r.hub.handleFrameMessage({ type: 'youcoded:video:ack', id: 'v1', n: 1 });
    r.hub.handleFrameMessage({ type: 'youcoded:video:ack', id: 'v1', n: 1 });
    tick();
    el.frame(); await flush();
    expect(r.bitmaps).toHaveLength(2);
    expect(r.frames().map((f) => f.n)).toEqual([1, 2]);
    // The second ack of picture 1 must not have freed picture 2.
    el.frame(); await flush();
    expect(r.bitmaps).toHaveLength(2);
    r.hub.dispose();
  });

  it('closes a bitmap that was being made when the video ended, instead of sending it', async () => {
    const r = rig();
    const { el } = await playing(r);
    r.holdBitmaps(true);
    el.frame();
    await flush();
    expect(r.bitmaps).toHaveLength(1);
    r.hub.handleFrameMessage({ type: 'youcoded:video:stop', id: 'v1' });
    r.releaseBitmaps();
    await flush();
    expect(r.bitmaps[0].closed).toBe(true);
    expect(r.frames()).toHaveLength(0);
    r.hub.dispose();
  });

  it('closes a bitmap that cannot be posted (the frame went away)', async () => {
    const r = rig();
    const posts: any[] = [];
    const hub = createPageVideoHub({
      pageId: 'personal:home', frame: 'f1', bridge: () => r.bridge as any,
      deps: { createPeer: () => { const p = new FakePeer(); r.peers.push(p); return p; }, createVideoEl: () => { const e = new FakeEl(); r.els.push(e); return e; }, createBitmap: async () => { const b: Bitmap = { id: 1, closed: false, close() { this.closed = true; } }; r.bitmaps.push(b); return b as unknown as ImageBitmap; } },
      post: (m) => { if ((m as any).kind === 'frame') return false; posts.push(m); return true; }, // the real post does nothing, and does not throw, when the frame is gone
    });
    hub.handleFrameMessage(START);
    await flush();
    r.push({ socket: 'lv1', kind: 'video-answer', answer: 'a' });
    r.peers[0].emit('track', { track: { kind: 'video' }, streams: [{}] });
    r.els[0].frame();
    await flush();
    expect(r.bitmaps[0].closed).toBe(true);
    // And the pump is not left waiting for an ack that can never come: the next picture is made.
    tick();
    r.els[0].frame();
    await flush();
    expect(r.bitmaps).toHaveLength(2);
    hub.dispose();
  });

  it('makes at most about 15 pictures a second, however fast the camera sends and however fast the page acks', async () => {
    const r = rig();
    const { el } = await playing(r);
    for (let i = 1; i <= 30; i++) {
      el.frame(); await flush();
      r.hub.handleFrameMessage({ type: 'youcoded:video:ack', id: 'v1', n: r.frames().at(-1)?.n });
      tick(33); // a 30 fps camera
    }
    // 30 frames over about one second: no more than 15 pictures (+1 for the edge).
    expect(r.bitmaps.length).toBeGreaterThanOrEqual(10);
    expect(r.bitmaps.length).toBeLessThanOrEqual(16);
    r.hub.dispose();
  });

  it('asks for a smaller picture when the camera is wider than 1280 pixels, and leaves a smaller one alone', async () => {
    const r = rig();
    const { el } = await playing(r);
    el.frame(); await flush();
    expect(r.bitmapOpts).toEqual([undefined]);
    r.hub.handleFrameMessage({ type: 'youcoded:video:ack', id: 'v1', n: 1 });
    el.videoWidth = 1920;
    tick(); el.frame(); await flush();
    expect(r.bitmapOpts[1]).toEqual({ resizeWidth: 1280, resizeQuality: 'low' });
    r.hub.dispose();
  });

  it('reads the track directly when the element\'s frame callback is missing, and drops (closes) a frame while one is out', async () => {
    const closes: number[] = [];
    let frameNo = 0;
    const queue: Array<(v: { done: boolean; value?: { close(): void } }) => void> = [];
    const r = rig({
      createVideoEl: () => { const e = new FakeEl(); (e as any).requestVideoFrameCallback = undefined; r.els.push(e); return e; },
      createProcessor: () => ({ read: () => new Promise((res) => queue.push(res)), cancel: () => { /* reader cancelled */ } }),
    });
    await playing(r);
    const feed = async () => { tick(); const n = ++frameNo; queue.shift()!({ done: false, value: { close: () => closes.push(n) } }); await flush(); };
    await feed();           // picture 1 goes out
    expect(r.frames()).toHaveLength(1);
    await feed();           // arrives while picture 1 is out: closed, not kept
    expect(closes).toEqual([1, 2]); // 1: closed after the bitmap was made; 2: dropped
    expect(r.bitmaps).toHaveLength(1);
    r.hub.handleFrameMessage({ type: 'youcoded:video:ack', id: 'v1', n: 1 });
    await feed();
    expect(r.bitmaps).toHaveLength(2);
    r.hub.dispose();
  });

  it('switches to the track reader if the element\'s frame callback stalls', async () => {
    vi.useFakeTimers();
    let readers = 0;
    const r = rig({ createProcessor: () => { readers++; return { read: () => new Promise(() => {}), cancel: () => {} }; } });
    await playing(r);
    expect(readers).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readers).toBe(1);
    r.hub.dispose();
  });
});

describe('when a video must stop', () => {
  it('stops when the page says so: main is told, the peer and element are released, and the page is not echoed', async () => {
    const r = rig();
    const { pc, el } = await playing(r);
    r.hub.handleFrameMessage({ type: 'youcoded:video:stop', id: 'v1' });
    expect(r.bridge.videoStop).toHaveBeenCalledWith({ page: 'personal:home', frame: 'f1', video: 'lv1' });
    expect(pc.closed).toBe(true);
    expect(el.removed).toBe(true);
    expect(el.srcObject).toBeNull();
    expect(r.states()).toEqual([['starting']]);
    r.hub.dispose();
  });

  it('stops, and says why, when main says stopped (without asking main to stop again)', async () => {
    const r = rig();
    const { pc } = await playing(r);
    r.push({ socket: 'lv1', kind: 'video-stopped', why: 'The video reached its 5-minute limit.' });
    expect(r.states().at(-1)).toEqual(['stopped', 'The video reached its 5-minute limit.']);
    expect(pc.closed).toBe(true);
    expect(r.bridge.videoStop).not.toHaveBeenCalled();
    r.hub.dispose();
  });

  it('stops when the peer connection fails', async () => {
    const r = rig();
    const { pc } = await playing(r);
    pc.connectionState = 'failed';
    pc.emit('connectionstatechange');
    expect(r.states().at(-1)).toEqual(['stopped', 'The video connection to the camera failed.']);
    expect(r.bridge.videoStop).toHaveBeenCalledTimes(1);
    r.hub.dispose();
  });

  it('stops on purpose when the window is hidden, says why, and does NOT start again when it is shown', async () => {
    const r = rig();
    const { pc } = await playing(r);
    setVisibility('hidden');
    expect(r.states().at(-1)).toEqual(['stopped', 'paused while the page was hidden']);
    expect(r.bridge.videoStop).toHaveBeenCalledTimes(1);
    expect(pc.closed).toBe(true);
    setVisibility('visible');
    await flush();
    expect(r.bridge.videoStart).toHaveBeenCalledTimes(1);
    r.hub.dispose();
  });

  it('refuses to start while hidden, with the same reason, and never builds a peer', async () => {
    const r = rig();
    setVisibility('hidden');
    r.hub.handleFrameMessage(START);
    await flush();
    expect(r.states()).toEqual([['stopped', 'paused while the page was hidden']]);
    expect(r.peers).toHaveLength(0);
    expect(r.bridge.videoStart).not.toHaveBeenCalled();
    r.hub.dispose();
  });

  it('stops everything when the hub is disposed (the frame unmounted or its document changed)', async () => {
    const r = rig();
    const { pc, el } = await playing(r);
    r.hub.dispose();
    expect(r.bridge.videoStop).toHaveBeenCalledWith({ page: 'personal:home', frame: 'f1', video: 'lv1' });
    expect(pc.closed).toBe(true);
    expect(el.removed).toBe(true);
    // A late answer or picture after disposal does nothing.
    r.push({ socket: 'lv1', kind: 'video-answer', answer: 'late' });
    expect(pc.remote).toEqual([{ type: 'answer', sdp: 'v=0 answer' }]);
  });

  it('closes main\'s video if the page stopped it while main was still answering', async () => {
    const r = rig();
    let release!: () => void;
    r.bridge.videoStart.mockImplementationOnce(() => new Promise((res) => { release = () => res({ ok: true as const, video: 'lv7' }); }));
    r.hub.handleFrameMessage(START);
    await flush();
    r.hub.handleFrameMessage({ type: 'youcoded:video:stop', id: 'v1' });
    release();
    await flush();
    expect(r.bridge.videoStop).toHaveBeenCalledWith({ page: 'personal:home', frame: 'f1', video: 'lv7' });
    r.hub.dispose();
  });

  it('stops after 5 minutes', async () => {
    vi.useFakeTimers();
    const r = rig();
    r.hub.handleFrameMessage(START);
    await vi.advanceTimersByTimeAsync(10);
    r.push({ socket: 'lv1', kind: 'video-answer', answer: 'a' });
    r.peers[0].emit('track', { track: { kind: 'video' }, streams: [{}] });
    r.els[0].frame();
    await vi.advanceTimersByTimeAsync(10);
    await alive(r, VIDEO_MAX_MS);
    expect(r.states().at(-1)).toEqual(['stopped', 'The video reached its 5-minute limit. Play again to keep watching.']);
    expect(r.bridge.videoStop).toHaveBeenCalledTimes(1);
    r.hub.dispose();
  });

  it('stops with a plain reason if the camera never produces a picture', async () => {
    vi.useFakeTimers();
    const r = rig();
    r.hub.handleFrameMessage(START);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.states().at(-1)).toEqual(['stopped', 'The camera did not start playing.']);
    r.hub.dispose();
  });

  it('stops, with a reason, when main answers a ping with "not playing any more" (main ended it silently)', async () => {
    vi.useFakeTimers();
    const r = rig();
    const { el } = await playing(r);
    el.frame();
    r.bridge.videoPing.mockResolvedValueOnce({ ok: false, message: 'That video is not playing any more.' } as any);
    await alive(r, VIDEO_PING_MS); // the camera is alive; only the ping tells
    expect(r.states().at(-1)).toEqual(['stopped', 'The video stopped.']);
    expect(r.peers[0].closed).toBe(true);
    expect(r.bridge.videoStop).not.toHaveBeenCalled(); // main already ended it
    r.hub.dispose();
  });

  it('stops when the connection stays "disconnected" for 10 seconds, but not when it comes back', async () => {
    vi.useFakeTimers();
    const r = rig();
    const { pc, el } = await playing(r);
    el.frame();
    pc.connectionState = 'disconnected'; pc.emit('connectionstatechange');
    await vi.advanceTimersByTimeAsync(DISCONNECT_MS - 1_000);
    pc.connectionState = 'connected'; pc.emit('connectionstatechange');
    await alive(r, DISCONNECT_MS * 2);
    expect(r.states().at(-1)).toEqual(['playing']);
    pc.connectionState = 'disconnected'; pc.emit('connectionstatechange');
    await vi.advanceTimersByTimeAsync(DISCONNECT_MS + 1);
    expect(r.states().at(-1)).toEqual(['stopped', 'The connection to the camera was lost.']);
    expect(r.bridge.videoStop).toHaveBeenCalledTimes(1);
    r.hub.dispose();
  });

  it('stops when no picture has come for 15 seconds while playing', async () => {
    vi.useFakeTimers();
    const r = rig();
    const { el } = await playing(r);
    el.frame(); await vi.advanceTimersByTimeAsync(10);
    await alive(r, 10_000);
    expect(r.states().at(-1)).toEqual(['playing']);
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1_000); // the camera goes quiet
    expect(r.states().at(-1)).toEqual(['stopped', 'The camera stopped sending pictures.']);
    expect(r.bridge.videoStop).toHaveBeenCalledTimes(1);
    r.hub.dispose();
  });

  it('pings main every 20 seconds while visible, and not at all while hidden', async () => {
    vi.useFakeTimers();
    const r = rig();
    r.hub.handleFrameMessage(START);
    await vi.advanceTimersByTimeAsync(10);
    r.push({ socket: 'lv1', kind: 'video-answer', answer: 'a' });
    r.peers[0].emit('track', { track: { kind: 'video' }, streams: [{}] });
    r.els[0].frame(); // a picture, so the "no picture" limit does not end it first
    await alive(r, VIDEO_PING_MS * 2);
    expect(r.bridge.videoPing).toHaveBeenCalledTimes(2);
    expect(r.bridge.videoPing).toHaveBeenCalledWith({ page: 'personal:home', frame: 'f1', video: 'lv1' });
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(VIDEO_PING_MS * 3);
    expect(r.bridge.videoPing).toHaveBeenCalledTimes(2);
    r.hub.dispose();
  });
});

describe('wired to a frame', () => {
  it('a page\'s message starts a video, a stranger\'s does not, and unmounting stops it', async () => {
    const r = rig();
    const frameWindow = { postMessage: vi.fn() };
    const frameRef = { current: { contentWindow: frameWindow } as unknown as HTMLIFrameElement };
    const bridge = { ...r.bridge, videoPlayback: { createPeer: () => { const p = new FakePeer(); r.peers.push(p); return p; }, createVideoEl: () => { const e = new FakeEl(); r.els.push(e); return e; } } };
    const { unmount } = renderHook(() => usePageSockets(frameRef, 'personal:home', true, 'doc1', () => bridge as any));
    window.dispatchEvent(new MessageEvent('message', { data: START, source: {} as MessageEventSource }));
    await flush();
    expect(r.bridge.videoStart).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', { data: START, source: frameWindow as unknown as MessageEventSource }));
    await flush();
    expect(r.bridge.videoStart).toHaveBeenCalledTimes(1);
    expect(frameWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'youcoded:video:event', kind: 'state', state: 'starting' }), '*', undefined);
    unmount();
    expect(r.bridge.videoStop).toHaveBeenCalledTimes(1);
    expect(r.peers[0].closed).toBe(true);
  });
});
