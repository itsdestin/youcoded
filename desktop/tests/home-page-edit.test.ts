// @vitest-environment jsdom
// The Home page's Edit mode, the "organise board" (redesign round 1, Edit c,
// picked by Destin 2026-10-04): slim rows, drag by the dots (mouse) or press and
// hold (finger) to reorder / move between rooms / drop in the new-room box; star
// and eye on the row; the name opens the row's settings. Every old Edit ability
// must stay reachable, a refused rename or move must say so on its row, and every
// action must be reachable without a mouse. Runs the real page against the
// workbench's pretend Home Assistant with fake clocks.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// WHY a fresh harness (and so a fresh pretend Home Assistant) per test: moves and renames are
// really kept by the pretend house, so one test's move would be the next test's starting point.
let H: typeof import('./home-page-harness');
beforeEach(async () => { vi.resetModules(); H = await import('./home-page-harness'); });
afterEach(() => { H.unmount(); vi.useRealTimers(); });
const mount: typeof H.mount = (o) => H.mount(o);
const q: typeof H.q = (s) => H.q(s);
const qa: typeof H.qa = (s) => H.qa(s);
const tick: typeof H.tick = (n) => H.tick(n);
const frame: typeof H.frame = () => H.frame();
const flip: typeof H.flip = (e) => H.flip(e);
const noCameraPicture: typeof H.noCameraPicture = (r) => H.noCameraPicture(r);
const EDIT = { editing: true };
const row = (id: string, key?: string) => q(`.edc-row[data-edid="${id}"]${key ? `[data-edkey="${key}"]` : ''}`);
const roomOfRow = (id: string) => row(id).closest('.edc-room')!.getAttribute('data-edid');
const open = (id: string) => row(id).querySelector<HTMLElement>('[data-act="edopen"]')!.click();
const act = (id: string, a: string) => row(id).querySelector<HTMLElement>(`[data-act="${a}"]`)!.click();
const ids = (key: string) => qa(`.edc-row[data-edkey="${key}"]`).map((r) => r.getAttribute('data-edid'));
const roomNames = () => qa('.edc-room h2').map((h) => h.textContent);
const saved = () => { const out: Array<Record<string, any>> = []; (window as any).youcoded.save = (d: any) => out.push(d); return out; };
const registryReply = (fail: boolean) => ({ ok: true, status: 200, headers: {}, body: JSON.stringify(['{"type":"auth_ok"}', fail ? '{"id":1,"type":"result","success":false,"error":{"message":"Home Assistant says no"}}' : '{"id":1,"type":"result","success":true,"result":null}']) });
const refuseRegistry = (what: string) => (req: any) => { noCameraPicture(req); return req.url.endsWith('/api/websocket') && String(req.socket?.send).includes(what) ? registryReply(true) : undefined; };

/** A mouse or finger drag from `src`'s grip to `target` (stubbed under the pointer), landing before or after it. */
function drag(grip: Element, target: Element | null, where: 'before' | 'after' = 'after', touch = false) {
  (document as any).elementFromPoint = () => target;
  if (target) target.getBoundingClientRect = () => ({ top: 0, height: 0, bottom: 0, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const ev = (type: string, x: number, y: number) => { const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }); Object.defineProperty(e, 'pointerType', { value: touch ? 'touch' : 'mouse' }); return e; };
  grip.dispatchEvent(ev('pointerdown', 0, 0));
  return {
    move: () => document.dispatchEvent(ev('pointermove', 40, where === 'after' ? 10 : -10)),
    up: () => document.dispatchEvent(ev('pointerup', 40, 10)),
  };
}
const dragTo = (id: string, target: Element | null, where: 'before' | 'after' = 'after') => { const d = drag(row(id).querySelector('[data-edgrip]')!, target, where); d.move(); d.up(); };

describe('Edit is slim rows, not cards', () => {
  it('shows one line per device with a star and an eye, and none of the old button row', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    expect(qa('.edit-row')).toHaveLength(0);
    expect(qa('#rooms .tile, #rooms .clim')).toHaveLength(0);
    expect(row('light.kitchen_pendants').textContent).toContain('Pendants');
    expect(row('light.kitchen_pendants').querySelector('[data-act="fav"]')).toBeTruthy();
    expect(row('light.kitchen_pendants').querySelector('[data-act="hide"]')).toBeTruthy();
    expect(row('light.kitchen_pendants').querySelector('select')).toBeNull(); // settings stay closed until the name is pressed
    qa('[data-act="edit"]')[0].click(); // Done: the normal cards come back
    expect(qa('.edc-row')).toHaveLength(0);
    await tick(500);
    expect(qa('#rooms .tile').length).toBeGreaterThan(0);
  });
});

describe('every old Edit ability', () => {
  it('favourites: the star adds the device to Favourites and takes it out again', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    act('light.under_cabinet', 'fav');
    expect(q('#favs').textContent).toContain('Under cabinet');
    q('#favs [data-act="fav"][data-id="light.under_cabinet"]').click();
    expect(q('#favs').textContent).not.toContain('Under cabinet');
  });

  it('hiding: the eye hides it from the normal page and shows it again', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    act('light.under_cabinet', 'hide');
    expect(row('light.under_cabinet').classList.contains('is-hidden')).toBe(true); // still listed so it can come back
    qa('[data-act="edit"]')[0].click(); await tick(500);
    expect(document.querySelector('[data-eid="light.under_cabinet"]')).toBeNull();
    qa('[data-act="edit"]')[0].click();
    act('light.under_cabinet', 'hide');
    expect(row('light.under_cabinet').classList.contains('is-hidden')).toBe(false);
  });

  it('renaming is saved to Home Assistant and still there after the next check', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    open('light.under_cabinet');
    const box = q('[data-rn]') as HTMLInputElement; box.value = 'Counter strip';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(row('light.under_cabinet').textContent).toContain('Counter strip');
    await tick(2000); await tick(6000);
    expect(row('light.under_cabinet').textContent).toContain('Counter strip');
  });

  it('moving to another room from the Room list is saved to Home Assistant', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    open('light.under_cabinet');
    const sel = q('select[data-move]') as HTMLSelectElement; sel.value = 'living_room'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(roomOfRow('light.under_cabinet')).toBe('living_room');
    await tick(2000); await tick(6000);
    expect(roomOfRow('light.under_cabinet')).toBe('living_room'); // the house's own answer agrees
  });

  it('a new room from the Room list: name it, and the device moves into it', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    open('light.under_cabinet');
    const sel = q('select[data-move]') as HTMLSelectElement; sel.value = '__new'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    (q('[data-nr]') as HTMLInputElement).value = 'Pantry';
    q('[data-act="room-create"]').click();
    expect(roomNames()).toContain('Pantry');
    await tick(2000);
    expect(roomNames()).toContain('Pantry');
  });

  it('a TV has its sound choice in settings; details and Open in Home Assistant are there too', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    open('media_player.destins_room_tv');
    const sound = q('select[data-sound]') as HTMLSelectElement;
    sound.value = 'none'; sound.dispatchEvent(new Event('change', { bubbles: true }));
    expect((q('select[data-sound]') as HTMLSelectElement).value).toBe('none');
    expect(row('media_player.destins_room_tv').querySelector('[data-dev]')).toBeTruthy();
    expect(row('media_player.destins_room_tv').querySelector('a[href*="/config/devices/device/"]')).toBeTruthy();
    q('[data-dev]').click(); // Details opens the device's pop-up
    expect(document.querySelector('.dlg')).toBeTruthy();
  });

  it('Earlier and Later in the settings change the order and keep it', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    const log = saved();
    const first = ids('r:kitchen');
    open(first[1]!); act(first[1]!, 'up');
    expect(ids('r:kitchen')).toEqual([first[1], first[0]]);
    expect(log.at(-1)!.order['r:kitchen']).toEqual([first[1], first[0]]);
    act(first[1]!, 'down');
    expect(ids('r:kitchen')).toEqual(first);
  });

  it('rooms move with their arrows', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    const before = qa('.edc-room').map((r) => r.getAttribute('data-edid')!);
    q(`#edroom-${before[1]} [data-act="up"]`).click();
    expect(qa('.edc-room').map((r) => r.getAttribute('data-edid'))[0]).toBe(before[1]);
    expect(q(`#edroom-${before[1]} a[href*="/config/areas/area/"]`)).toBeTruthy();
  });
});

describe('dragging', () => {
  it('drag by the dots reorders a room\'s devices and the order is saved', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    const log = saved();
    const [a, b] = ids('r:kitchen');
    dragTo(a!, row(b!), 'after');
    expect(ids('r:kitchen')).toEqual([b, a]);
    expect(log.at(-1)!.order['r:kitchen']).toEqual([b, a]);
  });

  it('dropping on a row in another room moves the device there, saved to Home Assistant', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    dragTo('light.under_cabinet', row('light.living_room_lamp'), 'before');
    expect(roomOfRow('light.under_cabinet')).toBe('living_room');
    expect(ids('r:living_room')[0]).toBe('light.under_cabinet');
    await tick(2000); await tick(6000);
    expect(roomOfRow('light.under_cabinet')).toBe('living_room');
  });

  it('dropping on a room\'s empty space puts it at the end of that room', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    dragTo('light.under_cabinet', q('#edroom-living_room'));
    expect(ids('r:living_room').at(-1)).toBe('light.under_cabinet');
  });

  it('dropping in the dashed box asks for a name, then makes the room and moves it', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    expect(q('#edc-new').textContent).toContain('Drag a device here');
    dragTo('light.under_cabinet', q('#edc-new'));
    expect(q('#edc-new').textContent).toContain('New room for');
    (q('#edc-new [data-nr]') as HTMLInputElement).value = 'Den';
    q('#edc-new [data-act="room-create"]').click();
    expect(roomNames()).toContain('Den');
    await tick(2000);
    expect(roomNames()).toContain('Den');
  });

  it('drag by the room\'s dots reorders rooms', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    const rooms = qa('.edc-room').map((r) => r.getAttribute('data-edid')!);
    const d = drag(q(`#edroom-${rooms[0]} [data-edroomgrip]`), q(`#edroom-${rooms[1]}`), 'after'); d.move(); d.up();
    expect(qa('.edc-room').map((r) => r.getAttribute('data-edid'))[1]).toBe(rooms[0]);
  });

  it('a favourite can be dragged within Favourites but not out into a room', async () => {
    await mount({ data: { ...EDIT, fav: ['light.under_cabinet', 'light.kitchen_pendants'] }, fetchHook: noCameraPicture });
    dragTo('light.under_cabinet', row('light.living_room_lamp', 'r:living_room'), 'before'); // from the favourite row? first row of that id is in Favourites
    expect(row('light.under_cabinet', 'r:kitchen').closest('.edc-room')!.getAttribute('data-edid')).toBe('kitchen');
    const fav = () => qa('.edc-row[data-edkey="fav"]').map((r) => r.getAttribute('data-edid'));
    const [a, b] = fav();
    const d = drag(q(`.edc-row[data-edkey="fav"][data-edid="${a}"] [data-edgrip]`), q(`.edc-row[data-edkey="fav"][data-edid="${b}"]`), 'after'); d.move(); d.up();
    expect(fav()).toEqual([b, a]);
  });

  it('a check landing mid-drag does not redraw under the drag; the drop still lands', async () => {
    const m = await mount({ data: EDIT, fetchHook: noCameraPicture });
    const [a, b] = ids('r:kitchen');
    const d = drag(row(a!).querySelector('[data-edgrip]')!, row(b!), 'after'); d.move();
    expect(row(a!).style.transform).toContain('translate');
    // The house renames a light by itself: a row's drawing changes, so a redraw would have to touch the page.
    H.push(m.socks[0]!, 'light.living_room_lamp', { a: { friendly_name: 'Floor lamp 2' } }); await frame();
    expect(row(a!).style.transform).toContain('translate'); // not wiped by a redraw
    d.up();
    await frame();
    expect(row('light.living_room_lamp').textContent).toContain('Floor lamp 2'); // what was held back draws once the drag is over
    expect(ids('r:kitchen')).toEqual([b, a]);
    expect(row(a!).style.transform).toBe('');
  });

  it('Escape gives a drag up and nothing moves', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    const before = ids('r:kitchen');
    const d = drag(row(before[0]!).querySelector('[data-edgrip]')!, row(before[1]!), 'after'); d.move();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(ids('r:kitchen')).toEqual(before);
  });
});

describe('a finger', () => {
  it('press and hold on a row, then drag, reorders it; a quick press only opens settings', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    const [a, b] = ids('r:kitchen');
    const name = row(a!).querySelector('[data-act="edopen"]')!;
    const d = drag(name, row(b!), 'after', true);
    await tick(450); // held long enough
    d.move(); d.up();
    expect(ids('r:kitchen')).toEqual([b, a]);
    name.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); // the click that follows a held drag is not a tap
    expect(row(a!).querySelector('select')).toBeNull();
    // a quick tap, no hold: opens settings
    const d2 = drag(row(b!).querySelector('[data-act="edopen"]')!, null, 'after', true);
    await tick(100); d2.up();
    open(b!);
    expect(row(b!).querySelector('select')).toBeTruthy();
  });

  it('moving the finger before the hold is up is a scroll, not a drag', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    const [a, b] = ids('r:kitchen');
    const d = drag(row(a!).querySelector('[data-act="edopen"]')!, row(b!), 'after', true);
    d.move(); await tick(450); d.up();
    expect(ids('r:kitchen')).toEqual([a, b]);
  });
});

describe('a refusal is shown on the row', () => {
  it('a move Home Assistant refuses goes back and says Didn’t work on that row', async () => {
    await mount({ data: EDIT, fetchHook: refuseRegistry('device_registry/update') });
    const from = roomOfRow('light.under_cabinet');
    dragTo('light.under_cabinet', row('light.living_room_lamp'), 'before');
    await tick(100); // before the next check could put it back by itself
    expect(roomOfRow('light.under_cabinet')).toBe(from);
    const note = row('light.under_cabinet').querySelector('.pend')!;
    expect(note.getAttribute('data-pend')).toBe('failed');
    expect(note.textContent).toContain('Didn’t work');
    expect(note.textContent).toContain('Home Assistant says no');
    (note.querySelector('[data-pend-dismiss]') as HTMLElement).click();
    expect(row('light.under_cabinet').querySelector('.pend')).toBeNull();
  });

  it('a refused move into a brand-new room leaves no empty room behind', async () => {
    await mount({ data: EDIT, fetchHook: refuseRegistry('area_registry/create') });
    dragTo('light.under_cabinet', q('#edc-new'));
    (q('[data-nr]') as HTMLInputElement).value = 'Den';
    q('[data-act="room-create"]').click();
    await tick(1000);
    expect(roomNames()).not.toContain('Den');
    expect(row('light.under_cabinet').querySelector('.pend')!.getAttribute('data-pend')).toBe('failed');
  });

  it('a refused rename puts the old name back and says so on the row', async () => {
    await mount({ data: EDIT, fetchHook: refuseRegistry('entity_registry/update') });
    open('light.under_cabinet');
    (q('[data-rn]') as HTMLInputElement).value = 'Counter strip';
    q('[data-act="rename-save"]').click();
    await tick(1000);
    expect(row('light.under_cabinet').textContent).toContain('Under cabinet');
    expect(row('light.under_cabinet').querySelector('.pend')!.getAttribute('data-pend')).toBe('failed');
  });
});

describe('without a mouse', () => {
  const focusable = (el: Element | null) => !!el && ['BUTTON', 'A', 'SELECT', 'INPUT'].includes(el.tagName) && !(el as HTMLElement).hasAttribute('disabled') && (el as HTMLElement).tabIndex >= 0;
  it('every row action is a real control Tab can reach, and nothing needs the dots', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    const r = 'media_player.destins_room_tv';
    open(r);
    const el = row(r);
    for (const sel of ['[data-act="fav"]', '[data-act="hide"]', '[data-act="edopen"]', '[data-rn]', '[data-act="rename-save"]', 'select[data-move]', 'select[data-sound]', '[data-act="up"]', '[data-act="down"]', '[data-dev]', 'a[href*="/config/devices/device/"]']) {
      expect(focusable(el.querySelector(sel)), sel).toBe(true);
    }
    const head = qa('.edc-room .room-head')[1]!;
    for (const sel of ['[data-act="up"]', '[data-act="down"]', 'a[href*="/config/areas/area/"]']) expect(focusable(head.querySelector(sel)), sel).toBe(true);
    expect(el.querySelector('[data-edgrip]')!.getAttribute('aria-hidden')).toBe('true'); // decoration: the same jobs are buttons
  });

  it('Escape in the name box closes the settings and the keyboard goes back to the row’s name', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    open('light.under_cabinet');
    q('[data-rn]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(row('light.under_cabinet').querySelector('select')).toBeNull();
    expect(document.activeElement).toBe(row('light.under_cabinet').querySelector('[data-act="edopen"]'));
  });

  it('only the row you pressed opens, even for a device that is also a favourite', async () => {
    await mount({ data: { ...EDIT, fav: ['light.under_cabinet'] }, fetchHook: noCameraPicture });
    q('#favs [data-act="edopen"]').click();
    expect(qa('.edx-menu')).toHaveLength(1);
    expect(q('#favs').querySelector('.edx-menu')).toBeTruthy();
  });
});
