// @vitest-environment jsdom
// Live video when Google says "too many requests" (HA's error text: 429 / RESOURCE_EXHAUSTED / Rate limited): the page
// (which is what re-asks; main never retries) leaves that camera alone for 60 s, then 120 s, then 300 s, shared by every
// tile and card of the camera, says so calmly, and still lets a person press Retry. The Cameras tab also starts its
// cameras 1.5 s apart. Real page, fake clocks, a stand-in for the app's `youcoded.video`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeHomeAssistantNestSignedIn } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import { FAKE_RATE_LIMIT_WHY } from '../src/renderer/dev/workbench/fixtures/fake-camera';
import { mount, unmount, q, tick, frame } from './home-page-harness';

const LIVING = 'camera.living_room_camera';
const NEST = [LIVING, 'camera.hallway_camera', 'camera.backyard_camera'];
type M = Awaited<ReturnType<typeof mount>>;
const tile = (id: string) => q(`.cam-tile[data-eid="${id}"]`);
const asked = (m: M, id: string) => m.videos.filter((v) => v.target === id);
const last = (m: M, id: string) => asked(m, id)[asked(m, id).length - 1];
/** Google refuses the newest video of a camera (the app relays HA's words as the reason). */
const refuse = (m: M, id: string) => last(m, id).o.onState('stopped', FAKE_RATE_LIMIT_WHY);

beforeEach(() => {
  fakeHomeAssistantNestSignedIn(true);
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: vi.fn() })) as never;
});
afterEach(() => { unmount(); vi.useRealTimers(); fakeHomeAssistantNestSignedIn(false); });

describe('the Cameras tab starting its cameras', () => {
  it('starts them one after another, 1.5 seconds apart, never all in the same instant', async () => {
    const m = await mount({ data: { view: 'cameras' }, video: true });
    await tick(5000);
    const first = NEST.map((id) => asked(m, id)[0]);
    expect(first.every(Boolean)).toBe(true);
    const times = first.map((v) => v.at).sort((a, b) => a - b);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1500);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(1500);
  });
});

describe('Google limiting live video', () => {
  it('leaves the camera alone for 60 s, then 120 s, then 300 s (and stays at 300), saying so, with the time it will try again', async () => {
    const m = await mount({ data: { view: 'cameras' }, video: true });
    await tick(5000);
    const n = () => asked(m, LIVING).length;
    refuse(m, LIVING);
    await frame();
    expect(tile(LIVING).textContent).toContain('Google is limiting live video. Trying again at ');
    expect(tile(LIVING).textContent).not.toContain('429'); // the raw error is not what the owner reads
    const base = n();
    await tick(58_000);
    expect(n()).toBe(base); // not at 2 s, not at 30 s: Google just said "too many requests"
    await tick(3_000);
    expect(n()).toBe(base + 1); // after 60 s
    refuse(m, LIVING);
    await tick(118_000);
    expect(n()).toBe(base + 1);
    await tick(3_000);
    expect(n()).toBe(base + 2); // 120 s
    refuse(m, LIVING);
    await tick(298_000);
    expect(n()).toBe(base + 2);
    await tick(3_000);
    expect(n()).toBe(base + 3); // 300 s
    refuse(m, LIVING);
    await tick(298_000);
    expect(n()).toBe(base + 3); // the cap: 300 s, not longer, not shorter
    await tick(3_000);
    expect(n()).toBe(base + 4);
  });

  it('keeps asking again quickly for any OTHER failure (unchanged)', async () => {
    const m = await mount({ data: { view: 'cameras' }, video: true });
    await tick(5000);
    const base = asked(m, LIVING).length;
    last(m, LIVING).o.onState('stopped', 'The camera did not answer.');
    await tick(2_500);
    expect(asked(m, LIVING).length).toBe(base + 1);
  });

  it('lets a person press Retry at once, and a second refusal then makes the wait longer', async () => {
    const m = await mount({ data: { view: 'cameras' }, video: true });
    await tick(5000);
    const base = asked(m, LIVING).length;
    refuse(m, LIVING);
    await frame();
    await tick(10_000);
    tile(LIVING).querySelector<HTMLButtonElement>('[data-cam-act="retry"]')!.click();
    await frame();
    expect(asked(m, LIVING).length).toBe(base + 1); // allowed, even in the pause
    refuse(m, LIVING); // refused again: now the wait is 120 s
    await tick(100_000);
    expect(asked(m, LIVING).length).toBe(base + 1);
    await tick(21_000);
    expect(asked(m, LIVING).length).toBe(base + 2);
  });

  it('shows no Retry button for a camera that is not limited', async () => {
    const m = await mount({ data: { view: 'cameras' }, video: true });
    await tick(5000);
    expect(tile(LIVING).querySelector('[data-cam-act="retry"]')).toBeNull();
    expect(m.videos.length).toBeGreaterThan(0);
  });

  it('backs off when a restart fails after a long stream, the same as a first start', async () => {
    const m = await mount({ data: { view: 'cameras' }, video: true });
    await tick(5000);
    const v = last(m, LIVING);
    v.o.onFrame({ width: 640, height: 360, close: vi.fn() }, vi.fn());
    await frame();
    await tick(11_000);
    v.o.onState('stopped', 'The video reached its 5-minute limit. Play again to keep watching.');
    await tick(1_000);
    const restarted = asked(m, LIVING).length; // the quiet restart, as before
    expect(restarted).toBeGreaterThan(1);
    refuse(m, LIVING); // ...and Google refuses that restart
    await tick(50_000);
    expect(asked(m, LIVING).length).toBe(restarted);
    await tick(11_000);
    expect(asked(m, LIVING).length).toBe(restarted + 1);
  });

  it('is shared: leaving the Cameras tab and coming back does not start the limited camera early, while the others start', async () => {
    const m = await mount({ data: { view: 'cameras' }, video: true });
    await tick(5000);
    const base = asked(m, LIVING).length, other = asked(m, 'camera.hallway_camera').length;
    refuse(m, LIVING);
    await frame();
    document.querySelector<HTMLButtonElement>('[data-home]')!.click();
    await tick(500);
    document.querySelector<HTMLButtonElement>('[data-view="cameras"]')!.click();
    await tick(5_000);
    expect(asked(m, LIVING).length).toBe(base); // still waiting, and the tile says so
    expect(tile(LIVING).textContent).toContain('Google is limiting live video');
    expect(asked(m, 'camera.hallway_camera').length).toBeGreaterThan(other); // not limited: started again
    await tick(60_000);
    expect(asked(m, LIVING).length).toBe(base + 1);
  });

  it('is shared with the camera card: a refusal there is remembered by the tab, and the card never retries by itself', async () => {
    const m = await mount({ video: true });
    const card = q(`[data-eid="${LIVING}"]`);
    card.querySelector<HTMLElement>('.cam-play')!.click();
    const before = asked(m, LIVING).length;
    refuse(m, LIVING);
    await frame();
    expect(q(`[data-eid="${LIVING}"]`).textContent).toContain('Google is limiting live video right now');
    expect(q(`[data-eid="${LIVING}"] .cam-play`)).toBeTruthy(); // Play again is still there: a person may try
    // WHY 70 s, not longer: just past the first 60 s pause is enough to prove the card never retries on its own; ten
    // pretend minutes ran ~120 of the page's 5 s checks and took 2.3 s of real time, timing out on a busy machine.
    await tick(70_000);
    expect(asked(m, LIVING).length).toBe(before); // the card never asks again on its own
    // Now the Cameras tab, after that pause is over: refuse again to start a fresh pause.
    q(`[data-eid="${LIVING}"] .cam-play`).click();
    refuse(m, LIVING);
    await frame();
    document.querySelector<HTMLButtonElement>('[data-view="cameras"]')!.click();
    await tick(3_000);
    expect(asked(m, LIVING).length).toBe(before + 1); // the tab did not start it: Google refused it a moment ago
    expect(tile(LIVING).textContent).toContain('Google is limiting live video');
  });
});
