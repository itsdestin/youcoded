// The keyboard's announced-versus-real height, remembered (useVisualViewport.ts — why).
// WHY its own module: the hook is driven by animation frames and the phone; this is the part that decides where the
// message box aims, so it is tested on its own (tests/ime-rest-memory.test.ts).

/** Where the box should aim when the phone announces a height, and what to learn when the keyboard comes to rest. */
export interface ImeRestMemory {
  /** The phone announced the keyboard's final height (0 = closing). Returns the height to aim at. */
  announce(px: number): number;
  /** The keyboard came to rest at this height. Returns the height to aim at (always the real one). */
  rest(px: number): number;
}

type Store = Pick<Storage, 'getItem' | 'setItem'> | null;

export function createImeRestMemory(store: Store, key = 'youcoded:ime-rest-heights'): ImeRestMemory {
  let learned: Record<string, number> = {};
  try { learned = JSON.parse(store?.getItem(key) || '{}') || {}; } catch { learned = {}; }
  // Per-viewer convenience only: storage can be missing or refuse, and the box still lands right via rest().
  const save = () => { try { store?.setItem(key, JSON.stringify(learned)); } catch { /* ignore */ } };
  let first = 0; // the first height announced since the keyboard was last closed
  return {
    announce(px) {
      const v = Number.isFinite(px) ? Math.max(0, px) : 0;
      if (v === 0) { first = 0; return 0; }
      if (first === 0) first = v;
      return learned[v] ?? v;
    },
    rest(px) {
      const v = Number.isFinite(px) ? Math.max(0, px) : 0;
      if (first > 0 && v > 0 && v !== first) { learned[first] = v; save(); }
      // The keyboard really was as tall as announced: a remembered correction for it is wrong, forget it.
      else if (first > 0 && v === first && learned[first] !== undefined) { delete learned[first]; save(); }
      return v;
    },
  };
}
