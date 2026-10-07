// @vitest-environment jsdom
// Code review F10 ("hidden means idle"): while the page is not on screen it stops listening to the house (the live
// subscription is ended and pushes are not processed) and a "Watch live" card stream stops; showing the page again
// subscribes anew, catches up, and starts the card stream again.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, flush, frame, tick, flip, push, noCameraPicture } from './home-page-harness';
import { fakeHomeAssistantNestSignedIn } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

afterEach(() => { unmount(); vi.useRealTimers(); fakeHomeAssistantNestSignedIn(false); });
const setHidden = (h: boolean) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); document.dispatchEvent(new Event('visibilitychange')); };
const LAMP = 'light.living_room_lamp';
const lamp = () => q(`[data-eid="${LAMP}"] [data-toggle]`).getAttribute('aria-pressed') === 'true';

it('stops listening to the house while hidden and catches up when shown', async () => {
  const m = await mount({ fetchHook: noCameraPicture });
  const subs = () => m.socks[0].sent.filter((t) => t.includes('"subscribe_entities"')).length;
  const before = lamp(), subsBefore = subs();
  setHidden(true); await flush();
  expect(m.socks[0].sent.some((t) => t.includes('unsubscribe_events'))).toBe(true);
  // A push that was already on its way is dropped unread.
  push(m.socks[0], LAMP, { s: before ? 'off' : 'on', lc: Date.now() / 1000 + 50 });
  await frame();
  expect(lamp()).toBe(before);
  flip(LAMP); // the house changes while hidden
  await tick(10_000);
  setHidden(false); await flush(); await frame(); await tick(1000);
  expect(subs()).toBe(subsBefore + 1); // subscribed anew
  expect(lamp()).toBe(!before); // and caught up with the house
});

it('stops a Watch-live card stream while hidden and starts it again when shown', async () => {
  fakeHomeAssistantNestSignedIn(true);
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: vi.fn() })) as never;
  const m = await mount({ data: { startOpen: ['living_room'] }, video: true });
  await tick(1000);
  q('[data-eid="camera.living_room_camera"] [data-cam-act="live"]').click();
  await tick(500);
  const asked = () => m.videos.length;
  expect(asked()).toBe(1);
  setHidden(true); await flush();
  expect(m.videos[0].stop).toHaveBeenCalled();
  setHidden(false); await flush(); await tick(500);
  expect(asked()).toBe(2);
});
