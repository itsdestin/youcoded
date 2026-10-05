// @vitest-environment jsdom
// A camera card that is not live shows a labelled preview still: the NEWER of its newest recording's thumbnail and the
// last live frame the page kept when a live view stopped. Frames are kept only on stop, one per camera, under a size
// cap, in the page's own saved data; nothing ever starts live in the background to get one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeHomeAssistantNestSignedIn } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import { mount, unmount, q, qa, frame, tick } from './home-page-harness';

const LIVING = 'camera.living_room_camera', HALL = 'camera.hallway_camera';
const card = (id: string) => q(`[data-eid="${id}"]`);
const preview = (id: string) => card(id).querySelector<HTMLImageElement>('.cam-prev');
const label = (id: string) => card(id).querySelector('.cam-prevlbl')?.textContent;
let dataUrlLength = 20_000;
const drawImage = vi.fn();

beforeEach(() => {
  fakeHomeAssistantNestSignedIn(true);
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage })) as never;
  HTMLCanvasElement.prototype.toDataURL = (() => 'data:image/jpeg;base64,' + 'A'.repeat(dataUrlLength - 23)) as never;
  dataUrlLength = 20_000;
});
afterEach(() => { unmount(); vi.useRealTimers(); fakeHomeAssistantNestSignedIn(false); });
const bitmap = () => ({ width: 1280, height: 720, close: vi.fn() });
/** Start live on a camera, let a picture arrive, and press Stop. */
async function watchAndStop(m: Awaited<ReturnType<typeof mount>>, id: string) {
  card(id).querySelector<HTMLElement>('.cam-play')!.click();
  const v = m.videos[m.videos.length - 1];
  v.o.onFrame(bitmap(), vi.fn());
  await frame();
  card(id).querySelector<HTMLElement>('[data-cam-act="stop"]')!.click();
  await frame();
  return v;
}
const savedFrames = (m: Awaited<ReturnType<typeof mount>>) => ((m.saves[m.saves.length - 1] ?? {}) as { frames?: Record<string, { at: number; img: string }> }).frames ?? {};

describe('preview stills on a camera card', () => {
  it('shows the newest recording’s thumbnail, dimmed, labelled with what it is and when', async () => {
    await mount({ video: true });
    await tick(1000);
    expect(preview(LIVING)!.getAttribute('src')).toMatch(/^data:image\//);
    expect(label(LIVING)).toMatch(/^Person · \d{1,2}:\d{2} (am|pm)$/);
    expect(card(LIVING).querySelector('.cam-play')).toBeTruthy(); // the disc stays on top
  });

  it('shows the last live frame instead when it is newer than the newest recording, labelled "Last seen"', async () => {
    await mount({ video: true, data: { frames: { [LIVING]: { at: Date.now() - 60_000, img: 'data:image/jpeg;base64,FRAME' } } } });
    await tick(1000);
    expect(preview(LIVING)!.getAttribute('src')).toBe('data:image/jpeg;base64,FRAME');
    expect(label(LIVING)).toMatch(/^Last seen \d{1,2}:\d{2} (am|pm)$/);
  });

  it('keeps the thumbnail when the kept frame is older than the newest recording', async () => {
    await mount({ video: true, data: { frames: { [LIVING]: { at: Date.now() - 10 * 3600_000, img: 'data:image/jpeg;base64,OLD' } } } });
    await tick(1000);
    expect(preview(LIVING)!.getAttribute('src')).toMatch(/^data:image\/(svg|jpeg|png)/);
    expect(preview(LIVING)!.getAttribute('src')).not.toContain('OLD');
    expect(label(LIVING)).toMatch(/^Person/);
  });

  it('never starts a live view in the background to get a picture', async () => {
    const m = await mount({ video: true });
    await tick(70_000);
    expect(m.videos).toHaveLength(0);
  });
});

describe('keeping the last live frame', () => {
  it('saves one frame per camera, only when live stops, small and as a JPEG, and the card then shows it', async () => {
    const m = await mount({ video: true });
    await tick(1000);
    const before = m.saves.length;
    card(LIVING).querySelector<HTMLElement>('.cam-play')!.click();
    m.videos[0].o.onFrame(bitmap(), vi.fn());
    m.videos[0].o.onFrame(bitmap(), vi.fn());
    await frame();
    expect(m.saves.length).toBe(before); // not on every frame
    card(LIVING).querySelector<HTMLElement>('[data-cam-act="stop"]')!.click();
    await frame();
    expect(m.saves.length).toBe(before + 1);
    const f = savedFrames(m)[LIVING];
    expect(f.img).toMatch(/^data:image\/jpeg;base64,/);
    expect(f.img.length).toBeLessThanOrEqual(60_000);
    expect(Math.abs(f.at - Date.now())).toBeLessThan(5000);
    expect(label(LIVING)).toMatch(/^Last seen/);
    // A second camera adds its own; the first is kept (one each).
    await watchAndStop(m, HALL);
    expect(Object.keys(savedFrames(m)).sort()).toEqual([HALL, LIVING]);
  });

  it('shrinks a frame that is too big for the cap, and keeps none when it cannot fit', async () => {
    const m = await mount({ video: true });
    const sizes = [90_000, 90_000, 90_000, 90_000]; // every try is over the cap
    HTMLCanvasElement.prototype.toDataURL = (() => 'data:image/jpeg;base64,' + 'A'.repeat(sizes.shift() ?? 90_000)) as never;
    await watchAndStop(m, LIVING);
    expect(savedFrames(m)[LIVING]).toBeUndefined();
    const tries = [90_000, 40_000]; // too big at first, fits on the second try
    HTMLCanvasElement.prototype.toDataURL = (() => 'data:image/jpeg;base64,' + 'A'.repeat(tries.shift() ?? 40_000)) as never;
    await watchAndStop(m, LIVING);
    expect(savedFrames(m)[LIVING].img.length).toBeLessThanOrEqual(60_000);
  });

  it('shows the kept frame after the page is loaded again', async () => {
    const m = await mount({ video: true });
    await watchAndStop(m, LIVING);
    const kept = m.saves[m.saves.length - 1] as Record<string, unknown>;
    const keptImg = savedFrames(m)[LIVING].img;
    unmount();
    fakeHomeAssistantNestSignedIn(true);
    await mount({ video: true, data: kept });
    await tick(1000);
    expect(label(LIVING)).toMatch(/^Last seen/);
    expect(preview(LIVING)!.getAttribute('src')).toBe(keptImg);
  });

  it('drops frames for cameras that are no longer on the page', async () => {
    const m = await mount({ video: true, data: { frames: { 'camera.long_gone': { at: Date.now(), img: 'data:image/jpeg;base64,X' }, [LIVING]: { at: Date.now() - 3600_000, img: 'data:image/jpeg;base64,Y' } } } });
    await tick(1000);
    expect(Object.keys(savedFrames(m))).toEqual([LIVING]);
  });

  it('keeps at most 8 frames in all', async () => {
    const frames: Record<string, { at: number; img: string }> = {};
    for (let i = 0; i < 9; i++) frames[`camera.c${i}`] = { at: Date.now() - i * 1000, img: 'data:image/jpeg;base64,Z' };
    const m = await mount({ video: true, data: { frames } });
    await watchAndStop(m, LIVING);
    expect(Object.keys(savedFrames(m)).length).toBeLessThanOrEqual(8);
    expect(savedFrames(m)[LIVING]).toBeTruthy();
  });
});
