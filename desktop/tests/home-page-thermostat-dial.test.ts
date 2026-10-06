// @vitest-environment jsdom
// Owner, 2026-10-05: the thermostat's "now" marker is a line across the ring (not a dot), the ring has a handle like the brightness bar's
// that can be dragged instead of − and +, and the room's number ("79°", option b of deck now-label-all) hangs off the line's outer tip without ever touching the − / + buttons or the handle.
// Pins: the tick, the handle's drag (one throttled, held send), keyboard steps, Auto's two handles never crossing, − / + still working,
// and the label's place (computed by the page's own pure function; jsdom cannot measure layout).
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, tick, noCameraPicture, pointer } from './home-page-harness';
import { HOME_DIAL_GEOM_JS } from '../src/renderer/dev/workbench/fixtures/home-assistant-page-dial';
import { fakeHomeAssistantSet } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

afterEach(() => { unmount(); vi.useRealTimers(); });
const T = 'climate.thermostat';
const card = () => q(`[data-eid="${T}"]`);
const S = 148; // the room card's dial

// The page's own geometry code, run on its own.
const G = new Function(`${HOME_DIAL_GEOM_JS}; return { thAngle, thFracOf, thSnap, thClampRange, thGeom, thLabelPlan };`)() as {
  thAngle: (f: number) => number; thFracOf: (d: number) => number; thSnap: (v: number, lo: number, hi: number, s: number) => number;
  thClampRange: (side: string, v: number, a: number, b: number, lo: number, hi: number, s: number) => { tlo: number; thi: number };
  thGeom: (compact: boolean, narrow: boolean) => Record<string, number>;
  thLabelPlan: (g: Record<string, number>, deg: number, len: number, hs: number[], has: boolean, range: boolean, setLen: number) => { o: any; spot: { x: number; y: number; side: string } | null };
};

async function open(sent: Array<Record<string, unknown>> = []) {
  await mount({ data: { startOpen: ['upstairs'] }, fetchHook: (req: { url: string; body?: string }) => { noCameraPicture(req); if (req.url.includes('set_temperature')) sent.push(JSON.parse(req.body ?? '{}')); return undefined; } });
  await tick(600);
  placeDial();
  return sent;
}
// jsdom has no layout: give every dial the size the CSS gives it, at the top left of the window.
function placeDial() { qa('.th-dial').forEach((d) => { (d as any).getBoundingClientRect = () => ({ left: 0, top: 0, width: S, height: S, right: S, bottom: S, x: 0, y: 0 }); }); }
// A pointer event at the place on the ring where the temperature (50-90) is.
const at = (t: number, type = 'pointermove') => {
  const a = G.thAngle((t - 50) / 40) * Math.PI / 180;
  document.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: S / 2 + 100 * Math.cos(a), clientY: S / 2 + 100 * Math.sin(a) }));
};
const handle = (w = 'set') => q(`[data-th-h="${w}"]`);

it('draws the room temperature as a line across the ring, not a dot', async () => {
  await open();
  const d = card().querySelector('.th-dial')!;
  expect(d.querySelectorAll('svg circle.th-now').length).toBe(0);
  expect(d.querySelectorAll('svg .th-now .th-now-line').length).toBe(1);
  const line = d.querySelector('.th-now-line')!;
  const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((n) => Number(line.getAttribute(n)));
  // It runs along a radius of the 200-unit drawing, from inside the ring (r 68) to outside it (r 92): across the 14-wide track.
  expect(Math.hypot(x1 - 100, y1 - 100)).toBeCloseTo(68, 0);
  expect(Math.hypot(x2 - 100, y2 - 100)).toBeCloseTo(92, 0);
  expect(Math.atan2(y2 - y1, x2 - x1)).toBeCloseTo(Math.atan2(y1 - 100, x1 - 100), 1);
});

it('puts a handle on the set point and drags it with one held, throttled send', async () => {
  const sent = await open();
  expect(handle().getAttribute('role')).toBe('slider');
  expect(handle().getAttribute('aria-valuenow')).toBe('72');
  pointer(handle(), 'pointerdown');
  at(75); at(78); at(80); at(83); at(85); // a drag: the number follows at once
  expect(card().querySelector('.th-set')!.textContent).toBe('85°');
  expect(handle().getAttribute('aria-valuenow')).toBe('85');
  expect(handle().getAttribute('aria-valuetext')).toBe('85 degrees');
  at(85, 'pointerup');
  await tick(50);
  expect(sent.length).toBeLessThanOrEqual(2); // not one per movement
  expect(sent.at(-1)).toMatchObject({ entity_id: T, temperature: 85 });
  expect(new Set(sent.map((s) => s.temperature)).size).toBe(sent.length); // never the same value twice
  await tick(6000); // the house reports it; nothing jumps back
  expect(card().querySelector('.th-set')!.textContent).toBe('85°');
});

it('holds the dragged number until the thermostat reports it (no rubber-banding)', async () => {
  await open();
  pointer(handle(), 'pointerdown'); at(80); at(80, 'pointerup');
  fakeHomeAssistantSet(T, { target: 72 }); // a late, old report from the house
  await tick(2000);
  expect(card().querySelector('.th-set')!.textContent).toBe('80°');
});

it('moves with the arrow keys, Home and End, and the buttons still work', async () => {
  const sent = await open();
  const key = (k: string) => handle().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  key('ArrowUp'); key('ArrowRight');
  expect(handle().getAttribute('aria-valuenow')).toBe('74');
  key('ArrowDown');
  expect(handle().getAttribute('aria-valuenow')).toBe('73');
  key('End'); expect(handle().getAttribute('aria-valuenow')).toBe('90');
  key('Home'); expect(handle().getAttribute('aria-valuenow')).toBe('50');
  await tick(1000);
  expect(sent.at(-1)).toMatchObject({ temperature: 50 });
  // − and + are still there and still send.
  card().querySelector<HTMLElement>('[aria-label="Warmer"]')!.click();
  await tick(600);
  expect(sent.at(-1)).toMatchObject({ temperature: 51 });
  card().querySelector<HTMLElement>('[aria-label="Cooler"]')!.click();
  await tick(600);
  expect(sent.at(-1)).toMatchObject({ temperature: 50 });
});

it('has no handle when the thermostat is off', async () => {
  await open();
  card().querySelector<HTMLElement>('[data-hvac="off"]')!.click();
  await tick(1000);
  expect(card().querySelector('[data-th-h]')).toBeNull();
  expect(card().querySelectorAll('.th-now-line').length).toBe(1); // the room's temperature is still shown
});

it('Auto has two handles that never cross', async () => {
  const sent = await open();
  card().querySelector<HTMLElement>('[data-hvac="heat_cool"]')!.click();
  await tick(1000);
  expect(qa('[data-th-h]').map((h) => h.getAttribute('data-th-h'))).toEqual(['low', 'high']);
  expect(handle('low').getAttribute('aria-valuenow')).toBe('68');
  expect(handle('high').getAttribute('aria-valuenow')).toBe('75');
  // Drag the low one far past the high one: it stops a degree short.
  pointer(handle('low'), 'pointerdown'); at(88); at(88, 'pointerup');
  await tick(1000);
  expect(sent.at(-1)).toMatchObject({ target_temp_low: 74, target_temp_high: 75 });
  // And the high one far below the low one.
  pointer(handle('high'), 'pointerdown'); at(52); at(52, 'pointerup');
  await tick(1000);
  expect(sent.at(-1)).toMatchObject({ target_temp_low: 74, target_temp_high: 75 }); // already pressed together: nothing to move
  pointer(handle('low'), 'pointerdown'); at(60); at(60, 'pointerup');
  await tick(1000);
  pointer(handle('high'), 'pointerdown'); at(52); at(52, 'pointerup');
  await tick(1000);
  expect(sent.at(-1)).toMatchObject({ target_temp_low: 60, target_temp_high: 61 });
  // The number a handle moves is the one − and + act on (the underline follows).
  expect(card().querySelector('.th-side-btn[aria-pressed="true"]')!.getAttribute('data-side')).toBe('high');
});

it('the handle is left alone by a redraw while it is dragged', async () => {
  await open();
  pointer(handle(), 'pointerdown'); at(80);
  const el = handle();
  fakeHomeAssistantSet('light.desk', { state: 'off' }); // any push redraws the page
  await tick(1500);
  expect(handle()).toBe(el); // the same element: a drag in progress is never reset
  at(82); at(82, 'pointerup');
  await tick(1000);
});

// ── Where "79°" goes ─────────────────────────────────────────────────
// Checked independently of the page's own overlap test: sample points across the label's box and test them against the buttons, the handles
// and the dial's allowed area.
function problems(g: Record<string, number>, plan: ReturnType<typeof G.thLabelPlan>) {
  const s = plan.spot, o = plan.o;
  if (!s) return [];
  const bad: string[] = [];
  for (let fx = 0; fx <= 1; fx += 0.1) for (let fy = 0; fy <= 1; fy += 0.1) {
    const x = s.x - o.w / 2 + fx * o.w, y = s.y - o.h / 2 + fy * o.h;
    if (x < -g.mx || y < -g.my || x > g.S + g.mx || y > g.S + g.my) bad.push('outside the card');
    for (const r of o.rects) if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) bad.push('on a button');
    for (const c of o.circles) if (Math.hypot(x - c.x, y - c.y) < c.r) bad.push('on a handle');
    const d = Math.hypot(x - g.S / 2, y - g.S / 2);
    if (Math.abs(d - o.R) < o.half) bad.push('on the ring');
  }
  return bad;
}
const SIZES: Array<[string, boolean, boolean]> = [['Home card', true, false], ['Home card, narrow window', true, true], ['Climate tab', false, false]];

it('the label never overlaps a button, a handle, the ring or leaves the card (every current temperature, every set point)', () => {
  const stats: Record<string, { n: number; centre: number; out: number }> = {};
  for (const [name, compact, narrow] of SIZES) {
    const g = G.thGeom(compact, narrow);
    stats[name] = { n: 0, centre: 0, out: 0 };
    for (let cur = 50; cur <= 90; cur += 0.5) for (let t = 50; t <= 90; t += 2) {
      for (const handles of [[(t - 50) / 40], [Math.max(0, (t - 50) / 40 - 0.1), Math.min(1, (t - 50) / 40 + 0.1)]]) {
        const range = handles.length === 2;
        const plan = G.thLabelPlan(g, G.thAngle((cur - 50) / 40), `${cur}°`.length, handles, true, range, range ? 5 : 3);
        expect(problems(g, plan), `${name}: now ${cur}, set ${t}${range ? ' (Auto)' : ''}`).toEqual([]);
        stats[name].n++; if (!plan.spot) stats[name].centre++; else if (plan.spot.side === 'out') stats[name].out++;
      }
    }
  }
  // Informational: how often the label sits beside the line, and how often it falls back to the middle.
  console.log('label placement', JSON.stringify(stats));
  for (const s of Object.values(stats)) expect(s.centre / s.n).toBeLessThan(0.5); // most of the time it is next to the line
});

it('the label is beside the line at the extremes (room at the minimum and at the maximum)', () => {
  for (const [name, compact, narrow] of SIZES) {
    const g = G.thGeom(compact, narrow);
    for (const cur of [50, 90]) {
      const plan = G.thLabelPlan(g, G.thAngle((cur - 50) / 40), 3, [0.5], true, false, 3);
      expect(problems(g, plan), `${name} at ${cur}`).toEqual([]);
      expect(plan.spot, `${name} at ${cur} has a place beside the line`).not.toBeNull();
    }
  }
});

it('the label stays attached to the line: its nearest corner touches the line\'s tip, on the outer side when there is room', () => {
  for (const [name, compact, narrow] of SIZES) {
    const g = G.thGeom(compact, narrow);
    let outer = 0, n = 0;
    for (let cur = 50; cur <= 90; cur += 1) {
      const plan = G.thLabelPlan(g, G.thAngle((cur - 50) / 40), 3, [0.5], true, false, 3), sp = plan.spot, o = plan.o;
      n++; if (!sp) continue;
      const a = G.thAngle((cur - 50) / 40) * Math.PI / 180, c = g.S / 2, ux = Math.cos(a), uy = Math.sin(a);
      // The label's box, seen from the line's tip: the nearest point of the box to the tip is within the 2px gap plus the 2px steps (<= 15 steps) and the box's own half-size.
      const dir = sp.side === 'out' ? 1 : -1, tip = [c + ux * (o.R + dir * o.tick), c + uy * (o.R + dir * o.tick)];
      const dx = Math.max(sp.x - o.w / 2 - tip[0], 0, tip[0] - (sp.x + o.w / 2)), dy = Math.max(sp.y - o.h / 2 - tip[1], 0, tip[1] - (sp.y + o.h / 2));
      expect(Math.hypot(dx, dy), `${name} at ${cur}: label ${Math.hypot(dx, dy).toFixed(1)}px from the tip`).toBeLessThanOrEqual(2 + 15 * 2 + 1);
      if (sp.side === 'out') outer++;
    }
    expect(outer / n, `${name}: mostly hangs off the outer tip`).toBeGreaterThan(0.5);
  }
});

it('the page puts the label in the middle under the number when nothing else fits', () => {
  const g = G.thGeom(true, true); // the narrowest card
  const plan = G.thLabelPlan({ ...g, S: 40, mx: 0, my: 0 }, 135, 3, [0.5], true, false, 3); // a dial too small for any label
  expect(plan.spot).toBeNull();
});

it('snaps to the device step, stays inside its limits, and the ring gap picks the nearer end', () => {
  expect(G.thSnap(72.4, 50, 90, 1)).toBe(72);
  expect(G.thSnap(72.3, 50, 90, 0.5)).toBe(72.5);
  expect(G.thSnap(95, 50, 90, 1)).toBe(90);
  expect(G.thFracOf(135)).toBe(0);
  expect(G.thFracOf(405 % 360)).toBeCloseTo(1, 5);
  expect(G.thFracOf(100)).toBe(0); // in the gap, nearer the minimum
  expect(G.thFracOf(60)).toBe(1); // in the gap, nearer the maximum
  expect(G.thClampRange('low', 80, 68, 75, 50, 90, 1)).toEqual({ tlo: 74, thi: 75 });
  expect(G.thClampRange('high', 60, 68, 75, 50, 90, 0.5)).toEqual({ tlo: 68, thi: 69 }); // a gap of at least a degree
});

it('the label is drawn at the place the page computed, as a share of the dial, and the centre one is only a fallback', async () => {
  await open();
  const lbl = card().querySelector<HTMLElement>('.th-now-lbl');
  expect(lbl).toBeTruthy();
  expect(lbl!.textContent).toBe('74°'); // just the number (deck now-label-all, option b)
  expect(lbl!.getAttribute('aria-label')).toBe('Now 74° inside'); // the meaning the word "Now" carried, kept for screen readers
  expect(lbl!.style.left).toMatch(/%$/);
  expect(card().querySelector('.th-mid .th-cur')).toBeNull();
});

it('the centre text (Auto\'s two numbers, or the big number) fits inside the ring, clear of the handles, on every dial size', () => {
  for (const [name, compact, narrow] of SIZES) {
    const g = G.thGeom(compact, narrow);
    for (const range of [false, true]) {
      const { o } = G.thLabelPlan(g, 135, 3, [0.5], true, range, range ? 5 : 3);
      // The text box (with its caption line) has corners that must stay inside the ring's inner edge, less the handle's overhang and a gap.
      const clear = o.R - (range ? Math.max(o.half, g.hs / 2) : o.half) - 3; // Auto's text sits beside two handles; the single number is a short word with empty corners
      const corner = Math.hypot(o.core.w / 2, o.core.h / 2) - (range ? 0 : 4);
      expect(corner, `${name}${range ? ' (Auto)' : ''}: text corner ${corner.toFixed(1)} vs clear radius ${clear.toFixed(1)}`).toBeLessThanOrEqual(clear);
    }
  }
});
