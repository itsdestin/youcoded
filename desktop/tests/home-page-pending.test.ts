// @vitest-environment jsdom
// Redesign audit F5/F6/F7 (A-4 "show sending, done, failed", A-6 "one list of
// pending changes"): a press the house does not take is undone at once and says
// so on its own card until dismissed; a slow press says "Sending…" and then
// "Done"; speaker ticks and new names are held like switches are.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, flush, frame, tick, push, noCameraPicture } from './home-page-harness';

afterEach(() => { unmount(); vi.useRealTimers(); });
const card = (id: string) => q(`[data-eid="${id}"]`);
const sw = (id: string) => card(id).querySelector('[data-toggle]')!.getAttribute('aria-pressed') === 'true';
const note = (id: string) => card(id).querySelector<HTMLElement>('.pend');
const OPEN = { open: ['kitchen', 'living_room', 'destins_room'] };
const refuse = (what: string) => (req: { url: string }) => { noCameraPicture(req); return req.url.includes(what) ? { ok: false, status: 500, headers: {}, body: '' } : undefined; };

describe('a press the house does not take', () => {
  it('goes back at once and says so on its card until dismissed', async () => {
    await mount({ data: OPEN, fetchHook: refuse('/services/light/') });
    const id = 'light.kitchen_pendants', before = sw(id);
    card(id).querySelector<HTMLElement>('[data-toggle]')!.click();
    expect(sw(id)).toBe(!before); // instant, as always
    await tick(600);
    expect(sw(id)).toBe(before); // not kept lying for 8 seconds
    expect(note(id)!.getAttribute('data-pend')).toBe('failed');
    expect(note(id)!.textContent).toContain('Didn\u2019t work');
    await tick(30_000); // checks come and go: the message stays
    expect(note(id)!.getAttribute('data-pend')).toBe('failed');
    card(id).querySelector<HTMLElement>('[data-pend-dismiss]')!.click();
    expect(note(id)).toBeNull();
  });

  it('is replaced by the next press on the same card', async () => {
    let fail = true;
    await mount({ data: OPEN, fetchHook: (req) => { noCameraPicture(req); return fail && req.url.includes('/services/light/') ? { ok: false, status: 500, headers: {}, body: '' } : undefined; } });
    const id = 'light.under_cabinet';
    card(id).querySelector<HTMLElement>('[data-toggle]')!.click(); await tick(600);
    expect(note(id)!.getAttribute('data-pend')).toBe('failed');
    fail = false;
    card(id).querySelector<HTMLElement>('[data-toggle]')!.click(); await tick(200);
    expect(note(id)?.getAttribute('data-pend') ?? null).not.toBe('failed');
  });

  it('sets a refused volume slider back and says so', async () => {
    await mount({ fetchHook: refuse('/volume_set') });
    const id = 'media_player.living_room_speaker';
    const el = () => q(`[data-vol="${id}"]`) as HTMLInputElement;
    const start = el().value;
    el().value = '85'; el().dispatchEvent(new Event('input', { bubbles: true })); el().dispatchEvent(new Event('change', { bubbles: true }));
    document.dispatchEvent(new Event('pointerup'));
    await tick(1000);
    expect(el().value).toBe(start);
    expect(note(id)!.getAttribute('data-pend')).toBe('failed');
  });
});

describe('a slow press', () => {
  it('stays quiet when fast, shows Sending… when it takes a while, then Done', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    await mount({ data: OPEN, fetchHook: async (req) => { noCameraPicture(req); if (req.url.includes('/services/light/')) await gate; return undefined; } });
    const id = 'light.kitchen_pendants';
    card(id).querySelector<HTMLElement>('[data-toggle]')!.click();
    await tick(100);
    expect(note(id)).toBeNull();
    await tick(600);
    expect(note(id)!.getAttribute('data-pend')).toBe('sending');
    expect(note(id)!.textContent).toContain('Sending');
    release(); await tick(100);
    expect(note(id)!.getAttribute('data-pend')).toBe('done');
    await tick(3000);
    expect(note(id)).toBeNull();
  });
});

describe('guesses held until the house agrees', () => {
  it('keeps a speaker tick while another update for that speaker lands', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const m = await mount({ fetchHook: async (req) => { noCameraPicture(req); if (req.url.includes('/services/media_player/join')) await gate; return undefined; } });
    const lead = 'media_player.destins_room', mem = 'media_player.roam_2';
    q(`[data-group="${lead}"]`).click();
    const tickOn = () => q(`[data-join="${lead}"][data-member="${mem}"]`).getAttribute('aria-pressed');
    q(`[data-join="${lead}"][data-member="${mem}"]`).click();
    expect(tickOn()).toBe('true');
    push(m.socks[0], lead, { a: { volume_level: 0.5 } }); await frame();
    expect(tickOn()).toBe('true');
    release(); await tick(1000);
    expect(tickOn()).toBe('true');
  });

  it('keeps a new name while another update still carrying the old name lands', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const m = await mount({ data: { open: ['living_room'], editing: true }, fetchHook: async (req) => { noCameraPicture(req); if (req.url.endsWith('/api/websocket') && String((req as any).socket?.send).includes('entity_registry/update')) await gate; return undefined; } });
    const id = 'light.living_room_lamp';
    card(id).querySelector<HTMLElement>('[data-act="rename"]')!.click();
    const box = document.querySelector<HTMLInputElement>('[data-rn]')!; box.value = 'Reading lamp';
    document.querySelector<HTMLElement>('[data-act="rename-save"]')!.click();
    expect(card(id).textContent).toContain('Reading lamp');
    push(m.socks[0], id, { a: { brightness: 100, friendly_name: 'Floor lamp' } }); await frame();
    expect(card(id).textContent).toContain('Reading lamp');
    release(); await tick(1000);
  });
});
