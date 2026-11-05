// @vitest-environment jsdom
// Pins the narrow-screens proposal's Shortcuts button (Q-7, 2026-11-05): the shortcut
// chips behind one button in the message box. The promise to Destin was "nothing is
// lost" — every chip the row shows is in the menu, choosing one does exactly what
// tapping it on the row does, and the row's editor is still one step away.

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react';
import { QuickChipsMenuButton } from '../src/renderer/components/QuickChips';
import { SkillProvider } from '../src/renderer/state/skill-context';
import type { ChipConfig } from '../src/shared/types';

const CHIPS: ChipConfig[] = [
  { label: 'Journal', prompt: "let's journal" },
  { label: 'Git Status', prompt: 'run git status' },
  { label: 'Set aside', prompt: 'hidden one', hidden: true },
];

beforeEach(() => {
  (globalThis as any).window.claude = {
    skills: {
      list: vi.fn().mockResolvedValue([]),
      getFavorites: vi.fn().mockResolvedValue([]),
      getCuratedDefaults: vi.fn().mockResolvedValue([]),
      getChips: vi.fn().mockResolvedValue(CHIPS),
      setChips: vi.fn().mockResolvedValue(undefined),
      setFavorite: vi.fn().mockResolvedValue(undefined),
      setOverride: vi.fn().mockResolvedValue(undefined),
      getShareLink: vi.fn().mockResolvedValue(''),
      publish: vi.fn().mockResolvedValue({ prUrl: '' }),
    },
  };
});
afterEach(() => { cleanup(); });

async function mount(onChipTap = vi.fn()) {
  await act(async () => {
    render(<SkillProvider><QuickChipsMenuButton onChipTap={onChipTap} /></SkillProvider>);
  });
  return onChipTap;
}

describe('QuickChipsMenuButton', () => {
  it('lists every shown chip, not the set-aside ones', async () => {
    await mount();
    fireEvent.click(screen.getByTitle('Shortcuts'));
    await screen.findByRole('menu');
    expect(screen.getByRole('menuitem', { name: 'Journal' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Git Status' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Set aside' })).toBeNull();
  });

  it('choosing a chip hands the row\'s handler the same chip and closes', async () => {
    const onChipTap = await mount();
    fireEvent.click(screen.getByTitle('Shortcuts'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Git Status' }));
    expect(onChipTap).toHaveBeenCalledWith({ label: 'Git Status', prompt: 'run git status' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Edit shortcuts opens the row\'s chip editor', async () => {
    await mount();
    fireEvent.click(screen.getByTitle('Shortcuts'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit shortcuts' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
