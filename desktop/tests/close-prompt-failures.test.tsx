// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import CloseSessionPrompt from '../src/renderer/components/CloseSessionPrompt';
import { applyCloseChoices } from '../src/renderer/state/close-prompt-writes';
import { resetFailureDedupeForTests } from '../src/renderer/utils/report-failure';

// R-1 batch 1: a tag / pin / note the person chose must never vanish when the chat closes.
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { resetFailureDedupeForTests(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const choices = { flags: { priority: true }, addTagIds: ['t1'], removeTagIds: [], note: 'hi', noteChanged: true };

describe('applyCloseChoices', () => {
  it('names only the parts that failed, in plain words', async () => {
    (window as any).claude = { session: {
      setFlag: vi.fn().mockResolvedValue(undefined),
      setTag: vi.fn().mockRejectedValue(new Error('disk full')),
      setNote: vi.fn().mockRejectedValue(new Error('disk full')),
    } };
    expect(await applyCloseChoices('s', choices)).toEqual(['tags', 'note']);
  });
  it('reports nothing when every write lands, and ignores a phone that cannot do it at all', async () => {
    (window as any).claude = { session: { setFlag: vi.fn().mockResolvedValue(undefined), setTag: vi.fn().mockResolvedValue(undefined), setNote: vi.fn().mockResolvedValue(undefined) } };
    expect(await applyCloseChoices('s', choices)).toEqual([]);
    (window as any).claude.session.setNote = vi.fn().mockRejectedValue(new Error('remote-unsupported: session:set-note'));
    expect(await applyCloseChoices('s', choices)).toEqual([]);
  });
});

describe('CloseSessionPrompt when a write failed', () => {
  it('stays open with the red notice and Try again, and closes once the retry works', async () => {
    (window as any).claude = {
      session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', supported: true, flags: {} }) },
      tags: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), delete: vi.fn() }, on: {},
    };
    const onConfirm = vi.fn().mockResolvedValueOnce(['tags', 'note']).mockResolvedValueOnce([]);
    render(<CloseSessionPrompt open sessionName="x" sessionId="s" onCancel={() => {}} onCloseAnyway={() => {}} onConfirm={onConfirm} />);
    await screen.findByText(/no tags/i);
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    expect(await screen.findByText('Couldn’t save tags and note. This chat is still open.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Couldn’t save/)).toBeNull());
  });

  it('offers Close anyway, which closes without writing again, so a save that keeps failing never traps the chat', async () => {
    (window as any).claude = {
      session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', supported: true, flags: {} }) },
      tags: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), delete: vi.fn() }, on: {},
    };
    const onConfirm = vi.fn().mockResolvedValue(['note']);
    const onCloseAnyway = vi.fn();
    render(<CloseSessionPrompt open sessionName="x" sessionId="s" onCancel={() => {}} onCloseAnyway={onCloseAnyway} onConfirm={onConfirm} />);
    await screen.findByText(/no tags/i);
    expect(screen.queryByRole('button', { name: 'Close anyway' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close anyway' }));
    expect(onCloseAnyway).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
