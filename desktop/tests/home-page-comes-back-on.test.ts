// @vitest-environment jsdom
// Destin, 2026-10-05: "when flicking lights on/off, the brightness slider often jumps between 0 and the correct level when
// turning back on." Traced on the real house (ha-trace3.tsv): Home Assistant BLANKS brightness, colour, volume and set points
// while a device is off, and the device reports them back about a second after it is turned on (its "on" and its levels in ONE
// message). The page showed "on" at once with no level, so every bar drew 0 for that second. The pretend house now behaves the
// same way (blanks on off, reports back after fakeHomeAssistantReportDelay), and these tests sample the screen every 100 ms.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, tick, noCameraPicture } from './home-page-harness';
import { fakeHomeAssistantReportDelay } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

afterEach(() => { unmount(); vi.useRealTimers(); });
const DATA = { startOpen: ['living_room', 'destins_room', 'kitchen', 'upstairs', 'media_room'] };
const text = (s: string) => (q(s).textContent ?? '').replace(/\s+/g, ' ').trim();
// Samples the screen every 100 ms for ms, returning what `read` saw each time.
async function watch<T>(ms: number, read: () => T): Promise<T[]> {
  const seen: T[] = [];
  for (let t = 0; t < ms; t += 100) { await tick(100); seen.push(read()); }
  return seen;
}
const LAMP = '[data-eid="light.living_room_lamp"]';
const press = (s: string) => q(s).click();

it('a light flicked off and on again never draws 0 while the device is making up its mind', async () => {
  fakeHomeAssistantReportDelay(1000);
  await mount({ data: DATA, fetchHook: noCameraPicture });
  const bar = () => (q(`${LAMP} [data-bright]`) as HTMLInputElement).value;
  expect(bar()).toBe('71');
  press(`${LAMP} [data-toggle]`);
  await tick(2000); // off, and the house has reported it (brightness blank)
  press(`${LAMP} [data-toggle]`);
  const seen = await watch(2500, () => `${bar()} ${text(`${LAMP} .sub`)}`);
  expect(new Set(seen)).toEqual(new Set(['71 71%'])); // the same level on every look, before and after the device answers
});

it('a light flicked off and on again quickly (the late "off" arrives after the "on") still never draws 0', async () => {
  fakeHomeAssistantReportDelay(1000);
  await mount({ data: DATA, fetchHook: noCameraPicture });
  const bar = () => (q(`${LAMP} [data-bright]`) as HTMLInputElement).value;
  press(`${LAMP} [data-toggle]`);
  await tick(300);
  press(`${LAMP} [data-toggle]`);
  const seen = await watch(3000, () => bar());
  expect(new Set(seen)).toEqual(new Set(['71']));
  expect(q(`${LAMP} [data-toggle]`).getAttribute('aria-pressed')).toBe('true');
});

it('a room All button: every light and the room bar come back at their old levels and the bar does not move', async () => {
  fakeHomeAssistantReportDelay(1000);
  await mount({ data: DATA, fetchHook: noCameraPicture });
  const room = () => (q('[data-gbright="destins_room"]') as HTMLInputElement).value;
  const lights = () => ['overhead_light', 'desk_backlight', 'hue_play_1'].map((n) => (q(`[data-eid="light.${n}"] [data-bright]`) as HTMLInputElement).value).join();
  const before = `${room()} ${lights()}`;
  press('[data-room="destins_room"]'); await tick(2000); // all off
  press('[data-room="destins_room"]');
  const seen = await watch(2500, () => `${room()} ${lights()}`);
  expect(new Set(seen)).toEqual(new Set([before]));
});

it('a speaker or TV keeps its volume bar, at its old level, through power-on', async () => {
  fakeHomeAssistantReportDelay(1000);
  await mount({ data: DATA, fetchHook: noCameraPicture });
  const TV = '[data-eid="media_player.media_room_tv"]';
  const vol = () => (document.querySelector(`${TV} [data-vol]`) as HTMLInputElement | null)?.value ?? 'no bar';
  expect(vol()).toBe('30');
  press(`${TV} [data-toggle]`); await tick(2000);
  press(`${TV} [data-toggle]`);
  const seen = await watch(2500, vol);
  expect(new Set(seen)).toEqual(new Set(['30']));
});

it('a thermostat switched Off then back to Cool shows its old set point, not a dash', async () => {
  fakeHomeAssistantReportDelay(1000);
  await mount({ data: DATA, fetchHook: noCameraPicture });
  const set = () => text('.th-compact .th-set') + ' ' + text('.th-compact .th-lbl');
  expect(set()).toMatch(/^72° /);
  press('.th-compact [data-hvac="off"]'); await tick(2000);
  press('.th-compact [data-hvac="cool"]');
  const seen = await watch(2500, () => text('.th-compact .th-set'));
  expect(new Set(seen)).toEqual(new Set(['72°']));
});

it('a coloured light keeps its colour on the way back on', async () => {
  fakeHomeAssistantReportDelay(1000);
  await mount({ data: DATA, fetchHook: noCameraPicture });
  const DESK = '[data-eid="light.desk_backlight"]';
  const colour = () => q(DESK).getAttribute('style');
  expect(colour()).toContain('rgb(50,110,255)');
  press(`${DESK} [data-toggle]`); await tick(2000);
  press(`${DESK} [data-toggle]`);
  const seen = await watch(2500, () => colour()!.includes('rgb(50,110,255)'));
  expect(new Set(seen)).toEqual(new Set([true]));
});

it('a light the page has never seen on shows "not known yet" (no 0%) until the device answers, then its real level', async () => {
  fakeHomeAssistantReportDelay(1000);
  await mount({ data: DATA, fetchHook: noCameraPicture });
  const PEND = '[data-eid="light.kitchen_pendants"]';
  press(`${PEND} [data-toggle]`);
  await tick(500);
  expect(q(`${PEND} [data-bright]`).classList.contains('lr-unk')).toBe(true);
  expect(text(`${PEND} .sub`)).toBe('On');
  await tick(1500);
  expect(q(`${PEND} [data-bright]`).classList.contains('lr-unk')).toBe(false);
  expect(text(`${PEND} .sub`)).toBe('100%');
});

it('a level the device DOES report wins over the remembered one', async () => {
  fakeHomeAssistantReportDelay(0);
  await mount({ data: DATA, fetchHook: noCameraPicture });
  const bar = () => (q(`${LAMP} [data-bright]`) as HTMLInputElement).value;
  press(`${LAMP} [data-toggle]`); await tick(1500);
  const { fakeHomeAssistantSet } = await import('../src/renderer/dev/workbench/fixtures/fake-home-assistant');
  fakeHomeAssistantSet('light.living_room_lamp', { state: 'on', brightness: 51 }); // someone switches it on at the wall, dimmed
  await tick(500);
  expect(bar()).toBe('20');
});

it('the Lights tab: a tall card and the room bar keep their levels when a light comes back on', async () => {
  fakeHomeAssistantReportDelay(1000);
  await mount({ data: { view: 'lights', startOpen: ['destins_room'] }, fetchHook: noCameraPicture });
  const CARD = '[data-eid="light.desk_backlight"]';
  const read = () => `${text(`${CARD} .sub`)} ${(q(`${CARD} [data-bright]`) as HTMLInputElement).value} ${(q('[data-gbright="destins_room"]') as HTMLInputElement).value}`;
  const before = read();
  expect(before).toMatch(/^40% /);
  press(`${CARD} [data-toggle]`); await tick(2000);
  press(`${CARD} [data-toggle]`);
  const seen = await watch(2500, read);
  expect(new Set(seen)).toEqual(new Set([before]));
});

it('a TV with a remote: the old Cast title does not reappear after a power cycle (pin: it was already hidden)', async () => {
  fakeHomeAssistantReportDelay(1000);
  await mount({ data: DATA, fetchHook: noCameraPicture });
  const TV = '[data-eid="media_player.destins_room_google_tv"]';
  expect(text(TV)).toContain('Lofi beats');
  press(`${TV} [data-toggle]`); await tick(2000); // off
  expect(text(TV)).not.toContain('Lofi beats');
  press(`${TV} [data-toggle]`);
  const seen = await watch(2500, () => text(TV).includes('Lofi beats'));
  expect(new Set(seen)).toEqual(new Set([false]));
});
