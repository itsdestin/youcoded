// @vitest-environment jsdom
// The thinking indicator answers exactly one question: "is it alive?" — and it
// should appear ONLY when the user has no other evidence of progress.
//
// Destin, 2026-07-26: "during live token output/generation, there really
// shouldn't be any spinner or thinking indicator at all (for either local or
// cloud models). The thinking indicator/spinner only exists to show that the
// model isn't stalled when no output is actively being produced."
//
// ChatView already suppresses it for running tools and pending approvals; the
// streaming case had no signal at all until `lastOutputAt` was added, so a
// spinner sat under a bubble that was actively filling.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import React from 'react';
import ThinkingIndicator from '../src/renderer/components/ThinkingIndicator';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ThinkingIndicator — when it may appear at all', () => {
  it('renders NOTHING while output is actively arriving', () => {
    const { container } = render(<ThinkingIndicator lastOutputAt={Date.now()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders once output has paused past the grace window', () => {
    const { container } = render(<ThinkingIndicator lastOutputAt={Date.now() - 10_000} />);
    expect(container.innerHTML).not.toBe('');
  });

  it('renders when no output has ever arrived — the first-token wait', () => {
    // This is the case the indicator exists for: nothing on screen yet.
    const { container } = render(<ThinkingIndicator lastOutputAt={null} />);
    expect(container.innerHTML).not.toBe('');
  });

  it('a stall warning OUTRANKS streaming — if something may be wrong, say so', () => {
    // Suppressing a genuine "this may be broken" warning because a token landed
    // a moment ago would hide the one message the user most needs.
    render(
      <ThinkingIndicator
        lastOutputAt={Date.now()}
        stallWarning={{ retryInMs: 15_000, willRetry: true }}
      />,
    );
    expect(screen.getByText(/taking a while/i)).toBeTruthy();
  });
});

describe('ThinkingIndicator — what it says while waiting', () => {
  it('names the PROMPT on the first step', () => {
    render(<ThinkingIndicator promptProcessing={{ promptTokens: 25_000, budgetMs: 600_000, source: 'prompt' }} />);
    expect(screen.getByText(/Reading your prompt — 25,000 tokens/)).toBeTruthy();
  });

  it('names TOOL OUTPUT after a tool call — "your prompt" is wrong there', () => {
    // The exact confusion Destin flagged: this text appeared after a Read, where
    // the new context is the file, not anything the user typed.
    render(<ThinkingIndicator promptProcessing={{ promptTokens: 98_000, budgetMs: 600_000, source: 'tool-output' }} />);
    expect(screen.getByText(/Reading tool output — 98,000 tokens/)).toBeTruthy();
    expect(screen.queryByText(/your prompt/i)).toBeNull();
  });

  it('falls back to the generic rotation with no prefill payload', () => {
    render(<ThinkingIndicator />);
    expect(screen.queryByText(/Reading your prompt|Reading tool output/)).toBeNull();
  });

  it('a stall warning outranks the prefill notice too', () => {
    render(
      <ThinkingIndicator
        promptProcessing={{ promptTokens: 25_000, budgetMs: 600_000, source: 'prompt' }}
        stallWarning={{ retryInMs: 15_000, willRetry: false }}
      />,
    );
    expect(screen.getByText(/taking a while/i)).toBeTruthy();
    expect(screen.queryByText(/Reading your prompt/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Live prefill progress: the label upgrades in place as llama.cpp reports in.
// ---------------------------------------------------------------------------
import { formatEta, prefillLabel } from '../src/renderer/components/ThinkingIndicator';

describe('formatEta — deliberately coarse', () => {
  it('says nothing when the wait is nearly over', () => {
    // A number here would just flicker on its way to zero.
    expect(formatEta(1_500)).toBeNull();
  });

  it('rounds seconds to 5s buckets — the projection is not precise enough for more', () => {
    expect(formatEta(9_894)).toBe('about 10s left');
    expect(formatEta(23_100)).toBe('about 25s left');
  });

  it('switches to minutes for long waits, pluralized', () => {
    expect(formatEta(61_000)).toBe('about 1 min left');
    expect(formatEta(200_000)).toBe('about 3 mins left');
  });

  it('returns null for missing or nonsense input rather than rendering NaN', () => {
    for (const v of [null, undefined, NaN, -5]) expect(formatEta(v as any)).toBeNull();
  });
});

describe('prefillLabel', () => {
  it('states the size when there is no live progress yet', () => {
    expect(prefillLabel({ promptTokens: 25_000, source: 'prompt' }))
      .toBe('Reading your prompt — 25,000 tokens…');
  });

  it('upgrades to a percentage once llama.cpp reports progress', () => {
    const label = prefillLabel({ promptTokens: 5_519, processed: 2_048, source: 'prompt', etaMs: 9_894 });
    expect(label).toContain('37% of 5,519 tokens');
    expect(label).toContain('about 10s left');
  });

  it('still names tool output correctly with live progress attached', () => {
    expect(prefillLabel({ promptTokens: 98_000, processed: 49_000, source: 'tool-output', etaMs: 30_000 }))
      .toContain('Reading tool output — 50% of 98,000 tokens');
  });

  it('omits the ETA when none can be projected', () => {
    const label = prefillLabel({ promptTokens: 5_519, processed: 0, source: 'prompt', etaMs: null });
    expect(label).toContain('0% of 5,519 tokens');
    expect(label).not.toContain('left');
  });

  it('never shows more than 100%', () => {
    expect(prefillLabel({ promptTokens: 100, processed: 130, source: 'prompt' })).toContain('100% of 100 tokens');
  });
});

// ---------------------------------------------------------------------------
// Smoothing. llama.cpp reports once per 2,048-token batch, so a 7,149-token
// prompt yields ~4 readings — 0%, 29%, 57%, 100% — which reads as broken:
// "starts at 0%, sits there for a long time, jumps to 29, sits there, jumps to
// 57, jumps to 100" (Destin, 2026-07-26). We extrapolate between reports from
// the rate the server itself measured.
// ---------------------------------------------------------------------------
import { interpolateProcessed } from '../src/renderer/components/ThinkingIndicator';

describe('interpolateProcessed', () => {
  const READING = { processed: 2048, promptTokens: 7149, timeMs: 20_000 };  // ~102 tok/s

  it('advances between reports instead of sitting frozen', () => {
    const at0 = interpolateProcessed(READING, 0)!;
    const at5s = interpolateProcessed(READING, 5_000)!;
    expect(at0).toBe(2048);
    expect(at5s).toBeGreaterThan(at0);
  });

  it('never advances more than one batch past the last real reading', () => {
    // A stalled prefill must visibly STOP, not glide to the finish line.
    expect(interpolateProcessed(READING, 10 * 60_000)!).toBeLessThanOrEqual(2048 + 2048);
  });

  it('never claims completion the server has not confirmed', () => {
    const nearEnd = { processed: 7100, promptTokens: 7149, timeMs: 60_000 };
    expect(interpolateProcessed(nearEnd, 10 * 60_000)!).toBeLessThan(7149);
  });

  it('never moves backwards from the reported value', () => {
    const late = { processed: 7148, promptTokens: 7149, timeMs: 60_000 };
    expect(interpolateProcessed(late, 5_000)!).toBeGreaterThanOrEqual(7148);
  });

  it('leaves a reading alone when there is no rate to extrapolate from', () => {
    expect(interpolateProcessed({ processed: 0, promptTokens: 7149, timeMs: 0 }, 5_000)).toBe(0);
    expect(interpolateProcessed({ promptTokens: 7149 } as any, 5_000)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rules of hooks. The suppression branch once sat ABOVE the prefill hooks, so a
// render that returned early ran fewer hooks than the previous one — React threw
// "Rendered fewer hooks than expected" and the ErrorBoundary took the whole chat
// view down (Destin, 2026-07-26). These drive the exact transitions that crashed.
// ---------------------------------------------------------------------------
describe('ThinkingIndicator — hook order survives every transition', () => {
  it('survives toggling from suppressed to shown and back', () => {
    // suppressed (early return) -> shown -> suppressed, on ONE mounted instance.
    const { rerender, container } = render(<ThinkingIndicator lastOutputAt={Date.now()} />);
    expect(container.innerHTML).toBe('');

    expect(() => rerender(<ThinkingIndicator lastOutputAt={Date.now() - 10_000} />)).not.toThrow();
    expect(container.innerHTML).not.toBe('');

    expect(() => rerender(<ThinkingIndicator lastOutputAt={Date.now()} />)).not.toThrow();
    expect(container.innerHTML).toBe('');
  });

  it('survives gaining and losing a prefill reading while suppressed', () => {
    // The crash needed the prefill hooks to be skipped on the suppressed render.
    const { rerender } = render(<ThinkingIndicator lastOutputAt={Date.now()} />);
    expect(() => {
      rerender(<ThinkingIndicator lastOutputAt={Date.now()} promptProcessing={{ promptTokens: 5000, budgetMs: 0, processed: 100, timeMs: 500 }} />);
      rerender(<ThinkingIndicator lastOutputAt={Date.now() - 10_000} promptProcessing={{ promptTokens: 5000, budgetMs: 0, processed: 2048, timeMs: 5000 }} />);
      rerender(<ThinkingIndicator lastOutputAt={Date.now()} />);
    }).not.toThrow();
  });

  it('survives a stall warning appearing during suppression', () => {
    // stallWarning flips the early return off — another hook-count transition.
    const { rerender, container } = render(<ThinkingIndicator lastOutputAt={Date.now()} />);
    expect(() => rerender(
      <ThinkingIndicator lastOutputAt={Date.now()} stallWarning={{ retryInMs: 15_000, willRetry: true }} />,
    )).not.toThrow();
    expect(container.innerHTML).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// Monotonic display. Destin, 2026-07-28: "the percentage constantly jumps up and
// then back down, which doesn't make any sense (it should only be able to count
// upward)."
//
// Two things could move it backwards, and the fix has to survive BOTH because
// neither is fully eliminable:
//   - interpolateProcessed extrapolates between the server's sparse per-batch
//     reports; when the next real report lands lower than the projection, the
//     raw value drops.
//   - toReport's warm-cache origin is unverified, so a reading can legitimately
//     come in below the previous one.
// Prefill only ever moves forward, so the DISPLAY refuses to go backwards.
// ---------------------------------------------------------------------------
import { monotonic } from '../src/renderer/components/ThinkingIndicator';

describe('monotonic', () => {
  it('passes an increasing sequence through untouched', () => {
    const m = monotonic();
    expect([10, 20, 55, 100].map((v) => m(v))).toEqual([10, 20, 55, 100]);
  });

  it('holds at the high-water mark instead of going backwards', () => {
    const m = monotonic();
    m(60);
    expect(m(45)).toBe(60);
  });

  it('resumes climbing once the real value passes the mark again', () => {
    const m = monotonic();
    m(60); m(45);
    expect(m(70)).toBe(70);
  });

  it('a fresh instance starts over — a new turn is not the old turn', () => {
    const m1 = monotonic();
    m1(90);
    expect(monotonic()(5)).toBe(5);
  });

  it('ignores null/undefined rather than latching them as a floor', () => {
    const m = monotonic();
    m(40);
    expect(m(undefined)).toBeUndefined();
    expect(m(50)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// The clamp has to be WIRED, not merely exported. `monotonic` had five green
// tests while nothing in the component called it — coverage that proved nothing
// about the pixels (caught in the 2026-07-28 review).
// ---------------------------------------------------------------------------
describe('ThinkingIndicator — the displayed percentage never counts down', () => {
  const reading = (processed: number) => ({
    promptTokens: 1000, budgetMs: 0, source: 'prompt' as const,
    processed, timeMs: 0, etaMs: null,
  });

  it('holds the high-water mark when a later reading comes in lower', () => {
    const { rerender } = render(<ThinkingIndicator promptProcessing={reading(600)} />);
    expect(screen.getByText(/60% of 1,000 tokens/)).toBeTruthy();

    // A lower reading — exactly what an overshooting extrapolation or the
    // unverified warm-cache origin can produce.
    rerender(<ThinkingIndicator promptProcessing={reading(450)} />);
    expect(screen.getByText(/60% of 1,000 tokens/)).toBeTruthy();
    expect(screen.queryByText(/45% of/)).toBeNull();
  });

  it('resumes climbing once a reading passes the mark', () => {
    const { rerender } = render(<ThinkingIndicator promptProcessing={reading(600)} />);
    rerender(<ThinkingIndicator promptProcessing={reading(450)} />);
    rerender(<ThinkingIndicator promptProcessing={reading(800)} />);
    expect(screen.getByText(/80% of 1,000 tokens/)).toBeTruthy();
  });

  it('a NEW prefill run starts from zero, not the last run\'s ceiling', () => {
    // Without the reset a second turn would open at 100% and stay there.
    const { rerender } = render(<ThinkingIndicator promptProcessing={reading(900)} />);
    expect(screen.getByText(/90% of 1,000 tokens/)).toBeTruthy();
    rerender(<ThinkingIndicator promptProcessing={null} />);           // run ends
    rerender(<ThinkingIndicator promptProcessing={reading(100)} />);   // next turn
    expect(screen.getByText(/10% of 1,000 tokens/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The stale-stamp bug. `prefillSeenAt` has always stored `{ key, at }` — but the
// elapsed-time calculation never compared the key, so the render that RECEIVES a
// new report measured elapsed time from the PREVIOUS report's stamp (effects run
// after render, so the new stamp isn't written yet).
//
// That made every new reading project a full batch ahead on arrival. Latent and
// self-correcting until the monotonic clamp latched the overshoot — which is
// what turned smooth counting into "27 -> 52 -> 70 -> 85 -> 100"
// (Destin, 2026-07-28).
// ---------------------------------------------------------------------------
describe('ThinkingIndicator — a new reading is not projected forward on arrival', () => {
  const reading = (processed: number, timeMs: number) => ({
    promptTokens: 10_000, budgetMs: 0, source: 'prompt' as const, processed, timeMs, etaMs: null,
  });

  it('shows the new report\'s OWN value, not one batch past it', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<ThinkingIndicator promptProcessing={reading(2_000, 4_000)} />);
      // Long enough for the extrapolation to saturate its one-batch ceiling.
      act(() => { vi.advanceTimersByTime(6_000); });
      // A new report lands. Elapsed time for THIS reading is zero.
      rerender(<ThinkingIndicator promptProcessing={reading(4_000, 8_000)} />);
      expect(screen.getByText(/40% of 10,000 tokens/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still extrapolates forward once time passes on the CURRENT reading', () => {
    // The fix must not disable smoothing — only stop it double-counting.
    vi.useFakeTimers();
    try {
      render(<ThinkingIndicator promptProcessing={reading(2_000, 4_000)} />);
      act(() => { vi.advanceTimersByTime(2_000); });
      // 0.5 tok/ms over 2s ≈ +1,000 tokens → past 20%, still under the ceiling.
      expect(screen.queryByText(/20% of 10,000 tokens/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// A chat that is not on screen. Every open session keeps its chat mounted, so a
// thinking line in a background tab used to run its word rotation, countdown
// and prefill ticks for nobody. They stand still while hidden; each number is
// worked out from timestamps, so the first frame back is already right.
// ---------------------------------------------------------------------------
import { OnScreenContext } from '../src/renderer/state/on-screen-context';
import BrailleSpinner from '../src/renderer/components/BrailleSpinner';

describe('ThinkingIndicator in a hidden chat', () => {
  // The spinner glyph has its own shared driver (BrailleSpinner.tsx), outside
  // this change; these tests count the indicator's OWN timers on top of it.
  const spinnerTimers = () => {
    const r = render(<BrailleSpinner size="base" />);
    const n = vi.getTimerCount();
    r.unmount();
    return n;
  };
  const inPane = (onScreen: boolean, props: React.ComponentProps<typeof ThinkingIndicator>) => (
    <OnScreenContext.Provider value={onScreen}>
      <ThinkingIndicator {...props} />
    </OnScreenContext.Provider>
  );
  const prefill = { promptTokens: 10_000, budgetMs: 0, source: 'prompt' as const, processed: 2_000, timeMs: 4_000, etaMs: null };
  const stall = { retryInMs: 15_000, willRetry: true };

  it('runs no timers while hidden — words, prefill ticks or countdown', () => {
    vi.useFakeTimers();
    const base = spinnerTimers();
    render(inPane(false, { promptProcessing: prefill }));
    expect(vi.getTimerCount()).toBe(base);
    cleanup();
    render(inPane(false, { stallWarning: stall }));
    expect(vi.getTimerCount()).toBe(base);
  });

  it('runs them on screen (so the test above can fail)', () => {
    vi.useFakeTimers();
    const base = spinnerTimers();
    render(inPane(true, { promptProcessing: prefill }));
    expect(vi.getTimerCount()).toBeGreaterThan(base);
  });

  it('shows the true countdown the moment the chat comes back', () => {
    vi.useFakeTimers();
    const stallWarning = { ...stall };
    const r = render(inPane(true, { stallWarning }));
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByText(/Retrying in 13s/)).toBeTruthy();
    r.rerender(inPane(false, { stallWarning }));
    act(() => { vi.advanceTimersByTime(5_000); });
    r.rerender(inPane(true, { stallWarning }));
    expect(screen.getByText(/Retrying in 8s/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByText(/Retrying in 7s/)).toBeTruthy();
  });

  it('counts on the same whole seconds after the stall began as before', () => {
    vi.useFakeTimers();
    const base = spinnerTimers();
    render(inPane(true, { stallWarning: { retryInMs: 4_500, willRetry: true } }));
    expect(screen.getByText(/Retrying in 5s/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(999); });
    expect(screen.getByText(/Retrying in 5s/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByText(/Retrying in 4s/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(screen.getByText(/Retrying\.\.\./)).toBeTruthy();
    expect(vi.getTimerCount()).toBe(base);   // nothing left to count
  });
});
