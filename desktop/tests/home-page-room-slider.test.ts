// @vitest-environment jsdom
// Destin, 2026-10-05: "when dragging a brightness slider for a room, the sliders for the individual
// lights visibly lag behind and jump around." The room's All bar now drives every dimmable light's own
// bar, percent and glow on the same frame, and holds them against the house's per-light answers.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, frame, tick, push, pointer, noCameraPicture } from './home-page-harness';

afterEach(() => { unmount(); vi.useRealTimers(); });
const KIDS = ['light.overhead_light', 'light.desk_backlight', 'light.hue_play_1'];
const bar = (id: string) => q(`[data-eid="${id}"] .lr[data-bright]`) as HTMLInputElement;
const v = (id: string) => Number(bar(id).style.getPropertyValue('--v'));
const want = (pct: number) => Math.round((pct - 1) / 99 * 100); // the bar's fill for a percent
const group = () => q('[data-gbright="destins_room"]') as HTMLInputElement;
const drag = (to: number) => { group().value = String(to); group().dispatchEvent(new Event('input', { bubbles: true })); };

it('moves every light\'s bar, percent and glow on the same frame as the room bar', async () => {
  await mount({ data: { open: ['destins_room'] }, fetchHook: noCameraPicture });
  group().focus(); pointer(group(), 'pointerdown');
  for (const pct of [30, 45, 62, 81]) {
    drag(pct);
    for (const id of KIDS) { // no timer has run: all of it is already drawn
      expect(v(id)).toBe(want(pct));
      expect(q(`[data-eid="${id}"]`).textContent).toContain(`${pct}%`);
      expect(q(`[data-eid="${id}"]`).style.getPropertyValue('--b')).toBe(String(pct / 100));
    }
  }
});

it('never moves a light\'s bar backwards while late, out-of-order answers land, during or after the drag', async () => {
  const m = await mount({ data: { open: ['destins_room'] }, fetchHook: noCameraPicture });
  group().focus(); pointer(group(), 'pointerdown');
  const last: Record<string, number> = {};
  const check = () => { for (const id of KIDS) { expect(v(id)).toBeGreaterThanOrEqual(last[id] ?? 0); last[id] = v(id); } };
  for (const pct of [25, 40, 55, 70, 90]) {
    drag(pct); check();
    // the house's answers to EARLIER positions arrive now, one light at a time and out of order
    for (const id of [...KIDS].reverse()) push(m.socks[0], id, { a: { brightness: Math.round((pct - 15) * 2.55) }, lu: 1, lc: 1 });
    await frame(); check();
  }
  group().dispatchEvent(new Event('change', { bubbles: true })); pointer(group(), 'pointerup');
  for (const id of KIDS) push(m.socks[0], id, { a: { brightness: Math.round(40 * 2.55) }, lu: 1, lc: 1 }); // still more late answers
  await tick(100); check();
  for (const id of KIDS) expect(v(id)).toBe(want(90));
});

it('shows the final values on release with no jump', async () => {
  await mount({ data: { open: ['destins_room'] }, fetchHook: noCameraPicture });
  group().focus(); pointer(group(), 'pointerdown');
  drag(35); drag(66);
  const before = KIDS.map(v), barBefore = group().value;
  group().dispatchEvent(new Event('change', { bubbles: true })); pointer(group(), 'pointerup');
  for (const t of [0, 20, 500, 3000]) { await tick(t); expect(KIDS.map(v)).toEqual(before); expect(group().value).toBe(barBefore); }
});

it('leaves a light that is not responding alone, and turns on an off light that can dim', async () => {
  await mount({ data: { open: ['destins_room', 'living_room'] }, fetchHook: noCameraPicture });
  expect(document.querySelector('[data-eid="light.tv_backlight"] .lr')).toBeNull(); // unavailable: no bar
  const room = q('[data-gbright="living_room"]') as HTMLInputElement; // Living Room: lamp on, ceiling off (both dim)
  room.focus(); pointer(room, 'pointerdown');
  room.value = '50'; room.dispatchEvent(new Event('input', { bubbles: true }));
  expect(q('[data-eid="light.living_room_ceiling"] .lr[data-bright]')).toBeTruthy(); // it came on and joined at the bar's level
  expect(document.querySelector('[data-eid="light.tv_backlight"] .lr')).toBeNull();
});
