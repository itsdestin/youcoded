// @vitest-environment jsdom
// worker-health-context.test.tsx
// Tests for WorkerHealthProvider + useWorkerHealth.
// Verifies that reachable flips false after 30s of errors and back to true on success.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { WorkerHealthProvider, useWorkerHealth } from '../src/renderer/state/worker-health-context';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Captures the context value so tests can inspect it. */
function makeCapture() {
  let captured: ReturnType<typeof useWorkerHealth> | null = null;
  function Capture() {
    captured = useWorkerHealth();
    return null;
  }
  return {
    Component: Capture,
    get value() { return captured!; },
  };
}

function renderWithProvider(ui: React.ReactElement) {
  return render(
    <WorkerHealthProvider>{ui}</WorkerHealthProvider>
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('WorkerHealthProvider / useWorkerHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('starts as reachable (no errors recorded yet)', () => {
    const cap = makeCapture();
    renderWithProvider(<cap.Component />);
    expect(cap.value.reachable).toBe(true);
    expect(cap.value.lastError).toBeNull();
  });

  it('stays reachable immediately after a single error (within grace period)', async () => {
    const cap = makeCapture();
    renderWithProvider(<cap.Component />);

    await act(async () => {
      cap.value.reportResult(false);
    });

    // 0ms after error — still within 30s grace period
    expect(cap.value.reachable).toBe(true);
    expect(cap.value.lastError).not.toBeNull();
  });

  it('flips reachable to false after 30s with no success', async () => {
    const cap = makeCapture();
    renderWithProvider(<cap.Component />);

    await act(async () => {
      cap.value.reportResult(false);
    });

    // Advance 30+ seconds — the scheduled timer fires and flips reachable
    await act(async () => {
      vi.advanceTimersByTime(30_001);
    });

    expect(cap.value.reachable).toBe(false);
  });

  it('flips back to reachable when reportResult(true) is called after an error', async () => {
    const cap = makeCapture();
    renderWithProvider(<cap.Component />);

    // Record an error
    await act(async () => {
      cap.value.reportResult(false);
    });

    // Advance past grace period — timer fires, reachable flips false
    await act(async () => {
      vi.advanceTimersByTime(30_001);
    });

    expect(cap.value.reachable).toBe(false);

    // Now a success comes in
    await act(async () => {
      cap.value.reportResult(true);
    });

    expect(cap.value.reachable).toBe(true);
  });

  it('stays reachable when successes interleave with errors', async () => {
    const cap = makeCapture();
    renderWithProvider(<cap.Component />);

    // Error then success before 30s
    await act(async () => {
      cap.value.reportResult(false);
    });

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      cap.value.reportResult(true); // success within grace period
    });

    // Advance another 20s (total 35s since error, but success came at 15s)
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });

    // Should still be reachable since last success > last error
    expect(cap.value.reachable).toBe(true);
  });

  it('throws when useWorkerHealth is used outside the provider', () => {
    const cap = makeCapture();
    // Suppress expected console.error from React's error boundary
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<cap.Component />)).toThrow(
      /useWorkerHealth must be used inside/
    );
    consoleError.mockRestore();
  });
});
