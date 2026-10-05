// @vitest-environment jsdom
// The TV card's remote (Destin, 2026-10-05, round 2b "option A"): a remote icon in the header (only while the TV is on)
// opens a round arrow pad INSIDE the now-playing panel; the transport row is previous / -10s / play / +10s / next closed and
// Back / previous / play / next / Home open; four app buttons show only while open, the app on the TV swapped for Prime Video;
// -10s / +10s use media_seek when the player can seek (and reports where it is), else the TV's own rewind / fast-forward keys.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, frame, tick, push, house } from './home-page-harness';
import { fakeHomeAssistantCalls, fakeHomeAssistantSet } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';

afterEach(() => { unmount(); vi.useRealTimers(); });
const TV = 'media_player.destins_room_google_tv';
const RC = 'remote.destins_room_tv_remote';
const card = () => q(`[data-eid="${TV}"]`);
const keys = () => card().querySelector<HTMLElement>('.np-keys')!;
const key = (label: string) => card().querySelector<HTMLButtonElement>(`.np-keys [aria-label="${label}"]`)!;
const remoteCalls = () => fakeHomeAssistantCalls().filter((c) => c.domain === 'remote' || c.service === 'media_seek');
const chipNames = () => qa(`[data-eid="${TV}"] .rapp`).map((b) => b.getAttribute('data-name'));
/** The pad, the volume row, the key row and the app buttons, in the order they sit in the panel. */
const panelOrder = () => Array.from(card().querySelectorAll('.np-ctl > *')).map((e) => e.getAttribute('data-slot') ?? (e.classList.contains('vrow') ? 'vol' : e.className));

describe('the TV card: remote icon, rows, reveal', () => {
  it('closed: the remote icon sits in the header beside power, the pad and Back/Home are drawn but shut', async () => {
    await mount({ data: { startOpen: ['destins_room'] } });
    const toggle = card().querySelector<HTMLElement>('.line .rtoggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.nextElementSibling?.getAttribute('data-toggle')).toBe(RC); // power is right beside it
    expect(keys().getAttribute('data-open')).toBe('0');
    expect(card().querySelector('.rpad')!.hasAttribute('inert')).toBe(true);
    expect(card().querySelector('.rpad')!.getAttribute('data-open')).toBe('0');
    // the old separate Remote row is gone
    expect(card().querySelector('.rcard, .rbtn, .remote')).toBeNull();
    // closed row: every key is in the page, in slot order; the open-only ones are marked to wait
    expect(Array.from(keys().children).map((k) => k.getAttribute('aria-label'))).toEqual(['Back', 'Previous', 'Back 10 seconds', 'Play or pause', 'Forward 10 seconds', 'Next', 'Home']);
  });

  it('pressing the icon opens it in place: same pad, same key row, only data-open changes (so the reveal is a transition, never a redraw)', async () => {
    const m = await mount({ data: { startOpen: ['destins_room'] } });
    const pad = card().querySelector('.rpad')!, row = keys(), chips = card().querySelector('.rchips')!, play = key('Pause');
    card().querySelector<HTMLElement>('.rtoggle')!.click();
    await frame();
    expect(card().querySelector('.rpad')).toBe(pad);
    expect(keys()).toBe(row);
    expect(card().querySelector('.rchips')).toBe(chips);
    expect(key('Pause')).toBe(play); // play never moves or is rebuilt
    expect(pad.getAttribute('data-open')).toBe('1');
    expect(pad.hasAttribute('inert')).toBe(false);
    expect(row.getAttribute('data-open')).toBe('1');
    expect(card().querySelector('.rtoggle')!.getAttribute('aria-expanded')).toBe('true');
    expect((m.saves.at(-1) as { remote: string[] }).remote).toEqual([RC]);
    card().querySelector<HTMLElement>('.rtoggle')!.click();
    await frame();
    expect(pad.getAttribute('data-open')).toBe('0');
    expect(card().querySelector('.rpad')).toBe(pad);
  });

  it('the pad sits above the volume row, then the keys, then the app buttons; a push from the TV mid-open changes nothing about them', async () => {
    const m = await mount({ data: { startOpen: ['destins_room'], remote: [RC] } });
    expect(panelOrder()).toEqual(['pad', 'vol', 'keys', 'chips']);
    const pad = card().querySelector('.rpad')!, row = keys();
    push(m.socks[0], TV, { a: { media_title: 'Another video' } }); await frame();
    expect(card().querySelector('.rpad')).toBe(pad);
    expect(keys()).toBe(row);
    expect(pad.getAttribute('data-open')).toBe('1');
  });

  it('the remote icon is not drawn while the TV is off', async () => {
    const m = await mount({ data: { startOpen: ['destins_room'], remote: [RC] } });
    expect(card().querySelector('.rtoggle')).toBeTruthy();
    house('remote/turn_off', { entity_id: RC });
    await tick(1000);
    expect(card().querySelector('.rtoggle')).toBeNull();
    expect(card().querySelector('.rpad')).toBeNull(); // no panel, so no pad either
    void m;
  });

  it('the pad sends the TV its arrow keys', async () => {
    await mount({ data: { startOpen: ['destins_room'], remote: [RC] } });
    for (const [label, cmd] of [['Up', 'DPAD_UP'], ['Left', 'DPAD_LEFT'], ['OK', 'DPAD_CENTER'], ['Right', 'DPAD_RIGHT'], ['Down', 'DPAD_DOWN'], ['Back', 'BACK'], ['Home', 'HOME']]) {
      card().querySelector<HTMLElement>(`[aria-label="${label}"][data-rc]`)!.click();
    }
    await tick(10);
    expect(remoteCalls().map((c) => c.data.command)).toEqual(['DPAD_UP', 'DPAD_LEFT', 'DPAD_CENTER', 'DPAD_RIGHT', 'DPAD_DOWN', 'BACK', 'HOME']);
  });
});

describe('the -10s / +10s buttons: seek, remote keys, or not at all', () => {
  it('a TV that cannot seek but has a paired remote presses the TV\'s own rewind and fast-forward keys', async () => {
    await mount({ data: { startOpen: ['destins_room'] } });
    expect(keys().getAttribute('data-ten')).toBe('1');
    key('Back 10 seconds').click(); key('Forward 10 seconds').click();
    await tick(10);
    expect(fakeHomeAssistantCalls().filter((c) => c.service === 'media_seek')).toEqual([]);
    expect(remoteCalls().map((c) => [c.service, c.data.entity_id, c.data.command])).toEqual([['send_command', RC, 'MEDIA_REWIND'], ['send_command', RC, 'MEDIA_FAST_FORWARD']]);
  });

  it('a TV that can seek and reports its position uses media_seek to that position plus or minus 10, and two quick presses add up', async () => {
    await mount({ data: { startOpen: ['destins_room'] } });
    fakeHomeAssistantSet(TV, { features: 4 | 2, pos: 100, posAt: new Date().toISOString() });
    await tick(1000);
    key('Forward 10 seconds').click(); key('Forward 10 seconds').click(); key('Back 10 seconds').click();
    await tick(10);
    const seeks = fakeHomeAssistantCalls().filter((c) => c.service === 'media_seek');
    expect(seeks.map((c) => [c.domain, c.data.entity_id, c.data.seek_position])).toEqual([['media_player', TV, 111], ['media_player', TV, 121], ['media_player', TV, 111]]);
    // (reported at 100 s, one second passed while it kept playing: 101 + 10; the next press starts from where the last one went)
    expect(remoteCalls().filter((c) => c.domain === 'remote')).toEqual([]); // the remote keys were not used
  });

  it('a TV that says it can seek but gives no position falls back to the remote keys (a seek needs a place to go to)', async () => {
    await mount({ data: { startOpen: ['destins_room'] } });
    fakeHomeAssistantSet(TV, { features: 4 | 2 });
    await tick(1000);
    key('Forward 10 seconds').click();
    await tick(10);
    expect(fakeHomeAssistantCalls().filter((c) => c.service === 'media_seek')).toEqual([]);
    expect(remoteCalls().map((c) => c.data.command)).toEqual(['MEDIA_FAST_FORWARD']);
  });

  it('a TV with no paired remote has no -10s/+10s (nor any transport row): nothing is drawn that cannot work', async () => {
    await mount({ data: { startOpen: ['destins_room'] } });
    house('media_player/turn_on', { entity_id: 'media_player.destins_room_tv' }); // the Samsung TV: no remote entity
    await tick(1000);
    const samsung = q('[data-eid="media_player.destins_room_tv"]');
    expect(samsung.querySelector('.np-keys, [aria-label$="10 seconds"], .rtoggle')).toBeNull();
  });
});

describe('the app drawer', () => {
  const ORDER = ['YouTube', 'Netflix', 'HBO Max', 'Disney+', 'Prime Video', 'Hulu', 'Apple TV', 'Peacock', 'Paramount+', 'Spotify', 'YouTube Music', 'Plex', 'Tubi', 'Twitch', 'Crunchyroll'];
  const on = () => qa(`[data-eid="${TV}"] .rapp.on`).map((b) => b.getAttribute('data-name'));

  it('lists Destin\'s four first, then Prime Video, then the rest, then a More button; every app is always drawn (no swapping)', async () => {
    const m = await mount({ data: { startOpen: ['destins_room'], remote: [RC] } });
    expect(chipNames()).toEqual([...ORDER, null]); // null = the More button
    push(m.socks[0], RC, { a: { current_activity: 'com.netflix.ninja' } }); await frame();
    expect(chipNames()).toEqual([...ORDER, null]); // the open app does not move or disappear
  });

  it('the app on the TV is highlighted "on now" in place (including the new apps, matched by package name); none when it is not in the list', async () => {
    const m = await mount({ data: { startOpen: ['destins_room'], remote: [RC] } });
    expect(on()).toEqual(['YouTube']);
    expect(card().querySelector('.rapp.on')!.getAttribute('aria-label')).toBe('Open YouTube (on now)');
    push(m.socks[0], RC, { a: { current_activity: 'com.netflix.ninja' } }); await frame();
    expect(on()).toEqual(['Netflix']);
    push(m.socks[0], RC, { a: { current_activity: 'com.spotify.tv.android' } }); await frame();
    expect(on()).toEqual(['Spotify']);
    push(m.socks[0], RC, { a: { current_activity: 'com.google.android.youtube.tvmusic' } }); await frame();
    expect(on()).toEqual(['YouTube Music']); // not YouTube, although the package name contains "youtube"
    push(m.socks[0], RC, { a: { current_activity: 'com.some.other.app' } }); await frame();
    expect(on()).toEqual([]);
  });

  it('pressing one opens that app through the remote: the five older apps by web address, the new ones by Android app id', async () => {
    await mount({ data: { startOpen: ['destins_room'], remote: [RC] } });
    for (const n of ['HBO Max', 'Prime Video', 'Spotify', 'Plex']) card().querySelector<HTMLElement>(`[data-name="${n}"]`)!.click();
    await tick(10);
    expect(fakeHomeAssistantCalls().filter((c) => c.service === 'turn_on').map((c) => [c.data.entity_id, c.data.activity])).toEqual([
      [RC, 'https://play.hbomax.com'], [RC, 'https://app.primevideo.com'], [RC, 'com.spotify.tv.android'], [RC, 'com.plexapp.android']]);
  });

  it('More / Less: pressing it toggles the drawer, and a redraw from the house cannot fold it shut again', async () => {
    const m = await mount({ data: { startOpen: ['destins_room'], remote: [RC] } });
    const chips = () => card().querySelector('.rchips')!;
    expect(chips().getAttribute('data-more')).toBe('0');
    card().querySelector<HTMLElement>('.rapp.more')!.click(); await frame();
    expect(chips().getAttribute('data-more')).toBe('1');
    expect(card().querySelector('.rapp.more')!.getAttribute('aria-expanded')).toBe('true');
    expect(card().querySelector('.rapp.more .nm')!.textContent).toBe('Less');
    push(m.socks[0], TV, { a: { media_title: 'Another video' } }); await frame();
    push(m.socks[0], RC, { a: { current_activity: 'com.netflix.ninja' } }); await frame();
    await tick(6000); // a periodic check too
    expect(chips().getAttribute('data-more')).toBe('1');
    card().querySelector<HTMLElement>('.rapp.more')!.click(); await frame();
    expect(chips().getAttribute('data-more')).toBe('0');
  });

  it('the drawer\'s sizes are container queries on the TV card (narrow bar, side by side, two thirds wide) and the wide size shows every app with no More', async () => {
    await mount({ data: { startOpen: ['destins_room'], remote: [RC] } });
    const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join('\n');
    expect(css).toMatch(/\.tile\.mv-wide, \.np-ctl\.tv \{ container: tvc \/ inline-size; \}/);
    for (const w of [400, 460, 650, 900, 1200, 1500, 1800]) expect(css).toContain(`@container tvc (min-width: ${w}px)`);
    const wide = css.slice(css.indexOf('@container tvc (min-width: 900px)'));
    expect(wide).toMatch(/grid-template-columns: minmax\(0, 2fr\) minmax\(0, 1fr\)/); // drawer two thirds, pad one third
    expect(wide).toMatch(/\.rchips \.rapp\.more \{ display: none !important; \}/);
    expect(css).toMatch(/\.mv-np > \.rchips \{ grid-column: 1;/); // wide: drawer left
    expect(css).toMatch(/\.mv-np > \.rpad \{ grid-column: 2; align-self: center;/); // wide: pad right, centred up and down
  });

  it('the drawer sits after the pad in the Media tab\'s now-playing box, so the pad and drawer share one row at medium and wide sizes', async () => {
    await mount({ data: { view: 'media', remote: [RC] } });
    const np = card().querySelector('.mv-np')!;
    expect(Array.from(np.children).map((e) => e.getAttribute('data-slot') ?? e.className.split(' ')[0])).toEqual(['mv-nprow', 'mv-vol', 'pad', 'chips']);
  });

  // WHY CSS-only: jsdom cannot measure a container query, so this pins the DOM (nothing moves, nothing is re-made) and the exact
  // rules that arrange it. Destin's markup (2026-10-05): wide + remote open = drawer fills the left under the title; right column is
  // pad, then volume, then the five keys; row 1 keeps only the app mark and title.
  it('wide + remote open: pad, volume and the five keys stack in the right column; every other size keeps today\'s structure', async () => {
    await mount({ data: { view: 'media', remote: [RC] } });
    const np = card().querySelector('.mv-np')!;
    // The elements are the same ones at every size: keys stay inside row 1 in the DOM, volume and drawer are the panel's own children.
    expect(np.querySelector(':scope > .mv-nprow > .np-keys')).toBeTruthy();
    expect(np.querySelector(':scope > .mv-vol .vrow')).toBeTruthy();
    expect(np.querySelector('.mv-nprow > .mv-art')).toBeTruthy();
    const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join('\n');
    const start = css.indexOf('@container tvc (min-width: 900px)');
    const wide = css.slice(start, css.indexOf('@container tvc (min-width: 1200px)'));
    const open = '.mv-wide .np.mv-np:has(.rpad[data-open="1"])';
    const rule = (sel: string) => wide.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}'))?.[1] ?? '';
    expect(rule(open + ' > .mv-nprow')).toContain('display: contents'); // row 1 stops being a box so its keys can leave it
    expect(rule(open + ' > .rchips')).toMatch(/grid-column: 1; grid-row: 2 \/ -1/); // drawer: whole left area under the title
    expect(rule(open + ' > .rpad')).toMatch(/grid-column: 2; grid-row: 2/); // pad first, top lined up with the drawer
    expect(rule(open + ' > .mv-vol')).toMatch(/grid-column: 2; grid-row: 3/); // then the volume
    expect(rule(open + ' .mv-nprow > .np-keys')).toMatch(/grid-column: 2; grid-row: 4/); // then the keys, last
    // Closed, medium and narrow: no arrangement rule exists outside the wide size, and none without "open".
    const before = css.slice(0, start);
    expect(before).not.toContain('display: contents');
    expect(before).not.toContain(open);
    expect(wide).not.toMatch(/\.mv-wide \.np\.mv-np > /); // every wide rule above is gated on :has(open)
  });
});
