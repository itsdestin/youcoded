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

  // Destin's N1: a failed save is said inside the popup, next to the toggle; it clears when the retry works.
  it('says "Couldn\'t save the power saving setting" with Try again when the save rejects, and clears when the retry succeeds', async () => {
    const set = vi.fn().mockRejectedValueOnce(new Error('config locked')).mockResolvedValue(undefined);
    render(<PerformancePopup onClose={() => {}} saved={false} gpuList={[]} needsRestart={false} setPreferPowerSaving={set} restart={async () => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Prefer power saving' })); });
    expect(await screen.findByText("Couldn't save the power saving setting")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(screen.queryByText(/Couldn't save/)).toBeNull();
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('shows nothing while a save is merely slow', async () => {
    render(<PerformancePopup onClose={() => {}} saved={false} gpuList={[]} needsRestart={false} setPreferPowerSaving={() => new Promise<void>(() => {})} restart={async () => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Prefer power saving' })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByText(/Couldn't save/)).toBeNull();
  });
});
