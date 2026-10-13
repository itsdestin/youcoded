// @vitest-environment jsdom
// The Computer card (Destin, 2026-10-05: "lets pull the pc in"): a ping sensor and a wake-on-LAN button, two unlinked things in
// Home Assistant, shown as ONE card in their room. Status follows the sensor, Wake shows only while it is off, one press sends one
// signal, and a computer that never answers says "Didn't wake" after about 3 minutes. Runs the real page against the pretend house.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, tick, frame } from './home-page-harness';
import { ROOMS_TEMPLATE } from '../src/renderer/dev/workbench/fixtures/home-assistant-page-templates';
import { fakeHomeAssistantCalls, fakeHomeAssistantPcNeverWakes, fakeHomeAssistantRemove, fakeHomeAssistantSet } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

afterEach(() => { unmount(); vi.useRealTimers(); });
const SENSOR = 'binary_sensor.desktop_pc';
const BUTTON = 'button.wake_desktop_pc';
const HOME = { startOpen: ['destins_room'] };
const card = () => q(`[data-eid="${SENSOR}"]`);
const status = () => card().querySelector('.sub')?.textContent ?? '';
const wake = () => card().querySelector<HTMLElement>('[data-wake]');
const presses = () => fakeHomeAssistantCalls().filter((c) => c.domain === 'button' && c.service === 'press');

describe('the Computer card', () => {
  it('shows the sensor and the button as ONE card in their room', async () => {
    await mount({ data: HOME });
    expect(qa(`[data-eid="${SENSOR}"]`)).toHaveLength(1);
    expect(qa(`[data-eid="${BUTTON}"]`)).toHaveLength(0); // the button is folded into the sensor's card
    expect(card().closest('.room')!.querySelector('h2')!.textContent).toBe("Destin's Room");
    expect(card().querySelector('.mname')!.textContent).toBe('Desktop PC');
    expect(card().querySelector('.kind')!.textContent).toBe('Computer');
    expect(status()).toBe('Off');
  });

  it('is not on the Lights, Media or Climate tabs', async () => {
    await mount({ data: HOME });
    for (const view of ['lights', 'media', 'climate']) {
      q(`[data-view="${view}"]`).click(); await frame();
      expect(q('#view').textContent!.length).toBeGreaterThan(20); // the tab really is showing
      expect(document.body.innerHTML).not.toContain(SENSOR);
      expect(document.body.innerHTML).not.toContain(BUTTON);
    }
  });

  it('status follows the sensor, and Wake shows only while the computer is off', async () => {
    await mount({ data: HOME });
    expect(wake()).not.toBeNull();
    fakeHomeAssistantSet(SENSOR, { state: 'on' });
    await frame();
    expect(status()).toBe('On');
    expect(wake()).toBeNull();
    fakeHomeAssistantSet(SENSOR, { state: 'off' });
    await frame();
    expect(status()).toBe('Off');
    expect(wake()).not.toBeNull();
  });

  it('one press sends one signal, says Waking…, and ignores a second press while it waits', async () => {
    await mount({ data: HOME });
    const btn = wake()!;
    btn.click();
    btn.click(); // a second tap on the same button, before the card has redrawn
    await frame();
    expect(presses()).toHaveLength(1);
    expect(presses()[0].data).toEqual({ entity_id: BUTTON });
    expect(status()).toBe('Waking…');
    expect(wake()).toBeNull();
    // the computer answers ping a few seconds later: On, no Wake, still one press
    await tick(6000);
    expect(status()).toBe('On');
    expect(wake()).toBeNull();
    expect(presses()).toHaveLength(1);
  });

  it('says "Didn\'t wake" after about 3 minutes, and Wake is there to try again', async () => {
    fakeHomeAssistantPcNeverWakes(true);
    await mount({ data: HOME });
    wake()!.click();
    await tick(1000);
    expect(status()).toBe('Waking…');
    await tick(170_000);
    expect(status()).toBe('Waking…'); // not yet: under 3 minutes
    await tick(15_000);
    expect(status()).toContain('Didn’t wake');
    expect(card().querySelector('.pc-fail')).not.toBeNull();
    expect(wake()).not.toBeNull();
    wake()!.click();
    await tick(500);
    expect(presses()).toHaveLength(2);
    expect(status()).toBe('Waking…');
  });

  it('a refused press is not "Waking": the page says it did not work and Wake comes back', async () => {
    await mount({ data: HOME, fetchHook: (req) => (req.url.endsWith('/api/services/button/press') ? { ok: true, status: 500, headers: {}, body: '' } : undefined) });
    wake()!.click();
    await tick(1000);
    expect(status()).toBe('Off');
    expect(wake()).not.toBeNull();
    expect(card().querySelector('.pend[data-pend="failed"]')).not.toBeNull();
    expect(card().querySelector('[data-pend-retry]')).toBeNull(); // the card's own Wake is the retry
  });

  it('a sensor with no wake button is status-only', async () => {
    fakeHomeAssistantRemove(BUTTON);
    await mount({ data: HOME });
    expect(status()).toBe('Off');
    expect(wake()).toBeNull();
  });

  it('a wake button with no sensor is a Wake-only card, and a press sends one signal', async () => {
    fakeHomeAssistantRemove(SENSOR);
    await mount({ data: HOME });
    const c = q(`[data-eid="${BUTTON}"]`);
    expect(c.querySelector('.mname')!.textContent).toBe('Wake Desktop PC');
    const w = c.querySelector<HTMLElement>('[data-wake]')!;
    w.click(); w.click();
    await frame();
    expect(presses()).toHaveLength(1);
    expect(q(`[data-eid="${BUTTON}"]`).querySelector('[data-wake]')).toBeNull();
  });

  it('a button whose name does not contain the sensor name is not paired with it', async () => {
    fakeHomeAssistantSet(BUTTON, { name: 'Wake Laptop' });
    await mount({ data: HOME });
    expect(wake()).toBeNull(); // the sensor card has no Wake
    expect(q(`[data-eid="${BUTTON}"] [data-wake]`)).not.toBeNull(); // and the button stands alone
  });

  it('is in Edit as ONE row that can be favorited, and Edit calls it a Computer', async () => {
    await mount({ data: { ...HOME, editing: true } });
    const rows = qa(`.edc-row[data-edid="${SENSOR}"]`);
    expect(rows).toHaveLength(1);
    expect(qa(`.edc-row[data-edid="${BUTTON}"]`)).toHaveLength(0);
    expect(rows[0].querySelector('.edc-k')!.textContent).toBe('Computer');
    rows[0].querySelector<HTMLElement>('[data-act="fav"]')!.click();
    await frame();
    expect(q(`.edc-row[data-edid="${SENSOR}"][data-edkey="fav"]`)).not.toBeNull();
  });

  it('a never-pressed button and a switched-off computer are not "problems"; an unreachable sensor is', async () => {
    fakeHomeAssistantSet(BUTTON, { state: 'unknown' });
    await mount({ data: HOME });
    q('[data-view="problems"]').click(); await frame();
    expect(document.body.innerHTML).not.toContain('Desktop PC');
    expect(document.body.innerHTML).not.toContain('Wake Desktop PC');
    unmount(); vi.useRealTimers();
    fakeHomeAssistantSet(SENSOR, { state: 'unavailable' });
    await mount({ data: HOME });
    q('[data-view="problems"]').click(); await frame();
    expect(document.body.innerHTML).toContain('Desktop PC is not responding');
  });

  it('updates over the live connection, with no new template request', async () => {
    let roomsAsked = 0;
    const m = await mount({ data: HOME, fetchHook: (req) => { if (req.url.endsWith('/api/template') && String(req.body).includes('namespace(rooms=[])')) roomsAsked++; return undefined; } });
    expect(m.socks.length).toBeGreaterThan(0);
    const before = roomsAsked;
    fakeHomeAssistantSet(SENSOR, { state: 'on' });
    await frame();
    expect(status()).toBe('On');
    expect(roomsAsked).toBe(before);
  });
});

describe('the rooms template', () => {
  it('takes only ping sensors and wake-on-LAN buttons, by integration, and sends only strings', () => {
    expect(ROOMS_TEMPLATE).toContain("integration_entities('ping')");
    expect(ROOMS_TEMPLATE).toContain("integration_entities('wake_on_lan')");
    expect(ROOMS_TEMPLATE).toContain("d in ['button','binary_sensor'] and e in pcs");
    // the new branch must not put a set or a date into the answer: every value is a string, a state attribute or none
    const branch = ROOMS_TEMPLATE.slice(ROOMS_TEMPLATE.indexOf("d in ['button','binary_sensor']"), ROOMS_TEMPLATE.indexOf("{%- endfor -%}\n{%- if ens.items"));
    expect(branch.match(/\| ?list/g)).toHaveLength(1); // the one guarded config-entry lookup, as the other kinds use
    expect(branch).toContain('if ce else none');
    expect(branch).toContain('.isoformat()');
  });
});
