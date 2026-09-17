// @vitest-environment jsdom
import React from 'react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const state = vi.hoisted(() => ({ attention: false, reducedEffects: false }));
vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ theme: 'light', activeTheme: null, reducedEffects: state.reducedEffects }),
}));
vi.mock('../src/renderer/hooks/useThemeMascot', () => ({ useThemeMascot: () => null }));
vi.mock('../src/renderer/hooks/useAnyAttentionNeeded', () => ({ useAnyAttentionNeeded: () => state.attention }));
import { BuddyMascot, type MascotDockState } from '../src/renderer/components/buddy/BuddyMascot';

// Dock state reaches the mascot the way it does in the app — main's
// buddy:mascot-state push, subscribed through window.claude.buddy (see
// buddy-peek-attention.test.tsx for the same fake and why).
const bridge: { push: ((s: MascotDockState) => void) | null } = { push: null };
const win = window as unknown as { claude?: unknown };
const realClaude = win.claude;
beforeAll(() => {
  win.claude = {
    buddy: {
      onMascotState: (cb: (s: MascotDockState) => void) => {
        bridge.push = cb;
        return () => { if (bridge.push === cb) bridge.push = null; };
      },
    },
  };
});
afterAll(() => { win.claude = realClaude; });
afterEach(() => { cleanup(); state.attention = false; state.reducedEffects = false; });

it.each([false, true])('preserves a docked rig through repeated attention changes (reduced effects: %s)', (reducedEffects) => {
  state.reducedEffects = reducedEffects;
  const view = render(<BuddyMascot />);
  // 'docked' (out of the edge), not 'peeking': a tucked-in buddy never bounces
  // for attention (buddy-peek-attention.test.tsx), so only here does it toggle.
  expect(bridge.push).not.toBeNull();
  act(() => { bridge.push!({ mode: 'docked', edge: 'left' }); });
  const svg = view.container.querySelector('.mascot-lean svg');
  expect(svg).not.toBeNull();
  const host = svg!.parentElement!.parentElement;
  for (const attention of [true, false, true]) {
    state.attention = attention;
    view.rerender(<BuddyMascot />);
    // The grip observer watches this host; replacing it also strands async hand extraction.
    expect(view.container.querySelector('.mascot-lean svg')!.parentElement!.parentElement).toBe(host);
    expect(view.container.querySelector('.mascot-lean svg')).toBe(svg);
    expect(!!view.container.querySelector('.mascot-bounce')).toBe(attention && !reducedEffects);
  }
});
