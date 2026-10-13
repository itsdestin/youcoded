// @vitest-environment jsdom
// Code review F1: the real house sends "lc" ALONE when a state changes (last-updated equals it and is left
// out) and "lu" alone when only attributes change. The page must stamp a pushed state with the NEWER of the
// two, or a state change that follows an attribute change is thrown away as stale after the next check.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, flush, frame, push, noCameraPicture } from './home-page-harness';
import { fakeHomeAssistantFetch } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

afterEach(() => { unmount(); vi.useRealTimers(); });

const LAMP = 'light.living_room_lamp';
it('a state change (lc only) after an attribute change (lu only) is not thrown away as stale', async () => {
  let lampUpd = '';
  const m = await mount({ fetchHook: (req) => {
    noCameraPicture(req);
    if (lampUpd && req.url.endsWith('/api/template') && !(req.body ?? '').includes('EXTRAS')) {
      // The check answers with the lamp stamped a little after the attribute push (the house's own lu).
      const answer = fakeHomeAssistantFetch(req as never) as { body: string };
      const rooms = JSON.parse(answer.body) as Array<{ items: Array<{ id: string; upd: string }> }>;
      rooms.forEach((r) => r.items.forEach((i) => { if (i.id === LAMP) i.upd = lampUpd; }));
      return { ...answer, body: JSON.stringify(rooms) };
    }
  } });
  const lamp = () => q(`[data-eid="${LAMP}"] [data-toggle]`).getAttribute('aria-pressed') === 'true';
  const was = lamp();
  const A = Date.now() / 1000 + 100;
  push(m.socks[0], LAMP, { a: { brightness: 120 }, lu: A + 1 }); // attributes only: lu alone
  await frame();
  lampUpd = new Date((A + 1.5) * 1000).toISOString();
  document.dispatchEvent(new Event('visibilitychange')); // a check lands, stamped after that push
  await flush(); await frame();
  push(m.socks[0], LAMP, { s: was ? 'off' : 'on', lc: A + 2 }); // the state changes: lc ALONE, like the real house
  await frame();
  expect(lamp()).toBe(!was);
});
