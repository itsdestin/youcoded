// @vitest-environment jsdom
// Unsaved non-Office edits (open text editors, parked drafts): the window tells main their file
// names so a quit — or the last window's close — can be refused before anything is torn down,
// and the refused prompt lists them with a way to open each parked draft or discard them all.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { holdUnsavedEditor, resetUnsavedEditorsForTests, type DraftFileStatus, type ParkedSaveOptions, type ParkedSaveResult } from '../src/renderer/state/unsaved-editors';
import { resetOfficeStoreForTests } from '../src/renderer/components/office/office-store';
import { OfficeAlerts } from '../src/renderer/components/office/OfficeAlerts';
import { clearDraft, draftKey, settleDraft, stashDraft, takeDraft } from '../src/renderer/components/artifact-views/draft-store';
import { saveParkedDraft } from '../src/renderer/components/artifact-views/ActiveArtifactView';
import { draftFileStatus } from '../src/renderer/components/artifact-views/edit-permission';
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
  const parked = (save: (o?: ParkedSaveOptions) => Promise<ParkedSaveResult>, available: DraftFileStatus = 'editable') => ({ available: async () => available, save });

  it('lists the files: an open editor is noted, a parked draft offers Save, a gone one offers Discard only (asked first)', async () => {
    const { prompt } = bridge();
    holdUnsavedEditor({ name: 'notes.md', discard: () => {} });
    holdUnsavedEditor({ name: 'plan.txt', parked: parked(async () => ({ ok: true })), discard: () => {} });
    const goneDiscard = vi.fn();
    holdUnsavedEditor({ name: 'old.txt', parked: parked(async () => ({ ok: true }), 'gone'), discard: goneDiscard });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    expect(screen.getByText('3 files have unsaved changes.')).toBeInTheDocument();
    expect(screen.getByText('(open in this window)')).toBeInTheDocument();
    expect(await screen.findByText('(file no longer available)')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1); // plan.txt only
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByText('Discard your changes to this file?')).toBeInTheDocument();
    expect(goneDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('(file no longer available)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' })); // the confirm
    expect(goneDiscard).toHaveBeenCalled();
  });

  it('a check that could not read the file shows why, with Retry — not "no longer available"', async () => {
    const { prompt } = bridge();
    let answer: DraftFileStatus = { error: 'YouCoded couldn’t read this file: permission denied.' };
    holdUnsavedEditor({ name: 'plan.txt', parked: { available: async () => answer, save: async () => ({ ok: true as const }) }, discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    expect(await screen.findByText('YouCoded couldn’t read this file: permission denied.')).toBeInTheDocument();
    expect(screen.queryByText('(file no longer available)')).toBeNull();
    answer = 'editable';
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('a check that failed outright shows a general sentence with Retry, never the raw error', async () => {
    const { prompt } = bridge();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    holdUnsavedEditor({ name: 'plan.txt', parked: { available: () => Promise.reject(new Error("Error invoking remote method 'artifacts:get': /home/you/secret")), save: async () => ({ ok: true as const }) }, discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    expect(await screen.findByText("YouCoded couldn't read this file.")).toBeInTheDocument();
    expect(screen.queryByText(/secret|remote method/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('when nothing is left unsaved it says so, and Quit goes on only when pressed', async () => {
    const { office, prompt } = bridge();
    let release!: () => void;
    release = holdUnsavedEditor({ name: 'plan.txt', parked: parked(async () => { release(); return { ok: true as const }; }), discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Nothing left unsaved here.')).toBeInTheDocument();
    expect(office.proceedClose).not.toHaveBeenCalled(); // nothing automatic
    expect(screen.queryByRole('button', { name: /Discard/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Quit' }));
    expect(office.proceedClose).toHaveBeenCalledTimes(1);
  });

  it('Discard-all waits while a save is running', async () => {
    const { prompt } = bridge();
    let finish!: () => void;
    holdUnsavedEditor({ name: 'plan.txt', parked: parked(() => new Promise((r) => { finish = () => r({ error: 'x' }); })), discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Discard and quit' })).toBeDisabled();
    await act(async () => { finish(); });
    expect(screen.getByRole('button', { name: 'Discard and quit' })).toBeEnabled();
  });

  it('a settings file whose change can\'t be checked: yes, Save anyway, Replace — it saves (no loop)', async () => {
    const { prompt } = bridge();
    let release!: () => void;
    const save = vi.fn(async (o?: ParkedSaveOptions) => {
      if (!o?.confirmed) return { needsConfirm: true as const };
      if (!o.force) return { conflict: true as const, unknown: true };
      release(); // saved: its draft (and mark) goes
      return { ok: true as const };
    });
    release = holdUnsavedEditor({ name: 'settings.json', parked: parked(save), discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save anyway' })); // the settings question
    expect(await screen.findByText('YouCoded can’t tell whether this file changed on disk — save anyway or discard.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ force: true, confirmed: true }));
    expect(await screen.findByText('Nothing left unsaved here.')).toBeInTheDocument();
  });

  it('a file in a protected location offers Discard only', async () => {
    const { prompt } = bridge();
    holdUnsavedEditor({ name: 'id_rsa', parked: parked(async () => ({ ok: true as const }), 'protected'), discard: () => {} });
    holdUnsavedEditor({ name: 'key.txt', parked: parked(async () => ({ protected: true as const })), discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    fireEvent.click(await screen.findByRole('button', { name: 'Save' })); // key.txt: main refuses it as protected
    await waitFor(() => expect(screen.getAllByText('(file can’t be saved here)')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Discard' })).toHaveLength(2);
  });

  it('keeps the restart note once everything is saved', async () => {
    const { prompt } = bridge();
    render(<OfficeAlerts onReview={() => {}} />);
    prompt({ afterTeardown: true, restartDropped: true });
    expect(screen.getByText('Nothing left unsaved here.')).toBeInTheDocument();
    expect(screen.getByText('YouCoded will quit instead of restarting.')).toBeInTheDocument();
  });

  it('a settings file asks inline before it is saved', async () => {
    const { prompt } = bridge();
    const save = vi.fn(async (o?: ParkedSaveOptions) => (o?.confirmed ? { ok: true as const } : { needsConfirm: true as const }));
    holdUnsavedEditor({ name: 'settings.json', parked: parked(save), discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This is a settings file. Save anyway?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ confirmed: true }));
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
    expect(save).toHaveBeenCalledWith({});
  });

  it('a file changed on disk: says so, then Save anyway asks before replacing it', async () => {
    const { prompt } = bridge();
    const save = vi.fn(async (o?: ParkedSaveOptions) => (o?.force ? { ok: true as const } : { conflict: true as const, unknown: true }));
    holdUnsavedEditor({ name: 'plan.txt', parked: parked(save), discard: () => {} });
    render(<OfficeAlerts onReview={() => {}} />);
    prompt();
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    const unknownText = 'YouCoded can’t tell whether this file changed on disk — save anyway or discard.';
    expect(await screen.findByText(unknownText)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    expect(screen.getByText('Replace the file on disk with your version?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); // back, with the same (accurate) wording
    expect(screen.getByText(unknownText)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ force: true }));
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
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument(); // per-row discard offered
  });

  it('Discard and quit asks in place, then throws the edits away and lets main go on', () => {
    const { office, prompt } = bridge();
    const discardA = vi.fn();
    const discardB = vi.fn();
    holdUnsavedEditor({ name: 'notes.md', discard: discardA });
    holdUnsavedEditor({ name: 'plan.txt', parked: { available: async () => 'editable' as const, save: async () => ({ ok: true as const }) }, discard: discardB });
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
    withSave({ ok: false, error: 'disk-full' });
    const r = await saveParkedDraft({ ...base, baseMtimeMs: 1 });
    expect('error' in r && r.error).toMatch(/disk-full/);
    expect(takeDraft(draftKey('/p', 'notes.md'))?.draft).toBe('new text');
    clearDraft(draftKey('/p', 'notes.md'));
  });
  it('judges a settings file on its resolved path and asks first', async () => {
    const save = withSave({ ok: true });
    await expect(saveParkedDraft({ ...base, baseMtimeMs: 1, resolvedPath: '/home/you/.claude/settings.json' })).resolves.toEqual({ needsConfirm: true });
    expect(save).not.toHaveBeenCalled();
    await saveParkedDraft({ ...base, baseMtimeMs: 1, resolvedPath: '/home/you/.claude/settings.json', confirmed: true });
    expect(save).toHaveBeenCalledWith('/p', 'p', 'p', 'notes.md', 'new text', 's1', { baseMtimeMs: 1, confirmed: true });
  });

  it("maps main's needs-confirm and protected-path answers to the prompt's own states", async () => {
    withSave({ ok: false, error: 'needs-confirm' });
    await expect(saveParkedDraft({ ...base, baseMtimeMs: 1 })).resolves.toEqual({ needsConfirm: true });
    withSave({ ok: false, error: 'protected-path' });
    await expect(saveParkedDraft({ ...base, baseMtimeMs: 1 })).resolves.toEqual({ protected: true });
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
  it("is 'gone' only when missing or not editable; any other failed read says why", async () => {
    answer({ ok: true, content: 'hi', sizeBytes: 2 });
    await expect(draftFileStatus('/p', artifact)).resolves.toBe('editable');
    answer({ ok: true, content: null, orphan: true });
    await expect(draftFileStatus('/p', artifact)).resolves.toBe('gone');
    answer({ ok: true, content: 'x', binary: true });
    await expect(draftFileStatus('/p', artifact)).resolves.toBe('gone');
    answer({ ok: true, content: 'x', sizeBytes: 50 * 1024 * 1024 });
    await expect(draftFileStatus('/p', artifact)).resolves.toBe('gone');
    answer({ ok: true, content: 'x', sizeBytes: 1 });
    await expect(draftFileStatus('/p', { ...artifact, id: 'a.png', path: 'a.png' })).resolves.toBe('gone');
    await expect(draftFileStatus('/p', { ...artifact, id: '.git/config', path: '.git/config' })).resolves.toBe('gone');
    answer({ ok: false, error: 'protected-path' });
    await expect(draftFileStatus('/p', artifact)).resolves.toBe('protected');
    answer({ ok: false, error: 'read-failed', code: 'EACCES' });
    await expect(draftFileStatus('/p', artifact)).resolves.toMatchObject({ error: expect.any(String) });
  });

  // Final review, finding 5: a request that failed outright carries a raw message (it can name
  // folders); the person sees a general sentence, and the detail goes to the log.
  it('says only that the file could not be read when the request itself fails, and logs why', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as unknown as { claude: unknown }).claude = { artifacts: { get: vi.fn(async () => { throw new Error("EACCES: open '/home/you/secret/notes.md'"); }) } };
    await expect(draftFileStatus('/p', artifact)).resolves.toEqual({ error: "YouCoded couldn't read this file." });
    expect(quiet).toHaveBeenCalled();
    expect(String(quiet.mock.calls[0])).toContain('/home/you/secret');
    quiet.mockRestore();
  });
});
