import { useState, useEffect, useRef } from 'react';
import BrailleSpinner from './BrailleSpinner';

// How long after the last token the model still counts as "actively streaming".
// Long enough to bridge normal inter-token gaps, short enough that a real pause
// brings the indicator back promptly.
const STREAMING_GRACE_MS = 2_000;

/**
 * Round an ETA to something honest. The projection runs OPTIMISTIC — prefill
 * slows as context grows, so a rate measured early under-predicts what's left
 * (measured ~7% out a third of the way in, ~22% two thirds in against llama.cpp
 * b9992). Rendering "9.9s" would claim a precision we don't have, so buckets:
 * near the end it barely matters, further out we round hard and say "about".
 */
export function formatEta(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 2_000) return null;                       // about to finish — a number here only flickers
  if (ms < 60_000) return `about ${Math.round(ms / 5_000) * 5}s left`;
  const mins = Math.round(ms / 60_000);
  return `about ${mins} min${mins === 1 ? '' : 's'} left`;
}

/**
 * Advance a progress reading between server reports.
 *
 * llama.cpp reports once per BATCH (n_batch, typically 2048), so a 7,149-token
 * prompt produces about four readings — 0%, 29%, 57%, 100%. Rendering those raw
 * looks broken: the number sits still for tens of seconds, then leaps
 * (Destin, 2026-07-26, "really janky/jumpy").
 *
 * Between reports we extrapolate from the rate the server itself measured. This
 * is presentation only — the underlying reading is never altered, and the next
 * real report snaps the display back to truth.
 *
 * Two guards keep the lie small and always in the honest direction:
 *   - never pass 99%, so the bar cannot claim completion the server hasn't
 *     confirmed (finishing early then waiting is the most annoying failure);
 *   - never advance more than one batch ahead of the last real reading, so a
 *     stalled prefill visibly stops instead of gliding serenely to the end.
 */
export function interpolateProcessed(
  p: { processed?: number; promptTokens: number; timeMs?: number },
  msSinceReport: number,
  batchSize = 2048,
): number | undefined {
  if (p.processed == null || p.promptTokens <= 0) return p.processed;
  if (!p.timeMs || p.timeMs <= 0 || p.processed <= 0) return p.processed;
  const rate = p.processed / p.timeMs;                 // tokens per ms, measured
  const projected = p.processed + rate * Math.max(0, msSinceReport);
  const ceiling = Math.min(
    p.processed + batchSize,                           // at most one batch ahead
    Math.floor(p.promptTokens * 0.99),                 // never claim done
  );
  return Math.min(projected, Math.max(p.processed, ceiling));
}

/**
 * A high-water mark. Prefill only ever moves FORWARD, so the display must too.
 *
 * Two things can hand us a lower number than last time, and neither is fully
 * eliminable: interpolateProcessed extrapolates between the server's sparse
 * per-batch reports and can overshoot the next real one, and toReport's
 * warm-cache origin is unverified so a reading can legitimately come in low.
 * Rather than chase both, the DISPLAY refuses to go backwards — a percentage
 * that jumps up and then down reads as broken whatever caused it
 * (Destin, 2026-07-28).
 *
 * A closure rather than a ref hook so it is testable on its own; the component
 * makes a fresh one per prefill run, which is what resets it between turns.
 */
export function monotonic(): (v: number | undefined) => number | undefined {
  let high = -Infinity;
  return (v) => {
    if (v == null || !Number.isFinite(v)) return v;
    high = Math.max(high, v);
    return high;
  };
}

/**
 * What the indicator says while the model is reading. Upgrades in place: with no
 * live progress it states the size; once llama.cpp reports progress it becomes a
 * percentage, and an ETA joins once one can be projected.
 */
export function prefillLabel(p: {
  promptTokens: number; source?: 'prompt' | 'tool-output';
  processed?: number; cached?: number; etaMs?: number | null;
}): string {
  const what = p.source === 'tool-output' ? 'Reading tool output' : 'Reading your prompt';
  const parts: string[] = [];
  // A percentage is more legible than raw counts once we have real progress;
  // without it, the token count is the only honest thing we can say.
  if (p.processed != null && p.promptTokens > 0) {
    // 100% is reserved for actually-done. Rounding gets there at 99.5%, and the
    // project's own captured llama.cpp trace contains a NON-final reading of
    // 5,515/5,519 (99.93%) — so the label read "100%" while prefill was still
    // running, and the monotonic clamp then held it there. Anything short of the
    // full count floors to 99.
    const done = p.processed >= p.promptTokens;
    const pct = done ? 100 : Math.min(99, Math.floor((p.processed / p.promptTokens) * 100));
    parts.push(`${pct}% of ${p.promptTokens.toLocaleString()} tokens`);
  } else {
    parts.push(`${p.promptTokens.toLocaleString()} tokens`);
  }
  const eta = formatEta(p.etaMs);
  if (eta) parts.push(eta);
  return `${what} — ${parts.join(', ')}…`;
}

const THINKING_LINES = [
  'Thinking',
  'Cogitating',
  'Pondering',
  'Ruminating',
  'Noodling',
  'Percolating',
  'Brainstorming',
  'Deliberating',
  'Marinating',
  'Musing',
  'Contemplating',
  'Stewing',
  'Mulling it over',
  'Chewing on it',
  'Untangling',
  'Connecting dots',
  'Rearranging neurons',
  'Consulting the vibes',
  'Findangling',
  'Embellishing',
  'Simmering',
  'Calibrating',
  'Perplexing',
];

interface ThinkingIndicatorProps {
  /**
   * Native runtime only. When set, the streaming watchdog has flagged the
   * provider as silent — swap the playful rotating word for a "taking a while"
   * warning. `willRetry` controls whether we promise an auto-retry countdown
   * (true) or stay non-committal because the stall will end in an error (false).
   */
  stallWarning?: { retryInMs: number; willRetry: boolean } | null;
  /** Native prefill: the model is reading a long prompt, not hanging. */
  promptProcessing?: { promptTokens: number; budgetMs: number; source?: 'prompt' | 'tool-output'; processed?: number; cached?: number; etaMs?: number | null; timeMs?: number } | null;
  /** When visible output last arrived. While this is fresh the indicator renders
   *  NOTHING — the filling bubble is already the proof of life. */
  lastOutputAt?: number | null;
}

export default function ThinkingIndicator({ stallWarning, promptProcessing, lastOutputAt }: ThinkingIndicatorProps = {}) {
  // ── EVERY hook runs unconditionally, before any early return ──────────────
  // The suppression branch below used to sit ABOVE the prefill hooks, so a
  // render that returned early ran fewer hooks than the previous one and React
  // threw "Rendered fewer hooks than expected", taking the chat view down with
  // it (Destin, 2026-07-26). Keep all hooks together at the top; the only
  // conditional is the return at the end of this block.
  const [lineIndex, setLineIndex] = useState(() =>
    Math.floor(Math.random() * THINKING_LINES.length),
  );
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [, forceTick] = useState(0);
  const [, setPrefillTick] = useState(0);
  const prefillSeenAt = useRef<{ key: string; at: number } | null>(null);
  // One high-water clamp per prefill RUN. Held in a ref so it survives re-renders
  // (a fresh closure each render would reset the mark every 250ms tick and defeat
  // the whole point) and reset when the run ends, so the next turn starts at zero
  // rather than inheriting the last turn's ceiling.
  const clampRef = useRef<((v: number | undefined) => number | undefined) | null>(null);

  // Rotate the playful words only while NOT stalled — a stall shows fixed copy.
  useEffect(() => {
    if (stallWarning) return;
    const id = setInterval(() => {
      setLineIndex(Math.floor(Math.random() * THINKING_LINES.length));
    }, 2500);
    return () => clearInterval(id);
  }, [stallWarning]);

  // Countdown while stalled. Seeded from the watchdog's retryInMs and ticked to
  // zero. A fresh stallWarning object (each distinct stall) restarts the timer;
  // clearing it (-> null, activity resumed) tears the timer down.
  useEffect(() => {
    if (!stallWarning) { setSecondsLeft(0); return; }
    let n = Math.ceil(stallWarning.retryInMs / 1000);
    setSecondsLeft(n);
    const id = setInterval(() => {
      n = Math.max(0, n - 1);
      setSecondsLeft(n);
      if (n === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [stallWarning]);

  // Identity of the current server reading. Changing it restarts the clock.
  const ppKey = promptProcessing
    ? `${promptProcessing.processed}/${promptProcessing.promptTokens}/${promptProcessing.timeMs ?? 0}`
    : '';
  // Stamped in an EFFECT, not during render: mutating this ref mid-render is
  // what produced React's "Cannot update a component while rendering a
  // different component" warning.
  useEffect(() => {
    if (!promptProcessing) {
      prefillSeenAt.current = null;
      clampRef.current = null;   // run over — the next turn starts from zero
      return;
    }
    prefillSeenAt.current = { key: ppKey, at: Date.now() };
  }, [ppKey, promptProcessing]);

  // Tick while a prefill reading is on screen so the extrapolation can advance
  // it between the server's sparse per-batch reports. 250ms is smooth to the eye
  // and trivial next to the work the model is doing.
  useEffect(() => {
    if (!promptProcessing) return;
    const id = setInterval(() => setPrefillTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [promptProcessing]);

  const streamingNow = lastOutputAt != null && Date.now() - lastOutputAt < STREAMING_GRACE_MS;
  useEffect(() => {
    if (!streamingNow) return;
    // Re-evaluate once the grace expires so the indicator reappears on a pause.
    const remaining = STREAMING_GRACE_MS - (Date.now() - (lastOutputAt ?? 0));
    const id = setTimeout(() => forceTick((n) => n + 1), Math.max(50, remaining));
    return () => clearTimeout(id);
  }, [streamingNow, lastOutputAt]);

  // ── Hooks done; conditional rendering from here ───────────────────────────
  //
  // Suppress while output is actively arriving: the indicator answers "is it
  // alive?" when the user has NO other evidence of progress, and tokens landing
  // in a bubble ARE that evidence. Tool cards and approval prompts are handled
  // upstream by ChatView's thinkingArea predicate. A stall warning outranks
  // this — if we think something is wrong, say so even if a delta just landed.
  if (streamingNow && !stallWarning) return null;

  // Extrapolate the reading forward for display only; the next real report snaps
  // it back to truth. `since` is 0 until the effect above has stamped a reading,
  // which simply means no extrapolation on that first paint.
  // Elapsed time for THIS reading. The key comparison is load-bearing: effects
  // run AFTER render, so on the render that receives a new report the ref still
  // holds the PREVIOUS reading's stamp. Measuring against it projected every new
  // report a full batch forward the instant it arrived — latent and
  // self-correcting until the monotonic clamp latched that overshoot, which is
  // what turned smooth counting into 27 -> 52 -> 70 -> 85 -> 100
  // (Destin, 2026-07-28). The `key` field was stored for exactly this and never
  // compared.
  const since = prefillSeenAt.current?.key === ppKey ? Date.now() - prefillSeenAt.current.at : 0;
  const smoothedPrefill = promptProcessing
    ? {
      ...promptProcessing,
      // Clamped so the number never counts DOWN. interpolateProcessed can
      // overshoot the next real report, and toReport's warm-cache origin is
      // unverified — either can hand us a lower value than last render, and a
      // percentage that jumps up then back reads as broken whatever caused it.
      processed: (clampRef.current ??= monotonic())(interpolateProcessed(promptProcessing, since)),
      // Count the extrapolated time down too, so the ETA doesn't sit frozen
      // between reports the way the percentage used to.
      etaMs: promptProcessing.etaMs != null ? Math.max(0, promptProcessing.etaMs - since) : promptProcessing.etaMs,
    }
    : null;

  // Prefill copy is deliberately NOT alarming: nothing is wrong, the model is
  // simply reading. A real stall warning still outranks it.
  const label = stallWarning
    ? `This is taking a while, something may be wrong...${
        stallWarning.willRetry
          ? secondsLeft > 0 ? ` Retrying in ${secondsLeft}s...` : ' Retrying...'
          : ''
      }`
    : smoothedPrefill
      ? prefillLabel(smoothedPrefill)
      : THINKING_LINES[lineIndex];

  return (
    // in-view: opts the inner bg-inset bubble into wallpaper-driven bubble
    // glassmorphism (theme-engine targets `.in-view .bg-inset` descendants).
    // data-testid: the visible label is one of THINKING_LINES chosen at random,
    // so callers that need to assert this is (or is NOT) on screen — e.g. the
    // compaction case, where CompactingCard is the only status — have no stable
    // text to match on.
    // select-none: a status line, not content. Ctrl+A must not paint it
    // (Destin, 2026-09-10).
    <div data-testid="thinking-indicator" className="flex items-center gap-2 px-4 py-1.5 in-view select-none">
      <div className="flex items-center gap-2 bg-inset rounded-2xl rounded-bl-sm px-4 py-2.5">
        <BrailleSpinner size="base" />
        <span className="text-sm text-fg-dim">
          {label}
        </span>
      </div>
    </div>
  );
}
