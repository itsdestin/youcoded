// @vitest-environment jsdom
// Destin: "the ac +/- is still buggy and rubberband-y" (2026-10-07). His Nest accepts a change at once but confirms it through
// Google seconds later, and Google refuses rapid commands. Every press used to send at once, so confirmations of EARLIER
// presses landed after the newest and pulled the number back and forth. Now: the number moves at once, ONE send goes out once the
// presses stop, the target is held until the thermostat reports it (or 20 s), a refusal puts the old number back and says so.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, tick, pointer, noCameraPicture } from './home-page-harness';
import { fakeHomeAssistantNestLag, fakeHomeAssistantNestRefuse, fakeHomeAssistantSet } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

afterEach(() => { unmount(); vi.useRealTimers(); });
const ID = 'climate.thermostat';
function recorder() {
  const sent: Array<Record<string, any>> = [];
  const hook = (req: { url: string; body?: string }) => {
    noCameraPicture(req);
    if (req.url.endsWith('/api/services/climate/set_temperature')) sent.push(JSON.parse(req.body ?? '{}'));
    return undefined;
  };
  return { sent, hook };
}
const card = () => q(`#rooms [data-eid="${ID}"]`);
const num = () => card().querySelector<HTMLElement>('.th-dial [data-th-h="set"]')!.getAttribute('aria-valuenow')!;
const press = (delta: number) => { (q(`#rooms [data-eid="${ID}"] [data-temp][data-delta="${delta}"]`) as HTMLElement).click(); };

it('five quick presses show every step at once but send ONE request, for the final value', async () => {
  const r = recorder();
  await mount({ fetchHook: r.hook });
  const start = Number(num());
  for (let i = 0; i < 5; i++) { press(1); await tick(150); }
  expect(num()).toBe(String(start + 5));
  expect(r.sent).toEqual([]); // nothing sent while still pressing
  await tick(900);
  expect(r.sent).toHaveLength(1);
  expect(r.sent[0]).toMatchObject({ entity_id: ID, temperature: start + 5 });
});

it('late confirmations of earlier values never pull the number back; the matching one releases the hold', async () => {
  fakeHomeAssistantNestLag([3000]);
  const r = recorder();
  const m = await mount({ fetchHook: r.hook });
  const start = Number(num());
  press(1); await tick(900); // first send (start + 1), confirms at +3 s
  press(1); press(1); await tick(900); // second send (start + 3)
  expect(r.sent.map((s) => s.temperature)).toEqual([start + 1, start + 3]);
  const seen = new Set<string>();
  for (let t = 0; t < 2000; t += 100) { await tick(100); seen.add(num()); } // the start + 1 confirmation lands in here
  expect([...seen]).toEqual([String(start + 3)]);
  await tick(6000); // start + 3 confirmed: the hold is released and the number is the device's
  expect(num()).toBe(String(start + 3));
  fakeHomeAssistantSet(ID, { target: start + 9 }); // a wall change after confirmation is shown (nothing held any more)
  await tick(400);
  expect(num()).toBe(String(start + 9));
  void m;
});

it('a refused send (429) puts the old number back and says Didn\'t work', async () => {
  fakeHomeAssistantNestRefuse(true);
  const r = recorder();
  await mount({ fetchHook: r.hook });
  const start = Number(num());
  press(1); press(1);
  expect(num()).toBe(String(start + 2));
  await tick(1200);
  expect(r.sent).toHaveLength(1);
  expect(num()).toBe(String(start));
  expect(card().textContent).toContain('Didn’t work');
});

it('a press during a drag and a drag after a press end with ONE agreed number and no duplicate send', async () => {
  const r = recorder();
  await mount({ fetchHook: r.hook });
  const start = Number(num());
  const h = q(`#rooms [data-eid="${ID}"] [data-th-h="set"]`);
  pointer(h, 'pointerdown');
  h.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); // a drag step (start + 1)
  press(1); // a press while holding (start + 2)
  pointer(document, 'pointerup');
  await tick(1500);
  expect(num()).toBe(String(start + 2));
  const vals = r.sent.map((s) => s.temperature);
  expect(vals.at(-1)).toBe(start + 2);
  vals.forEach((v, i) => { if (i) expect(v).not.toBe(vals[i - 1]); });
  void qa;
});

it('an echo of an OLDER value that lands while the newest is held does not change the number', async () => {
  fakeHomeAssistantNestLag([5000]); // the newest value is still unconfirmed
  const r = recorder();
  await mount({ fetchHook: r.hook });
  const start = Number(num());
  press(1); press(1); press(1);
  await tick(900);
  fakeHomeAssistantSet(ID, { target: start + 1 }); // Google confirms an earlier value late
  await tick(300);
  expect(num()).toBe(String(start + 3));
  await tick(5000); // the real confirmation: released

  expect(num()).toBe(String(start + 3));
});
