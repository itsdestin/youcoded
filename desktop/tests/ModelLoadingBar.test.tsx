// @vitest-environment jsdom
// The strip above the message box while a local model loads.
//
// WHY: on a GPU build the byte reading used to sit near zero for a whole load,
// and the "stopped growing" rule then said "finishing up" for 10-30 s while
// almost nothing had loaded. A pause early in a load must stay "Loading".
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, screen } from '@testing-library/react';
import ModelLoadingBar from '../src/renderer/components/ModelLoadingBar';

const GB = 1024 ** 3;
const info = { modelId: 'Qwen3.8-27B-UD-Q8_K_XL', sizeBytes: 30 * GB };

function bar(loadedBytes: number) {
  return (
    <ModelLoadingBar modelState="loading" modelInfo={info} loadedBytes={loadedBytes}
      everResident={false} isThinking={false} onReload={() => {}} />
  );
}

afterEach(() => { vi.useRealTimers(); });

describe('ModelLoadingBar', () => {
  it('a pause early in a load still reads "Loading", not "finishing up"', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { rerender } = render(bar(0.2 * GB));
    rerender(bar(0.3 * GB));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText('Loading')).toBeTruthy();
    expect(screen.queryByText(/finishing up/)).toBeNull();
  });

  it('a pause once the file is nearly all read switches to "finishing up"', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { rerender } = render(bar(10 * GB));
    rerender(bar(28 * GB));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText(/finishing up/)).toBeTruthy();
  });

  it('shows time left once it has a steady reading speed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { rerender } = render(bar(0.1 * GB));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    // 6 GB in ~4 s → 24 GB left at that speed is about 15-20 s.
    rerender(bar(6 * GB));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText(/about \d+s left/)).toBeTruthy();
  });
});
