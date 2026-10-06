// @vitest-environment jsdom
// Basic controls for players with NO paired remote (Destin, 2026-10-05): one capability-driven rule. A card shows exactly what the device
// says it can do right now (supported_features): play/pause, stop, back/forward 10 s, previous/next, a volume bar (else - / +), mute,
// power and an input picker; a Google TV with no remote gets one quiet hint. The paired-remote TV and the neutral play/pause rule stay.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, frame, tick } from './home-page-harness';
import { fakeHomeAssistantCalls, fakeHomeAssistantSet } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

afterEach(() => { unmount(); vi.useRealTimers(); });
const CAST = 'media_player.media_room_tv'; // Cast TV, no remote: pause volume_set mute turn_on turn_off stop play
const NOVOL = 'media_player.grandmas_room_tv'; // Cast TV with no volume and no mute
const DLNA = 'media_player.family_room_samsung_tv'; // Samsung-style: seek volume mute prev next source stop, no power
const ATV = 'media_player.guest_room_streamer'; // Android TV player: volume steps only
const PAIRED = 'media_player.destins_room_google_tv';
const HOME = { startOpen: ['media_room', 'grandmas_room', 'family_room', 'guest_room', 'destins_room'] };
const PAGES = ['home', 'media'] as const;
const dataFor = (page: (typeof PAGES)[number]) => (page === 'home' ? HOME : { view: 'media' });
const card = (id: string) => q(`[data-eid="${id}"]`);
const labels = (id: string) => Array.from(card(id).querySelectorAll('.np-keys .key')).map((k) => k.getAttribute('aria-label'));
const has = (id: string, sel: string) => card(id).querySelector(sel) !== null;
const calls = (service: string) => fakeHomeAssistantCalls().filter((c) => c.service === service);
const NOTE = "Pair this TV's remote in Home Assistant for the arrow pad and apps.";
const playing = (id: string, extra: Record<string, unknown> = {}) => fakeHomeAssistantSet(id, { state: 'playing', title: 'A show', ...extra });
const BITS = { pause: 1, seek: 2, vol: 4, mute: 8, prev: 16, next: 32, on: 128, off: 256, source: 2048, step: 1024, stop: 4096, play: 16384 };

for (const page of PAGES) describe(`basic controls on the ${page === 'home' ? 'Home' : 'Media'} tab`, () => {
  it('each capability shows only when its feature bit is set (idle Cast TV: volume, mute, power; no keys for nothing playing)', async () => {
    await mount({ data: dataFor(page) });
    const c = card(CAST);
    expect(has(CAST, '[data-vol]')).toBe(true); // volume_set -> a bar
    expect(has(CAST, '[data-svc="volume_mute"]')).toBe(true);
    expect(has(CAST, `[data-toggle="${CAST}"]`)).toBe(true);
    expect(has(CAST, '[data-svc="media_stop"]')).toBe(false); // nothing is playing, so nothing to stop
    expect(c.querySelector('.key.main')?.getAttribute('data-svc') ?? 'media_play').toBe('media_play'); // an idle play key plays, it never guesses
    // No volume bit: no bar, no steps, no mute; power stays.
    expect(has(NOVOL, '[data-vol]') || has(NOVOL, '[data-svc="volume_up"]') || has(NOVOL, '[data-svc="volume_mute"]')).toBe(false);
    expect(has(NOVOL, `[data-toggle="${NOVOL}"]`)).toBe(true);
    // Samsung-style: no power bits, so no power button; input picker and a bar.
    expect(has(DLNA, '[data-toggle]')).toBe(false);
    expect(has(DLNA, 'select[data-source]')).toBe(true);
    expect(has(DLNA, '[data-vol]')).toBe(true);
  });

  it('a playing app adds stop, previous, next; the features are read again on every draw (seek appears only with a known position)', async () => {
    const m = await mount({ data: dataFor(page) });
    playing(CAST, { features: BITS.pause | BITS.vol | BITS.mute | BITS.stop | BITS.play | BITS.prev | BITS.next | BITS.on | BITS.off });
    await tick(6000);
    expect(labels(CAST)).toEqual(['Previous', 'Pause', 'Next', 'Stop']);
    // seek bit without a position: still no 10 s buttons (a seek is "go to second N")
    fakeHomeAssistantSet(CAST, { features: BITS.pause | BITS.seek | BITS.stop | BITS.play });
    await tick(6000);
    expect(labels(CAST)).toEqual(['Pause', 'Stop']);
    fakeHomeAssistantSet(CAST, { pos: 100, posAt: new Date().toISOString() });
    await tick(6000);
    expect(labels(CAST)).toEqual(['Back 10 seconds', 'Pause', 'Forward 10 seconds', 'Stop']);
    void m;
  });

  it('every key calls the right service with the right data', async () => {
    await mount({ data: dataFor(page) });
    playing(CAST, { features: BITS.pause | BITS.seek | BITS.stop | BITS.play | BITS.prev | BITS.next | BITS.vol | BITS.mute | BITS.on | BITS.off, pos: 100, posAt: new Date().toISOString(), vol: 0.3 });
    await tick(6000);
    const press = async (label: string) => { card(CAST).querySelector<HTMLElement>(`.np-keys [aria-label="${label}"]`)!.click(); await tick(500); };
    await press('Pause');
    expect(calls('media_play_pause').pop()?.data).toEqual({ entity_id: CAST });
    await press('Previous'); expect(calls('media_previous_track').pop()?.data).toEqual({ entity_id: CAST });
    await press('Next'); expect(calls('media_next_track').pop()?.data).toEqual({ entity_id: CAST });
    await press('Forward 10 seconds');
    const seek = calls('media_seek').pop()!.data as { entity_id: string; seek_position: number };
    expect(seek.entity_id).toBe(CAST); expect(seek.seek_position).toBeGreaterThanOrEqual(110); expect(seek.seek_position).toBeLessThan(112);
    await press('Stop'); expect(calls('media_stop').pop()?.data).toEqual({ entity_id: CAST });
    // mute, power, volume
    card(CAST).querySelector<HTMLElement>('[data-svc="volume_mute"]')!.click(); await tick(500);
    expect(calls('volume_mute').pop()?.data).toEqual({ entity_id: CAST, is_volume_muted: true });
    const bar = card(CAST).querySelector<HTMLInputElement>('input[data-vol]')!;
    bar.value = '60'; bar.dispatchEvent(new Event('input', { bubbles: true })); bar.dispatchEvent(new Event('change', { bubbles: true })); await tick(1000);
    expect((calls('volume_set').pop()?.data as { volume_level: number }).volume_level).toBe(0.6);
    card(CAST).querySelector<HTMLElement>(`[data-toggle="${CAST}"]`)!.click(); await tick(500);
    expect(calls('turn_off').pop()?.data).toEqual({ entity_id: CAST });
  });

  it('an idle play key sends media_play and the card never claims "playing" before the house says so', async () => {
    await mount({ data: dataFor(page) });
    fakeHomeAssistantSet(CAST, { state: 'idle' });
    await tick(6000);
    const play = card(CAST).querySelector<HTMLElement>('.key.main');
    // (shown only while something plays or the TV is a TV: an idle TV offers play when it can)
    expect(play?.getAttribute('data-svc')).toBe('media_play');
    play!.click(); await frame();
    expect(card(CAST).textContent).not.toMatch(/Now playing/);
  });

  it('volume steps only (Android TV box): - / + that step it, no bar; its controls come with power', async () => {
    await mount({ data: dataFor(page) });
    expect(has(ATV, '[data-vol]')).toBe(false);
    card(ATV).querySelector<HTMLElement>('[data-svc="volume_up"]')!.click(); await tick(500);
    expect(calls('volume_up').pop()?.data).toEqual({ entity_id: ATV });
    card(ATV).querySelector<HTMLElement>('[data-svc="volume_down"]')!.click(); await tick(500);
    expect(calls('volume_down').pop()?.data).toEqual({ entity_id: ATV });
    expect(has(ATV, '[data-svc="volume_mute"]')).toBe(true);
    expect(has(ATV, `[data-toggle="${ATV}"]`)).toBe(true);
  });

  it('the input picker lists the device sources and selects one', async () => {
    await mount({ data: dataFor(page) });
    const sel = card(DLNA).querySelector<HTMLSelectElement>('select[data-source]')!;
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['TV', 'HDMI 1', 'HDMI 2', 'HDMI 3']);
    expect(sel.value).toBe('HDMI 1');
    sel.value = 'HDMI 2'; sel.dispatchEvent(new Event('change', { bubbles: true })); await tick(500);
    expect(calls('select_source').pop()?.data).toEqual({ entity_id: DLNA, source: 'HDMI 2' });
  });

  it('the pairing hint shows on a Cast / Google TV with no remote, never on a Samsung, an Android TV box or a TV that has its remote', async () => {
    await mount({ data: dataFor(page) });
    expect(card(CAST).textContent).toContain(NOTE);
    expect(card(NOVOL).textContent).toContain(NOTE); // a Google TV Streamer seen only through Cast, like Grandma's Room TV
    expect(card(DLNA).textContent).not.toContain('Pair this TV');
    expect(card(ATV).textContent).not.toContain('Pair this TV');
    expect(card(PAIRED).textContent).not.toContain('Pair this TV');
  });

  it('a plain Chromecast (no Android TV inside) never gets the pairing hint: it can never be paired', async () => {
    fakeHomeAssistantSet(CAST, { model: 'Chromecast' });
    await mount({ data: dataFor(page) });
    expect(card(CAST).textContent).not.toContain('Pair this TV');
  });

  it('a Cast-only TV that Home Assistant calls off says "Nothing casting", not "Off" (its screen may be on and playing)', async () => {
    // WHY (2026-10-05): "i know the living room tv is on and playing rn, but the media tab is showing it as off" — Cast only
    // knows what is cast to it; a TV's own app or an HDMI input reads as off.
    fakeHomeAssistantSet(CAST, { state: 'off' });
    fakeHomeAssistantSet(PAIRED, { state: 'off' });
    await mount({ data: dataFor(page) });
    expect(card(CAST).textContent).toContain('Nothing casting');
    expect(card(CAST).textContent).not.toMatch(/\bOff\b/);
    // a TV with its remote paired knows its real power: it still says Off
    expect(card(PAIRED).textContent).not.toContain('Nothing casting');
  });

  it('the paired-remote TV is unchanged: its seven remote keys, no Stop, no input picker', async () => {
    await mount({ data: dataFor(page) });
    expect(labels(PAIRED)).toEqual(['Back', 'Previous', 'Back 10 seconds', 'Play or pause', 'Forward 10 seconds', 'Next', 'Home']);
    expect(has(PAIRED, 'select[data-source]')).toBe(false);
    expect(has(PAIRED, '[data-svc="media_stop"]')).toBe(false);
  });

  it('keeps the neutral play/pause rule for an app that never reports it (one key, a press changes nothing by itself)', async () => {
    // A Netflix-style app: the house takes the press and reports no change, so the card must not invent one.
    const sent: string[] = [];
    await mount({ data: dataFor(page), fetchHook: (req) => { if (req.url.includes('media_play_pause')) { sent.push(req.body ?? ''); return { ok: true, status: 200, headers: {}, body: '[]' }; } return undefined; } });
    playing(CAST, { title: null, features: BITS.pause | BITS.stop | BITS.play | BITS.vol });
    await tick(6000);
    const k = card(CAST).querySelector<HTMLElement>('.key.main')!;
    expect(k.getAttribute('aria-label')).toBe('Play or pause');
    expect(k.innerHTML).toContain('M2 5v14l9-7z');
    expect(k.getAttribute('data-neutral')).toBe('1'); // tells the press handler to send no guess
    k.click(); await tick(1000);
    expect(card(CAST).querySelector('.key.main')!.getAttribute('aria-label')).toBe('Play or pause'); // not "Resume"/"Play": the page made no guess
    expect(card(CAST).textContent).not.toMatch(/Paused|Now playing/);
    expect(JSON.parse(sent[0])).toEqual({ entity_id: CAST });
  });

  it('a device that is not responding gets nothing new', async () => {
    await mount({ data: dataFor(page) });
    fakeHomeAssistantSet(DLNA, { state: 'unavailable', features: 0 });
    await tick(6000);
    expect(has(DLNA, 'select[data-source]') || has(DLNA, '.key') || has(DLNA, '[data-vol]') || has(DLNA, '.bc-note')).toBe(false);
    expect(qa(`[data-eid="${DLNA}"]`).length).toBe(1);
  });
});

describe('basic controls: where they leave things alone', () => {
  it('Sonos-style speakers keep their keys, with no input picker', async () => {
    await mount({ data: { startOpen: ['living_room'] } });
    fakeHomeAssistantSet('media_player.living_room_speaker', { state: 'playing', sources: ['Favourite 1'], maker: 'Sonos', features: 4 | 8 | 1 | 16 | 32 | 2048 });
    await tick(6000);
    expect(labels('media_player.living_room_speaker')).toEqual(['Previous', 'Pause', 'Next']);
    expect(has('media_player.living_room_speaker', 'select[data-source]')).toBe(false);
  });
});
