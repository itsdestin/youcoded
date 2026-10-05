// @vitest-environment jsdom
// Redesign audit F9 (A-7 "never move the video"): a playing clip is not touched
// when something else on the page changes — the player stays where it is and is
// never taken out and started again.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, flush, frame, tick, flip } from './home-page-harness';
import { fakeHomeAssistantNestSignedIn } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

afterEach(() => { unmount(); vi.useRealTimers(); fakeHomeAssistantNestSignedIn(false); });

it('leaves a playing clip alone when an unrelated light changes', async () => {
  fakeHomeAssistantNestSignedIn(true);
  const plays: number[] = [];
  (HTMLMediaElement.prototype as any).play = function () { plays.push(1); return Promise.resolve(); };
  (HTMLMediaElement.prototype as any).pause = function () { /* jsdom has no player */ };
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return false; } });
  await mount();
  await tick(12_000);
  q('.cam-ev').click(); await tick(500);
  const video = document.querySelector('video')!;
  expect(video).toBeTruthy();
  const slot = video.parentElement;
  plays.length = 0;
  flip('light.living_room_lamp'); await frame();
  flip('light.living_room_lamp'); await frame();
  expect(document.querySelector('video')).toBe(video);
  expect(video.parentElement).toBe(slot);
  expect(plays).toHaveLength(0);
});
