// @vitest-environment jsdom
// A device that is not responding goes after the working ones in every list, unless the person has put that
// list in an order himself in Edit; a device that comes back returns to its place.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, frame, tick, push } from './home-page-harness';

afterEach(() => { unmount(); vi.useRealTimers(); });
const LAMP = 'light.living_room_lamp', CEILING = 'light.living_room_ceiling';
/** The lights listed in the open Living Room card, in the order they are drawn. */
const lightIds = () => qa('[data-eid^="light.living_room"]').map((e) => e.getAttribute('data-eid'));
const cams = () => qa('.cam-tile').map((e) => e.getAttribute('data-eid'));

describe('devices that are not responding', () => {
  it('go after the working ones in a room, and return to their place when they recover', async () => {
    const m = await mount({ data: { startOpen: ['living_room'] } });
    expect(lightIds()).toEqual([LAMP, CEILING]);
    push(m.socks[0], LAMP, { s: 'unavailable' }); await frame();
    expect(lightIds()).toEqual([CEILING, LAMP]);
    push(m.socks[0], LAMP, { s: 'on' }); await frame();
    expect(lightIds()).toEqual([LAMP, CEILING]);
  });

  it('go last in the Cameras grid by default, and return when they recover', async () => {
    const m = await mount({ data: { view: 'cameras' } });
    await tick(1000);
    expect(cams()[0]).toBe('camera.living_room_camera');
    push(m.socks[0], 'camera.living_room_camera', { s: 'unavailable' }); await frame();
    const ids = cams();
    // Last of all (the doorbell is not responding too, so the two go together after the working ones).
    expect(ids.slice(-2).sort()).toEqual(['camera.doorbell', 'camera.living_room_camera']);
    push(m.socks[0], 'camera.living_room_camera', { s: 'idle' }); await frame();
    expect(cams()[0]).toBe('camera.living_room_camera');
  });

  it('keep the place he gave them once that list has an order of his own', async () => {
    const m = await mount({ data: { startOpen: ['living_room'], order: { 'r:living_room': [LAMP, CEILING] } } });
    push(m.socks[0], LAMP, { s: 'unavailable' }); await frame();
    expect(lightIds()).toEqual([LAMP, CEILING]); // his order, not the default
    expect(q(`[data-eid="${LAMP}"]`)).toBeTruthy();
  });

  it('keep his order in the Cameras grid too', async () => {
    await mount({ data: { view: 'cameras', order: { cameras: ['camera.doorbell', 'camera.living_room_camera'] } } });
    await tick(1000);
    expect(cams()[0]).toBe('camera.doorbell');
  });
});
