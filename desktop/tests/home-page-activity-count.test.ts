// @vitest-environment jsdom
// Code review F11: the Activity pill's "N changes today" is counted from a cached result, not by walking the whole loaded
// logbook on every drawing. Measured through Date.parse (one call per logbook line each time the lines are walked).
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, frame, tick, push } from './home-page-harness';

afterEach(() => { unmount(); vi.useRealTimers(); });

it('does not re-walk the logbook when a push redraws the page', async () => {
  const m = await mount();
  q('#chips [data-view="activity"]').click(); await tick(2000); // the logbook is loaded
  const real = Date.parse; let calls = 0; Date.parse = (s: string) => { calls++; return real(s); };
  for (let i = 0; i < 5; i++) { push(m.socks[0], 'light.living_room_lamp', { a: { brightness: 100 + i }, lu: Date.now() / 1000 + 100 + i }); await frame(); }
  Date.parse = real;
  // Measured: about 115 calls with the cache, about 255 without it (a pass over every line, each drawing).
  expect(calls).toBeLessThan(180);
});
