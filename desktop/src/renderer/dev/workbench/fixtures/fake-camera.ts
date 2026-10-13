// A pretend camera for the workbench (the page's `youcoded.video`): no network,
// no WebRTC. The REAL host code (page-video-host.ts) runs against these stand-ins,
// so the frame hand-off, one-picture-at-a-time ack and stop rules are exercised
// exactly as in the app; only the peer connection and the picture source are fake.
// Dev-only: reached through the workbench's mock `pages` bridge, never shipped.
import type { PeerLike, VideoElLike, VideoHostDeps } from '../../../components/pages/page-video-host';

const FRAME_MS = 160;

/** Google refusing live video (HA's own words for the real refusal, from the owner's log): while set, the workbench's pretend
 *  Home Assistant answers every video start with "stopped" and this reason, so the page's back-off can be seen. Off by default. */
export const FAKE_RATE_LIMIT_WHY = 'Error handling WebRTC offer: Nest API error: Too Many Requests (429): RESOURCE_EXHAUSTED Rate limited for the GenerateWebRtcStream API';
let refusal: string | null = null;
export function fakeCameraRefuse(why: string | null): void { refusal = why; }
export function fakeCameraRefusal(): string | null { return refusal; }

export function fakeCameraDeps(): Partial<VideoHostDeps> {
  // Made on the first picture, not here: the mock is built in places with no real document.
  let canvas: HTMLCanvasElement | null = null;
  let tick = 0;
  const peer = (): PeerLike => {
    const listeners = new Map<string, Array<(e: any) => void>>();
    const track = { kind: 'video' };
    return {
      addTransceiver: () => ({}),
      createDataChannel: () => ({}),
      createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\n(workbench offer)' }),
      setLocalDescription: async () => {},
      // Once the "answer" arrives, the picture "starts": a video track appears.
      setRemoteDescription: async () => { setTimeout(() => (listeners.get('track') ?? []).forEach((cb) => cb({ track, streams: [{}] })), 20); },
      addIceCandidate: async () => {},
      close: () => {},
      localDescription: { sdp: 'v=0\r\n(workbench offer)' },
      iceGatheringState: 'complete',
      connectionState: 'connected',
      addEventListener: (t, cb) => { listeners.set(t, [...(listeners.get(t) ?? []), cb]); },
      removeEventListener: (t, cb) => { listeners.set(t, (listeners.get(t) ?? []).filter((x) => x !== cb)); },
    };
  };
  const el = (): VideoElLike => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    return {
      srcObject: null, muted: true, readyState: 4,
      play: () => {},
      remove: () => { cancelled = true; if (timer) clearTimeout(timer); },
      requestVideoFrameCallback: (cb) => { timer = setTimeout(() => { if (!cancelled) cb(); }, FRAME_MS); return 1; },
      cancelVideoFrameCallback: () => { if (timer) clearTimeout(timer); },
    };
  };
  return {
    createPeer: peer,
    createVideoEl: el,
    // A moving test card, so a person can see frames really arrive in the page's canvas.
    createBitmap: async () => {
      if (!canvas) { canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; }
      const g = canvas.getContext('2d')!;
      tick++;
      g.fillStyle = `hsl(${(tick * 9) % 360} 40% 30%)`;
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#fff';
      g.font = '28px sans-serif';
      g.fillText('Workbench camera (pretend)', 24, 60);
      g.fillRect(24 + ((tick * 12) % 560), 200, 40, 40);
      return createImageBitmap(canvas!);
    },
  };
}
