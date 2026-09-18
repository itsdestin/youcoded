// The hover / press / focus treatment for chrome controls, in ONE place.
//
// WHY (2026-09-18): Settings and Projects "look good" on hover and minimize /
// maximize / Games / Files did not (Destin), and the reason was that nothing was
// shared. Four buttons hand-copied one good class string; seven others sat inside
// a `bg-inset` pill, where the app's standard hover fill (`inset`) is invisible,
// and each had separately fallen back to a ~10-grey-level glyph nudge. None of
// the eleven showed a keyboard focus ring. The ladder itself — what fills with
// what — is styles/motion.css → "Hover and press: one ladder".
// Guard: tests/hover-press-ladder.test.ts.
import { FOCUS_RING } from '../ui/Button';

/** The UNSELECTED state of a control inside a `bg-inset` pill: caption buttons,
 *  Session Files, Games, the chat/terminal toggles, ScreenBand's back button.
 *  A selected (accent-filled) control must NOT carry it — see motion.css. */
export const ON_INSET_CONTROL = `text-fg-dim on-inset-control ${FOCUS_RING}`;

/** An icon button sitting directly on the header band: Settings, Projects, a
 *  pinned page. Press comes from motion.css's `.hover\:bg-inset:active` rule. */
export const HEADER_ICON_BUTTON =
  `relative p-1 rounded-sm hover:bg-inset transition-colors shrink-0 text-fg-muted hover:text-fg ${FOCUS_RING}`;

/** A session pill's border + fill. `chip` is the look the ACTIVE pill and a
 *  hover-PEEKED dot wear; everything else is an expanded, unselected name.
 *
 *  WHY the second branch has a hover (2026-09-18, Destin: "when 3 names in the
 *  session switcher are already expanded, the expanded but unselected names
 *  currently have no hover effect"): the chip look went only to those two states,
 *  so this third one sat inert under the pointer. COLOUR ONLY — the border is
 *  already there, transparent — so no pill changes width and the packer never
 *  hears about it; it fades on the pill's own inline transition. Off while a pill
 *  is in hand (`dragging` is STATE, per session-strip-motion.md): the drag's
 *  visuals are the strip's most guarded surface. Same ladder as the rest of the
 *  header: on panel → inset → edge.
 *  Here, not in SessionStrip.tsx, because that file is held at its line budget. */
export function pillSurfaceClass(chip: boolean, dragging: boolean): string {
  if (chip) return 'border-edge bg-panel';
  return `border-transparent ${dragging ? '' : 'hover:border-edge-dim hover:bg-inset active:bg-edge'}`;
}
