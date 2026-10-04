// @vitest-environment jsdom
// The Home page's instant updates (spec 2026-10-04, Part 1): a change Home
// Assistant pushes lands on the card with no new template request, a press the
// person just made still wins over a push that has not caught up, a lost
// connection brings the 5-second checks back, and a new connection subscribes
// again once Home Assistant has accepted the key. Runs the real page against the
// workbench's pretend Home Assistant, with a stand-in for `youcoded.socket`.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { HOME_ASSISTANT_PAGE_HTML } from '../src/renderer/dev/workbench/fixtures/home-assistant-page';
import { fakeHomeAssistantFetch, fakeHomeAssistantLive, fakeHomeAssistantSocket } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import type { PageFetchRequest } from '../src/shared/pages-types';

interface FakeSocket {
  url: string; state: string; sent: string[];
  live: ReturnType<typeof fakeHomeAssistantLive> | null;
  say: (...texts: string[]) => void;
  setState: (s: string) => void;
  /** The app's side of a fresh connection: 'open', then (optionally) Home Assistant's "logged in". */
  open: (withAuth?: boolean) => void;
  send: (t: string) => boolean;
  close: () => void;
}
const sockets: FakeSocket[] = [];
let roomsRequests = 0;
// Service calls wait here, so a "press" can be answered late, as a slow TV is.
let serviceGate: Promise<void> | null = null;

const flush = async () => { await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(0); };
const frame = async () => { await vi.advanceTimersByTimeAsync(20); await flush(); };
const lamp = () => document.querySelector('[data-eid="light.living_room_lamp"]');
/** Whether the card shows the light as on (its switch's pressed state). */
const lampOn = () => lamp()!.querySelector('[data-toggle]')!.getAttribute('aria-pressed') === 'true';
const subscribes = (s: FakeSocket) => s.sent.map((t) => JSON.parse(t)).filter((m) => m.type === 'subscribe_entities');
/** Home Assistant's own compressed change for one light. */
const push = (s: FakeSocket, id: number, entity: string, plus: Record<string, unknown>) =>
  s.say(JSON.stringify({ id, type: 'event', event: { c: { [entity]: { '+': plus } } } }));

beforeAll(async () => {
  // jsdom reports a page nobody can see; the page only checks while it is on screen.
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  const html = HOME_ASSISTANT_PAGE_HTML;
  document.head.innerHTML = /<head>([\s\S]*?)<\/head>/.exec(html)![1];
  document.body.innerHTML = /<body>([\s\S]*?)<script>/.exec(html)![1];
  (window as unknown as { youcoded: unknown }).youcoded = {
    devices: { ha: 'http://100.99.234.114:8123' }, data: { open: ['living_room'] },
    save: () => undefined, onRefresh: () => undefined, onData: () => undefined,
    fetch: async (url: string, opts: Omit<PageFetchRequest, 'url'> = {}) => {
      const req = { url, ...opts } as PageFetchRequest;
      if (req.url.includes('/api/template') && !(req.body ?? '').includes('EXTRAS')) roomsRequests++;
      if (req.url.includes('/api/services/') && serviceGate) await serviceGate;
      return fakeHomeAssistantSocket(req) ?? fakeHomeAssistantFetch(req) ?? { ok: false, status: 404, headers: {}, body: '' };
    },
    socket: (url: string, o: { onState: (s: string, why?: string) => void; onMessages: (t: string[]) => void }) => {
      const s: FakeSocket = {
        url, state: 'connecting', sent: [], live: null,
        say: (...texts) => o.onMessages(texts),
        setState: (st) => { s.state = st; o.onState(st); },
        open: (withAuth = true) => {
          s.live?.close();
          s.live = fakeHomeAssistantLive((texts) => o.onMessages(texts));
          s.setState('open');
          const [required, ok] = s.live.opened();
          o.onMessages(withAuth ? [required, ok] : [required]);
        },
        send: (t) => {
          if (s.state !== 'open') return false;
          s.sent.push(t);
          const out = s.live!.message(t);
          if (out.length) o.onMessages(out);
          return true;
        },
        close: () => { s.state = 'closed'; s.live?.close(); },
      };
      sockets.push(s);
      return s;
    },
  };
  new Function(/<script>([\s\S]*?)<\/script>/.exec(html)![1])();
  await flush();
  await vi.waitFor(() => expect(lamp()).toBeTruthy());
});
afterAll(() => { vi.useRealTimers(); });

describe('instant updates', () => {
  it('opens the live connection to the device on load, and waits for Home Assistant to accept the key before saying anything', async () => {
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('http://100.99.234.114:8123/api/websocket');
    sockets[0].open(false); // open, but no "logged in" yet
    await flush();
    expect(sockets[0].sent).toEqual([]);
    // Even a check landing in between (it asks the page to follow the devices) waits for the yes.
    await vi.advanceTimersByTimeAsync(5_100);
    expect(sockets[0].sent).toEqual([]);
    // Home Assistant says yes: now the page subscribes, to every device it shows (remotes included).
    sockets[0].say(JSON.stringify({ type: 'auth_ok' }));
    await flush();
    const subs = subscribes(sockets[0]);
    expect(subs).toHaveLength(1);
    expect(subs[0].entity_ids).toEqual(expect.arrayContaining(['light.living_room_lamp', 'remote.destins_room_tv_remote', 'camera.doorbell', 'climate.thermostat']));
  });

  it('puts a pushed change on the card with no new template request', async () => {
    expect(lampOn()).toBe(true);
    const before = roomsRequests;
    // The house changes on its own (someone presses the switch on the wall).
    fakeHomeAssistantFetch({ url: 'http://100.99.234.114:8123/api/services/light/turn_off', method: 'POST', body: JSON.stringify({ entity_id: 'light.living_room_lamp' }) });
    await frame();
    expect(lampOn()).toBe(false);
    expect(roomsRequests).toBe(before);
  });

  it('lets a press the person just made win over a push that has not caught up', async () => {
    // Turn it on again (the house, directly), then press it OFF while the house is slow to answer.
    fakeHomeAssistantFetch({ url: 'http://100.99.234.114:8123/api/services/light/turn_on', method: 'POST', body: JSON.stringify({ entity_id: 'light.living_room_lamp' }) });
    await frame();
    expect(lampOn()).toBe(true);
    let release!: () => void;
    serviceGate = new Promise<void>((r) => { release = r; });
    lamp()!.querySelector<HTMLElement>('[data-toggle]')!.click();
    await frame();
    expect(lampOn()).toBe(false);
    // A late push still says "on": the press holds.
    push(sockets[0], 1, 'light.living_room_lamp', { s: 'on', lu: Date.now() / 1000 });
    await frame();
    expect(lampOn()).toBe(false);
    // The house catches up and agrees: still off, and the hold is released.
    serviceGate = null; release();
    await flush();
    await frame();
    expect(lampOn()).toBe(false);
  });

  it('checks the template once a minute while live, not every 5 seconds', async () => {
    await vi.advanceTimersByTimeAsync(1_000); // the check a press asks for after itself lands first
    const before = roomsRequests;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(roomsRequests).toBe(before);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(roomsRequests).toBe(before + 1);
  });

  it('shows "Reconnecting…" only after 5 seconds, and goes back to 5-second checks while the connection is down', async () => {
    const note = () => document.getElementById('livenote');
    sockets[0].setState('reconnecting');
    await vi.advanceTimersByTimeAsync(4_900);
    expect(note()?.hidden ?? true).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(note()!.hidden).toBe(false);
    expect(note()!.textContent).toBe('Reconnecting…');
    const before = roomsRequests;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(roomsRequests).toBeGreaterThanOrEqual(before + 2);
  });

  it('subscribes again on the new connection once Home Assistant has accepted the key', async () => {
    const first = subscribes(sockets[0]).length;
    sockets[0].open(false);
    await flush();
    expect(document.getElementById('livenote')!.hidden).toBe(true);
    expect(subscribes(sockets[0])).toHaveLength(first); // not before auth_ok
    sockets[0].say(JSON.stringify({ type: 'auth_ok' }));
    await flush();
    expect(subscribes(sockets[0])).toHaveLength(first + 1);
    // Messages start again from 1 on a fresh connection.
    expect(JSON.parse(sockets[0].sent[sockets[0].sent.length - 1]).id).toBe(1);
    // And it is live again: checks are slow once more.
    const before = roomsRequests;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(roomsRequests).toBe(before);
  });

  it('resumes 5-second checks when the connection is closed for good', async () => {
    sockets[0].setState('closed');
    await flush();
    const before = roomsRequests;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(roomsRequests).toBeGreaterThanOrEqual(before + 2);
  });
});
