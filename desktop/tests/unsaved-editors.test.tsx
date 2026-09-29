// @vitest-environment jsdom
// Unsaved non-Office edits (open text editors, parked drafts): the window tells main their file
// names so a quit — or the last window's close — can be refused before anything is torn down,
// and the refused prompt lists them with a way to open each parked draft or discard them all.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { holdUnsavedEditor, resetUnsavedEditorsForTests } from '../src/renderer/state/unsaved-editors';
import { resetOfficeStoreForTests } from '../src/renderer/components/office/office-store';
import { OfficeAlerts } from '../src/renderer/components/office/OfficeAlerts';
import { clearDraft, settleDraft, stashDraft, takeDraft } from '../src/renderer/components/artifact-views/draft-store';
import type { OfficeUnsavedPrompt } from '../src/shared/office-types';

beforeEach(() => resetUnsavedEditorsForTests());
afterEach(() => { resetOfficeStoreForTests(); delete (window as unknown as { claude?: unknown }).claude; });

function bridge() {
  let prompt!: (p: OfficeUnsavedPrompt) => void;
  const office = {
    setOtherUnsaved: vi.fn(),
    proceedClose: vi.fn(),
    onFlushRequest: vi.fn(), flushDone: vi.fn(),
    onUnsavedPrompt: vi.fn((cb: typeof prompt) => { prompt = cb; }),
  };
  (window as unknown as { claude: unknown }).claude = { office };
  return { office, prompt: (p: Partial<OfficeUnsavedPrompt> = {}) => act(() => prompt({ count: 0, firstPath: '', other: true, ...p })) };
}

describe('unsaved non-Office edits', () => {
  it('reports the file names to main only when they change', () => {
    const { office } = bridge();
    const a = holdUnsavedEditor({ name: 'notes.md', discard: () => {} });
    const b = holdUnsavedEditor({ name: 'plan.txt', discard: () => {} });
    a();
    b();
    expect(office.setOtherUnsaved.mock.calls).toEqual([[['notes.md']], [['notes.md', 'plan.txt']], [['plan.txt']], [[]]]);
  });

  it('a parked draft holds its name until it is applied — a failed restore keeps it parked', () => {
    const { office } = bridge();
    stashDraft('k', { draft: 'x', mtimeMs: null, name: 'plan.txt' });
    expect(office.setOtherUnsaved).toHaveBeenLastCalledWith(['plan.txt']);
    expect(takeDraft('k')?.draft).toBe('x');
    expect(takeDraft('k')).toBeUndefined(); // one consumer at a time
    settleDraft('k', false); // could not be applied (the file can't be edited now)
    expect(office.setOtherUnsaved).toHaveBeenLastCalledWith(['plan.txt']);
    expect(takeDraft('k')?.draft).toBe('x'); // still there
    settleDraft('k', true); // back in the editor
    expect(office.setOtherUnsaved).toHaveBeenLastCalledWith([]);
    clearDraft('k');
  });
});

describe('the refused-quit prompt', () => {
  it('lists the files; a parked draft offers Open it, a gone one says so', async () => {
    const { prompt } = bridge();
    const open = vi.fn();
    holdUnsavedEditor({ name: 'notes.md', discard: () => {} });
    holdUnsavedEditor({ name: 'plan.txt', parked: { open, available: async () => true }, discard: () => {} });
    holdUnsavedEditor({ name: 'old.txt', parked: { open: () => {}, available: async () => false }, discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    expect(screen.getByText('3 files have unsaved changes.')).toBeInTheDocument();
    expect(screen.getByText('Save them, then quit again.')).toBeInTheDocument();
    expect(screen.getByText('notes.md')).toBeInTheDocument();
    expect(await screen.findByText('(file no longer available)')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Open it' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('notes.md')).toBeNull(); // the prompt closed for the file to open
  });

  it('Discard and quit asks in place, then throws the edits away and lets main go on', () => {
    const { office, prompt } = bridge();
    const discardA = vi.fn();
    const discardB = vi.fn();
    holdUnsavedEditor({ name: 'notes.md', discard: discardA });
    holdUnsavedEditor({ name: 'plan.txt', parked: { open: () => {}, available: async () => true }, discard: discardB });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    fireEvent.click(screen.getByRole('button', { name: 'Discard and quit' }));
    expect(screen.getByText('Discard unsaved changes to 2 files?')).toBeInTheDocument();
    expect(discardA).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard and quit' })); // the confirm
    expect(discardA).toHaveBeenCalled();
    expect(discardB).toHaveBeenCalled();
    // main heard "nothing unsaved" BEFORE it was told to go on
    const order = [...office.setOtherUnsaved.mock.invocationCallOrder].pop()!;
    expect(office.setOtherUnsaved).toHaveBeenLastCalledWith([]);
    expect(office.proceedClose.mock.invocationCallOrder[0]).toBeGreaterThan(order);
  });

  it('after teardown it says the chats stopped, and that a restart became a quit', () => {
    const { prompt } = bridge();
    holdUnsavedEditor({ name: 'notes.md', discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt({ afterTeardown: true, restartDropped: true });
    expect(screen.getByText('Your chats have stopped. Save the file, then quit again. YouCoded will quit instead of restarting.')).toBeInTheDocument();
  });

  it("the last window's close says close, not quit", () => {
    const { prompt } = bridge();
    holdUnsavedEditor({ name: 'notes.md', discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt({ mode: 'close' });
    expect(screen.getByText('Save it, then close the window again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard and close' })).toBeInTheDocument();
  });

  it('discards only what was listed when the person chose to; a newer edit stays', () => {
    const { prompt } = bridge();
    const listedDiscard = vi.fn();
    const laterDiscard = vi.fn();
    holdUnsavedEditor({ name: 'notes.md', discard: listedDiscard });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    fireEvent.click(screen.getByRole('button', { name: 'Discard and quit' }));
    act(() => { holdUnsavedEditor({ name: 'late.txt', discard: laterDiscard }); });
    fireEvent.click(screen.getByRole('button', { name: 'Discard and quit' }));
    expect(listedDiscard).toHaveBeenCalled();
    expect(laterDiscard).not.toHaveBeenCalled();
  });

  it('dismissing it (OK) tells main to forget what it held', () => {
    const { office, prompt } = bridge();
    (office as unknown as { dismissPrompt: () => void }).dismissPrompt = vi.fn();
    holdUnsavedEditor({ name: 'notes.md', discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect((office as unknown as { dismissPrompt: () => void }).dismissPrompt).toHaveBeenCalled();
  });
});
