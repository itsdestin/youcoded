// leak-probe.ts — measure what a closed chat leaves behind (R-4 phase 0).
//
// WHY: the cleanup plan said "about 100 per-chat lists, not proven which leak". This reads the size of every Map, Set and
// array held directly on the real owner objects, so a test can open and close many chats and compare before/after.
// It reads instance fields (including private ones) — closures inside factory functions are invisible to it, which is why
// those owners (terminal-output-router, cc-outside-comments) are covered by their own tests instead.
export type Sizes = Record<string, number>;

/** Sizes of every Map / Set / array held directly on `obj`, keyed `<label>.<field>`. */
export function sizesOf(label: string, obj: object): Sizes {
  const out: Sizes = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof Map || value instanceof Set) out[`${label}.${key}`] = value.size;
    else if (Array.isArray(value)) out[`${label}.${key}`] = value.length;
  }
  return out;
}

/** Fields whose size grew from `before` to `after` (a field that did not exist before counts from 0). */
export function growth(before: Sizes, after: Sizes): Record<string, number> {
  const grew: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) {
    const d = v - (before[k] ?? 0);
    if (d > 0) grew[k] = d;
  }
  return grew;
}

/** Live timers and handles by kind, from the runtime itself (counts items, never milliseconds). */
export function activeResources(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo()) out[name] = (out[name] ?? 0) + 1;
  return out;
}
