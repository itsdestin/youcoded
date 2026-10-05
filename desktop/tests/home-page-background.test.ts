// @vitest-environment jsdom
// The page's Background choice (Destin, 2026-10-05, round 3): gear > Page settings > Background = Plain (today, the default) /
// Frosted / House colours. Plain must add nothing at all; House colours must follow the lights that are on and the app that plays,
// and write to the page only when those colours really changed.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, qa, frame, tick, push, house } from './home-page-harness';

afterEach(() => { unmount(); vi.useRealTimers(); document.documentElement.removeAttribute('data-bg'); document.documentElement.removeAttribute('style'); });
const root = () => document.documentElement;
const RC = 'remote.destins_room_tv_remote';
const gear = async () => { q('.gear').click(); await frame(); };
const h = (n: number) => root().style.getPropertyValue('--h' + n);

describe('the Background setting', () => {
  it('Plain (the default) adds nothing: no attribute on the page, no colours written, and it is the checked choice in settings', async () => {
    await mount({}); await gear();
    expect(root().hasAttribute('data-bg')).toBe(false);
    expect(root().getAttribute('style')).toBeNull();
    expect(qa('.bgopt').map((b) => [b.getAttribute('data-bg'), b.getAttribute('aria-checked')])).toEqual([['plain', 'true'], ['frosted', 'false'], ['house', 'false']]);
  });

  it('an unknown saved value counts as Plain', async () => {
    await mount({ data: { prefs: { bg: 'sparkles' } } });
    expect(root().hasAttribute('data-bg')).toBe(false);
  });

  it('choosing Frosted saves it in the page data and applies it; choosing Plain again takes everything away', async () => {
    const m = await mount({}); await gear();
    q('[data-bg="frosted"].bgopt').click(); await frame();
    expect((m.saves.at(-1) as { prefs: { bg: string } }).prefs.bg).toBe('frosted');
    expect(root().getAttribute('data-bg')).toBe('frosted');
    expect(q('[data-bg="frosted"].bgopt').getAttribute('aria-checked')).toBe('true');
    q('[data-bg="house"].bgopt').click(); await frame();
    expect(root().getAttribute('data-bg')).toBe('house');
    q('[data-bg="plain"].bgopt').click(); await frame();
    expect((m.saves.at(-1) as { prefs: { bg: string } }).prefs.bg).toBe('plain');
    expect(root().hasAttribute('data-bg')).toBe(false);
    expect(h(1)).toBe(''); // the house colours are cleared too
  });

  it('a saved choice is applied when the page opens, and other settings keep their values', async () => {
    await mount({ data: { prefs: { bg: 'frosted', scenes: false } } });
    expect(root().getAttribute('data-bg')).toBe('frosted');
    expect(root().style.getPropertyValue('--h1')).toBe(''); // Frosted uses the theme's colours only
  });

  it('every rule that changes a card or draws the glow sits behind the data-bg switch (so Plain is pixel-identical)', async () => {
    await mount({});
    const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join('\n');
    const bg = css.slice(css.indexOf('Frosted and House colours'));
    const rules = bg.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{')[0].trim()).filter((s) => s && !s.startsWith('@') && !s.startsWith('from') && !s.startsWith('to'));
    expect(rules.length).toBeGreaterThan(5);
    for (const sel of rules) expect(sel, sel).toContain('data-bg');
  });
});

describe('House colours', () => {
  it('takes its glow from the lights that are on (up to three) and the app that is playing', async () => {
    await mount({ data: { prefs: { bg: 'house' }, startOpen: ['destins_room'] } });
    const lights = [1, 2, 3].map(h);
    expect(lights.every((c) => /^rgb\(/.test(c))).toBe(true);
    expect(new Set(lights).size).toBe(3);
    expect(h(4)).toBe('#ff0033'); // the TV is playing YouTube
  });

  it('follows the house: a light switched off leaves the glow, and a different app changes the app colour', async () => {
    const m = await mount({ data: { prefs: { bg: 'house' }, startOpen: ['destins_room'] } });
    const blue = 'rgb(50,110,255)';
    expect([1, 2, 3].map(h)).toContain(blue);
    house('light/turn_off', { entity_id: 'light.desk_backlight' }); await tick(1000);
    expect([1, 2, 3].map(h)).not.toContain(blue);
    push(m.socks[0], RC, { a: { current_activity: 'com.wbd.stream' } }); await frame();
    expect(h(4)).toBe('#8a3ffc'); // HBO Max: the last colour of its gradient
  });

  it('writes to the page only when the colours changed, never on a redraw that changed nothing', async () => {
    const m = await mount({ data: { prefs: { bg: 'house' }, startOpen: ['destins_room'] } });
    const spy = vi.spyOn(root().style, 'setProperty');
    push(m.socks[0], 'media_player.destins_room_google_tv', { a: { media_title: 'Another video' } }); await frame();
    await tick(6000);
    expect(spy).not.toHaveBeenCalled();
    house('light/turn_off', { entity_id: 'light.desk_backlight' }); await tick(1000);
    expect(spy).toHaveBeenCalled();
  });

  it('a dark app colour (Netflix) is not used for the glow', async () => {
    const m = await mount({ data: { prefs: { bg: 'house' }, startOpen: ['destins_room'] } });
    push(m.socks[0], RC, { a: { current_activity: 'com.netflix.ninja' } }); await frame();
    expect(h(4)).not.toBe('#141414');
  });
});
