// @vitest-environment jsdom
// Redesign audit F4 (A-3 "the newest one wins"): when the page's own check and a
// live update disagree, the one that happened later wins, whichever order the
// answers arrive in. A check that was already on its way when the wall switch
// was flipped must not put the card back.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, flush, frame, tick, flip, BASE, noCameraPicture } from './home-page-harness';
import { fakeHomeAssistantFetch } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

afterEach(() => { unmount(); vi.useRealTimers(); });

it('a slow check answer does not put back a card the house changed after the check was asked', async () => {
  let gate: Promise<void> | null = null;
  await mount({ fetchHook: async (req) => {
    noCameraPicture(req);
    if (gate && req.url.endsWith('/api/template') && !(req.body ?? '').includes('EXTRAS')) {
      const answer = fakeHomeAssistantFetch(req as never); // what the house said when asked
      const g = gate; gate = null; await g; return answer;
    }
  } });
  const lamp = () => q('[data-eid="light.living_room_lamp"] [data-toggle]').getAttribute('aria-pressed') === 'true';
  const want = !lamp();
  let release!: () => void; gate = new Promise<void>((r) => { release = r; });
  document.dispatchEvent(new Event('visibilitychange')); // the window comes back: the page checks
  await flush();
  flip('light.living_room_lamp'); // someone uses the wall switch while the check is on its way
  await frame();
  expect(lamp()).toBe(want);
  release(); await flush(); await frame();
  expect(lamp()).toBe(want);
  await tick(5_000); // and it stays that way until the next check
  expect(lamp()).toBe(want);
});
