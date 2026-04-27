// Pure PTY-buffer classifier for the chat-view attention banner.
//
// Rewritten 2026-04-26 after empirical capture against CC v2.1.119 showed the
// spinner display has dropped its seconds-counter / "esc to interrupt"
// suffix. The previous regex
//     /[✻✽✢✳✶*⏺◉·]\s+\w+[…\.]*\s*\((\d+)s\s*[·•]\s*esc\s*to\s*interrupt\)/i
// could not match anything in real CC output, so the classifier silently
// produced 'unknown' on every turn — and the upstream hook's no-spinner-20s
// safety net then escalated to 'stuck', flashing the wrong banner during
// every long-thinking turn (>25s). See test-conpty/test-attention-states.mjs
// and test-spinner-fullcapture.mjs for the empirical evidence; cc-dependencies
// "PTY spinner regex" entry tracks the version anchor.
//
// Active staleness now uses GLYPH ROTATION instead of a seconds counter:
// CC cycles glyphs through {✻ ✽ ✢ ✳ ✶ * ⏺ ◉ ·} every few hundred ms while
// thinking. Same glyph for ≥10s ⇒ thinking-stalled. Any glyph at all ⇒
// thinking-active. None ⇒ unknown (upstream maps to 'ok' until the 20s
// no-spinner escalation in the hook fires).
//
// Genuine attention cases still come from stronger signals elsewhere:
//   - session death        → SESSION_PROCESS_EXITED (authoritative exit code)
//   - permission prompts   → hook relay (PERMISSION_REQUEST)
//   - long silent thinking → 'thinking-stalled' below + 20s escalation in hook
//
// Patterns verified against Claude Code CLI as of 2026-04-26 — review if CLI
// visuals change.

export type BufferClass =
  | 'thinking-active'   // Spinner glyph visible, rotating across ticks
  | 'thinking-stalled'  // Spinner glyph visible but unchanged ≥ 10s
  | 'unknown';          // No spinner found — upstream maps this to 'ok'

export interface ClassifierContext {
  /** Last ~40 visible lines of the PTY buffer, ANSI-stripped. */
  bufferTail: string[];
  /** Glyph from the prior classifier tick (null if first tick / no spinner). */
  previousSpinnerGlyph: string | null;
  /** Wall-clock seconds since previousSpinnerGlyph was last observed CHANGING. */
  secondsSincePreviousGlyph: number;
}

export interface ClassifierResult {
  class: BufferClass;
  /** The leading glyph captured by SPINNER_RE (null if no spinner). */
  spinnerGlyph: string | null;
}

// Claude Code thinking spinner — rotating glyph + gerund + ellipsis.
// CC v2.1.119 emits e.g. "✻ Warping…" without any seconds counter or
// "esc to interrupt" suffix. Group 1 captures the glyph for rotation tracking.
//
// Anchored to start of line (^) — without the anchor, the false-match probe
// (test-conpty/test-attention-false-match.mjs) showed Claude's response text
// triggers the regex constantly: markdown bullets like "  * Loading…",
// echoed user prompts containing literal spinner glyphs, and Claude responses
// prefixed with "● ✻ Pondering…" all match the unanchored pattern. Real CC
// spinner lines always have the glyph at column 0; false matches all have
// leading content (whitespace, "❯", "●"). The ^ anchor excludes every
// observed false match while still matching the real spinner.
//
// The pattern stops at `…`, so it ALSO matches the hook-execution variant
// "✶ Channelling… (running stop hook · 3s · ↓ 1 tokens)" — verified live.
//
// The leading-glyph set is EMPIRICAL — captured by inspecting real CC traces
// at `youcoded/desktop/test-conpty/spinner-full.log` and friends. Currently
// observed in probes: ✻ ✽ ✢ ✳ ✶ *. Documented (from older traces): ⏺ ◉ ·.
// If a future CC release adds a frame, the regex silently misses some ticks
// (banner shows wrong state during 1/Nth of thinking time). To verify, run
// `node test-conpty/test-attention-states.mjs` and inspect the cross-scenario
// glyph set in the harness summary. See `docs/cc-dependencies.md` "PTY
// spinner regex" entry.
const SPINNER_RE = /^([✻✽✢✳✶*⏺◉·])\s+[A-Za-z]+…/;

/**
 * Classify the tail of a terminal buffer. Pure: same input ⇒ same output.
 * No DOM, no timers, no side effects — easy to unit-test from fixtures.
 */
export function classifyBuffer(ctx: ClassifierContext): ClassifierResult {
  const tail = ctx.bufferTail;
  if (tail.length === 0) {
    return { class: 'unknown', spinnerGlyph: null };
  }

  // Scan the whole tail back-to-front — Claude Code often renders the spinner
  // a few lines above the tail's literal end while streaming other output, and
  // the most-recent line wins.
  let glyph: string | null = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i].match(SPINNER_RE);
    if (m) { glyph = m[1]; break; }
  }

  if (glyph === null) {
    return { class: 'unknown', spinnerGlyph: null };
  }

  // Spinner is visible. Decide active vs. stalled by glyph rotation.
  const prev = ctx.previousSpinnerGlyph;
  if (prev === null) {
    // First observation — give Claude the benefit of the doubt.
    return { class: 'thinking-active', spinnerGlyph: glyph };
  }
  if (glyph !== prev) {
    return { class: 'thinking-active', spinnerGlyph: glyph };
  }
  // Glyph unchanged. Only flag as stalled once ≥30s has passed since the
  // glyph last rotated. Empirical: CC v2.1.119 holds the same glyph for
  // 10–20s during silent thinking phases (extended-thinking blocks, plan-mode
  // pre-output), then rotates. A 10s threshold false-fired on every long
  // turn (see test-conpty/attention-long-prompt.log post-fix capture); 30s
  // covers normal slow rendering without missing genuine stalls. If CC ever
  // changes its render cadence, re-run the attention-states harness and
  // adjust here, not in the hook.
  if (ctx.secondsSincePreviousGlyph >= 30) {
    return { class: 'thinking-stalled', spinnerGlyph: glyph };
  }
  return { class: 'thinking-active', spinnerGlyph: glyph };
}
