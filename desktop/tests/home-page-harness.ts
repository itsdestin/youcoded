// NOTE: this file patches EventTarget.prototype.addEventListener for the whole test file, to remember every
// document- or window-level listener the page adds, so unmount() can remove them and a second mount starts
// clean. That is safe only because vitest gives each test file its own environment.
// Shared set-up for the Home page behaviour tests (redraw, newest-wins, pending,
// pop-up, clip): runs the REAL page in jsdom against the workbench's pretend Home
// Assistant, with fake clocks and a stand-in for `youcoded.socket`. Not a test file.
// Each test file mounts the page once or more; `unmount()` takes away the page's
// document-level listeners so a second mount starts clean.
import { vi } from 'vitest';
import { HOME_ASSISTANT_PAGE_HTML } from '../src/renderer/dev/workbench/fixtures/home-assistant-page';
import { fakeHomeAssistantFetch, fakeHomeAssistantLive, fakeHomeAssistantReset, fakeHomeAssistantSocket } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

export const BASE = 'http://100.99.234.114:8123';
export const flush = async () => { await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(0); };
export const frame = async () => { await vi.advanceTimersByTimeAsync(20); await flush(); };
export const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };
/** The house changes by itself (a wall switch, an automation): the pretend Home Assistant is told directly. */
export const house = (path: string, body: unknown) => fakeHomeAssistantFetch({ url: `${BASE}/api/services/${path}`, method: 'POST', body: JSON.stringify(body) } as never);
/** Switches a light the other way, whichever way it is now, so a test never depends on what an earlier one left behind. */
export const flip = (entity: string) => {
  const rooms = JSON.parse((fakeHomeAssistantFetch({ url: `${BASE}/api/template`, method: 'POST', body: 'ROOMS' } as never) as { body: string }).body) as Array<{ items: Array<{ id: string; state: string }> }>;
  const now = rooms.flatMap((r) => r.items).find((i) => i.id === entity)!.state;
  house(now === 'on' ? 'light/turn_off' : 'light/turn_on', { entity_id: entity });
};
/** A pointer event on an element (a finger or mouse), the way a slider is really grabbed and let go. */
export const pointer = (el: Element | Document, type: 'pointerdown' | 'pointerup' | 'pointercancel') =>
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
export const q = (s: string) => document.querySelector<HTMLElement>(s)!;
export const qa = (s: string) => Array.from(document.querySelectorAll<HTMLElement>(s));
export const noCameraPicture = (req: { url: string }) => { if (req.url.includes('camera_proxy')) throw new Error('no picture'); return undefined; };

export interface Sock { sent: string[]; say: (...t: string[]) => void; open: () => void; setState: (s: string) => void }
type Hook = (req: { url: string; body?: string }) => Promise<unknown> | unknown;
const listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject, unknown]> = [];
const realAdd = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function (this: EventTarget, t: string, l: EventListenerOrEventListenerObject, o?: unknown) {
  if (this === document || this === window) listeners.push([this, t, l, o]);
  return (realAdd as any).call(this, t, l, o);
} as never;

export function unmount() {
  fakeHomeAssistantReset(); // a fresh house for the next test: nothing one test changes reaches another
  for (const [t, n, l, o] of listeners.splice(0)) t.removeEventListener(n, l, o as never);
  vi.clearAllTimers();
  document.body.innerHTML = '';
}

export async function mount(opts: { data?: Record<string, unknown>; fetchHook?: Hook; live?: boolean; video?: boolean } = {}) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
  const html = HOME_ASSISTANT_PAGE_HTML;
  document.head.innerHTML = /<head>([\s\S]*?)<\/head>/.exec(html)![1];
  document.body.innerHTML = /<body>([\s\S]*?)<script>/.exec(html)![1];
  const puts: string[] & { greyBox?: boolean } = [];
  // Every time the rooms are drawn: was an empty grey picture box on screen (a camera card that is about to change shape)?
  (window as any).__homeAfterPut = (id: string) => { puts.push(id); if (id === 'rooms' && document.querySelector('#rooms img.cam:not([src])')) puts.greyBox = true; };
  const socks: Sock[] = [];
  (window as any).youcoded = {
    devices: { ha: BASE }, data: opts.data ?? { startOpen: ['living_room', 'destins_room'] },
    save: () => undefined, onRefresh: () => undefined, onData: () => undefined,
    fetch: async (url: string, o: Record<string, unknown> = {}) => {
      const req = { url, ...o } as { url: string; body?: string };
      if (opts.fetchHook) { const r = await opts.fetchHook(req); if (r) return r; }
      return fakeHomeAssistantSocket(req as never) ?? fakeHomeAssistantFetch(req as never) ?? { ok: false, status: 404, headers: {}, body: '' };
    },
    socket: opts.live === false ? undefined : (_url: string, o: { onState: (s: string) => void; onMessages: (t: string[]) => void }) => {
      const s: Sock & { live: ReturnType<typeof fakeHomeAssistantLive> | null } = {
        sent: [], live: null,
        say: (...t) => o.onMessages(t),
        setState: (st) => o.onState(st),
        open: () => { s.live?.close(); s.live = fakeHomeAssistantLive((texts) => o.onMessages(texts)); o.onState('open'); const [req, ok] = s.live.opened(); o.onMessages([req, ok]); },
      };
      const send = (t: string) => { s.sent.push(t); const out = s.live!.message(t); if (out.length) o.onMessages(out); return true; };
      socks.push(s);
      return { send, close: () => undefined };
    },
  };
  if (opts.video) (window as any).youcoded.video = () => ({ stop: () => undefined });
  new Function(/<script>([\s\S]*?)<\/script>/.exec(html)![1])();
  await flush();
  await vi.waitFor(() => { if (!document.querySelector('[data-eid]')) throw new Error('not drawn'); });
  if (socks[0]) { socks[0].open(); await flush(); await frame(); }
  await tick(1000);
  return { puts, socks };
}
/** A change Home Assistant pushes over the live connection for one entity (compressed form). */
export const push = (s: Sock, entity: string, plus: Record<string, unknown>, id = 1) =>
  s.say(JSON.stringify({ id, type: 'event', event: { c: { [entity]: { '+': plus } } } }));
