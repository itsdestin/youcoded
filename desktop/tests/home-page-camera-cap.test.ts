// @vitest-environment jsdom
// Code review F5: the Cameras tab streams at most 4 cameras. The TOP four tiles (the order the tab draws) stream; a tile
// beyond the cap says so honestly (it used to say "Starting live view…" forever) and one press swaps it in for the last one.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, flush, frame, tick, noCameraPicture } from './home-page-harness';
import { fakeHomeAssistantFetch, fakeHomeAssistantNestSignedIn } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

afterEach(() => { unmount(); vi.useRealTimers(); fakeHomeAssistantNestSignedIn(false); });
const tile = (id: string) => document.querySelector<HTMLElement>(`.cam-tile[data-eid="${id}"]`)!;
const EXTRA = ['camera.extra_1', 'camera.extra_2', 'camera.extra_3'];

// Six working Nest cameras: the pretend house's three, then three more cloned into the same room.
const sixCameras = (req: { url: string; body?: string }) => {
  noCameraPicture(req);
  if (req.url.endsWith('/api/template') && !(req.body ?? '').includes('EXTRAS')) {
    const answer = fakeHomeAssistantFetch(req as never) as { body: string };
    const rooms = JSON.parse(answer.body) as Array<{ items: Array<Record<string, unknown>> }>;
    const room = rooms.find((r) => r.items.some((i) => i.id === 'camera.living_room_camera'))!;
    const base = room.items.find((i) => i.id === 'camera.living_room_camera')!;
    EXTRA.forEach((id, n) => room.items.push({ ...base, id, name: `Extra ${n + 1}`, device: `dev_${id}` }));
    return { ...answer, body: JSON.stringify(rooms) };
  }
  return undefined;
};

it('streams the top four tiles, says so on the fifth and sixth, and swaps one in on a press', async () => {
  fakeHomeAssistantNestSignedIn(true);
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: vi.fn() })) as never;
  const m = await mount({ data: { view: 'cameras' }, video: true, fetchHook: sixCameras });
  await tick(15_000); // the staggered starts
  const drawn = Array.from(document.querySelectorAll<HTMLElement>('.cam-tile')).map((t) => t.getAttribute('data-eid')!).filter((id) => id.startsWith('camera.') && id !== 'camera.garage_pi' && id !== 'camera.doorbell');
  expect(drawn).toHaveLength(6);
  const started = () => new Set(m.videos.filter((v) => v.stop.mock.calls.length === 0).map((v) => v.target));
  expect(started()).toEqual(new Set(drawn.slice(0, 4))); // the top four, in drawn order
  // Tiles past the cap are honest about it and no longer say "Starting live view…".
  [4, 5].forEach((i) => {
    expect(tile(drawn[i]).textContent).toContain('Live view limit reached');
    expect(tile(drawn[i]).textContent).not.toContain('Starting live view');
  });
  expect(tile(drawn[0]).textContent).not.toContain('Live view limit');
  // One press swaps the fifth in for the last streaming one.
  tile(drawn[4]).querySelector<HTMLElement>('[data-cam-act="swap"]')!.click();
  await tick(15_000);
  expect(started()).toEqual(new Set([drawn[4], drawn[0], drawn[1], drawn[2]]));
  expect(tile(drawn[3]).textContent).toContain('Live view limit reached');
  expect(tile(drawn[4]).textContent).not.toContain('Live view limit');
});
