// @vitest-environment jsdom
// Second UX review of the Home page (2026-10-05), findings U7-U11 and U13-U18. Each test pins what a person sees.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, tick, frame, noCameraPicture } from './home-page-harness';
import { fakeHomeAssistantSet } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import { HOME_ASSISTANT_PAGE_HTML } from '../src/renderer/dev/workbench/fixtures/home-assistant-page';

afterEach(() => { unmount(); vi.useRealTimers(); });
const text = (e: Element | null) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
const OPEN = { startOpen: ['destins_room', 'kitchen'] };

it('U7: Edit and the gear stay pinned to the top of the header row, whatever the tabs do', () => {
  expect(HOME_ASSISTANT_PAGE_HTML).toMatch(/\.toprow \{[^}]*align-items: flex-start/);
  expect(HOME_ASSISTANT_PAGE_HTML).toMatch(/\.bar \{[^}]*flex-wrap: nowrap/);
});

it('U8: the Home tab says "not responding" for a room with a dead light, like the Lights tab', async () => {
  await mount({ data: OPEN, fetchHook: noCameraPicture });
  expect(text(q('[data-room="destins_room"]').querySelector('.sub'))).toBe('3 of 3 on · 1 not responding');
});

it('U8: a room that is on only through a light that cannot dim shows its bar full, not at zero', async () => {
  await mount({ data: OPEN, fetchHook: noCameraPicture });
  // Kitchen: Under cabinet (on/off only) is on, Pendants (dimmable) is off.
  expect(text(q('[data-room="kitchen"]').querySelector('.sub'))).toBe('1 of 2 on');
  expect((q('[data-gbright="kitchen"]') as HTMLInputElement).value).toBe('100');
});

it('U9: a change made from the page shows in Activity, newest first, with no repeated "on the device" line', async () => {
  await mount({ data: OPEN, fetchHook: noCameraPicture });
  q('[data-toggle="light.under_cabinet"]').click(); await tick(1000);
  q('[data-view="activity"]').click(); await tick(1000);
  const rows = qa('.ev');
  expect(text(rows[0])).toContain('Under cabinet turned off');
  expect(text(rows[0])).toContain('by Destin');
  const times = rows.map((r) => Number(r.getAttribute('data-k')!.split('|')[1]));
  expect(times).toEqual([...times].sort((a, b) => b - a));
  expect(text(q('#view'))).not.toContain('on the device or another app');
  // The one explanation, for rows with no name beside them.
  expect(qa('.act-list .yc-caption').map(text)).toEqual(['Changes with no name beside them came from a switch or another app.']);
});

it('U10: Lights cards sit in a grid so turning a room off cannot move them; their order does not change', async () => {
  await mount({ data: { view: 'lights', startOpen: ['kitchen'] }, fetchHook: noCameraPicture });
  const order = () => qa('[data-lt]').map((c) => c.getAttribute('data-lt'));
  const before = order();
  q('[data-room="living_room"]').click(); await tick(1000);
  expect(order()).toEqual(before);
  expect(HOME_ASSISTANT_PAGE_HTML).toMatch(/#view \.rooms \{ columns: auto; display: grid/);
});

it('U11: the thermostat says what it is doing: cooling, holding, off', async () => {
  fakeHomeAssistantSet('climate.thermostat', { action: 'idle', cur: 74, target: 75 });
  await mount({ data: OPEN, fetchHook: noCameraPicture });
  expect(text(q('.th-compact .th-lbl'))).toBe('Holding at');
  expect(q('[data-view="climate"]').getAttribute('aria-label')).toContain('Holding at 75°');
  expect(q('[data-view="climate"]').getAttribute('aria-label')).not.toContain('Cool to');
  fakeHomeAssistantSet('climate.thermostat', { action: 'cooling', cur: 76, target: 75 });
  await tick(6000);
  expect(text(q('.th-compact .th-lbl'))).toBe('Cooling to');
  expect(q('[data-view="climate"]').getAttribute('aria-label')).toContain('Cooling to 75°');
});

it('U13: the Cameras tab has one sign-in banner; tiles say Signed out, a dead camera says only Not responding', async () => {
  await mount({ data: { view: 'cameras' } });
  await tick(2000);
  expect(qa('.cam-banner')).toHaveLength(1);
  expect(q('.cam-banner a').getAttribute('href')).toContain('/config/integrations/integration/nest');
  expect(text(q('.cam-banner a'))).toBe('Sign in');
  expect(text(q('#view'))).not.toContain('No picture');
  expect(text(q('.cam-tile[data-eid="camera.doorbell"] .cam-msg'))).toBe('Not responding');
});

it('U14: Edit shows a one-line hint saying what the star, eye, dots and arrows do', async () => {
  await mount({ data: OPEN, fetchHook: noCameraPicture });
  expect(qa('.ed-hint')).toHaveLength(0);
  q('[data-act="edit"]').click(); await frame();
  expect(qa('.ed-hint')).toHaveLength(1);
  expect(text(q('.ed-hint'))).toMatch(/Star = favorite.*Eye = hide.*Dots.*Arrows/);
  expect(q('[data-act="fav"]').getAttribute('aria-label')).toMatch(/favorites$/);
});

it('U15/U16: plain words in Page settings, and the weather pill reads "77° out · 74° in"', async () => {
  await mount({ data: OPEN, fetchHook: noCameraPicture });
  q('[data-view="settings"]').click(); await frame();
  const t = text(q('#view'));
  for (const w of ['Lights tab', 'Problems tab', 'Light scenes in each room', 'Favorites row']) expect(t).toContain(w);
  for (const w of ['chip', 'Hue', 'Favourites']) expect(t).not.toContain(w);
  expect(text(q('[data-view="climate"]'))).toBe('77° out · 74° in');
});

it('U17: the pad\'s direction buttons are named, and the card reads in the order it is seen', async () => {
  await mount({ data: OPEN, fetchHook: noCameraPicture });
  expect(qa('.rdial .pk').map((b) => b.getAttribute('aria-label')).sort()).toEqual(['Down', 'Left', 'OK', 'Right', 'Up']);
  expect(HOME_ASSISTANT_PAGE_HTML).toMatch(/\.mv-wide \.np\.mv-np \{ reading-flow: grid-rows/);
});

it('U18: the device pop-up names a camera once', async () => {
  await mount({ data: { ...OPEN, dlg: 'camera.garage_pi' }, fetchHook: noCameraPicture });
  const dlg = q('.dlg');
  expect(text(dlg.querySelector('h2'))).toBe('Garage camera');
  expect(qa('.dlg .name').map(text).join('')).not.toContain('Garage camera');
});

const esc = () => { const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); document.dispatchEvent(e); return e.defaultPrevented; };
it('Escape: closing the pop-up uses the key (the frame must not also leave the page); with nothing open it is left alone', async () => {
  await mount({ data: { ...OPEN, dlg: 'camera.garage_pi' }, fetchHook: noCameraPicture });
  expect(qa('.dlg')).toHaveLength(1);
  expect(esc()).toBe(true);
  await frame();
  expect(qa('.dlg')).toHaveLength(0);
  expect(esc()).toBe(false);
});

it('Escape: closing the Lights colour panel uses the key too', async () => {
  await mount({ data: { view: 'lights', startOpen: ['destins_room'] }, fetchHook: noCameraPicture });
  q('.cbtn').click(); await frame();
  expect(qa('.ltp')).toHaveLength(1);
  expect(esc()).toBe(true);
  await frame();
  expect(qa('.ltp')).toHaveLength(0);
  expect(esc()).toBe(false);
});
