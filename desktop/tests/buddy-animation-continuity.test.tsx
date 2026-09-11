// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const state = vi.hoisted(() => ({ attention: false, reducedEffects: false }));
vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ theme: 'light', activeTheme: null, reducedEffects: state.reducedEffects }),
}));
vi.mock('../src/renderer/hooks/useThemeMascot', () => ({ useThemeMascot: () => null }));
vi.mock('../src/renderer/hooks/useAnyAttentionNeeded', () => ({ useAnyAttentionNeeded: () => state.attention }));
import { BuddyMascot } from '../src/renderer/components/buddy/BuddyMascot';

afterEach(() => { cleanup(); state.attention = false; state.reducedEffects = false; });

it.each([false, true])('preserves a docked rig through repeated attention changes (reduced effects: %s)', (reducedEffects) => {
  state.reducedEffects = reducedEffects;
  const overlayDrive = { dock: { mode: 'peeking' as const, edge: 'left' }, onDragMove: vi.fn(), onDragEnd: vi.fn(), onTap: vi.fn() };
  const view = render(<BuddyMascot overlayDrive={overlayDrive} />);
  const svg = view.container.querySelector('.mascot-lean svg');
  expect(svg).not.toBeNull();
  const host = svg!.parentElement!.parentElement;
  for (const attention of [true, false, true]) {
    state.attention = attention;
    view.rerender(<BuddyMascot overlayDrive={overlayDrive} />);
    // The grip observer watches this host; replacing it also strands async hand extraction.
    expect(view.container.querySelector('.mascot-lean svg')!.parentElement!.parentElement).toBe(host);
    expect(view.container.querySelector('.mascot-lean svg')).toBe(svg);
    expect(!!view.container.querySelector('.mascot-bounce')).toBe(attention && !reducedEffects);
  }
});
