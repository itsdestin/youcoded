// Pure PTY-buffer classifier for the chat-view attention banner.
//
// Given a stripped tail of the xterm buffer plus context about the previous
// spinner frame, decides what Claude's terminal is currently showing: active
// spinner, stalled spinner, a prompt waiting for input, an idle shell, an
// error, or "unknown." The renderer's useAttentionClassifier hook consumes
// this and maps the result onto AttentionState for the reducer.
//
// Patterns verified against Claude Code CLI as of April 2026 — review if CLI
// visuals change. Drift here is the most likely cause of classifier false
// positives/negatives; treat the regexes as versioned fixtures.

export type BufferClass =
  | 'thinking-active'   // Spinner visible, seconds counter advancing
  | 'thinking-stalled'  // Spinner visible, seconds counter flat ≥ 10s
  | 'awaiting-input'    // CLI-level prompt (non-hook) in the tail
  | 'shell-idle'        // Bash/shell prompt at tail, no spinner
  | 'error'             // Error/panic/traceback near tail
  | 'unknown';

export interface ClassifierContext {
  /** Last ~40 visible lines of the PTY buffer, ANSI-stripped. */
  bufferTail: string[];
  /** Seconds counter from the prior classifier tick (null if first tick). */
  previousSpinnerSeconds: number | null;
  /** Wall-clock seconds since previousSpinnerSeconds was observed. */
  secondsSincePreviousSpinner: number;
}

export interface ClassifierResult {
  class: BufferClass;
  /** Captured seconds counter from the spinner regex (null if no spinner). */
  spinnerSeconds: number | null;
}

// Claude Code thinking spinner — rotating glyph + word + "(Ns · esc to interrupt)".
// Group 1 captures the seconds counter we watch for staleness.
const SPINNER_RE =
  /[✻✽✢✳✶*⏺◉]\s+\w+[…\.]*\s*\((\d+)s\s*[·•]\s*esc\s*to\s*interrupt\)/i;

// Inline y/n prompts (do you want / proceed? / (y/n)).
const YES_NO_RE =
  /(do you want to|proceed\?|\(y\/n\)|press .* to continue)/i;

// Bracketed [y/n] or [yes/no].
const BRACKET_YN_RE = /\[([yY]\/[nN]|[yY][eE][sS]\/[nN][oO])\]/;

// "1. option" followed (within 3 lines) by "2. option" = numbered menu.
const NUMBERED_FIRST_RE = /^\s*❯?\s*1\.\s+/;
const NUMBERED_SECOND_RE = /^\s*❯?\s*2\.\s+/;

// Classic shell prompt (bash/zsh style). Loose but anchored at end of line.
// Allows common prompt tokens: user@host, ~, path segments, trailing $/#/>.
const SHELL_PROMPT_RE = /^[^<\n]*[~\w\/\.\-@: ]*[\$#>]\s*$/;

// Error / panic / stacktrace leader in the last few lines.
const ERROR_RE = /^(Error|panic|TypeError|Exception|Traceback):/;

/**
 * Classify the tail of a terminal buffer. Pure: same input ⇒ same output.
 * No DOM, no timers, no side effects — easy to unit-test from fixtures.
 */
export function classifyBuffer(ctx: ClassifierContext): ClassifierResult {
  const tail = ctx.bufferTail;
  if (tail.length === 0) return { class: 'unknown', spinnerSeconds: null };

  // --- 1. Spinner detection (highest priority) ---
  // Scan the whole tail — Claude Code often renders the spinner a few lines
  // above the tail's literal end while streaming other output.
  let spinnerSeconds: number | null = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i].match(SPINNER_RE);
    if (m) {
      spinnerSeconds = parseInt(m[1], 10);
      break;
    }
  }

  if (spinnerSeconds !== null) {
    // Spinner is visible. Decide active vs. stalled by comparing to previous tick.
    const prev = ctx.previousSpinnerSeconds;
    if (prev === null) {
      // First observation — give Claude the benefit of the doubt.
      return { class: 'thinking-active', spinnerSeconds };
    }
    if (spinnerSeconds > prev) {
      return { class: 'thinking-active', spinnerSeconds };
    }
    // Counter hasn't advanced. Only flag as stalled once we've waited ≥10s
    // between ticks — a short pause is normal between renders.
    if (ctx.secondsSincePreviousSpinner >= 10) {
      return { class: 'thinking-stalled', spinnerSeconds };
    }
    return { class: 'thinking-active', spinnerSeconds };
  }

  // No spinner anywhere in tail. Look at the bottom for shell/prompt/error shapes.

  // --- 2. Error near the tail (last 5 lines) ---
  const lastFive = tail.slice(-5);
  for (const line of lastFive) {
    if (ERROR_RE.test(line)) {
      return { class: 'error', spinnerSeconds: null };
    }
  }

  // --- 3. Awaiting-input prompts ---
  // y/n or bracketed anywhere in last ~10 lines.
  const lastTen = tail.slice(-10);
  for (const line of lastTen) {
    if (YES_NO_RE.test(line) || BRACKET_YN_RE.test(line)) {
      return { class: 'awaiting-input', spinnerSeconds: null };
    }
  }
  // Numbered choice: find "1." followed by "2." within 3 lines.
  for (let i = 0; i < tail.length; i++) {
    if (!NUMBERED_FIRST_RE.test(tail[i])) continue;
    const window = tail.slice(i + 1, i + 4);
    if (window.some((l) => NUMBERED_SECOND_RE.test(l))) {
      return { class: 'awaiting-input', spinnerSeconds: null };
    }
  }

  // --- 4. Shell idle ---
  // The very last non-empty line looks like a shell prompt, AND no spinner
  // was seen in the last 10 lines (already satisfied — we'd have returned above).
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (line.trim() === '') continue;
    if (SHELL_PROMPT_RE.test(line)) {
      return { class: 'shell-idle', spinnerSeconds: null };
    }
    break; // Only check the last non-empty line
  }

  return { class: 'unknown', spinnerSeconds: null };
}
