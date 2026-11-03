// @vitest-environment jsdom
// Destin's real house (2026-10-05, trace of what Home Assistant saw): "rubber-banding with brightness and volume
// sliders". A Hue light answers about a second after each call, and the answers for EARLIER values arrive stamped
// newer than the guess. A slider's value is a target: it stays until the device reports a value within 2% of it
// (or about 4 s pass), reports that do not match are ignored whatever their stamp, mid-drag values are sent at
// most every 400 ms (a room's command every second), the final value is always sent, and never twice.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, frame, tick, house, push, pointer, noCameraPicture } from './home-page-harness';

afterEach(() => { unmount(); vi.useRealTimers(); });
const bar = (id: string) => q(`[data-eid="${id}"] .lr[data-bright]`) as HTMLInputElement;
const vol = (id: string) => q(`[data-vol="${id}"]`) as HTMLInputElement;
const fill = (el: HTMLElement) => Number(el.style.getPropertyValue('--v'));
const want = (pct: number) => Math.round((pct - 1) / 99 * 100);
const input = (el: HTMLElement) => el.dispatchEvent(new Event('input', { bubbles: true }));
const change = (el: HTMLElement) => { el.dispatchEvent(new Event('change', { bubbles: true })); pointer(document, 'pointerup'); };

/** A house that, like Hue, takes about a second to act on each call, so its answers come late and in order. */
function slowHouse(lag = 1000) {
  const calls: Array<{ at: number; path: string; body: Record<string, any> }> = [];
  const hook = (req: { url: string; body?: string }) => {
    noCameraPicture(req);
    const m = /\/api\/services\/(light\/turn_on|media_player\/volume_set)$/.exec(req.url);
    if (!m) return undefined;
    const body = JSON.parse(req.body ?? '{}');
    calls.push({ at: Date.now(), path: m[1], body });
    setTimeout(() => house(m[1], body), lag);
    return { ok: true, status: 200, headers: {}, body: '[]' };
  };
  return { calls, hook };
}

it('a light slider stays at its released value while the house answers late: 74, 28, 23 then the stale 74 and the real 23', async () => {
  const h = slowHouse();
  const m = await mount({ data: { startOpen: ['destins_room'] }, fetchHook: h.hook });
  const id = 'light.overhead_light', el = bar(id);
  el.focus(); pointer(el, 'pointerdown');
  el.value = '74'; input(el); await tick(230);
  el.value = '28'; input(el); await tick(250);
  el.value = '23'; input(el); await tick(10);
  change(el);
  await tick(20);
  const seen: number[] = [];
  const watch = () => seen.push(fill(bar(id)));
  watch();
  // the answer to the 74% call arrives (stamped newer than anything the page did), then, a second later, 23%
  for (let t = 0; t < 3500; t += 50) { await tick(50); watch(); }
  expect(new Set(seen)).toEqual(new Set([want(23)])); // never away from where it was released, then back
  // every call carried a different value than the one before it; the final one went out
  const pcts = h.calls.map((c) => c.body.brightness_pct);
  expect(pcts.at(-1)).toBe(23);
  pcts.forEach((p, i) => { if (i) expect(p).not.toBe(pcts[i - 1]); });
  // and no more often than every 400 ms, except the release itself
  h.calls.slice(0, -1).forEach((c, i) => { if (i) expect(c.at - h.calls[i - 1].at).toBeGreaterThanOrEqual(400); });
  void m;
});

it('a room bar holds every light at its target through late answers and a group light\'s ramp, and sends a room command once a second', async () => {
  const h = slowHouse();
  const m = await mount({ data: { startOpen: ['destins_room'] }, fetchHook: h.hook });
  const kids = ['light.overhead_light', 'light.desk_backlight', 'light.hue_play_1'];
  const room = q('[data-gbright="destins_room"]') as HTMLInputElement;
  room.focus(); pointer(room, 'pointerdown');
  for (const pct of [98, 60, 40, 38]) { room.value = String(pct); input(room); await tick(150); }
  change(room);
  await tick(20);
  const seen = new Set<number>();
  // the group light's ramp and members' answers for EARLIER values, stamped newer, land one by one

  for (const [i, b] of [250, 233, 217, 201, 184, 168, 151, 135, 118].entries()) {
    for (const id of kids) push(m.socks[0], id, { a: { brightness: b }, lu: Date.now() / 1000 + 1 + i, lc: Date.now() / 1000 + 1 + i });
    await tick(60);
    for (const id of kids) seen.add(fill(bar(id)));
  }

  expect([...seen]).toEqual([want(38)]);
  await tick(3000);
  for (const id of kids) expect(fill(bar(id))).toBe(want(38));
  const rooms = h.calls.filter((c) => Array.isArray(c.body.entity_id));
  rooms.slice(0, -1).forEach((c, i) => { if (i) expect(c.at - rooms[i - 1].at).toBeGreaterThanOrEqual(1000); }); // mid-drag sends; letting go always sends at once
  expect(rooms.at(-1)!.body.brightness_pct).toBe(38);
  rooms.forEach((c, i) => { if (i) expect(c.body.brightness_pct).not.toBe(rooms[i - 1].body.brightness_pct); });
});

it('a volume bar does not flash its old value when you let go, and ignores late echoes of earlier values', async () => {
  const h = slowHouse(25);
  const m = await mount({ fetchHook: h.hook });
  const id = 'media_player.living_room_speaker', el = vol(id);
  const start = el.value;
  el.focus(); pointer(el, 'pointerdown');
  for (const v of ['88', '44', '60', '85', '20']) { el.value = v; input(el); await tick(120); }
  change(el);
  const seen: string[] = [];
  seen.push(vol(id).value);
  await frame(); seen.push(vol(id).value); // the very next drawing after release
  // an echo of an earlier value (stamped newer) lands after the release
  push(m.socks[0], id, { a: { volume_level: 0.85 }, lu: Date.now() / 1000 + 2, lc: Date.now() / 1000 + 2 });
  for (let t = 0; t < 2000; t += 50) { await tick(50); seen.push(vol(id).value); }
  expect(new Set(seen)).toEqual(new Set(['20']));
  expect(start).not.toBe('20');
  const vols = h.calls.map((c) => c.body.volume_level);
  expect(vols.at(-1)).toBe(0.2);
  vols.forEach((p, i) => { if (i) expect(p).not.toBe(vols[i - 1]); });
});

it('quick presses of + add up from what is shown, and late answers never take the bar back', async () => {
  const h = slowHouse(600);
  await mount({ fetchHook: h.hook });
  const id = 'media_player.living_room_speaker';
  const plus = () => q(`[data-mp="${id}"][data-svc="volume_up"]`);
  const start = Number(vol(id).value);
  const seen: number[] = [];
  for (let i = 0; i < 3; i++) { plus().click(); seen.push(Number(vol(id).value)); await tick(150); }
  for (let t = 0; t < 2500; t += 50) { await tick(50); seen.push(Number(vol(id).value)); }
  seen.forEach((v, i) => { if (i) expect(v).toBeGreaterThanOrEqual(seen[i - 1]); }); // never backwards
  expect(seen.at(-1)).toBe(start + 15);
});

it('accepts the device\'s word when it never reaches the target (it capped the value)', async () => {
  await mount({ data: { startOpen: ['destins_room'] }, fetchHook: (req) => { noCameraPicture(req); return /light\/turn_on$/.test(req.url) ? { ok: true, status: 200, headers: {}, body: '[]' } : undefined; } });
  const el = bar('light.overhead_light');
  el.focus(); pointer(el, 'pointerdown'); el.value = '50'; input(el); change(el);
  await tick(100);
  expect(fill(bar('light.overhead_light'))).toBe(want(50));
  await tick(6000); // no report ever matched: after about 4 s the house's own value is shown
  expect(fill(bar('light.overhead_light'))).not.toBe(want(50));
});
