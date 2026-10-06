import type { ScenarioId } from '../scenarios';

// One entry of the screen list (index.ts explains the list).
export type ScreenEntry = {
  /** Path-style name, e.g. `settings/assistant/cloud`. */
  name: string;
  /** Groups for `shoot --tag`. */
  tags: readonly string[];
  /** Workbench scenario the screen needs (default: `default`). */
  scenario?: ScenarioId;
  /** A window size other than the default 1440×900 (a phone is 390×844). */
  viewport?: { width: number; height: number };
  /** Extra workbench URL switches, e.g. `{ fail: 'tags.list' }`. */
  params?: Readonly<Record<string, string>>;
  /** A practice session to select before opening (fixtures/sessions.ts ids: wb-2 is the
   *  native-runtime session that seeded conversations, error cards and `stalled` replay into). */
  session?: string;
  /** Milliseconds to wait after the screen shows before its picture — for a state that
   *  CHANGES on its own (a notice that used to clear itself after 6s). Keep it rare: it is
   *  slow by design. */
  waitMs?: number;
  /** "Open this first": steps `shoot` replays once the screen shows, before its picture — a
   *  button label to click (`'Your status: Online'`), or a journey step (`{ do: 'key', key:
   *  'ArrowDown' }`). WHY (games-social friction, proposal 9): an opened menu or folded card
   *  otherwise needs a workbench-only switch in production code just to be photographed. */
  open?: readonly (string | { readonly do: string; readonly [k: string]: unknown })[];
  /** Another screen this one is EXPECTED to look identical to, and why. */
  sameAs?: { name: string; why: string };
};

