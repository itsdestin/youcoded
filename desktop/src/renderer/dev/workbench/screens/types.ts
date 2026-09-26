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
  /** Another screen this one is EXPECTED to look identical to, and why. */
  sameAs?: { name: string; why: string };
};

