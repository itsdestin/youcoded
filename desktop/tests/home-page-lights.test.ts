// @vitest-environment jsdom
// The Lights tab (Destin, 2026-10-05, round 2c, "Tall cards"): one card per room titled "<Room> Lights" with the page's round All
// button, scenes button, fold arrow and room bar; cards start closed; unfolded, each light is a tall card (bulb, name, percent, colour
// dot, a thick bar along the bottom); tapping the card switches the light; the colour dot opens a floating glass panel that closes on
// an outside click and on Escape; unreachable lights go last in their card (even after a custom Edit order) and a room where none
// answers goes last on the tab, dimmed. The Home tab keeps its old cards.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, frame, tick, pointer, noCameraPicture } from './home-page-harness';
import { fakeHomeAssistantCalls, fakeHomeAssistantSet } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

afterEach(() => { unmount(); vi.useRealTimers(); });
const text = (e: Element | null) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
// WHY one room is open in every test: the harness waits for a light card (data-eid) to know the page has drawn; cards start closed otherwise.
const DATA = { view: 'lights', startOpen: ['kitchen'] };
const OPEN = { view: 'lights', startOpen: ['destins_room'] };
const cards = () => qa('.lt-cell').map((c) => c.getAttribute('data-eid'));
const bar = (id: string) => q(`[data-eid="${id}"] .lr[data-bright]`) as HTMLInputElement;
const input = (el: HTMLElement) => el.dispatchEvent(new Event('input', { bubbles: true }));

it('one card per room titled "<Room> Lights", each starting closed, with the All button, fold arrow and (where there are scenes) the scenes button', async () => {
  await mount({ data: DATA, fetchHook: noCameraPicture });
  const titles = qa('.lt > .tile.all .name').map((n) => text(n.firstChild as Element));
  expect(titles).toEqual(["Destin's Room Lights", 'Living Room Lights', 'Kitchen Lights']);
  expect(qa('.lt-grid')).toHaveLength(1); // only the Kitchen (opened for the harness); the others start closed
  expect(q('[data-lt="destins_room"]').classList.contains('is-open')).toBe(false);
  const room = q('[data-lt="destins_room"]');
  expect(room.querySelector('[data-room="destins_room"]')).toBeTruthy();
  expect(room.querySelector('.scn')).toBeTruthy();
  expect(room.querySelector('[data-gbright="destins_room"]')).toBeTruthy();
  q('[data-fold="destins_room"]').click(); await frame();
  expect(qa('.lt-grid')).toHaveLength(2);
  expect(q('[data-fold="destins_room"]').getAttribute('aria-expanded')).toBe('true');
});

it('each light is a tall card: bulb, name, percent and colour dot on top, a bar along the bottom; the TV backlight (not responding) has none', async () => {
  await mount({ data: OPEN, fetchHook: noCameraPicture });
  expect(cards()).toEqual(['light.overhead_light', 'light.desk_backlight', 'light.hue_play_1', 'light.tv_backlight']);
  const c = q('[data-eid="light.desk_backlight"]');
  expect(c.querySelector('.bulb')).toBeTruthy();
  expect(text(c.querySelector('.name'))).toBe('Desk backlight40%');
  expect(c.querySelector('.cbtn')).toBeTruthy();
  const kids = Array.from(c.children).map((k) => k.className);
  expect(kids.at(-1)).toContain('lr'); // the bar is the last thing, along the bottom
  const gone = q('[data-eid="light.tv_backlight"]');
  expect(text(gone.querySelector('.name'))).toContain('Not responding');
  expect(gone.querySelector('.lr')).toBeNull();
  expect(q('.lt-grid').children).toHaveLength(4);
});

it('tapping the card switches the light', async () => {
  await mount({ data: OPEN, fetchHook: noCameraPicture });
  q('[data-eid="light.overhead_light"] [data-toggle]').click(); await tick(50);
  const last = fakeHomeAssistantCalls().filter((c) => c.domain === 'light').at(-1)!;
  expect(last.service).toBe('turn_off');
  expect(last.data).toMatchObject({ entity_id: 'light.overhead_light' });
  expect(q('[data-eid="light.overhead_light"]').classList.contains('on')).toBe(false);
});

it('the thick bar dims through the page\'s slider target model (held where released, sent once) and the room bar follows', async () => {
  await mount({ data: OPEN, fetchHook: noCameraPicture });
  const el = bar('light.desk_backlight');
  el.focus(); pointer(el, 'pointerdown');
  el.value = '70'; input(el); await tick(20);
  el.dispatchEvent(new Event('change', { bubbles: true })); pointer(document, 'pointerup');
  await tick(100);
  const sent = fakeHomeAssistantCalls().filter((c) => c.service === 'turn_on' && (c.data as any).entity_id === 'light.desk_backlight');
  expect(sent.at(-1)!.data).toMatchObject({ brightness_pct: 70 });
  expect(Number(bar('light.desk_backlight').value)).toBe(70);
  await tick(5000);
  expect(Number(bar('light.desk_backlight').value)).toBe(70); // the house agrees, no rubber-band
  expect(text(q('[data-eid="light.desk_backlight"] .name'))).toContain('70%');
  // the room bar is the average of the lights that are on: (255 + 70% + 200) / 3 -> 77%
  expect(Number((q('[data-gbright="destins_room"]') as HTMLInputElement).value)).toBe(Math.round((255 + Math.round(70 * 2.55) + 200) / 3 / 2.55));
});

it('the colour dot opens a floating panel that closes on Escape and on a click outside; a second dot replaces the first', async () => {
  await mount({ data: OPEN, fetchHook: noCameraPicture });
  expect(qa('.ltp')).toHaveLength(0);
  q('[data-eid="light.desk_backlight"] .cbtn').click(); await frame();
  expect(qa('.ltp')).toHaveLength(1);
  expect(q('.ltp').closest('.ltw')!.getAttribute('data-slot')).toBe('lt:light.desk_backlight'); // hangs off its own light
  expect(q('.ltp .palette')).toBeTruthy();
  q('.ltp .sw').click(); await frame(); // using it does not close it
  expect(qa('.ltp')).toHaveLength(1);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame();
  expect(qa('.ltp')).toHaveLength(0);
  q('[data-eid="light.desk_backlight"] .cbtn').click(); await frame();
  q('[data-eid="light.hue_play_1"] .cbtn').click(); await frame();
  expect(qa('.ltp').map((p) => p.getAttribute('aria-label'))).toEqual(['Colour of Hue Play 1']);
  q('.vhead').click(); await frame(); // outside
  expect(qa('.ltp')).toHaveLength(0);
});

it('unreachable lights go last in their card, even when Edit put one first', async () => {
  await mount({ data: { ...OPEN, order: { 'r:destins_room': ['light.tv_backlight', 'light.hue_play_1', 'light.overhead_light'] } }, fetchHook: noCameraPicture });
  expect(cards().at(-1)).toBe('light.tv_backlight');
  expect(cards().slice(0, 3)).toEqual(['light.hue_play_1', 'light.overhead_light', 'light.desk_backlight']);
});

it('a room where no light answers goes after every working room, dimmed', async () => {
  fakeHomeAssistantSet('light.living_room_lamp', { state: 'unavailable' });
  fakeHomeAssistantSet('light.living_room_ceiling', { state: 'unavailable' });
  await mount({ data: DATA, fetchHook: noCameraPicture });
  expect(qa('.lt').map((r) => r.getAttribute('data-lt'))).toEqual(['destins_room', 'kitchen', 'living_room']);
  expect(q('[data-lt="living_room"]').classList.contains('dead')).toBe(true);
  expect(q('[data-lt="kitchen"]').classList.contains('dead')).toBe(false);
});

it('the Home tab keeps its own lights cards', async () => {
  await mount({ data: { startOpen: ['destins_room'] }, fetchHook: noCameraPicture });
  expect(qa('.lt')).toHaveLength(0);
  expect(qa('.lights')).not.toHaveLength(0);
});

it('never draws a Hue room (a light whose members are that room\'s lights) as a light of its own, on either tab', async () => {
  // WHY: the real house's light.destin_s_room lists its 9 lights; drawn, it was a tile for the whole room inside the room's card.
  await mount({ data: OPEN, fetchHook: noCameraPicture });
  expect(cards()).not.toContain('light.destins_room_hue');
  expect(cards()).toContain('light.overhead_light');
  expect(q('[data-lt="destins_room"] .tile.all .sub').textContent).not.toMatch(/4 of|of 4/); // the group is not counted as a light
  unmount();
  await mount({ data: { startOpen: ['destins_room'] }, fetchHook: noCameraPicture });
  expect(document.querySelector('[data-eid="light.destins_room_hue"]')).toBeNull();
});
