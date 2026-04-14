import { describe, it, expect } from 'vitest';
import { packSessions } from '../src/renderer/components/header/pack-sessions';

const mk = (id: string, expanded = 120, collapsed = 20) =>
  ({ id, expandedWidth: expanded, collapsedWidth: collapsed });

describe('packSessions', () => {
  it('returns nothing when there are no sessions', () => {
    const r = packSessions({ sessions: [], activeId: null, budget: 500, gap: 2, triggerWidth: 20 });
    expect(r.expanded.size).toBe(0);
    expect(r.collapsed).toEqual([]);
    expect(r.overflow).toEqual([]);
  });

  it('shows only the active pill when budget is tight', () => {
    const sessions = [mk('a'), mk('b'), mk('c')];
    // Budget fits only the active expanded pill + trigger.
    const r = packSessions({ sessions, activeId: 'b', budget: 145, gap: 2, triggerWidth: 20 });
    expect(r.expanded.has('b')).toBe(true);
    expect(r.collapsed).toEqual([]);
    expect(r.overflow).toEqual(['a', 'c']);
  });

  it('collapses non-active pills to dot-only when names would not fit', () => {
    const sessions = [mk('a'), mk('b'), mk('c')];
    // Active expanded (120) + 2 collapsed (20 each) + 3 gaps (6) + trigger (20) = 186
    const r = packSessions({ sessions, activeId: 'b', budget: 200, gap: 2, triggerWidth: 20 });
    expect(r.expanded).toEqual(new Set(['b']));
    expect(r.collapsed).toEqual(['a', 'c']);
    expect(r.overflow).toEqual([]);
  });

  it('expands all pills when budget allows (allExpanded mode)', () => {
    const sessions = [mk('a'), mk('b'), mk('c')];
    // 3×120 + 2 gaps + trigger = 384
    const r = packSessions({ sessions, activeId: 'b', budget: 500, gap: 2, triggerWidth: 20 });
    expect(r.expanded).toEqual(new Set(['a', 'b', 'c']));
    expect(r.collapsed).toEqual([]);
    expect(r.overflow).toEqual([]);
  });

  it('overflows pills that do not fit even when collapsed', () => {
    const sessions = [mk('a'), mk('b'), mk('c'), mk('d'), mk('e')];
    // Active (120) + trigger (20) + 2 gaps (4) = 144; 30 px left = one collapsed pill fits
    const r = packSessions({ sessions, activeId: 'a', budget: 170, gap: 2, triggerWidth: 20 });
    expect(r.expanded).toEqual(new Set(['a']));
    expect(r.collapsed).toEqual(['b']);
    expect(r.overflow).toEqual(['c', 'd', 'e']);
  });

  it('treats a non-existent activeId as no-active and packs greedily', () => {
    const sessions = [mk('a'), mk('b'), mk('c')];
    const r = packSessions({ sessions, activeId: 'missing', budget: 90, gap: 2, triggerWidth: 20 });
    // pillBudget = 90 - 20 - 2 = 68; three collapsed at 20 + 2 gaps = 64 → all fit
    expect(r.expanded).toEqual(new Set());
    expect(r.collapsed).toEqual(['a', 'b', 'c']);
    expect(r.overflow).toEqual([]);
  });

  it('preserves original session order in collapsed list', () => {
    const sessions = [mk('x'), mk('y'), mk('z')];
    const r = packSessions({ sessions, activeId: 'y', budget: 250, gap: 2, triggerWidth: 20 });
    expect(r.collapsed).toEqual(['x', 'z']);
  });

  it('never expands more than the active pill when budget forces collapse', () => {
    // Three pills that could all collapse (60+40+40) but not all expand (3×120).
    const sessions = [mk('a'), mk('b'), mk('c')];
    const r = packSessions({ sessions, activeId: 'a', budget: 230, gap: 2, triggerWidth: 20 });
    expect(r.expanded).toEqual(new Set(['a']));
    expect(r.collapsed).toEqual(['b', 'c']);
    expect(r.overflow).toEqual([]);
  });

  it('keeps active expanded (CSS truncates) when budget is below its expanded width, overflowing the rest', () => {
    const sessions = [mk('a', 120, 20), mk('b', 120, 20), mk('c', 120, 20)];
    const r = packSessions({ sessions, activeId: 'a', budget: 50, gap: 2, triggerWidth: 20 });
    // Active must stay expanded (name over dots). Everything else overflows.
    expect(r.expanded).toEqual(new Set(['a']));
    expect(r.collapsed).toEqual([]);
    expect(r.overflow).toEqual(['b', 'c']);
  });
});
