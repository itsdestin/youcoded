/**
 * The one field surface — shared by TextInput, Textarea, and the Select trigger.
 *
 * Replaces 3 focus paradigms x 3 backgrounds x 4 radii across ~25 inputs.
 * Retires: `focus:border-fg-muted` (gray focus), `focus:ring-*` focus,
 * `bg-canvas`/`bg-well` field surfaces, and `rounded`/`rounded-sm`/`rounded-md`
 * field radii.
 *
 * FIELD covers ALL text entry, not just type="text": password (the 6 API-key
 * sites), search, number (keeps type="number"), and <textarea>.
 * ProvidersSection's key input already WAS this baseline — it's the reference.
 *
 * Known and accepted: inputs on `bg-inset/50` cards now sit closer to their
 * background than before. The alternative (bg-well inside inset cards) was
 * offered during review and not taken.
 *
 * Spec: docs/active/specs/2026-07-16-ui-consistency-design-spec.md §1.3
 */

import { mergeClasses } from './Button';

/**
 * The surface itself — background, border, radius. Split out because InputGroup
 * (change 77) puts these on a WRAPPER while the input inside goes bare; without
 * the split the two would drift apart the first time either is edited.
 */
export const FIELD_SURFACE = 'bg-inset border border-edge-dim rounded-lg';

/** The text treatment — shared by a bare input and a bordered one alike. */
export const FIELD_TEXT = 'text-fg placeholder:text-fg-muted';

/** Focus is a border color change, never a ring — the ring belongs to buttons. */
export const FIELD =
  `${FIELD_SURFACE} ${FIELD_TEXT} ` +
  'focus:outline-none focus:border-accent ' +
  // Disabled fields already exist (EngineCard's context-length input, InputBar's
  // composer, ReportReviewButton) and would otherwise lose their affordance.
  'disabled:opacity-50 disabled:cursor-not-allowed';

/** Hover and press for a field that is a BUTTON — a Select, the model picker, the
 *  folder switcher. Added 2026-09-18: these opened a menu on click and did nothing
 *  at all under the pointer. It is the border that answers, as it does on focus —
 *  a fill change would move under the value's text. Text INPUTS do not take this:
 *  a caret is their affordance, and changing every text field in the app was not
 *  what was asked for. */
export const FIELD_TRIGGER_STATES = 'cursor-pointer transition-colors hover:border-fg-muted active:border-fg-dim';

export type FieldSize = 'sm' | 'md';

export const FIELD_SIZE: Record<FieldSize, string> = {
  md: 'text-xs px-3 py-2',
  sm: 'text-2xs px-2.5 py-1.5',
};

export function fieldClasses(size: FieldSize = 'md', className = ''): string {
  // Goes through mergeClasses for the same reason buttonClasses does: Tailwind
  // resolves two competing utilities by CSS SOURCE order, not by the order they
  // appear in the class attribute. Plain concatenation meant a caller passing
  // `text-sm` or `px-4` got whichever one Tailwind happened to emit later —
  // which is how tranche 0's pills silently rendered as rounded rectangles
  // (§10.3). Fields had the same latent bug until this call was added.
  return mergeClasses([FIELD, FIELD_SIZE[size]].join(' '), className).trim();
}
