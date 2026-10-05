// stuck-tracker.ts — the "may be stuck" decision for ONE running turn of a Claude Code session, as a pure object.
//
// WHY (2026-10-01 one-core R5-4b): this was the body of the renderer's useAttentionClassifier hook. The check now runs in the main process
// (main/session-screens.ts) so a phone is right with no computer window open, while the Android app's own runtime keeps running it in its
// renderer until the Android rebuild. Both must reach the SAME answer from the same screen, so the decision lives here once and each caller
// only supplies the screen text and the clock. Timing constants are unchanged from the hook; see attention-classifier.ts for what the screen
// signals mean and why.
import { classifyBuffer, type BufferClass, type ClassifierContext } from './attention-classifier';

/** How often the check reads the screen while a turn is running. */
export const STUCK_TICK_MS = 1000;
/** How many terminal rows the check reads per tick (a tail walked back to a logical line start). */
export const STUCK_TAIL_ROWS = 40;
/** A non-ok reading must hold for this many consecutive ticks before it is shown (hides spinner-render gaps). */
const STUCK_STABILITY_TICKS = 5;
/**
 * No spinner or advancing counter for this long while the turn is "thinking" (no tool running, nothing waiting on the person) escalates to
 * stuck: the gates already rule out "busy with a tool" and "waiting on you", so a sustained silence is the CLI genuinely quiet.
 */
const STUCK_NO_SPINNER_MS = 20_000;

export type StuckState = 'ok' | 'stuck';

function toState(cls: BufferClass): StuckState {
  // Only spinner states are trusted; anything else ('unknown') is ok. See attention-classifier.ts for why.
  return cls === 'thinking-stalled' ? 'stuck' : 'ok';
}

export class StuckTracker {
  private previousSpinnerGlyph: string | null = null;
  /** When the glyph last CHANGED: a same glyph for 30 s with no advancing counter is a stall. */
  private previousSpinnerGlyphAt: number;
  /** When a Claude Code liveness signal (a glyph, or an advancing seconds counter) was last seen. Seeded at the turn's start. */
  private lastSignalSeenAt: number;
  private previousCounterSeconds: number | null = null;
  private pendingState: StuckState = 'ok';
  private pendingStreak = 0;

  constructor(now: number) {
    this.previousSpinnerGlyphAt = now;
    this.lastSignalSeenAt = now;
  }

  /**
   * One reading of the screen's last rows. Returns the state this reading maps to and whether it is allowed to be SHOWN yet: an escalation
   * is shown only after STUCK_STABILITY_TICKS in a row, while a return to 'ok' is shown at once.
   */
  tick(tail: string[], now: number): { state: StuckState; show: boolean } {
    const ctx: ClassifierContext = {
      bufferTail: tail,
      previousSpinnerGlyph: this.previousSpinnerGlyph,
      secondsSincePreviousGlyph: (now - this.previousSpinnerGlyphAt) / 1000,
      previousCounterSeconds: this.previousCounterSeconds,
    };
    const result = classifyBuffer(ctx);

    if (result.spinnerGlyph !== null) {
      this.lastSignalSeenAt = now;
      if (result.spinnerGlyph !== this.previousSpinnerGlyph) {
        this.previousSpinnerGlyph = result.spinnerGlyph;
        this.previousSpinnerGlyphAt = now;
      }
    }

    // A counter that ticked up is itself a liveness signal: compared with the value passed INTO this tick before it is overwritten.
    const priorCounter = this.previousCounterSeconds;
    if (result.counterSeconds !== null && priorCounter !== null && result.counterSeconds > priorCounter) this.lastSignalSeenAt = now;
    this.previousCounterSeconds = result.counterSeconds;

    let mapped = toState(result.class);
    if (mapped === 'ok' && result.class === 'unknown' && now - this.lastSignalSeenAt >= STUCK_NO_SPINNER_MS) mapped = 'stuck';

    if (mapped === this.pendingState) this.pendingStreak += 1;
    else { this.pendingState = mapped; this.pendingStreak = 1; }

    return { state: mapped, show: mapped === 'ok' || this.pendingStreak >= STUCK_STABILITY_TICKS };
  }
}
