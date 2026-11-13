// @vitest-environment jsdom
// WHY (error inventory 2026-09-10, Settings row 95): a failed read of the search options emptied the
// list, so the Tavily and Exa rows quietly vanished with nothing said.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen, waitFor } from '@testing-library/react';
import { SearchProvidersBlock } from '../src/renderer/components/ModelProvidersPopup';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Web search options when the read fails', () => {
  it('says it could not load, offers Try again, and brings the rows back after it', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('service down'))
      .mockResolvedValue([{ id: 'tavily', label: 'Tavily', hasKey: false }]);
    (globalThis as any).window.claude = { search: { list } };
    render(<SearchProvidersBlock />);
    await waitFor(() => expect(screen.getByText(/Couldn't load the search options/)).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText('Try again')); });
    await waitFor(() => expect(screen.getByText('Tavily')).toBeTruthy());
    expect(screen.queryByText(/Couldn't load the search options/)).toBeNull();
  });
});
