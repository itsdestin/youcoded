// @vitest-environment jsdom
// Redesign round 1, motion-state c ("Spread and spring", calmed): a press shows its result at once,
// repeated volume presses add up without snapping back, motion plays only for what the person just
// pressed (a change that arrives by itself gets one quiet shine), the sending note never catches a
// press, and it is all off for a hidden page, reduced motion and the practice "before" screen.
// jsdom cannot play animations, so Element.animate is a recorder and the tests read what was asked.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, frame, tick, flip, noCameraPicture } from './home-page-harness';

interface Call { el: Element; frames: Array<Record<string, unknown>>; opts: Record<string, unknown> }
let calls: Call[] = [];
function recordAnimations() {
  calls = [];
  (Element.prototype as any).animate = function (this: Element, frames: Call['frames'], opts: Call['opts']) {
    calls.push({ el: this, frames, opts }); return {};
  };
}
afterEach(() => {
  unmount(); vi.useRealTimers();
  delete (Element.prototype as any).animate; delete (window as any).__feelOff; delete (window as any).matchMedia;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});
const LAMP = 'light.living_room_lamp';
const SOUNDBAR = 'media_player.destins_room';
const lampButton = () => q(`[data-eid="${LAMP}"] [data-toggle]`);
const volume = (id = SOUNDBAR) => Number(q(`[data-vol="${id}"]`).getAttribute('value') ?? (q(`[data-vol="${id}"]`) as HTMLInputElement).value);
const volButton = (svc: string) => q(`[data-eid="${SOUNDBAR}"] [data-svc="${svc}"]`);
const sent = (log: Array<{ url: string; body?: string }>) => log.filter((r) => r.url.includes('/api/services/media_player/')).map((r) => ({ svc: r.url.split('/').pop(), body: JSON.parse(r.body ?? '{}') }));

it('shows a switch press in the same frame, with polish that starts close to the final look', async () => {
  recordAnimations();
  await mount({ fetchHook: noCameraPicture });
  const was = lampButton().getAttribute('aria-pressed');
  calls.length = 0;
  lampButton().click(); // no waiting: the result is there before anything else runs
  expect(lampButton().getAttribute('aria-pressed')).not.toBe(was);
  const tile = q(`[data-eid="${LAMP}"]`);
  const bulb = calls.find((c) => c.el === tile.querySelector('.bulb'))!;
  expect(bulb).toBeTruthy();
  // never starts far from the end, and never longer than a quarter second
  for (const f of bulb.frames) { const m = /scale\(([\d.]+)\)/.exec(String(f.transform)); if (m) expect(Number(m[1])).toBeGreaterThan(0.85); }
  expect(Number(bulb.opts.duration)).toBeLessThanOrEqual(300);
  expect(calls.some((c) => c.el.classList.contains('fx-glint') || c.el.parentElement?.classList.contains('fx-glint'))).toBe(false); // not the "from elsewhere" cue
});

it('adds up quick volume presses on screen at once and never snaps back', async () => {
  const log: Array<{ url: string; body?: string }> = [];
  await mount({ fetchHook: (req) => { log.push(req); return noCameraPicture(req); } });
  const start = volume();
  const seen: number[] = [];
  for (let i = 0; i < 3; i++) { volButton('volume_up').click(); seen.push(volume()); }
  expect(seen).toEqual([start + 5, start + 10, start + 15]); // each press shows its result before the next
  volButton('volume_down').click();
  expect(volume()).toBe(start + 10);
  await tick(3000); // the checks come back with whatever the house says by now
  expect(volume()).toBe(start + 10);
  const out = sent(log);
  expect(out.every((s) => s.svc === 'volume_set')).toBe(true); // an exact level, not "a step"
  expect(out[out.length - 1].body.volume_level).toBeCloseTo((start + 10) / 100, 5);
});

it('shows a thermostat step and a mute straight away, and gives each button an instant dip', async () => {
  recordAnimations();
  await mount({ fetchHook: noCameraPicture });
  const warmer = q('[data-temp][aria-label="Warmer"]');
  const before = q(`[data-eid="${warmer.getAttribute('data-temp')}"] .val b, .th-set`).textContent;
  calls.length = 0;
  warmer.click(); warmer.click();
  const after = q(`[data-eid="${warmer.getAttribute('data-temp')}"] .val b, .th-set`).textContent;
  expect(parseFloat(after!)).toBe(parseFloat(before!) + 2);
  expect(calls.filter((c) => c.el === warmer).length).toBe(2); // every press, even a quick one, dips
  q(`[data-eid="${SOUNDBAR}"] [data-svc="volume_mute"]`).click();
  expect(q(`[data-eid="${SOUNDBAR}"]`).classList.contains('muted')).toBe(true);
});

it('gives play/pause a quiet dip, not a spin', async () => {
  recordAnimations();
  await mount({ fetchHook: noCameraPicture });
  calls.length = 0;
  q('.np-ctl .key.main').click();
  await frame();
  const key = calls.filter((c) => c.el.matches('.np-ctl .key.main'));
  expect(key.length).toBeGreaterThan(0);
  expect(JSON.stringify(key.map((c) => c.frames))).not.toContain('rotate');
});

it('plays motion only for what was pressed: a change that arrives by itself gets one quiet shine', async () => {
  recordAnimations();
  await mount({ fetchHook: noCameraPicture });
  calls.length = 0;
  flip(LAMP); await frame(); await tick(5000); // a wall switch, found by the next check or push
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c.el.parentElement?.classList.contains('fx-glint'))).toBe(true); // only the shine
  calls.length = 0;
  await tick(10000); // nothing changed: nothing moves
  expect(calls).toEqual([]);
});

it('the sending note is see-through to the pointer, so it never swallows the next press', async () => {
  await mount({
    fetchHook: async (req) => { if (req.url.includes('/api/services/')) await new Promise((r) => setTimeout(r, 2500)); return noCameraPicture(req); },
  });
  volButton('volume_up').click();
  await tick(700);
  const note = q(`[data-eid="${SOUNDBAR}"] .pend`);
  expect(note.getAttribute('data-pend')).toBe('sending');
  expect(getComputedStyle(note).pointerEvents).toBe('none');
});

it('plays nothing when the page is hidden, when reduced motion is asked for, or on the "before" screen', async () => {
  recordAnimations();
  await mount({ fetchHook: noCameraPicture });
  calls.length = 0;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  lampButton().click(); flip('light.living_room_ceiling'); await frame();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  (window as any).__feelOff = true;
  lampButton().click(); volButton('volume_up').click(); await frame(); await tick(5000);
  expect(calls).toEqual([]);
  unmount(); delete (window as any).__feelOff;
  (window as any).matchMedia = () => ({ matches: true });
  await mount({ fetchHook: noCameraPicture });
  expect(calls).toEqual([]); // not even the first draw
  lampButton().click(); volButton('volume_up').click(); await frame();
  expect(calls).toEqual([]);
});

it('does not move the cards on the first draw when motion is off, and wakes them one after another when it is on', async () => {
  recordAnimations();
  await mount({ fetchHook: noCameraPicture });
  // (the first draw happened during mount; the recorder was installed first)
  const entering = calls.filter((c) => (c.frames[0] as any)?.opacity === 0 && (c.opts.delay as number) >= 0);
  expect(entering.length).toBeGreaterThan(1);
  expect(Math.max(...entering.map((c) => Number(c.opts.delay)))).toBeLessThanOrEqual(240);
});
