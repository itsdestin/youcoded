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
