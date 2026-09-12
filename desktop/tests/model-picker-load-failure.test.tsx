// @vitest-environment jsdom
/**
 * "You have not set up any model providers" means none are set up — not that the list
 * could not be read.
 *
 * Error inventory 2026-09-10, false message 9. ModelPicker loads providers and the model
 * catalog with `.catch(() => [])` on each call, so a failed load produced no rows,
 * `anyPickable` went false, and a native-only picker (a native session's model dialog,
 * Resume options) told someone with providers configured that they had none — and
 * offered "Add provider" for things they already had. A remote timeout reaches this too.
 * Pickers that include Claude were spared only because Claude rows survive a failed load.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import ModelPicker from '../src/renderer/components/model/ModelPicker';

function bridge(list: ReturnType<typeof vi.fn>, catalog: ReturnType<typeof vi.fn>) {
  (globalThis as any).window.claude = {
    providers: { list, catalog },
    models: { onDownloadProgress: () => () => {} },
  };
}

const openPanel = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Model' }));
};

beforeEach(() => { (globalThis as any).window = (globalThis as any).window ?? {}; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as any).claude; });

describe('ModelPicker — a failed provider load is not "no providers set up"', () => {
  it('a provider list that failed says it could not load, with Retry', async () => {
    bridge(
      vi.fn().mockRejectedValue(new Error("Error invoking remote method 'providers:list': Error: config unreadable")),
      vi.fn().mockResolvedValue([]),
    );
    render(<ModelPicker value={null} onSelect={() => {}} includeClaude={false} />);
    await openPanel();

    expect(await screen.findByText(/couldn.t load your models/i)).toBeInTheDocument();
    expect(screen.queryByText('You have not set up any model providers.')).toBeNull();
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('a catalog that failed says so too', async () => {
    bridge(
      vi.fn().mockResolvedValue([{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', ready: true }]),
      vi.fn().mockRejectedValue(new Error('Request providers:catalog timed out')),
    );
    render(<ModelPicker value={null} onSelect={() => {}} includeClaude={false} />);
    await openPanel();

    expect(await screen.findByText(/couldn.t load your models/i)).toBeInTheDocument();
    expect(screen.queryByText('You have not set up any model providers.')).toBeNull();
  });

  it('Retry loads again, and a real empty result may then say none are set up', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('not readable')).mockResolvedValue([]);
    bridge(list, vi.fn().mockResolvedValue([]));
    render(<ModelPicker value={null} onSelect={() => {}} includeClaude={false} />);
    await openPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('You have not set up any model providers.')).toBeInTheDocument();
  });
});
