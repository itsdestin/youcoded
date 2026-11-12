// @vitest-environment jsdom
// WHY (error inventory 2026-09-10, Settings rows 59 and 96): when the installed or recommended model
// list could not be read, the groups silently vanished and downloaded models looked gone.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen, waitFor } from '@testing-library/react';
import { LocalModelBrowser } from '../src/renderer/components/LocalModelsSection';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Local models list when a read fails', () => {
  it('says the list did not load, offers Try again, and does not say no models match', async () => {
    const installed = vi.fn()
      .mockRejectedValueOnce(new Error('disk unreadable'))
      .mockResolvedValue([]);
    (globalThis as any).window.claude = {
      native: { supported: true },
      models: {
        installed,
        curated: vi.fn().mockResolvedValue([]),
        onDownloadProgress: vi.fn().mockReturnValue(() => {}),
      },
    };
    render(<LocalModelBrowser />);
    await waitFor(() => expect(screen.getByText(/Couldn't load the model list/)).toBeTruthy());
    expect(screen.queryByText(/No models match/)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByText('Try again')); });
    await waitFor(() => expect(screen.queryByText(/Couldn't load the model list/)).toBeNull());
    expect(installed).toHaveBeenCalledTimes(2);
  });
});
