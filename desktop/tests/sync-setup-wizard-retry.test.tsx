// @vitest-environment jsdom
// Final review F34: when the GitHub repo was created but saving the backup then failed, Try again
// created the same repo again — GitHub refuses a name that already exists, and the raw error showed
// for a repo that was already the person's. Try again reuses the repo this wizard made.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import SyncSetupWizard from '../src/renderer/components/SyncSetupWizard';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('SyncSetupWizard — Try again after the GitHub repo was made', () => {
  it('saves again with the repo already made, and never asks GitHub to make it twice', async () => {
    const createRepo = vi.fn(async (name: string) => ({ success: true, repoUrl: `https://github.com/me/${name}` }));
    (window as any).claude = { sync: { setup: {
      checkPrereqs: vi.fn(async () => ({ ghInstalled: true, ghAuthenticated: true, ghUsername: 'me' })),
      createRepo,
    } } };
    const onComplete = vi.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(<SyncSetupWizard initialType="github" existingBackends={[]} onComplete={onComplete} onClose={onClose} />);

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'My GitHub' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start backup' }));
    await screen.findByText(/disk full/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(createRepo).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete.mock.calls[1][0].config.PERSONAL_SYNC_REPO).toBe(onComplete.mock.calls[0][0].config.PERSONAL_SYNC_REPO);
  });
});
