// @vitest-environment jsdom
// A window tells main whether a text editor in it has unsaved edits, so a quit can be refused
// before anything is torn down; the refusal shows as an in-app message in that window.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { holdUnsavedEditor } from '../src/renderer/state/unsaved-editors';
import { resetOfficeStoreForTests } from '../src/renderer/components/office/office-store';
import { OfficeAlerts } from '../src/renderer/components/office/OfficeAlerts';

afterEach(() => { resetOfficeStoreForTests(); delete (window as unknown as { claude?: unknown }).claude; });

describe('unsaved non-Office editors', () => {
  it('reports "any unsaved" to main only when it changes', () => {
    const setOtherUnsaved = vi.fn();
    (window as unknown as { claude: unknown }).claude = { office: { setOtherUnsaved } };
    const a = holdUnsavedEditor();
    const b = holdUnsavedEditor();
    a();
    expect(setOtherUnsaved.mock.calls).toEqual([[true]]);
    b();
    expect(setOtherUnsaved.mock.calls).toEqual([[true], [false]]);
  });

  it('a draft parked after its editor went away holds the mark until it is taken back or cleared', async () => {
    const setOtherUnsaved = vi.fn();
    (window as unknown as { claude: unknown }).claude = { office: { setOtherUnsaved } };
    const { stashDraft, takeDraft, clearDraft } = await import('../src/renderer/components/artifact-views/draft-store');
    stashDraft('a', { draft: 'x', mtimeMs: null });
    stashDraft('b', { draft: 'y', mtimeMs: null });
    expect(setOtherUnsaved.mock.calls).toEqual([[true]]);
    takeDraft('a');
    expect(setOtherUnsaved.mock.calls).toEqual([[true]]); // 'b' is still parked
    clearDraft('b');
    expect(setOtherUnsaved.mock.calls).toEqual([[true], [false]]);
  });

  it('shows the refused-quit message with just OK', async () => {
    let prompt!: (p: { count: number; firstPath: string; other?: boolean }) => void;
    (window as unknown as { claude: unknown }).claude = { office: {
      onFlushRequest: vi.fn(), flushDone: vi.fn(), onUnsavedPrompt: vi.fn((cb: typeof prompt) => { prompt = cb; }),
    } };
    render(<OfficeAlerts onReview={() => {}} />);
    act(() => prompt({ count: 0, firstPath: '', other: true }));
    expect(screen.getByText('A file has unsaved changes.')).toBeInTheDocument();
    expect(screen.getByText('Save it, then quit again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close anyway' })).toBeNull();
  });
});
