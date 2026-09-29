// @vitest-environment jsdom
// Unsaved non-Office edits (open text editors, parked drafts): the window tells main their file
// names so a quit — or the last window's close — can be refused before anything is torn down,
// and the refused prompt lists them with a way to open each parked draft or discard them all.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { holdUnsavedEditor, resetUnsavedEditorsForTests, type ParkedSaveResult } from '../src/renderer/state/unsaved-editors';
import { resetOfficeStoreForTests } from '../src/renderer/components/office/office-store';
import { OfficeAlerts } from '../src/renderer/components/office/OfficeAlerts';
import { clearDraft, draftKey, settleDraft, stashDraft, takeDraft } from '../src/renderer/components/artifact-views/draft-store';
import { saveParkedDraft } from '../src/renderer/components/artifact-views/ActiveArtifactView';
import { draftFileEditable } from '../src/renderer/components/artifact-views/edit-permission';
import type { ArtifactRecord } from '../src/shared/artifacts/types';
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
  const parked = (save: (force?: boolean) => Promise<ParkedSaveResult>, available = true) => ({ available: async () => available, save });

  it('lists the files: an open editor is noted, a parked draft offers Save, a gone one offers Discard only', async () => {
    const { prompt } = bridge();
    holdUnsavedEditor({ name: 'notes.md', discard: () => {} });
    holdUnsavedEditor({ name: 'plan.txt', parked: parked(async () => ({ ok: true })), discard: () => {} });
    const goneDiscard = vi.fn();
    holdUnsavedEditor({ name: 'old.txt', parked: parked(async () => ({ ok: true }), false), discard: goneDiscard });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    expect(screen.getByText('3 files have unsaved changes.')).toBeInTheDocument();
    expect(screen.getByText('(open in this window)')).toBeInTheDocument();
    expect(await screen.findByText('(file no longer available)')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1); // plan.txt only
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(goneDiscard).toHaveBeenCalled();
  });

  it('Save saves the parked draft; on success its row goes', async () => {
    const { prompt } = bridge();
    let release!: () => void;
    const save = vi.fn(async () => { release(); return { ok: true as const }; });
    release = holdUnsavedEditor({ name: 'plan.txt', parked: parked(save), discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByText('plan.txt')).toBeNull());
    expect(save).toHaveBeenCalledWith(false);
  });

  it('a file changed on disk: says so, then Save anyway asks before replacing it', async () => {
    const { prompt } = bridge();
    const save = vi.fn(async (force?: boolean) => (force ? { ok: true as const } : { conflict: true as const }));
    holdUnsavedEditor({ name: 'plan.txt', parked: parked(save), discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Changed on disk since — save anyway or discard.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    expect(screen.getByText('Replace the file on disk with your version?')).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(true));
  });

  it('a failed save shows its own reason and keeps the draft', async () => {
    const { prompt } = bridge();
    const discard = vi.fn();
    holdUnsavedEditor({ name: 'plan.txt', parked: parked(async () => ({ error: "Save failed: this folder can't be written to." })), discard });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText("Save failed: this folder can't be written to.")).toBeInTheDocument();
    expect(screen.getByText('plan.txt')).toBeInTheDocument();
    expect(discard).not.toHaveBeenCalled();
  });

  it('Discard and quit asks in place, then throws the edits away and lets main go on', () => {
    const { office, prompt } = bridge();
    const discardA = vi.fn();
    const discardB = vi.fn();
    holdUnsavedEditor({ name: 'notes.md', discard: discardA });
    holdUnsavedEditor({ name: 'plan.txt', parked: { available: async () => true, save: async () => ({ ok: true as const }) }, discard: discardB });
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


describe('saving a parked draft (the editor\'s own save path)', () => {
  const artifact = { id: 'notes.md', path: 'notes.md', kind: 'internal', absolutePath: null } as unknown as ArtifactRecord;
  const base = { projectRoot: '/p', projectId: 'p', projectName: 'p', artifact, sessionId: 's1', draft: 'new text' };
  const withSave = (res: unknown) => {
    const save = vi.fn(async () => res);
    (window as unknown as { claude: unknown }).claude = { office: { setOtherUnsaved: vi.fn() }, artifacts: { save } };
    return save;
  };
  it('saves with the draft\'s token and clears the draft on success', async () => {
    const save = withSave({ ok: true, mtimeMs: 2 });
    stashDraft(draftKey('/p', 'notes.md'), { draft: 'new text', mtimeMs: 1, name: 'notes.md' });
    await expect(saveParkedDraft({ ...base, baseMtimeMs: 1 })).resolves.toEqual({ ok: true });
    expect(save).toHaveBeenCalledWith('/p', 'p', 'p', 'notes.md', 'new text', 's1', { baseMtimeMs: 1 });
    expect(takeDraft(draftKey('/p', 'notes.md'))).toBeUndefined();
  });
  it('reports a conflict, and a failure with its reason; the draft stays', async () => {
    withSave({ ok: false, error: 'conflict' });
    stashDraft(draftKey('/p', 'notes.md'), { draft: 'new text', mtimeMs: 1, name: 'notes.md' });
    await expect(saveParkedDraft({ ...base, baseMtimeMs: 1 })).resolves.toEqual({ conflict: true });
    withSave({ ok: false, error: 'protected-path' });
    const r = await saveParkedDraft({ ...base, baseMtimeMs: 1 });
    expect('error' in r && r.error).toMatch(/protected/);
    expect(takeDraft(draftKey('/p', 'notes.md'))?.draft).toBe('new text');
    clearDraft(draftKey('/p', 'notes.md'));
  });
  it('never saves blind without a token: that is a possible conflict; Save anyway overwrites', async () => {
    const save = withSave({ ok: true });
    await expect(saveParkedDraft({ ...base, baseMtimeMs: null })).resolves.toEqual({ conflict: true, unknown: true });
    expect(save).not.toHaveBeenCalled();
    await saveParkedDraft({ ...base, baseMtimeMs: null, force: true });
    expect(save).toHaveBeenCalledWith('/p', 'p', 'p', 'notes.md', 'new text', 's1', {});
  });
});

describe('whether a parked draft can still go to its file', () => {
  const artifact = { id: 'notes.md', path: 'notes.md', kind: 'internal', absolutePath: null } as unknown as ArtifactRecord;
  const answer = (res: unknown) => { (window as unknown as { claude: unknown }).claude = { artifacts: { get: vi.fn(async () => res) } }; };
  it('only for an editable text file: not missing, binary, too large, drawn from bytes, or protected', async () => {
    answer({ ok: true, content: 'hi', sizeBytes: 2 });
    await expect(draftFileEditable('/p', artifact)).resolves.toBe(true);
    answer({ ok: true, content: null, orphan: true });
    await expect(draftFileEditable('/p', artifact)).resolves.toBe(false);
    answer({ ok: true, content: 'x', binary: true });
    await expect(draftFileEditable('/p', artifact)).resolves.toBe(false);
    answer({ ok: true, content: 'x', sizeBytes: 50 * 1024 * 1024 });
    await expect(draftFileEditable('/p', artifact)).resolves.toBe(false);
    answer({ ok: true, content: 'x', sizeBytes: 1 });
    await expect(draftFileEditable('/p', { ...artifact, id: 'a.png', path: 'a.png' })).resolves.toBe(false);
    await expect(draftFileEditable('/p', { ...artifact, id: '.git/config', path: '.git/config' })).resolves.toBe(false);
    (window as unknown as { claude: unknown }).claude = { artifacts: { get: vi.fn(async () => { throw new Error('x'); }) } };
    await expect(draftFileEditable('/p', artifact)).resolves.toBe(false);
  });
});
