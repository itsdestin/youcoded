// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PartialFileBanner } from '../src/renderer/components/artifact-views/PartialFileBanner';

afterEach(cleanup);

// Sizes are MiB-based, matching every existing size string in the app (the
// message Destin saw called his 2,411,724-byte file "2.3 MB"). The bar shares
// its width with a button, so the copy is a label plus a fraction, not a
// sentence.
describe('PartialFileBanner', () => {
  it('states how much of how much, so the notice is information not a refusal', () => {
    render(<PartialFileBanner sizeBytes={8.4 * 1024 * 1024} onLoadFull={() => {}} onOpenExternally={() => {}} />);
    expect(screen.getByText(/Large file/)).toBeInTheDocument();
    expect(screen.getByText(/Showing 3\.0\/8\.4 MB/)).toBeInTheDocument();
  });

  it('offers to load the rest while the file is under the full-read ceiling', () => {
    render(<PartialFileBanner sizeBytes={4 * 1024 * 1024} onLoadFull={() => {}} onOpenExternally={() => {}} />);
    expect(screen.getByRole('button', { name: /load the whole file/i })).toBeInTheDocument();
  });

  it('swaps to the external handoff above the ceiling', () => {
    render(<PartialFileBanner sizeBytes={500 * 1024 * 1024} onLoadFull={() => {}} onOpenExternally={() => {}} />);
    expect(screen.queryByRole('button', { name: /load the whole file/i })).toBeNull();
    expect(screen.getByRole('button', { name: /open externally/i })).toBeInTheDocument();
  });

  // A button that silently does nothing is worse than no button (spec §4.3).
  it('offers no action at all on a platform without shell.openPath', () => {
    (window as any).__PLATFORM__ = 'browser';
    render(<PartialFileBanner sizeBytes={500 * 1024 * 1024} onLoadFull={() => {}} onOpenExternally={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
    (window as any).__PLATFORM__ = 'electron';
  });
});
