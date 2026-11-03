// @vitest-environment jsdom
// Code review F2 (the rubber-banding Destin reported): when the house ACCEPTS a switch press but takes a moment to
// report the new state (a Hue light answers about a second later), a check asked in between must not put the old
// state back. The card keeps the pressed state until the device reports it or the 8-second hold runs out.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, frame, tick, house, noCameraPicture } from './home-page-harness';

afterEach(() => { unmount(); vi.useRealTimers(); });
const LAMP = 'light.living_room_lamp';
const lamp = () => q(`[data-eid="${LAMP}"] [data-toggle]`).getAttribute('aria-pressed') === 'true';
// Accepts every light call and does nothing about it: the device has not reported yet.
const acceptOnly = (req: { url: string }) => { noCameraPicture(req); return req.url.includes('/services/light/') ? { ok: true, status: 200, headers: {}, body: '[]' } : undefined; };

it('keeps the pressed state through checks until the device reports it', async () => {
  await mount({ fetchHook: acceptOnly });
  const before = lamp();
  q(`[data-eid="${LAMP}"] [data-toggle]`).click();
  const seen: boolean[] = [];
  for (let i = 0; i < 12; i++) { await tick(250); seen.push(lamp()); } // 3 seconds, a check lands about 400 ms in
  expect(seen.every((x) => x === !before)).toBe(true);
  // The device finally reports (the house acts, then the live push arrives): still the pressed state.
  house(before ? 'light/turn_off' : 'light/turn_on', { entity_id: LAMP });
  await frame(); await tick(1000);
  expect(lamp()).toBe(!before);
});

it('still gives up the hold after 8 seconds if the device never reports', async () => {
  await mount({ fetchHook: acceptOnly });
  const before = lamp();
  q(`[data-eid="${LAMP}"] [data-toggle]`).click();
  await tick(9000);
  expect(lamp()).toBe(before);
});
