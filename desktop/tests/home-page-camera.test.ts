// @vitest-environment jsdom
// The Home page's camera card (spec 2026-10-04, Parts 2 and 3): a Nest camera
// shows its recent events and a Watch live button; pressing an event plays its
// clip (fetched by the app as a video); Watch live draws the app's live pictures
// on a canvas until Stop; a camera that gives a still picture keeps it. Runs the
// real page against the workbench's pretend Home Assistant.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { HOME_ASSISTANT_PAGE_HTML } from '../src/renderer/dev/workbench/fixtures/home-assistant-page';
import { fakeHomeAssistantFetch, fakeHomeAssistantNestSignedIn, fakeHomeAssistantSocket } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import type { PageFetchRequest } from '../src/shared/pages-types';

const fetched: PageFetchRequest[] = [];
interface FakeVideo { connection: string; target: string; o: { onFrame: (b: unknown, ack: () => void) => void; onState: (s: string, why?: string) => void }; stop: ReturnType<typeof vi.fn> }
const videos: FakeVideo[] = [];
const drawImage = vi.fn();
// The doorbell gives a real still picture in one test, as a non-Nest camera would.
let doorbellPicture = false;

const card = (name: string) => Array.from(document.querySelectorAll<HTMLElement>('.cam-card')).find((c) => c.querySelector('.name')?.textContent?.startsWith(name));
const living = () => card('Living room camera')!;

beforeAll(async () => {
  fakeHomeAssistantNestSignedIn(true);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  // jsdom cannot draw; the page's canvas gets a stand-in whose calls can be read.
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage })) as never;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const html = HOME_ASSISTANT_PAGE_HTML;
  document.head.innerHTML = /<head>([\s\S]*?)<\/head>/.exec(html)![1];
  document.body.innerHTML = /<body>([\s\S]*?)<script>/.exec(html)![1];
  (window as unknown as { youcoded: unknown }).youcoded = {
    devices: { ha: 'http://100.99.234.114:8123' }, data: {},
    save: () => undefined, onRefresh: () => undefined, onData: () => undefined,
    fetch: async (url: string, opts: Omit<PageFetchRequest, 'url'> = {}) => {
      const req = { url, ...opts } as PageFetchRequest;
      fetched.push(req);
      if (doorbellPicture && req.url.endsWith('/api/camera_proxy/camera.doorbell')) {
        return { ok: true, status: 200, headers: {}, body: 'data:image/jpeg;base64,' + 'A'.repeat(7000) };
      }
      return fakeHomeAssistantSocket(req) ?? fakeHomeAssistantFetch(req) ?? { ok: false, status: 404, headers: {}, body: '' };
    },
    video: (connection: string, target: string, o: FakeVideo['o']) => {
      const v: FakeVideo = { connection, target, o, stop: vi.fn() };
      videos.push(v);
      return v;
    },
  };
  new Function(/<script>([\s\S]*?)<\/script>/.exec(html)![1])();
  await vi.waitFor(() => expect(living().querySelectorAll('.cam-ev').length).toBeGreaterThan(0));
});
afterAll(() => { vi.useRealTimers(); fakeHomeAssistantNestSignedIn(false); });

describe('a Nest camera card', () => {
  it('has a header with the camera name, its model and a Live button, then a short scrolling list of up to 20 recent events', () => {
    expect(living().querySelector('.name .sub')!.textContent).toBe('Nest Cam');
    const rows = Array.from(living().querySelectorAll('.cam-ev')).map((r) => r.querySelector('.w')!.textContent);
    // The pretend house has 22; the card loads 20, newest first, each with a kind and a time.
    expect(rows).toHaveLength(20);
    expect(rows.slice(0, 6)).toEqual(['Person', 'Motion', 'Doorbell rang', 'Person', 'Motion', 'Sound']);
    for (const t of Array.from(living().querySelectorAll('.cam-ev time'))) expect(t.textContent).toMatch(/\d{1,2}:\d{2} (am|pm)/);
    // The Live button is in the header, unpressed; the list is its own scrolling box.
    const btn = living().querySelector('.cam-head [data-cam-act="live"]')!;
    expect(btn.textContent).toBe('Live');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(living().querySelector('.cam-evs')).toBeTruthy();
  });

  it('asks Home Assistant for the camera’s own events, and shows thumbnails as they arrive', async () => {
    expect(fetched.some((r) => r.socket?.send.some((m) => m.includes('media_source/browse_media') && m.includes('media-source://nest/dev_camera_living_room_camera')))).toBe(true);
    await vi.waitFor(() => expect(living().querySelector('.cam-ev img')!.getAttribute('src')).toMatch(/^data:image\//));
  });

  it('loads thumbnails for the first rows only, and more as the list is scrolled', async () => {
    const thumbs = () => fetched.filter((r) => r.url.includes('/living_room_camera/') || r.url.includes('dev_camera_living_room_camera')).filter((r) => r.url.endsWith('/thumbnail')).length;
    await vi.waitFor(() => expect(thumbs()).toBe(6));
    const box = living().querySelector<HTMLElement>('.cam-evs')!;
    Object.defineProperty(box, 'scrollTop', { configurable: true, value: 10 * 50 });
    box.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(thumbs()).toBe(12));
    expect(living().querySelectorAll('.cam-ev img[src^="data:image/"]').length).toBe(12);
  });

  it('says plainly when a camera has no recordings, and still offers Watch live', () => {
    const bell = card('Doorbell')!;
    expect(bell.querySelector('.cam-note')!.textContent).toBe('No recordings yet. Nest only saves clips when it can send events to Home Assistant.');
    expect(bell.querySelector('.cam-ev')).toBeNull();
    // The doorbell is not responding in the pretend house: the button is there but cannot be pressed.
    expect(bell.querySelector<HTMLButtonElement>('[data-cam-act="live"]')!.disabled).toBe(true);
  });

  it('plays an event’s clip: the app fetches it as a video and the card shows a player', async () => {
    living().querySelector<HTMLButtonElement>('.cam-ev')!.click();
    await vi.waitFor(() => expect(living().querySelector('video')).toBeTruthy());
    const clipFetch = fetched.filter((r) => r.as === 'video');
    expect(clipFetch).toHaveLength(1);
    expect(clipFetch[0].url).toMatch(/^http:\/\/100\.99\.234\.114:8123\/api\/nest\/event_media\//);
    const video = living().querySelector('video')!;
    // It plays in the picture area under the header, above the list (not below it).
    const stage = video.closest('.cam-view')!;
    expect(stage.compareDocumentPosition(living().querySelector('.cam-evs')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(living().querySelector('.cam-head')!.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(video.getAttribute('src')).toMatch(/^data:video\/mp4;base64,/);
    expect(video.controls).toBe(true);
    expect(video.muted).toBe(true);
    // Closing it takes the player away and leaves the list.
    living().querySelector<HTMLButtonElement>('[data-cam-act="close"]')!.click();
    expect(living().querySelector('video')).toBeNull();
    expect(living().querySelectorAll('.cam-ev')).toHaveLength(20);
  });

  it('keeps the player when the page redraws for another reason', async () => {
    living().querySelector<HTMLButtonElement>('.cam-ev')!.click();
    await vi.waitFor(() => expect(living().querySelector('video')).toBeTruthy());
    const before = living().querySelector('video');
    // Any other change on the page redraws its rooms.
    document.querySelector<HTMLButtonElement>('[data-act="edit"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-act="edit"]')!.click();
    expect(living().querySelector('video')).toBe(before);
    living().querySelector<HTMLButtonElement>('[data-cam-act="close"]')!.click();
  });

  it('draws live pictures on a canvas with a LIVE badge, hands each one back, and stops when told to', async () => {
    living().querySelector<HTMLButtonElement>('[data-cam-act="live"]')!.click();
    expect(living().querySelector('[data-cam-act="stop"]')!.getAttribute('aria-pressed')).toBe('true'); // the Live button is pressed while live
    expect(videos).toHaveLength(1);
    expect(videos[0].connection).toBe('ha');
    expect(videos[0].target).toBe('camera.living_room_camera');
    expect(living().textContent).toContain('Starting live view');
    const bitmap = { width: 640, height: 360, close: vi.fn() };
    const ack = vi.fn();
    videos[0].o.onFrame(bitmap, ack);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(bitmap.close).toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    const canvas = living().querySelector('canvas')!;
    expect(canvas.width).toBe(640);
    expect(living().querySelector('.cam-badge')!.textContent).toBe('LIVE');
    // Pressing the pressed Live button ends it in the app and puts the button back to unpressed.
    living().querySelector<HTMLButtonElement>('[data-cam-act="stop"]')!.click();
    expect(videos[0].stop).toHaveBeenCalledTimes(1);
    expect(living().querySelector('canvas')).toBeNull();
    expect(living().querySelector('[data-cam-act="live"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('says in plain words why live video stopped, offers Play again, and keeps the Home Assistant link', () => {
    living().querySelector<HTMLButtonElement>('.cam-head [data-cam-act="live"]')!.click();
    videos[1].o.onState('stopped', 'paused while the page was hidden');
    const note = living().querySelector('.cam-note')!.textContent;
    expect(note).toBe('Live view stopped: paused while the page was hidden.');
    expect(living().querySelector('.cam-actions [data-cam-act="live"]')!.textContent).toContain('Play again');
    expect(living().querySelector('.cam-actions a')!.textContent).toBe('Watch live in Home Assistant');
    expect(living().querySelector('.cam-actions a')!.getAttribute('href')).toContain('/config/devices/device/');
  });
});

describe('a camera that gives a still picture', () => {
  it('keeps its picture instead of the events card', async () => {
    doorbellPicture = true;
    // The next round of pictures (every 10 seconds) finds a real one.
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(document.querySelector('img.cam[data-cam="camera.doorbell"]')!.getAttribute('src')).toMatch(/^data:image\/jpeg/));
    expect(card('Doorbell')).toBeUndefined();
  });
});

describe('scroll bars', () => {
  it('are thin, rounded and in the theme colours on every scrolling area, and no list switches that off with scrollbar-width', () => {
    const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join('\n');
    expect(css).toMatch(/\*::-webkit-scrollbar-thumb \{[^}]*border-radius: 9999px/);
    expect(css).toMatch(/\*::-webkit-scrollbar-thumb:hover \{[^}]*var\(--fg-muted\)/);
    expect(css).toMatch(/\*::-webkit-scrollbar-track[^{]*\{ background: transparent/);
    // Where scrollbar-width is set Chromium ignores the ::-webkit-scrollbar rules, so it may only appear for browsers without them.
    const outside = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@supports not selector\(::-webkit-scrollbar\) \{[^}]*\{[^}]*\} \}/, '');
    expect(outside).not.toMatch(/scrollbar-width/);
  });
});

describe('the three ways to start live (practice options)', () => {
  it.each(['look-cam-a', 'look-cam-b', 'look-cam-c'])('%s rewrites the built card and still runs as a page', async (key) => {
    const { findHomeVariant, withHomeVariant } = await import('../src/renderer/dev/workbench/fixtures/home-variants/registry');
    const out = withHomeVariant(HOME_ASSISTANT_PAGE_HTML, findHomeVariant(key)!); // throws if the page changed under the option
    for (const script of out.split('<script>').slice(1)) expect(() => new Function(script.split('</script>')[0])).not.toThrow();
  });
});
