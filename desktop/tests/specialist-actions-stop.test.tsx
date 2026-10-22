// @vitest-environment jsdom
// B9 (2026-10-22 audit): the popup's Stop flipped back to "Stop" as soon as the
// request returned, before the run record said it had stopped — so the button
// invited a second click on a helper that was already winding down.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';
import { SpecialistActions } from '../src/renderer/components/specialists/SpecialistActions';
import type { SpecialistRunView } from '../src/shared/types';

afterEach(cleanup);
const run: SpecialistRunView = { childId: 'c1', parentToolCallId: 't1', agentType: 'worker', title: 'Wren the Worker', background: true, status: 'running', startedAt: 1 };

describe('SpecialistActions Stop', () => {
  it('stays "Stopping…" after the request is accepted, until the run changes', async () => {
    (window as any).claude = { specialists: { interrupt: vi.fn().mockResolvedValue({ ok: true }) } };
    render(<SpecialistActions sessionId="s1" run={run} compact />);
    await act(async () => { fireEvent.click(screen.getByText('Stop')); });
    expect(screen.getByText('Stopping…')).toBeTruthy();
    expect((screen.getByText('Stopping…') as HTMLButtonElement).disabled).toBe(true);
  });
  it('goes back to "Stop" with the reason when the request is refused', async () => {
    (window as any).claude = { specialists: { interrupt: vi.fn().mockResolvedValue({ ok: false, error: 'No such helper' }) } };
    render(<SpecialistActions sessionId="s1" run={run} compact />);
    await act(async () => { fireEvent.click(screen.getByText('Stop')); });
    expect(screen.getByText('Stop')).toBeTruthy();
    expect(screen.getByText('No such helper')).toBeTruthy();
  });
  it('lets the person try again if the run never changes', async () => {
    vi.useFakeTimers();
    try {
      (window as any).claude = { specialists: { interrupt: vi.fn().mockResolvedValue({ ok: true }) } };
      render(<SpecialistActions sessionId="s1" run={run} compact />);
      await act(async () => { fireEvent.click(screen.getByText('Stop')); });
      expect(screen.getByText('Stopping…')).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(30_000); });
      expect(screen.getByText('Stop')).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });
});
