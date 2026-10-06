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
    expect(q('.scenes .sc-foot').textContent).toContain('Last used');
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
