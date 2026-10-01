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
// Updated 2026-04-30 after a real-world miss on CC's tool-running spinner
// "* Installing + verifying on device… (1m 52s · ↓ 3.0k tokens)". The single-
// word gerund regex `[A-Za-z]+…` couldn't match a multi-word phrase between
// the glyph and the ellipsis, so the classifier returned 'unknown' on every
// tick of that turn and the no-spinner-20s safety net flashed the "check
// terminal" banner during a healthy thinking turn. Two reinforcing fixes:
//
//   1. Widened the gerund body to `[A-Za-z][A-Za-z +\-]*…` so phrases like
//      "Installing + verifying on device…" still match. The leading-letter
//      anchor + closing ellipsis still excludes echoed prose.
//   2. Added a parallel COUNTER signal: any line containing a paren-wrapped
//      `Ns` or `Nm Ns` value (the live timer CC renders next to its tool/
//      progress lines). Used as an OR with glyph rotation — if the counter
//      increased since the prior tick, we're 'thinking-active' regardless of
//      whether the spinner regex matched. Provides defense-in-depth against
//      future CC visual changes that might add a glyph or alter the gerund
//      shape but keep the seconds counter.
//
// Active staleness uses GLYPH ROTATION as the primary signal. CC cycles
// glyphs through {✻ ✽ ✢ ✳ ✶ * ⏺ ◉ ·} every few hundred ms while thinking.
// Same glyph for ≥30s AND counter not advancing ⇒ thinking-stalled.
// Any glyph rotation OR counter advancement ⇒ thinking-active.
// None ⇒ unknown (upstream maps to 'ok' until the 20s no-spinner escalation
// in the hook fires — the hook's escalation is also gated on the counter
// signal so a ticking counter prevents the 20s false-stuck path).
//
// Genuine attention cases still come from stronger signals elsewhere:
//   - session death        → SESSION_PROCESS_EXITED (authoritative exit code)
//   - permission prompts   → hook relay (PERMISSION_REQUEST)
//   - long silent thinking → 'thinking-stalled' below + 20s escalation in hook
//
// Patterns verified against Claude Code CLI as of 2026-04-30 — review if CLI
// visuals change.

export type BufferClass =
  | 'thinking-active'   // Spinner glyph rotating OR seconds counter advancing
  | 'thinking-stalled'  // Spinner glyph unchanged ≥ 30s AND counter not advancing
  | 'unknown';          // No spinner found — upstream maps this to 'ok'

export interface ClassifierContext {
  /** Last ~40 visible lines of the PTY buffer, ANSI-stripped. */
  bufferTail: string[];
  /** Glyph from the prior classifier tick (null if first tick / no spinner). */
  previousSpinnerGlyph: string | null;
  /** Wall-clock seconds since previousSpinnerGlyph was last observed CHANGING. */
  secondsSincePreviousGlyph: number;
  /**
   * Total seconds value (Nm * 60 + Ns) of the highest paren-wrapped CC counter
   * observed in the previous tick, or null if no counter was visible. The hook
   * passes this through so the classifier can detect a counter advancing
   * across ticks — an independent signal that CC is alive and rendering.
   */
  previousCounterSeconds: number | null;
}

export interface ClassifierResult {
  class: BufferClass;
  /** The leading glyph captured by SPINNER_RE (null if no spinner). */
  spinnerGlyph: string | null;
  /**
   * Highest seconds value seen in any paren-wrapped CC counter this tick
   * (e.g. "(1m 52s · ↓ 3.0k tokens)" → 112). Null if no counter is visible.
   * The hook stores this and feeds it back as previousCounterSeconds.
   */
  counterSeconds: number | null;
}

// Claude Code thinking spinner — rotating glyph + gerund + ellipsis.
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
// The gerund body allows letters, spaces, and `+`/`-` so multi-word phrases
// like "Installing + verifying on device…" (CC tool-running variant captured
// 2026-04-30) match alongside single-word gerunds like "Pondering…". The
// leading character must still be A-Za-z so a bare "* — text…" or similar
// non-gerund shape doesn't match. Pattern stops at `…`, so it ALSO matches
// the suffixed variants:
//   "✶ Channelling… (running stop hook · 3s · ↓ 1 tokens)"
//   "* Installing + verifying on device… (1m 52s · ↓ 3.0k tokens)"
//   "✻ Pondering… (7s · esc to interrupt)" (legacy CC pre-v2.1.119)
//
// The leading-glyph set is EMPIRICAL — captured by inspecting real CC traces
// at `youcoded/desktop/test-conpty/spinner-full.log` and friends. Currently
// observed in probes: ✻ ✽ ✢ ✳ ✶ *. Documented (from older traces): ⏺ ◉ ·.
// If a future CC release adds a frame, the regex silently misses some ticks
// (banner shows wrong state during 1/Nth of thinking time) — but the new
// COUNTER_RE fallback below catches CC alive even when the glyph doesn't
// match. To verify, run `node test-conpty/test-attention-states.mjs`.
const SPINNER_RE = /^([✻✽✢✳✶*⏺◉·])\s+[A-Za-z][A-Za-z +\-]*…/;

// Paren-wrapped seconds counter. Matches "(7s · ...)", "(1m 52s · ...)",
// "(running stop hook · 3s · ...)" — any parenthesized substring containing
// `Nm Ns` or just `Ns`. Captures minutes (group 1, optional) and seconds
// (group 2). The opening `\(` + closing-paren guard `[^)]*\)` filters out
// Claude prose mentioning "5s ago" outside parens, which is the more common
// false-positive shape. Anchored to a real CC counter shape rather than a
// bare \d+s scan.
const COUNTER_RE = /\([^)]*?(?:(\d+)m\s+)?(\d+)s\b[^)]*\)/;

/** Extract the highest seconds value from any line in the buffer tail. */
function extractCounterSeconds(tail: string[]): number | null {
  let max: number | null = null;
  for (const line of tail) {
    // Use matchAll over the line so multiple counters on one line are seen.
    const re = new RegExp(COUNTER_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const minutes = m[1] ? parseInt(m[1], 10) : 0;
      const seconds = parseInt(m[2], 10);
      const total = minutes * 60 + seconds;
      if (max === null || total > max) max = total;
    }
  }
  return max;
}

/**
 * Classify the tail of a terminal buffer. Pure: same input ⇒ same output.
 * No DOM, no timers, no side effects — easy to unit-test from fixtures.
 */
export function classifyBuffer(ctx: ClassifierContext): ClassifierResult {
  const tail = ctx.bufferTail;
  if (tail.length === 0) {
    return { class: 'unknown', spinnerGlyph: null, counterSeconds: null };
  }

  // Scan the whole tail back-to-front — Claude Code often renders the spinner
  // a few lines above the tail's literal end while streaming other output, and
  // the most-recent line wins.
  let glyph: string | null = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i].match(SPINNER_RE);
    if (m) { glyph = m[1]; break; }
  }

  const counterSeconds = extractCounterSeconds(tail);

  // Counter advanced since the prior tick — CC is rendering, regardless of
  // whether the spinner regex matched anything. This rescues turns where a
  // future CC visual change adds a glyph or shifts the gerund shape but the
  // (Nm Ns) counter is still emitted.
  const counterAdvanced =
    counterSeconds !== null &&
    ctx.previousCounterSeconds !== null &&
    counterSeconds > ctx.previousCounterSeconds;

  if (glyph === null) {
    if (counterAdvanced) {
      // No spinner glyph this tick, but the counter ticked up — still active.
      return { class: 'thinking-active', spinnerGlyph: null, counterSeconds };
    }
    return { class: 'unknown', spinnerGlyph: null, counterSeconds };
  }

  // Spinner is visible. Decide active vs. stalled by glyph rotation, with
  // an OR escape via counter advancement.
  const prev = ctx.previousSpinnerGlyph;
  if (prev === null) {
    // First observation — give Claude the benefit of the doubt.
    return { class: 'thinking-active', spinnerGlyph: glyph, counterSeconds };
  }
  if (glyph !== prev) {
    return { class: 'thinking-active', spinnerGlyph: glyph, counterSeconds };
  }
  // Glyph unchanged. Only flag as stalled once ≥30s has passed since the
  // glyph last rotated AND the counter is not advancing. Empirical: CC
  // v2.1.119 holds the same glyph for 10–20s during silent thinking phases
  // (extended-thinking blocks, plan-mode pre-output), then rotates. A 10s
  // threshold false-fired on every long turn (see
  // test-conpty/attention-long-prompt.log post-fix capture); 30s covers
  // normal slow rendering without missing genuine stalls. The counter-not-
  // advancing AND clause prevents the rare case where CC freezes the spinner
  // glyph but is still rendering progress (visible counter increment) from
  // being mis-flagged as stalled. If CC ever changes its render cadence,
  // re-run the attention-states harness and adjust here, not in the hook.
  if (ctx.secondsSincePreviousGlyph >= 30 && !counterAdvanced) {
    return { class: 'thinking-stalled', spinnerGlyph: glyph, counterSeconds };
  }
  return { class: 'thinking-active', spinnerGlyph: glyph, counterSeconds };
}
