// @vitest-environment jsdom
// Code review F4 / F17: a thermostat in Auto (heat_cool) holds a low and a high set point and has NO single
// temperature. The dial used to say "Off" with no buttons while Auto was the pressed mode. It now shows both numbers
// and − / + move the chosen one, sending both to the house. The rooms template also stays safe for the real house.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, tick, noCameraPicture } from './home-page-harness';
import { ROOMS_TEMPLATE } from '../src/renderer/dev/workbench/fixtures/home-assistant-page-templates';

afterEach(() => { unmount(); vi.useRealTimers(); });
const T = 'climate.thermostat';
const card = () => q(`[data-eid="${T}"]`);

it('shows both set points in Auto and moves only the chosen one', async () => {
  const sent: Array<Record<string, unknown>> = [];
  await mount({ data: { startOpen: ['upstairs'] }, fetchHook: (req: { url: string; body?: string }) => { noCameraPicture(req); if (req.url.includes('set_temperature')) sent.push(JSON.parse(req.body ?? '{}')); return undefined; } });
  card().querySelector<HTMLElement>('[data-hvac="heat_cool"]')!.click();
  await tick(1000);
  expect(card().querySelector('.th-lbl')!.textContent).not.toBe('Off');
  const sides = qa(`[data-eid="${T}"] .th-side-btn`);
  expect(sides.map((b) => b.textContent)).toEqual(['68°', '75°']);
  expect(card().querySelector('[aria-label="Warmer"]')).toBeTruthy(); // the buttons are there (they were missing)
  // Choose the cool side: + raises 75 to 76 and sends both numbers.
  card().querySelector<HTMLElement>('[data-side="high"]')!.click();
  card().querySelector<HTMLElement>('[aria-label="Warmer"]')!.click();
  await tick(600);
  expect(sent.at(-1)).toMatchObject({ entity_id: T, target_temp_low: 68, target_temp_high: 76 });
  // Press the heat side, then −: 68 becomes 67, the high side stays.
  card().querySelector<HTMLElement>('[data-side="low"]')!.click();
  card().querySelector<HTMLElement>('[aria-label="Cooler"]')!.click();
  await tick(600);
  expect(sent.at(-1)).toMatchObject({ target_temp_low: 67, target_temp_high: 76 });
  expect(qa(`[data-eid="${T}"] .th-side-btn`).map((b) => b.textContent)).toEqual(['67°', '76°']);
});

it('keeps the rooms template free of non-JSON values (it is rendered by the real Home Assistant)', () => {
  expect(ROOMS_TEMPLATE).toContain("'tlo': s.attributes.get('target_temp_low')");
  expect(ROOMS_TEMPLATE).toContain("'thi': s.attributes.get('target_temp_high')");
  expect(ROOMS_TEMPLATE).toContain('pa is not string and pa.isoformat is defined'); // F17: a datetime OR a string
  expect(ROOMS_TEMPLATE).toContain('eid is string'); // F17: a lone id is not split into letters
});
