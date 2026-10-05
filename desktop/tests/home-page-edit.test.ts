// @vitest-environment jsdom
// The Home page's Edit mode, the "organise board" (redesign round 1, Edit c,
// picked by Destin 2026-10-04): slim rows, drag by the dots (mouse) or press and
// hold (finger) to reorder / move between rooms / drop in the new-room box; star
// and eye on the row; the name opens the row's settings. Every old Edit ability
// must stay reachable, a refused rename or move must say so on its row, and every
// action must be reachable without a mouse. Runs the real page against the
// workbench's pretend Home Assistant with fake clocks.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, tick, frame, push, noCameraPicture } from './home-page-harness';
import { fakeHomeAssistantFetch } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import { HOME_EDIT_CSS } from '../src/renderer/dev/workbench/fixtures/home-assistant-page-edit';

// The harness gives every test a fresh pretend Home Assistant (unmount resets it), so a move or
// rename in one test never reaches the next. Pointer capture and the page's scroll are not in jsdom, so they are stood in for here.
const captured: Array<number> = [];
let scrollY = 0;
beforeEach(() => {
  captured.length = 0; scrollY = 0;
  (Element.prototype as any).setPointerCapture = (id: number) => { captured.push(id); };
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  (window as any).scrollBy = (_x: number, y: number) => { scrollY += y; };
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.restoreAllMocks(); delete (document as any).elementFromPoint; delete (Element.prototype as any).setPointerCapture; });
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

/** A pointer event the way a browser sends it: with a pointerId, its kind and whether it is the first finger. */
let nextPid = 1;
const ptr = (type: string, x: number, y: number, o: { pid: number; touch?: boolean; primary?: boolean }) => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, 'pointerId', { value: o.pid }); Object.defineProperty(e, 'pointerType', { value: o.touch ? 'touch' : 'mouse' }); Object.defineProperty(e, 'isPrimary', { value: o.primary ?? true });
  return e;
};
/** A real-sized box for a drop target (top 100, 40 tall, so its middle is 120): 105 lands before it, 135 after. */
const box = (el: Element, top = 100) => { el.getBoundingClientRect = () => ({ top, height: 40, bottom: top + 40, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} }) as DOMRect; };
/** A mouse or finger drag from `src`'s grip to `target` (under the pointer), landing before or after it. */
function drag(grip: Element, target: Element | null, where: 'before' | 'after' = 'after', touch = false) {
  const pid = nextPid++;
  (document as any).elementFromPoint = () => target;
  if (target) box(target);
  const y = where === 'after' ? 135 : 105;
  grip.dispatchEvent(ptr('pointerdown', 0, 0, { pid, touch }));
  return {
    pid,
    move: (yy = y) => document.dispatchEvent(ptr('pointermove', 40, yy, { pid, touch })),
    up: () => document.dispatchEvent(ptr('pointerup', 40, y, { pid, touch })),
  };
}
const dragTo = (id: string, target: Element | null, where: 'before' | 'after' = 'after') => { const d = drag(row(id).querySelector('[data-edgrip]')!, target, where); d.move(); d.up(); };

/** Every request the page makes to Home Assistant's registry, and the means to refuse some. */
const sentTo = (log: string[], then?: (req: any) => any) => (req: any) => { noCameraPicture(req); if (req.url.endsWith('/api/websocket')) log.push(String(req.socket?.send)); return then?.(req); };

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
    const log: string[] = [];
    await mount({ data: EDIT, fetchHook: sentTo(log) });
    open('light.under_cabinet');
    const nameBox = q('[data-rn]') as HTMLInputElement; nameBox.value = 'Counter strip';
    nameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(row('light.under_cabinet').textContent).toContain('Counter strip');
    expect(log.some((m) => m.includes('entity_registry/update') && m.includes('Counter strip') && m.includes('light.under_cabinet'))).toBe(true); // really sent
    await tick(2000); await tick(6000);
    expect(row('light.under_cabinet').textContent).toContain('Counter strip');
  });

  it('moving to another room from the Room list is saved to Home Assistant', async () => {
    const log: string[] = [];
    await mount({ data: EDIT, fetchHook: sentTo(log) });
    open('light.under_cabinet');
    const sel = q('select[data-move]') as HTMLSelectElement; sel.value = 'living_room'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(roomOfRow('light.under_cabinet')).toBe('living_room');
    expect(log.some((m) => m.includes('registry/update') && m.includes('"area_id":"living_room"'))).toBe(true); // really sent
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
    const log: string[] = [];
    await mount({ data: { ...EDIT, fav: ['light.under_cabinet', 'light.kitchen_pendants'] }, fetchHook: sentTo(log) });
    dragTo('light.under_cabinet', row('light.living_room_lamp', 'r:living_room'), 'before'); // the first row of that id is its Favourites row
    expect(row('light.under_cabinet', 'r:kitchen').closest('.edc-room')!.getAttribute('data-edid')).toBe('kitchen');
    expect(q('#favs').querySelector('.edc-row[data-edid="light.under_cabinet"]')).toBeTruthy(); // still a favourite, still there
    expect(log.filter((m) => m.includes('registry/update'))).toHaveLength(0); // and nothing was sent to Home Assistant
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
    push(m.socks[0]!, 'light.living_room_lamp', { a: { friendly_name: 'Floor lamp 2' } }); await frame();
    expect(row(a!).style.transform).toContain('translate'); // not wiped by a redraw
    d.up();
    await frame();
    expect(row('light.living_room_lamp').textContent).toContain('Floor lamp 2'); // what was held back draws once the drag is over
    expect(ids('r:kitchen')).toEqual([b, a]);
    expect(row(a!).style.transform).toBe('');
  });

  it('Escape gives a drag up and nothing moves', async () => {
    const m = await mount({ data: EDIT, fetchHook: noCameraPicture });
    const before = ids('r:kitchen');
    const d = drag(row(before[0]!).querySelector('[data-edgrip]')!, row(before[1]!), 'after'); d.move();
    expect(row(before[0]!).classList.contains('edc-lift')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(ids('r:kitchen')).toEqual(before);
    expect(row(before[0]!).style.transform).toBe('');
    expect(qa('.edc-lift, .edc-before, .edc-after')).toHaveLength(0);
    // and the page is free again: a change from the house draws at once
    push(m.socks[0]!, 'light.living_room_lamp', { a: { friendly_name: 'Floor lamp 3' } }); await frame();
    expect(row('light.living_room_lamp').textContent).toContain('Floor lamp 3');
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
    // a quick tap, no hold: the press, the lift, then the click the browser sends — opens settings
    const tapName = row(b!).querySelector<HTMLElement>('[data-act="edopen"]')!;
    const d2 = drag(tapName, null, 'after', true);
    await tick(100); d2.up(); tapName.click();
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

// ── Code review of the Edit board (2026-10-05) ───────────────────────────────
const refuseReply = registryReply(true);
/** Holds a registry request until released, then refuses it. */
const gated = (what: string, log: string[] = []) => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  return { release: () => release(), hook: sentTo(log, async (req: any) => { if (String(req.socket?.send).includes(what)) { await gate; return refuseReply; } return undefined; }) };
};

describe('review 1: what arrives while a row is held draws when it is let go', () => {
  it('a finger held on a row for a while, then let go without moving, still draws a change that arrived meanwhile', async () => {
    const m = await mount({ data: EDIT, fetchHook: noCameraPicture });
    const [a] = ids('r:kitchen');
    const d = drag(row(a!).querySelector('[data-act="edopen"]')!, null, 'after', true);
    await tick(450); // the hold has begun a drag
    push(m.socks[0]!, 'light.living_room_lamp', { a: { friendly_name: 'Floor lamp 9' } }); await frame();
    expect(row('light.living_room_lamp').textContent).not.toContain('Floor lamp 9'); // nothing redraws under the finger
    d.up(); await frame();
    expect(row('light.living_room_lamp').textContent).toContain('Floor lamp 9');
  });
  it('a refusal that lands during a drag is drawn when the drag ends, even if nothing moved', async () => {
    const g = gated('device_registry/update');
    await mount({ data: EDIT, fetchHook: g.hook });
    dragTo('light.under_cabinet', row('light.living_room_lamp'), 'before');
    const [a] = ids('r:kitchen');
    const d = drag(row(a!).querySelector('[data-edgrip]')!, null); // a new press on the dots
    g.release(); await tick(50);
    d.up(); await frame();
    expect(row('light.under_cabinet').querySelector('.pend')!.getAttribute('data-pend')).toBe('failed');
  });
});

describe('review 2: a drag that loses its pointer does not freeze the page', () => {
  for (const [name, lose] of [
    ['the window loses focus', () => window.dispatchEvent(new Event('blur'))],
    ['the pointer capture is lost', () => document.dispatchEvent(new MouseEvent('lostpointercapture', { bubbles: true }))],
    ['the tab is hidden', () => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); }],
  ] as Array<[string, () => void]>) {
    it(`${name}: the drag ends, the row lands back, and the page draws again`, async () => {
      const m = await mount({ data: EDIT, fetchHook: noCameraPicture });
      const [a, b] = ids('r:kitchen');
      const d = drag(row(a!).querySelector('[data-edgrip]')!, row(b!), 'after'); d.move();
      expect(captured).toContain(d.pid); // the dots asked the browser to keep sending this pointer
      lose();
      expect(row(a!).style.transform).toBe('');
      expect(ids('r:kitchen')).toEqual([a, b]);
      push(m.socks[0]!, 'light.living_room_lamp', { a: { friendly_name: 'Floor lamp 5' } }); await frame();
      expect(row('light.living_room_lamp').textContent).toContain('Floor lamp 5');
    });
  }
  it('a second finger cannot steer or end somebody else’s drag', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    const [a, b] = ids('r:kitchen');
    const d = drag(row(a!).querySelector('[data-edgrip]')!, row(b!), 'after'); d.move();
    document.dispatchEvent(ptr('pointerup', 0, 0, { pid: 99 })); // another finger lifts
    document.dispatchEvent(ptr('pointercancel', 0, 0, { pid: 99 }));
    expect(row(a!).classList.contains('edc-lift')).toBe(true);
    row(b!).querySelector('[data-edgrip]')!.dispatchEvent(ptr('pointerdown', 0, 0, { pid: 100, primary: false })); // a non-primary finger starts nothing
    d.up();
    expect(ids('r:kitchen')).toEqual([b, a]);
  });
});

describe('review 3: the lifted row follows the finger when the page scrolls', () => {
  it('the page scrolls on its own near the bottom edge even with the finger still, and the row stays under it', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    const [a, b] = ids('r:kitchen');
    const d = drag(row(a!).querySelector('[data-edgrip]')!, row(b!), 'after');
    d.move(window.innerHeight - 10); // the finger is at the bottom edge
    const first = row(a!).style.transform;
    await tick(100); await tick(100); // the finger does not move
    expect(scrollY).toBeGreaterThan(0);
    expect(row(a!).style.transform).not.toBe(first); // follows the scrolled page
    expect(row(a!).style.transform).toContain(`${window.innerHeight - 10 + scrollY}px`);
    d.up();
  });
});

describe('review 4: scrolling never waits on the drag handler', () => {
  it('a touchmove listener exists only while a drag is on', async () => {
    const add = vi.spyOn(document, 'addEventListener'), rem = vi.spyOn(document, 'removeEventListener');
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    const touch = (spy: typeof add | typeof rem) => spy.mock.calls.filter((c) => c[0] === 'touchmove').length;
    expect(touch(add)).toBe(0);
    const [a, b] = ids('r:kitchen');
    const d = drag(row(a!).querySelector('[data-edgrip]')!, row(b!), 'after'); d.move();
    expect(touch(add)).toBe(1);
    const e = new Event('touchmove', { bubbles: true, cancelable: true }); document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    d.up();
    expect(touch(rem)).toBe(1);
  });
});

describe('review 5: the keyboard keeps its place', () => {
  it('moving a device from its settings keeps the settings open in the new room, with the keyboard on its name', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    open('light.under_cabinet');
    const sel = q('select[data-move]') as HTMLSelectElement; sel.value = 'living_room'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(roomOfRow('light.under_cabinet')).toBe('living_room');
    expect(row('light.under_cabinet').querySelector('.edx-menu')).toBeTruthy();
    expect(document.activeElement).toBe(row('light.under_cabinet').querySelector('[data-act="edopen"]'));
  });
  it('Create and move, and Cancel, hand the keyboard back to the row', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    open('light.under_cabinet');
    const sel = q('select[data-move]') as HTMLSelectElement; sel.value = '__new'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    q('[data-act="cancel"]').click();
    expect(document.activeElement).toBe(row('light.under_cabinet').querySelector('[data-act="edopen"]'));
    sel.value = '__new'; (q('select[data-move]') as HTMLSelectElement).value = '__new'; q('select[data-move]').dispatchEvent(new Event('change', { bubbles: true }));
    (q('[data-nr]') as HTMLInputElement).value = 'Pantry'; q('[data-act="room-create"]').click();
    expect(document.activeElement).toBe(row('light.under_cabinet').querySelector('[data-act="edopen"]'));
    expect(roomOfRow('light.under_cabinet')).not.toBe('kitchen');
  });
  it('Cancel on the dashed box goes back to the dropped row', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    dragTo('light.under_cabinet', q('#edc-new'));
    q('#edc-new [data-act="cancel"]').click();
    expect(document.activeElement).toBe(row('light.under_cabinet').querySelector('[data-act="edopen"]'));
  });
});

describe('review 6: an older refusal is not lost when a newer press lands on the same device', () => {
  it('rename, then move; the rename is refused afterwards: the old name comes back and the row says so', async () => {
    const g = gated('"name"');
    await mount({ data: EDIT, fetchHook: g.hook });
    open('light.under_cabinet');
    (q('[data-rn]') as HTMLInputElement).value = 'Counter strip';
    q('[data-act="rename-save"]').click();
    expect(row('light.under_cabinet').textContent).toContain('Counter strip');
    const sel = q('select[data-move]') as HTMLSelectElement; sel.value = 'living_room'; sel.dispatchEvent(new Event('change', { bubbles: true })); // a newer press on the same device
    await tick(50);
    g.release(); await tick(50);
    expect(row('light.under_cabinet').textContent).toContain('Under cabinet');
    expect(row('light.under_cabinet').textContent).not.toContain('Counter strip');
    expect(row('light.under_cabinet').querySelector('.pend')!.getAttribute('data-pend')).toBe('failed');
    expect(roomOfRow('light.under_cabinet')).toBe('living_room'); // the move itself went through
    await tick(1000);
    expect(row('light.under_cabinet').querySelector('.pend')!.getAttribute('data-pend')).toBe('failed'); // and the note stays after the move succeeds
  });
  it('a new room made for a move that is then refused is taken out of Home Assistant again', async () => {
    const log: string[] = [];
    await mount({ data: EDIT, fetchHook: sentTo(log, (req) => (String(req.socket?.send).includes('device_registry/update') || String(req.socket?.send).includes('"area_id":"') && String(req.socket?.send).includes('entity_registry/update')) ? refuseReply : undefined) });
    dragTo('light.under_cabinet', q('#edc-new'));
    (q('[data-nr]') as HTMLInputElement).value = 'Den';
    q('[data-act="room-create"]').click();
    await tick(100);
    expect(log.some((m) => m.includes('area_registry/delete'))).toBe(true);
    expect(roomNames()).not.toContain('Den');
  });
});

describe('review 7: a refused move puts everything back as it was', () => {
  it('the device returns to its old place in a room with no saved order', async () => {
    await mount({ data: EDIT, fetchHook: refuseRegistry('registry/update') });
    const before = ids('r:kitchen');
    dragTo(before[0]!, row('light.living_room_lamp'), 'before');
    await tick(100);
    expect(ids('r:kitchen')).toEqual(before); // first again, not last
  });
  it('the order the drop saved is taken back too', async () => {
    await mount({ data: EDIT, fetchHook: refuseRegistry('registry/update') });
    const log = saved();
    dragTo('light.under_cabinet', row('light.living_room_lamp'), 'before');
    await tick(100);
    expect(log.at(-1)!.order['r:living_room']).toBeUndefined();
  });
});

describe('review 8: a second finger down before the hold fires does no harm', () => {
  it('two presses in a row leave no stray timer to fail', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    const [a, b] = ids('r:kitchen');
    row(a!).querySelector('[data-act="edopen"]')!.dispatchEvent(ptr('pointerdown', 0, 0, { pid: 1, touch: true }));
    row(b!).querySelector('[data-act="edopen"]')!.dispatchEvent(ptr('pointerdown', 0, 0, { pid: 2, touch: true }));
    await tick(450); // would have thrown from a forgotten timer
    document.dispatchEvent(ptr('pointerup', 0, 0, { pid: 2, touch: true }));
    expect(ids('r:kitchen')).toEqual([a, b]);
  });
});

describe('review 9: a room that is not on the board keeps its place in the saved order', () => {
  it('reordering rooms leaves a room with only a remote where it was', async () => {
    const withRemoteOnly = (req: any) => {
      noCameraPicture(req);
      if (!req.url.endsWith('/api/template')) return undefined;
      const r = fakeHomeAssistantFetch(req) as { body: string } | null;
      let rooms: any; try { rooms = JSON.parse(r!.body); } catch { return undefined; }
      if (!Array.isArray(rooms) || !rooms[0]?.items) return undefined;
      rooms.push({ id: 'remote_only', name: 'Remotes', items: [{ id: 'remote.lonely', name: 'Lonely', state: 'on' }] });
      return { ...r, body: JSON.stringify(rooms) };
    };
    await mount({ data: EDIT, fetchHook: withRemoteOnly });
    const log = saved();
    const rooms = qa('.edc-room').map((r) => r.getAttribute('data-edid')!);
    expect(rooms).not.toContain('remote_only');
    const d = drag(q(`#edroom-${rooms[0]} [data-edroomgrip]`), q(`#edroom-${rooms[1]}`), 'after'); d.move(); d.up();
    expect(log.at(-1)!.order.rooms).toContain('remote_only');
  });
});

describe('review 10: Escape closes a row’s settings from anywhere in them', () => {
  for (const sel of ['select[data-move]', '[data-act="down"]']) {
    it(`from ${sel}`, async () => {
      await mount({ data: EDIT, fetchHook: noCameraPicture });
      open('light.under_cabinet');
      const el = row('light.under_cabinet').querySelector<HTMLElement>(sel)!; el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(row('light.under_cabinet').querySelector('.edx-menu')).toBeNull();
      expect(document.activeElement).toBe(row('light.under_cabinet').querySelector('[data-act="edopen"]'));
    });
  }
});

describe('review 11: a second device dropped on the dashed box starts a fresh name', () => {
  it('the box is emptied, labelled for the new device and focused', async () => {
    await mount({ data: EDIT, fetchHook: noCameraPicture });
    dragTo('light.under_cabinet', q('#edc-new'));
    (q('#edc-new [data-nr]') as HTMLInputElement).value = 'Pan';
    dragTo('light.kitchen_pendants', q('#edc-new'));
    expect(q('#edc-new').textContent).toContain('Pendants');
    expect((q('#edc-new [data-nr]') as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(q('#edc-new [data-nr]'));
  });
});

describe('review 13 and 14', () => {
  it('with no rooms at all, Edit says so instead of offering a box to drop on', async () => {
    let empty = false;
    const none = (req: any) => { noCameraPicture(req); return empty && req.url.endsWith('/api/template') ? { ok: true, status: 200, headers: {}, body: '[]' } : undefined; };
    await mount({ data: EDIT, fetchHook: none });
    expect(q('#edc-new')).toBeTruthy();
    empty = true; await tick(61_000); // the once-a-minute check finds no rooms
    expect(q('#rooms').textContent).toContain('Nothing to show');
    expect(document.querySelector('#edc-new')).toBeNull();
  });
  it('a finger gets 44 px targets for the dots, the star, the eye and the name', () => {
    expect(HOME_EDIT_CSS).toMatch(/pointer: coarse\)[^}]*\.edc-grip \{ width: 44px; height: 44px; \}[^}]*\.edc-row \.ib \{ width: 44px; height: 44px; \}[^}]*\.edc-name \{ min-height: 44px; \}/);
  });
});
