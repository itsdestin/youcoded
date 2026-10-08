// @vitest-environment jsdom
// Code review fixes F12-F16 for the Home page, one small test each.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, flush, frame, tick, push, house, noCameraPicture } from './home-page-harness';
import { fakeHomeAssistantFetch } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import { HOME_ASSISTANT_PAGE_HTML } from '../src/renderer/dev/workbench/fixtures/home-assistant-page';

afterEach(() => { unmount(); vi.useRealTimers(); });

describe('F12: the equaliser bars', () => {
  it('animate transform (scaleY), not height, keep steps(), and keep the reduced-motion rule', () => {
    const css = HOME_ASSISTANT_PAGE_HTML;
    const frames = /@keyframes eq \{([^}]*\}[^}]*\}[^}]*\})/.exec(css)![1];
    expect(frames).toContain('scaleY');
    expect(frames).not.toContain('height');
    expect(css).toMatch(/\.eq\.on i \{ animation: eq [^;]*steps\(/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.eq\.on i \{ animation: none/);
  });
});

describe('F13: a refused older press', () => {
  it('does not undo a newer press on the same field that went through', async () => {
    let gate!: () => void; const wait = new Promise<void>((r) => { gate = r; });
    let calls = 0;
    await mount({ live: false, data: { startOpen: ['upstairs'] }, fetchHook: async (req: { url: string }) => {
      noCameraPicture(req);
      if (req.url.includes('set_temperature') && ++calls === 1) { await wait; return { ok: false, status: 500, headers: {}, body: '' }; }
      return undefined;
    } });
    const set = () => q('[data-eid="climate.thermostat"] .th-set').textContent;
    const was = Number(set()!.replace('°', ''));
    const warmer = () => q('[data-eid="climate.thermostat"] [aria-label="Warmer"]').click();
    warmer(); await tick(900); // the first send is stuck
    warmer(); await tick(900); // the second goes through
    expect(set()).toBe(`${was + 2}°`);
    gate(); await tick(50); // now the first one is refused: only the newest send decides, so nothing is undone
    expect(set()).toBe(`${was + 2}°`); // the newer press still stands (it used to jump back to the old value)
  });
});

describe('F14: the latest check wins', () => {
  it('an older check that answers late does not put older rooms back', async () => {
    let asked = 0, release: (() => void) | null = null;
    await mount({ live: false, fetchHook: async (req: { url: string; body?: string }) => {
      noCameraPicture(req);
      if (req.url.endsWith('/api/template') && !(req.body ?? '').includes('EXTRAS') && asked > 0) {
        const answer = fakeHomeAssistantFetch(req as never); // what the house says at the moment it is asked
        if (asked++ === 1) await new Promise<void>((r) => { release = r; }); // check A is held on the way back
        return answer;
      }
    } });
    const lamp = () => q('[data-eid="light.living_room_lamp"] [data-toggle]').getAttribute('aria-pressed') === 'true';
    const was = lamp();
    asked = 1;
    document.dispatchEvent(new Event('visibilitychange')); // check A is asked (and held), seeing the old state
    await flush();
    house(was ? 'light/turn_off' : 'light/turn_on', { entity_id: 'light.living_room_lamp' }); // the house changes
    await tick(5200); // check B (the page's own 5-second one) sees the change
    expect(lamp()).toBe(!was);
    release!(); await flush(); await frame(); // A finally answers, with the old state
    expect(lamp()).toBe(!was);
  });
});

describe('F15: an open colour picker', () => {
  it('is not reset by a drawing while it has focus', async () => {
    const m = await mount({ data: { startOpen: ['destins_room'], startPalettes: ['light.desk_backlight'] }, fetchHook: noCameraPicture });
    const id = 'light.desk_backlight';
    const picker = () => document.querySelector<HTMLInputElement>(`[data-any="${id}"]`)!;
    picker().focus();
    picker().value = '#12ab34'; // the person is choosing a colour
    push(m.socks[0], 'light.overhead_light', { a: { brightness: 90 } }); // something else makes the page draw
    await frame(); await tick(100);
    expect(document.activeElement).toBe(picker());
    expect(picker().value).toBe('#12ab34');
  });
});

describe('F16: the Media tab keeps the order chosen in Edit', () => {
  // A second speaker in the living room in the same state as the first, so both sit in the same playing-first step.
  const twoSpeakers = (req: { url: string; body?: string }) => {
    noCameraPicture(req);
    if (req.url.endsWith('/api/template') && !(req.body ?? '').includes('EXTRAS')) {
      const answer = fakeHomeAssistantFetch(req as never) as { body: string };
      const rooms = JSON.parse(answer.body) as Array<{ id: string; items: Array<Record<string, unknown>> }>;
      const room = rooms.find((r) => r.id === 'living_room')!;
      room.items.push({ ...room.items.find((i) => i.id === 'media_player.living_room_speaker')!, id: 'media_player.living_room_speaker_2', name: 'Second speaker', device: 'dev_second' });
      return { ...answer, body: JSON.stringify(rooms) };
    }
    return undefined;
  };
  const ids = () => qa('#view .tile.media[data-eid]').map((c) => c.getAttribute('data-eid')!).filter((i) => i.startsWith('media_player.living_room_speaker'));
  it('lists a room\'s devices in the order he chose, inside the playing-first steps', async () => {
    await mount({ data: { view: 'media', order: { 'r:living_room': ['media_player.living_room_speaker_2', 'media_player.living_room_speaker'] } }, fetchHook: twoSpeakers });
    const a = ids();
    unmount();
    await mount({ data: { view: 'media', order: { 'r:living_room': ['media_player.living_room_speaker', 'media_player.living_room_speaker_2'] } }, fetchHook: twoSpeakers });
    const b = ids();
    expect(a).toHaveLength(2); expect(b).toHaveLength(2);
    expect(a).toEqual([...b].reverse());
  });
});
