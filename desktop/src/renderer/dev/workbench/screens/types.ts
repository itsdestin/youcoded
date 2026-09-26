// One entry of the screen list (index.ts explains the list).
export type ScreenEntry = {
  /** Path-style name, e.g. `settings/assistant/cloud`. */
  name: string;
  /** Groups for `shoot --tag`. */
  tags: readonly string[];
  /** Workbench scenario the screen needs (default: `default`). */
  scenario?: 'default' | 'empty' | 'no-providers' | 'refused' | 'stress';
  /** Extra workbench URL switches, e.g. `{ fail: 'tags.list' }`. */
  params?: Readonly<Record<string, string>>;
  /** Another screen this one is EXPECTED to look identical to, and why. */
  sameAs?: { name: string; why: string };
};

