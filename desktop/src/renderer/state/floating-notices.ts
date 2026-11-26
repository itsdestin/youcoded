// floating-notices.ts — the app's two floating notice slots.
//
// WHY two slots (Destin, waiting-notice deck R-queue; independent reviews 1 and 2): there used to be ONE toast spot, so any
// later toast replaced the last — a "Copied" could wipe out "We turned off a plugin" before it was read, and two "needs you"
// notices at startup meant only the second survived. Now:
//   routine slot    — quick, self-closing notices ("Copied", "Couldn't copy the path"). Works exactly as before: a new one
//                     replaces the old one, and it NEVER waits behind anything.
//   needs-you list  — notices that stay until closed (K-7). Nothing is ever dropped: the first shows (with "1 more" when others
//                     wait), and closing it brings up the next. A routine toast shows beside it, never instead of it.
// WHY a tiny store and not React state in App: callers deep in the tree (announce(), App's own setToast calls) have no prop path
// to the slot, and only <FloatingNotices> needs to re-render when a notice changes (performance rule 3).
import type { ToastAction } from '../components/ui/Toast';

interface RoutineToastObject {
  message: string; durationMs?: number | null; action?: ToastAction; actions?: ToastAction[]; dismissible?: boolean;
  tone?: 'default' | 'error';
}
/** What callers hand `showRoutineToast`: a plain sentence, a sentence with options, or null to clear the routine slot. */
export type RoutineToastInput = string | RoutineToastObject | null;

interface RoutineSlot extends RoutineToastObject {
  /** Counts every show. WHY: used as the toast's key, so the SAME sentence shown again restarts its timer instead of
   *  running out on the old countdown (review B8). */
  n: number;
}
export interface NeedsYouNotice {
  id: number; message: string; tone?: 'default' | 'error';
  /** Its own button (drawn filled, rightmost; Dismiss is the outlined one on the left). */
  action?: { label: string; onClick: () => void };
}
export interface FloatingState { routine: RoutineSlot | null; needsYou: NeedsYouNotice[] }

let state: FloatingState = { routine: null, needsYou: [] };
let shows = 0;
let nextId = 1;
const listeners = new Set<() => void>();
function set(next: FloatingState): void { state = next; for (const l of [...listeners]) l(); }

export const subscribeFloatingNotices = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getFloatingNotices = (): FloatingState => state;

/**
 * The one entry for quick notices. `null` clears ONLY the routine slot — a notice that needs you is never removed by someone
 * else's "clear the toast" (review B3).
 */
export function showRoutineToast(input: RoutineToastInput): void {
  if (input == null) { if (state.routine) set({ ...state, routine: null }); return; }
  const obj: RoutineToastObject = typeof input === 'string' ? { message: input } : input;
  set({ ...state, routine: { ...obj, n: ++shows } });
}

/**
 * Adds a notice that needs you to the end of the line. Returns its id.
 * An identical sentence already waiting is not added a second time: the same message twice asks for the same thing twice,
 * and "1 more" would only repeat what the first one already says (nothing different is dropped).
 */
export function showNeedsYou(n: Omit<NeedsYouNotice, 'id'>): number {
  const same = state.needsYou.find((x) => x.message === n.message && x.action?.label === n.action?.label);
  if (same) return same.id;
  const id = nextId++;
  set({ ...state, needsYou: [...state.needsYou, { ...n, id }] });
  return id;
}

/** Closes exactly this one; the others keep their places. */
export function closeNeedsYou(id: number): void {
  if (state.needsYou.some((x) => x.id === id)) set({ ...state, needsYou: state.needsYou.filter((x) => x.id !== id) });
}

/** Test and practice-screen reset. */
export function resetFloatingNotices(): void { shows = 0; nextId = 1; set({ routine: null, needsYou: [] }); }
