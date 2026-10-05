// @vitest-environment jsdom
// A camera card's recent events merge two sources: its recordings (a picture and a clip) and its event entities' history
// (motion / person / chime with NO picture: the owner's newer Nest cameras save no clips at all). An event with a recording
// shows once, as the recording; one without shows as a plain row that cannot be played; the "nothing yet" words appear only
// when there is neither. Real page, the workbench's pretend Home Assistant with camera events switched on.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeHomeAssistantCameraEvents, fakeHomeAssistantNestSignedIn } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import { mount, unmount, q, qa, tick } from './home-page-harness';

const OPEN = { startOpen: ['living_room', 'backyard', 'hallway', 'front_door'] };
const card = (id: string) => q(`[data-eid="${id}"]`);
const rows = (id: string) => Array.from(card(id).querySelectorAll<HTMLElement>('.cam-ev'));
const words = (id: string) => rows(id).map((r) => `${r.querySelector('.w')!.textContent}${r.classList.contains('cam-ev-plain') ? ' (no picture)' : ''}`);

beforeEach(() => { fakeHomeAssistantNestSignedIn(true); fakeHomeAssistantCameraEvents(true); });
afterEach(() => { unmount(); vi.useRealTimers(); fakeHomeAssistantNestSignedIn(false); });

describe('camera events with no recording', () => {
  it('lists an event that has no recording as a plain row among the recordings, newest first, and shows an event that has one only once', async () => {
    await mount({ data: OPEN, video: true });
    await tick(1000);
    const w = words('camera.living_room_camera');
    // 20 minutes and 31 minutes ago: Motion, no recording. 55 min: the Person recording (the Person and Motion events at that
    // second ARE it). 100 min: Person, no recording. 152 min: the Motion recording.
    expect(w.slice(0, 5)).toEqual(['Motion (no picture)', 'Motion (no picture)', 'Person', 'Person (no picture)', 'Motion']);
    // The "unavailable" state in the history is not an event; and recordings are not repeated as plain rows.
    expect(w.filter((x) => x.includes('(no picture)'))).toHaveLength(3);
    expect(w).toHaveLength(23);
  });

  it('gives a picture-less row an icon and a time, with no thumbnail, no play button, and nothing to press or tab to', async () => {
    await mount({ data: OPEN, video: true });
    await tick(1000);
    const plain = card('camera.living_room_camera').querySelector<HTMLElement>('.cam-ev-plain')!;
    expect(plain.tagName).toBe('DIV');
    expect(plain.querySelector('svg')).toBeTruthy();
    expect(plain.querySelector('img')).toBeNull();
    expect(plain.querySelector('time')!.textContent).toMatch(/\d{1,2}:\d{2} (am|pm)/);
    expect(plain.hasAttribute('data-cam-act')).toBe(false);
    expect(plain.hasAttribute('tabindex')).toBe(false);
    expect(plain.closest('button')).toBeNull();
    // Real recordings stay buttons.
    expect(card('camera.living_room_camera').querySelectorAll('button.cam-ev').length).toBe(20);
    plain.click();
    await tick(50);
    expect(card('camera.living_room_camera').querySelector('[data-clip-slot]')).toBeNull();
  });

  it('shows a camera that has events but no recordings as a list, never the empty words', async () => {
    await mount({ data: OPEN, video: true });
    await tick(1000);
    expect(words('camera.backyard_camera')).toEqual(['Motion (no picture)', 'Motion (no picture)', 'Motion (no picture)']);
    expect(card('camera.backyard_camera').textContent).not.toContain('No recordings or events yet');
    // No recording, so no preview still behind the play disc: picture-less events never make one.
    expect(card('camera.backyard_camera').querySelector('.cam-prev')).toBeNull();
    await tick(1000); // the newest recording's thumbnail arrives
    // The camera that has a recording still previews it, and the picture-less newer events do not take its place.
    expect(card('camera.living_room_camera').querySelector('.cam-prevlbl')!.textContent).toMatch(/^Person · /);
  });

  it('says "No recordings or events yet." only for a camera with neither', async () => {
    await mount({ data: OPEN, video: true });
    await tick(1000);
    const bell = card('camera.doorbell');
    expect(bell.querySelector('.cam-note')!.textContent).toBe('No recordings or events yet.');
    expect(rows('camera.doorbell')).toHaveLength(0);
    for (const id of ['camera.living_room_camera', 'camera.backyard_camera', 'camera.hallway_camera']) {
      expect(card(id).textContent).not.toContain('No recordings or events yet');
    }
  });

  it('merges one recording and one event for the same moment within a few seconds, and keeps an older event with none', async () => {
    await mount({ data: OPEN, video: true });
    await tick(1000);
    // Hallway: recordings at 130, 610 and 1500 minutes; an event seconds from the first (it IS that recording) and one at 400 minutes with none.
    expect(words('camera.hallway_camera')).toEqual(['Person', 'Motion (no picture)', 'Motion', 'Person']);
  });

  it('still shows the recordings when only the event history cannot be loaded', async () => {
    await mount({ data: OPEN, fetchHook: (req) => (req.url.includes('/api/history/') ? { ok: false, status: 500, headers: {}, body: '' } : undefined) });
    await tick(1000);
    expect(words('camera.living_room_camera').filter((x) => x.includes('(no picture)'))).toHaveLength(0);
    expect(rows('camera.living_room_camera')).toHaveLength(20);
    expect(card('camera.living_room_camera').textContent).not.toContain('Could not load');
    expect(qa('.cam-card').length).toBeGreaterThan(0);
  });
});
