// How wide a session pill actually is when it shows its name.
//
// The packer (how much room a pill needs) and the label's animated box
// (pill-label-style.ts) take their numbers from THIS file so they cannot drift:
// the box opens to text + tail + slack, and the packer must reserve exactly
// that, or a name that "fits exactly" is squeezed by its own fade tail.
//
// History: until 2026-09-02 a native-runtime pill also carried a
// "YouCoded · Coder" badge, measured here beside the name. The badge is gone
// (Destin: "eliminate the 'youcoded - coder' tags in session names entirely");
// the runtime and model now sit under the name in the All Sessions menu
// (session-runtime-label.ts). A pill is its dot and its name, nothing else.
import { LABEL_TAIL_PX } from './pill-label-style';

/** Pill chrome around the label: 6px left pad + dot (10) + 6px gap + 2px
 *  border. No right pad: the label's own tail (LABEL_TAIL_PX) is the right
 *  edge, so the name sits evenly between the pill's ends (2026-09-27). */
export const PILL_CHROME_PX = 24;

/** Fallback font for the measurement, used only until the strip has read the
 *  REAL computed font off its own label (SessionStrip). WHY that matters: the
 *  app's UI font is a monospace (`--font-sans` is Cascadia Mono), and measuring
 *  a mono name with a proportional system font under-reports it by ~15% —
 *  which is why the packer expanded pills that did not fit, and why the first
 *  numeric-width label cut "fix chat scroll stick" to "fix chat scroll"
 *  (2026-09-01). */
export const NAME_FONT = '500 12px system-ui, -apple-system, sans-serif';

export interface PillMetrics {
  /** The name's text width alone — what the label box animates open to (plus its tail). */
  nameWidth: number;
  /** Everything: what the packer budgets for an expanded pill — and exactly
   *  what the pill renders at, fractional px included. */
  expandedWidth: number;
}

/** Measure one pill. `measureText` is injected so this stays pure and the
 *  caller keeps owning the canvas. */
export function pillMetrics(
  name: string,
  measureText: (text: string, font: string) => number,
  font: string = NAME_FONT,
): PillMetrics {
  const nameWidth = measureText(name, font);
  // EXACTLY the rendered width, not rounded up and without the label's slack.
  // The label box is `max-width: ceil(text) + tail + slack` (pill-label-style),
  // but a max-width is a ceiling, not a size: the box lays out at the name's
  // own width, text + tail, so that is what the pill measures. Until
  // 2026-09-03 this reserved ceil + slack — 2-3px more than the pill ever
  // took — and a drag, judged against the reserved widths, parked every dot
  // 2px past its true place; they all nudged back on release (Destin, R6:
  // "they still bug out a little on release").
  const expandedWidth = nameWidth + LABEL_TAIL_PX + PILL_CHROME_PX;
  return { nameWidth, expandedWidth };
}

/** Width the pill needs to show `name` in full. Kept as the packer's
 *  one-number entry point. */
export function expandedPillWidth(
  name: string,
  measureText: (text: string, font: string) => number,
  font: string = NAME_FONT,
): number {
  return pillMetrics(name, measureText, font).expandedWidth;
}
