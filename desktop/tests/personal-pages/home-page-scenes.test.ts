// @vitest-environment jsdom
// Redesign round 1 (Destin, 2026-10-04): Scenes are an easel button left of the Lights card's chevron
// (opening the scene chips on their own), and every Lights card and colour palette starts closed on
// each load, whatever an older saved copy of the page's data says.
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, q, qa, tick, noCameraPicture } from './home-page-harness';

afterEach(() => unmount());

// What an older version of the page saved: cards and a palette left open, scenes unfolded.
const OLD_SAVED = { open: ['destins_room', 'living_room'], expanded: ['light.desk_backlight'], scenesOpen: ['destins_room'] };
const easel = (room: string) => q(`[data-scenes="${room}"]`);

describe('Lights cards, palettes and Scenes start closed', () => {
  it('ignores saved open cards, palettes and scenes', async () => {
    await mount({ data: OLD_SAVED, fetchHook: noCameraPicture });
    expect(qa('.lights-body').length).toBe(0);
    expect(qa('.pal-row').length).toBe(0);
    expect(qa('.scenes').length).toBe(0);
    expect(qa('[data-fold]').every((b) => b.getAttribute('aria-expanded') === 'false')).toBe(true);
  });

  it('opens a palette closed even when its card is open (seeded for a practice screen only)', async () => {
    await mount({ data: { startOpen: ['destins_room'] }, fetchHook: noCameraPicture });
    expect(qa('.lights-body').length).toBe(1);
    expect(qa('.pal-row').length).toBe(0);
  });
});

describe('the Scenes easel button', () => {
  it('sits in the Lights card header before the chevron and toggles the chips without unfolding the lights', async () => {
    await mount({ data: {}, fetchHook: noCameraPicture });
    const b = easel('destins_room');
    expect(b.nextElementSibling!.getAttribute('data-fold')).toBe('destins_room');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    b.click(); await tick(50);
    expect(easel('destins_room').getAttribute('aria-expanded')).toBe('true');
    expect(qa('.scenes .scene').length).toBeGreaterThan(1);
    expect(qa('.scenes .sx-card.last').length).toBe(1); // the scene used last is outlined; no "Last used" line any more
    expect(qa('.lights-body').length).toBe(0); // the lights list stayed folded
    easel('destins_room').click(); await tick(50);
    expect(qa('.scenes').length).toBe(0);
  });

  it('still sends a scene press', async () => {
    const urls: string[] = [];
    await mount({ data: {}, fetchHook: (req) => { urls.push(req.url); return noCameraPicture(req); } });
    easel('destins_room').click(); await tick(50);
    q('.scenes .scene').click(); await tick(50);
    expect(urls.some((u) => u.includes('/api/services/scene/turn_on'))).toBe(true);
  });
});

// Scene cards (Destin, 2026-10-06/07): scenes and the lights list never open together; cards show the colours the page learned.
describe('scene cards', () => {
  it('opening Scenes folds the lights, and unfolding the lights closes Scenes', async () => {
    await mount({ data: {}, fetchHook: noCameraPicture });
    q('[data-fold="destins_room"]').click(); await tick(50);
    expect(qa('.lights-body').length).toBe(1);
    easel('destins_room').click(); await tick(50);
    expect(qa('.scenes').length).toBe(1);
    expect(qa('.lights-body').length).toBe(0);
    q('[data-fold="destins_room"]').click(); await tick(50);
    expect(qa('.lights-body').length).toBe(1);
    expect(qa('.scenes').length).toBe(0);
  });

  it('paints a learned scene as a gradient with its own brightness, and an unseen one as "try it"', async () => {
    const id = 'scene.destins_room_tokyo';
    await mount({ data: { sceneLook: { [id]: { c: ['rgb(255, 70, 150)', 'rgb(60, 190, 255)'] } } }, fetchHook: noCameraPicture });
    easel('destins_room').click(); await tick(50);
    const tokyo = q(`.sx-card[data-scene="${id}"]`);
    expect(tokyo.querySelector('.sg-bg')!.getAttribute('style')).toContain('rgb(255, 70, 150)');
    expect(tokyo.querySelector('.sx-pct')!.textContent).toBe('70%'); // 179 of 255
    expect(tokyo.querySelector('.sx-mv')).not.toBeNull(); // Tokyo moves through its colours
    const read = q('.sx-card[data-scene="scene.destins_room_read"]');
    expect(read.classList.contains('unk')).toBe(true);
    expect(read.textContent).toContain('Try it to see its colours');
  });
});
