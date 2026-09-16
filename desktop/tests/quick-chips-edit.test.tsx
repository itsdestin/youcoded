// @vitest-environment jsdom
// Pins the quick-chip EDIT surface and the removal of QuickChips' private copy
// of the default chip list.
//
// WHY this test exists: before 2026-08-28 QuickChips had no test at all, and it
// carried two behaviours that a reader could not tell apart from a bug.
//   1. Chips were add/remove/reorder only. Retuning a prompt meant deleting the
//      chip and rebuilding it, which also lost its position — so the editor had
//      to grow a way to rewrite a chip in place, WITHOUT breaking the pointer
//      drag that shares the same row.
//   2. The component held a third copy of the default chip list (the other two
//      being skill-config-store.ts and SkillConfigStore.kt) and substituted it
//      whenever the store answered empty. `chips` starts [] and loads async, so
//      "not loaded yet" and "the user deleted every chip" were the same value:
//      the row resurrected seven defaults the editor could not see, because the
//      editor reads the real store list. These pin the honest behaviour — the
//      row must stay empty in BOTH of those states, which is exactly what the
//      fallback made impossible.

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent, waitFor } from '@testing-library/react';
import QuickChips from '../src/renderer/components/QuickChips';
import { SkillProvider } from '../src/renderer/state/skill-context';
import type { ChipConfig } from '../src/shared/types';

const CHIPS: ChipConfig[] = [
  { skillId: 'journaling-assistant', label: 'Journal', prompt: "let's journal" },
  { label: 'Git Status', prompt: 'run git status' },
];

let setChips: ReturnType<typeof vi.fn>;

function setupWindowClaude(chips: ChipConfig[], getChips?: () => Promise<ChipConfig[]>) {
  setChips = vi.fn().mockResolvedValue(undefined);
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    skills: {
      list: vi.fn().mockResolvedValue([]),
      getFavorites: vi.fn().mockResolvedValue([]),
      getCuratedDefaults: vi.fn().mockResolvedValue([]),
      getChips: getChips ?? vi.fn().mockResolvedValue(chips),
      setChips,
      setFavorite: vi.fn().mockResolvedValue(undefined),
      setOverride: vi.fn().mockResolvedValue(undefined),
      getShareLink: vi.fn().mockResolvedValue(''),
      publish: vi.fn().mockResolvedValue({ prUrl: '' }),
    },
  };
}

async function mount() {
  await act(async () => {
    render(
      <SkillProvider>
        <QuickChips onChipTap={() => {}} />
      </SkillProvider>,
    );
  });
}

const openEditor = () => fireEvent.click(screen.getByLabelText('Edit quick chips'));
const row = (i: number) => document.querySelector(`[data-chip-idx="${i}"]`) as HTMLElement;

// jsdom implements neither pointer-capture method, and the drag path calls
// setPointerCapture on every pointerdown — without these the drag test still
// passes but leaves an unhandled rejection behind it.
beforeEach(() => {
  (Element.prototype as any).setPointerCapture = vi.fn();
  (Element.prototype as any).releasePointerCapture = vi.fn();
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('quick chips — editing an existing chip', () => {
  beforeEach(() => setupWindowClaude(CHIPS));

  it('tapping a row opens it with the chip\'s current label and prompt', async () => {
    await mount();
    openEditor();
    fireEvent.click(row(1));
    expect(screen.getByLabelText('Chip label')).toHaveValue('Git Status');
    expect(screen.getByLabelText('Chip prompt')).toHaveValue('run git status');
  });

  it('saving writes the new prompt back and keeps every other chip', async () => {
    await mount();
    openEditor();
    fireEvent.click(row(1));
    fireEvent.change(screen.getByLabelText('Chip prompt'), {
      target: { value: 'run git status --short and summarize' },
    });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(setChips).toHaveBeenCalledTimes(1));
    expect(setChips.mock.calls[0][0]).toEqual([
      CHIPS[0],
      { label: 'Git Status', prompt: 'run git status --short and summarize' },
    ]);
  });

  // The whole point of spreading the existing chip on save: skillId is what the
  // uninstall cascade matches on, so a tuned skill chip must stay bound to it.
  it('editing a skill-backed chip preserves its skillId', async () => {
    await mount();
    openEditor();
    fireEvent.click(row(0));
    fireEvent.change(screen.getByLabelText('Chip prompt'), { target: { value: 'journal with me' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(setChips).toHaveBeenCalledTimes(1));
    expect(setChips.mock.calls[0][0][0]).toEqual({
      skillId: 'journaling-assistant', label: 'Journal', prompt: 'journal with me',
    });
  });

  it('Cancel discards the edit and writes nothing', async () => {
    await mount();
    openEditor();
    fireEvent.click(row(1));
    fireEvent.change(screen.getByLabelText('Chip prompt'), { target: { value: 'clobbered' } });
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByLabelText('Chip prompt')).toBeNull();
    expect(setChips).not.toHaveBeenCalled();
  });

  // Rows are also drag handles. A pointer run that passes the 5px threshold sets
  // suppressClick, and the click that follows a drop must NOT open the row it
  // just moved — otherwise every reorder ends in an accidental edit form.
  it('a drag does not open the row it dropped', async () => {
    await mount();
    openEditor();
    const r = row(1);
    fireEvent.pointerDown(r, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(r, { clientX: 0, clientY: 40 });
    fireEvent.pointerUp(r);
    fireEvent.click(r);
    expect(screen.queryByLabelText('Chip prompt')).toBeNull();
  });

  // Chips are identified by array position, so anything that shifts positions
  // must close the open row rather than risk saving onto a different chip.
  it('removing a chip closes an open edit row', async () => {
    await mount();
    openEditor();
    fireEvent.click(row(0));
    expect(screen.getByLabelText('Chip prompt')).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText('Remove chip')[0]);
    expect(screen.queryByLabelText('Chip prompt')).toBeNull();
  });

  it('an empty label or prompt cannot be saved', async () => {
    await mount();
    openEditor();
    fireEvent.click(row(1));
    fireEvent.change(screen.getByLabelText('Chip prompt'), { target: { value: '   ' } });
    expect(screen.getByText('Save')).toBeDisabled();
  });
});

describe('quick chips — the row shows the store, not a hardcoded fallback', () => {
  it('renders no chips while the store is still loading', async () => {
    let release: (c: ChipConfig[]) => void = () => {};
    setupWindowClaude([], () => new Promise((res) => { release = res; }));
    await mount();
    // Pre-load: the old code painted seven built-in chips here.
    expect(screen.queryByText('Journal')).toBeNull();
    expect(screen.getByLabelText('Edit quick chips')).toBeTruthy();
    await act(async () => { release(CHIPS); });
    expect(screen.getByText('Journal')).toBeTruthy();
  });

  it('a user who deleted every chip keeps an empty row, not the defaults back', async () => {
    setupWindowClaude([]);
    await mount();
    expect(screen.queryByText('Journal')).toBeNull();
    expect(screen.queryByText('Git Status')).toBeNull();
    // The editor and the row now agree — both show nothing.
    openEditor();
    expect(document.querySelector('[data-chip-idx]')).toBeNull();
    expect(screen.getByText('+ Add Chip')).toBeTruthy();
  });
});
