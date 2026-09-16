// @vitest-environment jsdom
// repo-card-page-structure.test.tsx — the recommended-model card's expand
// trigger must not be a <button> wrapped around another <button>.
//
// WHY. The size figure on a recommended row opens the "What this needs" bubble
// from its own button, and that figure sits inside the row's expand control. As
// long as that control was itself a <button>, the page was invalid HTML: React
// printed two errors every time Model Providers opened, browsers are free to
// rearrange the nesting, and the inner button can stop receiving its own
// presses — which would take the size breakdown (contract R20/R21, and two
// sentences Destin signed off) with it.
import React, { useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { RepoCard } from '../src/renderer/components/LocalModelsSection';
import type { FitEstimate } from '../src/shared/model-manager-types';

const FIT: FitEstimate = {
  fit: 'tight',
  label: 'Will be tight — close other apps first',
  breakdown: { modelBytes: 5_100_000_000, contextBytes: 540_000_000, contextLength: 32768 },
} as FitEstimate;

const QUANT = {
  quant: 'UD-Q4_K_XL', totalSizeBytes: 5_100_000_000, files: ['m.gguf'],
  sha256ByFile: {}, fit: FIT, visionBytes: 900_000_000,
};

function Host({ onToggle }: { onToggle: () => void }) {
  const ref = useRef<Record<string, any>>({});
  return (
    <RepoCard
      repo="unsloth/Gemma-4-12B-GGUF" label="Gemma 4 12B" autoResolve
      downloads={{}} quantOptsByKeyRef={ref as any} expanded={false} onToggle={onToggle}
    />
  );
}

beforeEach(() => {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    models: { quants: vi.fn().mockResolvedValue([QUANT]), download: vi.fn() },
  };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the recommended-model card is valid HTML', () => {
  it('renders without React reporting invalid page structure', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(String(a[0])); });
    render(<Host onToggle={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('repo-size-line')).toBeTruthy());
    spy.mockRestore();
    const nesting = errors.filter((e) => /validateDOMNesting|cannot (?:be a descendant|contain a nested)/i.test(e));
    expect(nesting, `React complained: ${nesting.join(' | ')}`).toHaveLength(0);
  });

  it('the size figure’s button has no <button> anywhere above it', async () => {
    render(<Host onToggle={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('repo-size-line')).toBeTruthy());
    const figure = screen.getByLabelText(/is made of$/);
    expect(figure.tagName).toBe('BUTTON');
    // From the PARENT upwards — `closest` on the figure itself would just find
    // the figure and pass no matter what is above it.
    expect(figure.parentElement!.closest('button'), 'no <button> ancestor').toBeNull();
  });

  it('the row still expands when you click it, and when you press Enter on it', async () => {
    const onToggle = vi.fn();
    render(<Host onToggle={onToggle} />);
    await waitFor(() => expect(screen.getByTestId('repo-size-line')).toBeTruthy());
    const row = screen.getByRole('button', { expanded: false });
    fireEvent.click(row);
    expect(onToggle, 'click expands').toHaveBeenCalledTimes(1);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onToggle, 'Enter expands').toHaveBeenCalledTimes(2);
    fireEvent.keyDown(row, { key: ' ' });
    expect(onToggle, 'Space expands').toHaveBeenCalledTimes(3);
  });

  it('pressing Enter on the size figure does NOT collapse the row underneath it', async () => {
    const onToggle = vi.fn();
    render(<Host onToggle={onToggle} />);
    await waitFor(() => expect(screen.getByTestId('repo-size-line')).toBeTruthy());
    fireEvent.keyDown(screen.getByLabelText(/is made of$/), { key: 'Enter', bubbles: true });
    expect(onToggle).not.toHaveBeenCalled();
  });
});
