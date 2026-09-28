// @vitest-environment jsdom
// Typing after "/" filters the command drawer WITHOUT re-rendering the App shell.
//
// The filter used to be App-level useState, so every letter of "/abc" re-rendered
// the whole shell (header, session strip, chat) to pass one string to the drawer.
// It now lives in a store only the drawer subscribes to. These tests drive the
// real InputBar and the real CommandDrawer, wired exactly the way App wires them,
// next to a sentinel that stands in for "the rest of the App shell".
import '@testing-library/jest-dom/vitest';
import React, { useState } from 'react';
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, act, within } from '@testing-library/react';
import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';
import type { SkillEntry } from '../src/shared/types';

const skills: SkillEntry[] = ['alpha', 'abacus', 'beta'].map((id) => ({
  id, displayName: id, description: `${id} description`, category: 'work',
  prompt: '', source: 'self', type: 'prompt', visibility: 'private',
}));
vi.mock('../src/renderer/state/skill-context', () => ({
  useSkills: () => ({
    drawerSkills: skills, drawerCommands: [], favorites: [], setFavorite: vi.fn(),
    chips: [], quickChips: [], installed: [],
  }),
}));
vi.mock('../src/renderer/state/marketplace-context', () => ({
  useMarketplace: () => ({ skillEntries: [] }),
}));

import { ChatProvider } from '../src/renderer/state/chat-context';
import InputBar from '../src/renderer/components/InputBar';
import CommandDrawer from '../src/renderer/components/CommandDrawer';
import { createDrawerFilterStore } from '../src/renderer/state/drawer-filter-store';

beforeAll(() => {
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  (window as any).claude = { session: { sendInput: vi.fn() } };
});
afterEach(cleanup);

let shellRenders = 0;
function Sentinel() { shellRenders++; return null; }

// Mirrors App.tsx: the store is created once with useState, InputBar gets its
// setter as onDrawerSearch, the drawer gets the store. Open/close stay App state.
function Shell() {
  const [store] = useState(createDrawerFilterStore);
  const [open, setOpen] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  return (
    <ChatProvider>
      <Sentinel />
      <div data-testid="drawer"><CommandDrawer
        open={open} searchMode={searchMode} filterStore={store}
        onSelect={() => {}} onSelectCommand={() => {}}
        onClose={() => { setOpen(false); store.set(undefined); }}
        onOpenManager={() => {}} onOpenMarketplace={() => {}}
      /></div>
      <InputBar
        sessionId="s1"
        onOpenDrawer={(sm) => { setSearchMode(sm); setOpen(true); if (!sm) store.set(undefined); }}
        onCloseDrawer={() => { setOpen(false); store.set(undefined); }}
        onDrawerSearch={store.set}
      />
    </ChatProvider>
  );
}

const typeInto = (box: HTMLElement, value: string) => act(() => { fireEvent.change(box, { target: { value } }); });

describe('slash search filters the command drawer', () => {
  it('shows the typed filter and matching skills, re-rendering only the drawer', () => {
    render(<Shell />);
    const box = screen.getByPlaceholderText('Message your assistant...');
    typeInto(box, '/');
    const rendersAfterOpen = shellRenders;
    typeInto(box, '/a');
    typeInto(box, '/ab');
    // The drawer mirrors what was typed and filters in the same render.
    const drawer = within(screen.getByTestId('drawer'));
    expect(drawer.getByText('/ab')).toBeInTheDocument();
    expect(drawer.getByText('abacus')).toBeInTheDocument();
    expect(drawer.queryByText('alpha')).toBeNull();
    expect(drawer.queryByText('beta')).toBeNull();
    typeInto(box, '/abc');
    expect(drawer.getByText('/abc')).toBeInTheDocument();
    // Opening the drawer is App state and may render the shell; the letters after it must not.
    expect(shellRenders).toBe(rendersAfterOpen);
  });

  it('App wires the drawer filter through the store, not App state', () => {
    // WHY a source check: the real App shell cannot mount in a unit test, and the
    // regression this guards is someone moving the filter back into App's useState.
    const app = readSource(join(__dirname, '..', 'src', 'renderer', 'App.tsx'));
    expect(app).toMatch(/useState\(createDrawerFilterStore\)/);
    expect(app).toMatch(/filterStore=\{drawerFilterStore\}/);
    expect(app).toMatch(/onDrawerSearch=\{setDrawerFilter\}/);
    expect(app).not.toMatch(/\[drawerFilter, setDrawerFilter\]\s*=\s*useState/);
  });
});
