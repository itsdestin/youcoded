// @vitest-environment jsdom
// Redesign audit F1/F2/F3 (A-1 "change only what changed", A-2 "one drawing per
// moment"): a change in the house updates the cards that changed IN PLACE, so
// what you are holding, typing in, or focused on is never thrown away; a quiet
// house does not touch the page at all, even with a camera picture refreshing.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, flush, frame, tick, house, flip, noCameraPicture } from './home-page-harness';

afterEach(() => { unmount(); vi.useRealTimers(); });
const lampCard = () => q('[data-eid="light.living_room_lamp"]');
const input = (el: HTMLElement, type = 'input') => el.dispatchEvent(new Event(type, { bubbles: true }));

describe('Home page draws changes in place', () => {
  it('keeps the same card, and keyboard focus on its switch, when it is pressed', async () => {
    await mount({ fetchHook: noCameraPicture });
    const card = q('[data-eid="light.living_room_ceiling"]');
    const sw = card.querySelector<HTMLElement>('[data-toggle]')!;
    sw.focus(); sw.click(); await tick(1000);
    expect(document.contains(card)).toBe(true);
    expect(document.activeElement).toBe(sw);
    expect(sw.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps every card when another light changes in the house', async () => {
    await mount({ fetchHook: noCameraPicture });
    const card = lampCard(), other = q('[data-eid="light.living_room_ceiling"]');
    const before = other.querySelector('[data-toggle]')!.getAttribute('aria-pressed');
    flip('light.living_room_ceiling'); await frame();
    expect(other.querySelector('[data-toggle]')!.getAttribute('aria-pressed')).toBe(String(before === 'false'));
    expect(document.contains(card)).toBe(true);
    expect(document.contains(other)).toBe(true);
  });

  it('does not touch the page for a whole minute in a quiet house with a camera picture', async () => {
    let n = 0;
    await mount({ live: false, fetchHook: (req) => {
      if (req.url.endsWith('/api/camera_proxy/camera.living_room_camera')) { n++; return { ok: true, status: 200, headers: {}, body: 'data:image/png;base64,' + String(n % 10).repeat(7000) }; }
    } });
    expect(document.querySelector('img.cam')).toBeTruthy();
    const card = lampCard();
    let structural = 0;
    const obs = new MutationObserver((ms) => ms.forEach((m) => { if (m.type === 'childList') structural++; }));
    obs.observe(q('#rooms'), { childList: true, subtree: true });
    for (let s = 0; s < 60; s++) await tick(1000);
    await flush();
    obs.disconnect();
    expect(document.contains(card)).toBe(true);
    expect(structural).toBe(0);
  });

  it('draws "All lights" once for the press, not once per light', async () => {
    const m = await mount({ data: { open: ['destins_room'] }, fetchHook: noCameraPicture });
    m.puts.length = 0;
    q('[data-room="destins_room"]').click();
    expect(m.puts.filter((p) => p === 'rooms')).toHaveLength(1);
  });

  it('keeps a name being typed in Edit, and does not re-select it, when anything redraws', async () => {
    await mount({ data: { open: ['living_room'], editing: true }, fetchHook: noCameraPicture });
    q('[data-eid="light.living_room_lamp"] [data-act="rename"]').click();
    const box = () => document.querySelector<HTMLInputElement>('[data-rn]')!;
    box().value = 'Reading lamp'; box().setSelectionRange(12, 12);
    flip('light.kitchen_pendants');
    await frame();
    await tick(61_000); // the once-a-minute check
    expect(box().value).toBe('Reading lamp');
    expect(box().selectionStart).toBe(12);
    expect(document.activeElement).toBe(box());
  });

  it('keeps a slider you have grabbed when something else changes, and through the minute check', async () => {
    await mount({ fetchHook: noCameraPicture });
    const el = q('[data-vol="media_player.living_room_speaker"]') as HTMLInputElement;
    el.focus(); // finger down, not moved yet
    flip('light.under_cabinet');
    await frame();
    expect(document.contains(el)).toBe(true);
    el.value = '55'; input(el); // now moving
    await tick(61_000);
    expect(document.contains(el)).toBe(true);
    expect(el.value).toBe('55');
  });

  it('shows what changed while you dragged as soon as you let go', async () => {
    await mount({ fetchHook: noCameraPicture });
    const el = q('[data-vol="media_player.living_room_speaker"]') as HTMLInputElement;
    const lampOn = () => lampCard().querySelector('[data-toggle]')!.getAttribute('aria-pressed') === 'true';
    const want = !lampOn();
    input(el); // grabbed and put back where it was: the speaker has nothing new to say
    flip('light.living_room_lamp'); await frame();
    el.dispatchEvent(new Event('change', { bubbles: true })); document.dispatchEvent(new Event('pointerup'));
    await tick(1000);
    expect(lampOn()).toBe(want);
  });

  it('corrects a slider the speaker did not take', async () => {
    let fail = true;
    await mount({ fetchHook: (req) => { noCameraPicture(req); if (fail && req.url.includes('/volume_set')) return { ok: false, status: 500, headers: {}, body: '' }; } });
    const id = 'media_player.living_room_speaker';
    const el = () => q(`[data-vol="${id}"]`) as HTMLInputElement;
    const start = el().value;
    el().value = '85'; input(el()); input(el(), 'change'); document.dispatchEvent(new Event('pointerup'));
    await tick(40_000); // inside the 60-second live checking gap: nothing else redraws the area
    expect(el().value).toBe(start);
    fail = false;
  });
});
