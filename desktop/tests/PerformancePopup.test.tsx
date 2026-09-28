// @vitest-environment jsdom
// The Performance popup's "Restart now": a restart is an ordinary quit now, which an unsaved
// Office document can hold (Review cancels it), so the button comes back when the call returns.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import PerformancePopup from '../src/renderer/components/PerformancePopup';

describe('PerformancePopup', () => {
  it('shows "Restarting…" while the restart is asked for, then restores the button', async () => {
    let answer!: () => void;
    const restart = vi.fn(() => new Promise<void>((r) => (answer = r)));
    render(<PerformancePopup onClose={() => {}} saved gpuList={[]} needsRestart setPreferPowerSaving={async () => {}} restart={restart} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(screen.getByRole('button', { name: 'Restarting…' })).toBeDisabled();
    await act(async () => { answer(); });
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeEnabled();
  });
});
