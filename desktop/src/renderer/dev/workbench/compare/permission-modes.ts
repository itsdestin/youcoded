// src/renderer/dev/workbench/compare/permission-modes.ts
//
// The permission-mode COPY, reproduced verbatim from the screen these rounds
// were run for — now components/PermissionsSection.tsx (its MODES and
// ALWAYS_ASKS), which at the time of the rounds was the candidate file
// components/permissions/VariantC.tsx.
//
// WHY A COPY AND NOT AN IMPORT. That file exports only its default component,
// and the comparison must not reach into a shipping file to serve the workbench —
// editing the production component to hold every candidate is the exact thing
// CompareView exists to replace (see its header). The words here are part of
// what is under review, so they are reproduced UNCHANGED: a candidate that
// rewrites a mode's definition is comparing copy and presentation at once, and
// the pick then cannot tell you which one you preferred.
//
// If a candidate wins, the winner moves into the real file and this copy goes
// away with the rest of the surface's scaffolding.

import type { NativePermissionMode } from '../../../../shared/permission-types';

export type PermissionModeDef = {
  id: NativePermissionMode;
  label: string;
  line: string;
};

/** VariantC's MODES, verbatim. Wording follows the StatusBar permission chip
 *  (PERMISSION_DISPLAY: ASK FIRST / AUTO EDIT / FULL AUTO), so this names the
 *  same three things the user can already see and click at the bottom of chat. */
export const MODES: readonly PermissionModeDef[] = [
  {
    id: 'ask',
    label: 'Ask first',
    line: 'Checks with you before it changes a file or runs a command. Reading and searching never interrupt you.',
  },
  {
    id: 'auto-edit',
    label: 'Auto edit',
    line: 'Changes files on its own without asking. It still checks before running a command.',
  },
  {
    id: 'full-auto',
    label: 'Full auto',
    line: 'Works without checking with you, so you can leave it running. The list below is the exception.',
  },
];

/** Option order for <RadioGroup>'s arrow-key walk — the same order as MODES. */
export const MODE_IDS: readonly string[] = MODES.map((m) => m.id);

export const MODE_ARIA = 'How much the assistant checks with you';

/** Where the mode ACTUALLY lives, verbatim from VariantC's mode card.
 *
 *  Every round-3 candidate prints this sentence, because a screen that defines
 *  the three modes and never says where they are set leaves the reader hunting
 *  for a control that is not on this screen at all. Held constant alongside
 *  MODES for the same reason MODES is: a pick should name a presentation, not a
 *  sentence. */
export const MODE_LOCATION_NOTE =
  'Each conversation has its own setting. Change it from the bar at the bottom of the chat.';

/** The hardcoded always-ask list (DESTRUCTIVE_DENY_LIST) in the user's words,
 *  verbatim from VariantC. Present in every candidate because Full auto's own
 *  definition ends "The list below is the exception" — judged without the list
 *  below it, that sentence points at nothing. */
export const ALWAYS_ASKS: readonly string[] = [
  'Deleting files or folders',
  'Sending your work to a shared code repository',
  "Throwing away changes you haven't saved anywhere else",
  "Anything needing your computer's administrator password",
];

/** The one canonical section-label spelling (ast-grep rule section-label-canonical-classes-ts). */
export const SECTION_LABEL = 'text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2';
