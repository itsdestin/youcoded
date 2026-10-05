// @vitest-environment jsdom
// A TV's app that gives no title and has never shown a real play/pause is not claimed to be "playing" or
// "paused": the card names the app with its mark and has one neutral play/pause button. An app that does
// report (a title, or a state seen to change) keeps the full Now playing / Paused display.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, frame, tick, push, type Sock } from './home-page-harness';

afterEach(() => { unmount(); vi.useRealTimers(); });
const TV = 'media_player.destins_room_google_tv';
const card = () => q(`[data-eid="${TV}"]`);
const keyLabels = () => Array.from(card().querySelectorAll('.np-keys .key')).map((k) => k.getAttribute('aria-label'));
const noTitle = async (s: Sock) => { push(s, TV, { a: { media_title: null } }); await frame(); };

describe('a TV app that gives no play/pause information', () => {
  it('with a title keeps Now playing, the moving bars and the real Pause button', async () => {
    await mount({ data: { startOpen: ['destins_room'] } });
    expect(card().querySelector('.lbl')!.textContent).toContain('Now playing');
    expect(card().querySelector('.eq.on')).toBeTruthy();
    expect(keyLabels()).toEqual(['Back', 'Previous', 'Back 10 seconds', 'Play or pause', 'Forward 10 seconds', 'Next', 'Home']); // the seven keys; opening the remote shows five of them
    expect(card().querySelector('.key.main')!.innerHTML).toContain('<rect'); // the pause bars
  });

  it('without a title shows the app name and mark, no label, no bars, and one neutral play/pause button', async () => {
    const m = await mount({ data: { startOpen: ['destins_room'] } });
    await noTitle(m.socks[0]);
    expect(card().querySelector('.lbl')).toBeNull();
    expect(card().querySelector('.eq')).toBeNull();
    expect(card().querySelector('.ttl')!.textContent).toBe('YouTube');
    expect(card().querySelector('.art svg, .art img, .art')).toBeTruthy(); // the app's mark
    expect(card().textContent).not.toMatch(/Paused|Now playing|Playing/);
    // One ⏯ that claims no state: the same icon whatever the state is.
    const icon = card().querySelector('.key.main')!.innerHTML;
    expect(icon).toContain('M2 5v14l9-7z');
    push(m.socks[0], TV, { s: 'paused' }); await frame();
    expect(card().querySelector('.key.main')!.innerHTML).not.toBe('');
  });

  it('does not count the page’s own guess: pressing the button changes nothing the card says', async () => {
    const m = await mount({ data: { startOpen: ['destins_room'] } });
    await noTitle(m.socks[0]);
    card().querySelector<HTMLElement>('.key.main')!.click();
    await tick(1000);
    expect(card().querySelector('.lbl')).toBeNull();
    expect(card().querySelector('.ttl')!.textContent).toBe('YouTube');
  });

  it('is shown in full once the house has really reported both playing and paused', async () => {
    const m = await mount({ data: { startOpen: ['destins_room'] } });
    await noTitle(m.socks[0]);
    expect(card().querySelector('.lbl')).toBeNull();
    push(m.socks[0], TV, { s: 'paused' }); await frame(); // it had been "playing"; now a real change
    expect(card().querySelector('.lbl')!.textContent).toContain('Paused');
    push(m.socks[0], TV, { s: 'playing' }); await frame();
    expect(card().querySelector('.lbl')!.textContent).toContain('Now playing');
  });

  it('does not count it as playing in the Media pill while it claims nothing', async () => {
    const m = await mount({ data: { startOpen: ['destins_room'] } });
    const playing = () => Number(/(\d+) playing/.exec(q('#chips [data-view="media"]').textContent ?? '')?.[1] ?? 0);
    const before = playing();
    await noTitle(m.socks[0]);
    expect(playing()).toBe(before - 1);
  });
});
