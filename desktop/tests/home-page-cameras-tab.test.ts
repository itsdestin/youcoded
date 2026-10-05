// @vitest-environment jsdom
// The Home page's Cameras tab: every camera in a grid, all live at once while the tab is open and
// the page is visible; leaving the tab or hiding the page stops them all; a stream the app ended
// is started again quietly; a camera that only gives pictures shows its picture. Runs the real
// page against the workbench's pretend Home Assistant.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { HOME_ASSISTANT_PAGE_HTML } from '../src/renderer/dev/workbench/fixtures/home-assistant-page';
import { fakeHomeAssistantFetch, fakeHomeAssistantNestSignedIn, fakeHomeAssistantSocket } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import type { PageFetchRequest } from '../src/shared/pages-types';

interface FakeVideo { ended?: boolean; target: string; o: { onFrame: (b: unknown, ack: () => void) => void; onState: (s: string, why?: string) => void }; stop: ReturnType<typeof vi.fn> }
const videos: FakeVideo[] = [];
let hidden = false;

const flush = async () => { await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(0); };
const frame = async () => { await vi.advanceTimersByTimeAsync(20); await flush(); };
/** The newest video asked for a camera. */
const latest = (target: string) => [...videos].reverse().find((v) => v.target === target)!;
/** The cameras whose newest video is neither stopped by the page nor ended by the app. */
const running = () => new Set([...new Set(videos.map((v) => v.target))].filter((t) => { const v = latest(t); return !v.ended && v.stop.mock.calls.length === 0; }));
/** The app ends a video (its 5-minute limit, a failure). */
const end = (v: FakeVideo, why: string) => { v.ended = true; v.o.onState('stopped', why); };
const tile = (id: string) => document.querySelector<HTMLElement>(`.cam-tile[data-eid="${id}"]`)!;
const NEST_LIVE = ['camera.living_room_camera', 'camera.hallway_camera', 'camera.backyard_camera'];
const play = (v: FakeVideo) => v.o.onFrame({ width: 640, height: 360, close: vi.fn() }, vi.fn());

beforeAll(async () => {
  fakeHomeAssistantNestSignedIn(true);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: vi.fn() })) as never;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
  const html = HOME_ASSISTANT_PAGE_HTML;
  document.head.innerHTML = /<head>([\s\S]*?)<\/head>/.exec(html)![1];
  document.body.innerHTML = /<body>([\s\S]*?)<script>/.exec(html)![1];
  (window as unknown as { youcoded: unknown }).youcoded = {
    devices: { ha: 'http://100.99.234.114:8123' }, data: { view: 'cameras' },
    save: () => undefined, onRefresh: () => undefined, onData: () => undefined,
    fetch: async (url: string, opts: Omit<PageFetchRequest, 'url'> = {}) => {
      const req = { url, ...opts } as PageFetchRequest;
      return fakeHomeAssistantSocket(req) ?? fakeHomeAssistantFetch(req) ?? { ok: false, status: 404, headers: {}, body: '' };
    },
    video: (_connection: string, target: string, o: FakeVideo['o']) => {
      const v: FakeVideo = { target, o, stop: vi.fn() };
      videos.push(v);
      return v;
    },
  };
  new Function(/<script>([\s\S]*?)<\/script>/.exec(html)![1])();
  await flush();
  await vi.waitFor(() => expect(videos.length).toBeGreaterThanOrEqual(3));
});
afterAll(() => { vi.useRealTimers(); fakeHomeAssistantNestSignedIn(false); });

describe('the Cameras tab', () => {
  it('shows a pill with the camera count and a tile for every camera, between Climate and Problems', () => {
    const pills = Array.from(document.querySelectorAll('#chips [data-view]')).map((p) => p.getAttribute('data-view'));
    expect(pills.indexOf('cameras')).toBe(pills.indexOf('climate') + 1);
    expect(pills.indexOf('problems')).toBe(pills.indexOf('cameras') + 1);
    expect(document.querySelectorAll('.cam-tile')).toHaveLength(5);
  });

  it('starts every working camera when it opens, and shows a camera that only gives pictures with its picture', () => {
    expect(running()).toEqual(new Set(NEST_LIVE)); // the doorbell is not responding, the garage camera has pictures
    expect(tile('camera.doorbell').textContent).toContain('Not responding');
    expect(tile('camera.garage_pi').querySelector('img.cam')!.getAttribute('src')).toMatch(/^data:image\//);
    expect(tile('camera.garage_pi').querySelector('.cam-badge')).toBeNull(); // a picture is not "live"
  });

  it('gives each tile a LIVE badge only once its picture is really playing, and says how many are live on the pill', async () => {
    expect(tile('camera.living_room_camera').querySelector('.cam-badge')).toBeNull();
    expect(tile('camera.living_room_camera').textContent).toContain('Starting live view');
    play(latest('camera.living_room_camera'));
    await frame();
    expect(tile('camera.living_room_camera').querySelector('.cam-badge')!.textContent).toBe('LIVE');
    expect(tile('camera.living_room_camera').querySelector('canvas')).toBeTruthy();
    expect(document.querySelector('#chips [data-view="cameras"]')!.textContent).toContain('1 live');
  });

  it('starts a stream the app ended again at once, quietly, on the same picture', async () => {
    const before = latest('camera.living_room_camera');
    const canvas = tile('camera.living_room_camera').querySelector('canvas');
    await vi.advanceTimersByTimeAsync(11_000); // it has been playing a while: the app ends it after about 5 minutes
    end(before, 'The video reached its 5-minute limit. Play again to keep watching.');
    await frame();
    // Nothing says "stopped" meanwhile: the picture stays up and the badge stays.
    expect(tile('camera.living_room_camera').querySelector('.cam-badge')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(500);
    expect(latest('camera.living_room_camera')).not.toBe(before);
    await frame();
    expect(tile('camera.living_room_camera').querySelector('canvas')).toBe(canvas);
  });

  it('pressing a tile opens that camera’s pop-up with its recordings, and the tile keeps streaming', async () => {
    const stopsBefore = videos.filter((v) => v.stop.mock.calls.length).length;
    tile('camera.hallway_camera').querySelector<HTMLButtonElement>('[data-cam-act="open"]')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('.dlg .cam-ev').length).toBe(3));
    expect(document.querySelector('.dlg [data-cam-act="live"]')).toBeNull(); // no second Live button: the tile is the live view
    expect(videos.filter((v) => v.stop.mock.calls.length).length).toBe(stopsBefore);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
  });

  it('stops every live picture when the tab is left', async () => {
    document.querySelector<HTMLButtonElement>('[data-home]')!.click();
    await flush();
    expect(running().size).toBe(0);
    expect(document.querySelector('.cam-tile')).toBeNull();
  });

  it('starts them all again when the tab is opened again, and stops them all when the page is hidden', async () => {
    const count = videos.length;
    document.querySelector<HTMLButtonElement>('[data-view="cameras"]')!.click();
    await flush();
    await vi.waitFor(() => expect(running()).toEqual(new Set(NEST_LIVE)));
    expect(videos.length).toBe(count + 3);
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(running().size).toBe(0);
    // Back on screen: they start again.
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(running()).toEqual(new Set(NEST_LIVE));
  });

  it('waits, with a growing pause, when a stream keeps failing to start, and says why', async () => {
    const first = latest('camera.backyard_camera');
    end(first, 'The camera did not answer.');
    await frame();
    expect(tile('camera.backyard_camera').textContent).toContain('Live view stopped: The camera did not answer.');
    const count = videos.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(videos.length).toBe(count); // not yet: first pause is 2 seconds
    await vi.advanceTimersByTimeAsync(1_500);
    expect(videos.length).toBe(count + 1);
    end(latest('camera.backyard_camera'), 'The camera did not answer.');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(videos.length).toBe(count + 1); // second pause is 4 seconds
    await vi.advanceTimersByTimeAsync(1_500);
    expect(videos.length).toBe(count + 2);
  });
});
