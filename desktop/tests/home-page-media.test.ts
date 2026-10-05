// @vitest-environment jsdom
// The Media tab (Destin, 2026-10-05, round 2 "option A" + his changes): playing devices are wide cards titled by the DEVICE name,
// everything else is a small tile on a "Not Playing" shelf (order playing, paused, idle, off, not responding); the play/pause/skip
// keys sit at the right end of the now-playing box so the volume sliders run full width; a TV and its soundbar are ONE card whose
// slider sits in a glass box titled with the soundbar's name; speakers playing together are one card with a Playing together box and
// one bar each, and the old "Playing with..." bar is gone (adding/removing speakers is a button in the box header).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, frame, tick, push, pointer } from './home-page-harness';
import { fakeHomeAssistantCalls, fakeHomeAssistantSet } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

afterEach(() => { unmount(); vi.useRealTimers(); });
const TV = 'media_player.destins_room_google_tv';
const BAR = 'media_player.destins_room';
const LR = 'media_player.living_room_speaker';
const ROAM = 'media_player.roam_2';
const DATA = { view: 'media' };
const text = (e: Element | null) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
const wideNames = () => qa('.mv-wide .mv-name').map(text);
const shelfNames = () => qa('.mv-shelf .mv-name').map(text);
const card = (id: string) => q(`[data-eid="${id}"]`);
// Two speakers playing one song as a group (the pretend house has none by default). Both can group, like real Sonos speakers.
const GROUPING = 524288;
const together = () => {
  const song = { state: 'playing', title: 'Weightless', app: 'Spotify', group: [LR, ROAM] };
  fakeHomeAssistantSet(LR, { ...song, features: 4 | 8 | 1 | 16 | 32 | GROUPING });
  fakeHomeAssistantSet(ROAM, song);
};

describe('the Media tab: order and layout', () => {
  it('playing and paused devices are wide cards (playing first), the rest a Not Playing shelf: idle, off, not responding last and dimmed', async () => {
    await mount({ data: DATA });
    expect(wideNames()).toEqual(['Destin\'s Room TV', 'Living Room speaker']); // the TV is playing, the speaker is paused
    expect(card(TV).classList.contains('st-playing')).toBe(true);
    expect(card(LR).classList.contains('st-paused')).toBe(true);
    expect(shelfNames()).toEqual(['Roam 2', 'Destin\'s Samsung TV', 'Move 2']); // idle, off, not responding
    expect(card('media_player.move_2').classList.contains('st-gone')).toBe(true);
    expect(text(q('.mv-shelfh'))).toContain('Not Playing');
  });

  it('the device name is the title and the room is the small line (only when the name does not already say it)', async () => {
    await mount({ data: DATA });
    expect(text(card(TV).querySelector('.mv-name'))).toBe('Destin\'s Room TV');
    expect(card(TV).querySelector('.mv-room')).toBeNull(); // the name says the room already
    expect(text(card('media_player.roam_2').querySelector('.mv-room'))).toBe('Destin\'s Bathroom');
    expect(text(card(LR).querySelector('.mv-song'))).toBe('Clair de Lune — Debussy'); // the song is the quiet line
  });

  it('the keys sit at the right end of the now-playing box; the volume sliders are outside it, full width', async () => {
    await mount({ data: DATA });
    const c = card(LR), np = c.querySelector('.mv-np')!;
    expect(np.querySelector('.mv-nprow > .np-keys')).toBeTruthy();
    expect(Array.from(np.querySelectorAll('.np-keys .key')).map((k) => k.getAttribute('aria-label'))).toEqual(['Previous', 'Resume', 'Next']);
    expect(np.querySelector('.vrow, .vlr')).toBeNull(); // no slider inside the box
    const vol = c.querySelector('.vrow')!;
    expect(vol.parentElement).toBe(c); // a direct child of the card: the card's full width
    expect(np.compareDocumentPosition(vol) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a TV with a remote is a wide card even with nothing playing; a TV that is off is a tile with a Turn on button', async () => {
    const m = await mount({ data: DATA });
    push(m.socks[0], TV, { s: 'idle', a: { media_title: null } }); await frame();
    expect(card(TV).classList.contains('mv-wide')).toBe(true);
    expect(card(TV).classList.contains('st-on')).toBe(true);
    expect(card(TV).querySelector('.mv-b .eq')).toBeNull(); // "On" claims nothing is playing: no moving bars
    expect(card('media_player.destins_room_tv').classList.contains('mv-sq')).toBe(true);
    expect(card('media_player.destins_room_tv').querySelector('.mv-act')!.getAttribute('data-toggle')).toBe('media_player.destins_room_tv');
  });
});

describe('a TV and its soundbar are one card', () => {
  it('one card for the pair: the soundbar has no card of its own, and its slider sits in a glass box titled with its name', async () => {
    await mount({ data: DATA });
    expect(qa(`[data-eid="${BAR}"]`)).toHaveLength(0);
    const box = card(TV).querySelector('.mv-tog')!;
    expect(text(box.querySelector('.mv-togh'))).toBe('Destin\'s Room'); // the soundbar's real name
    expect(box.querySelectorAll(`.vlr[data-vol="${BAR}"]`)).toHaveLength(1);
    expect(qa(`[data-vol="${BAR}"]`)).toHaveLength(1); // not drawn twice on the page
  });

  it('moving that slider uses the soundbar and goes through the target model (sent once on release, shown at once)', async () => {
    await mount({ data: DATA });
    const el = q(`[data-vol="${BAR}"]`) as HTMLInputElement;
    el.focus(); pointer(el, 'pointerdown');
    el.value = '60'; el.dispatchEvent(new Event('input', { bubbles: true })); await tick(20);
    el.dispatchEvent(new Event('change', { bubbles: true })); pointer(document, 'pointerup');
    await tick(100);
    const sets = fakeHomeAssistantCalls().filter((c) => c.service === 'volume_set');
    expect(sets.at(-1)!.data).toMatchObject({ entity_id: BAR, volume_level: 0.6 });
    expect(Number((q(`[data-vol="${BAR}"]`) as HTMLInputElement).value)).toBe(60); // holds where it was released
    await tick(5000);
    expect(Number((q(`[data-vol="${BAR}"]`) as HTMLInputElement).value)).toBe(60); // and the house agrees
  });

  it('the remote opens inside the same card: pad above the soundbar box, in the now-playing box', async () => {
    await mount({ data: { view: 'media', remote: ['remote.destins_room_tv_remote'] } });
    const c = card(TV), np = c.querySelector('.mv-np')!, pad = np.querySelector('.rpad')!;
    expect(pad.getAttribute('data-open')).toBe('1');
    expect(np.querySelector('.rchips')).toBeTruthy();
    expect(np.querySelector('.np-keys')!.getAttribute('data-open')).toBe('1');
    expect(pad.compareDocumentPosition(c.querySelector('.mv-tog')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('speakers playing together', () => {
  it('are one card with a Playing together box and one volume bar each; no "Playing with..." bar', async () => {
    await mount({ data: DATA });
    together();
    await tick(1500);
    expect(qa(`[data-eid="${LR}"]`)).toHaveLength(1);
    expect(qa(`[data-eid="${ROAM}"]`)).toHaveLength(0);
    expect(text(card(LR).querySelector('.mv-name'))).toBe('Living Room speaker + Roam 2');
    const box = card(LR).querySelector('.mv-tog')!;
    expect(text(box.querySelector('.mv-togh'))).toContain('Playing together');
    expect(Array.from(box.querySelectorAll('.vlr')).map((e) => e.getAttribute('data-vol'))).toEqual([LR, ROAM]);
    expect(card(LR).querySelector('.gcard, .rlbl')).toBeNull();
  });

  it('adding or removing speakers is still possible: the box header has a button that opens the tick list', async () => {
    await mount({ data: DATA });
    together();
    await tick(1500);
    const btn = card(LR).querySelector<HTMLElement>('.mv-togh [data-group]')!;
    expect(btn).toBeTruthy();
    expect(card(LR).querySelector('.glist')).toBeNull();
    btn.click(); await frame();
    expect(card(LR).querySelector('.glist')).toBeTruthy();
    const roam = card(LR).querySelector<HTMLElement>(`[data-member="${ROAM}"]`)!;
    expect(roam.getAttribute('aria-pressed')).toBe('true');
    roam.click(); await tick(1500); // untick: Roam 2 leaves
    expect(fakeHomeAssistantCalls().some((c) => c.service === 'unjoin' && c.data.entity_id === ROAM)).toBe(true);
    expect(qa(`[data-eid="${ROAM}"]`)).toHaveLength(1); // on its own again: back on the shelf
    expect(card(ROAM).classList.contains('mv-sq')).toBe(true);
  });

  it('a speaker playing alone can still start a group from a button under its volume', async () => {
    await mount({ data: DATA });
    fakeHomeAssistantSet(ROAM, { state: 'playing', title: 'Song', app: 'Spotify' });
    await tick(1500);
    const btn = card(ROAM).querySelector<HTMLElement>('[data-group]')!;
    expect(btn).toBeTruthy();
    btn.click(); await frame();
    expect(card(ROAM).querySelector('.glist .gitem')).toBeTruthy();
  });
});

describe('the neutral play/pause rule still holds on the Media tab', () => {
  it('a TV app that reports no play state keeps the one neutral key and no moving bars', async () => {
    const m = await mount({ data: DATA });
    push(m.socks[0], TV, { a: { media_title: null } }); await frame();
    expect(card(TV).querySelector('.np-keys .main')!.innerHTML).toContain('M2 5v14l9-7z');
    expect(card(TV).querySelector('.mv-b .eq')).toBeNull();
    expect(text(card(TV).querySelector('.mv-b'))).toBe('On');
  });
});
