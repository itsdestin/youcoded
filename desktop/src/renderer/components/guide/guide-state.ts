// src/renderer/components/guide/guide-state.ts
//
// The first-run guide's memory: whether the tour is owed, whether tips are
// armed, which tips have been read. Renderer localStorage, like every other UI
// preference in this app (theme, drawer width, buddy on/off) — there is no
// renderer settings store to put it in.
//
// WHY the tour is keyed on a flag the WIZARD sets, not on "setup is complete":
// every existing install already has setup complete, so keying on that would
// pop the tour over everyone's work on the first launch after this ships.
// Destin's rollout answer (2026-09-10 deck, Q-11): fresh installs only. The
// only way to get the pending flag is to finish the wizard after this shipped.
// Design: docs/active/specs/2026-09-10-first-run-guide-design.md §4.

const GUIDE_PENDING = 'youcoded-guide-pending';
const GUIDE_DONE = 'youcoded-guide-done';
const TIPS_ARMED = 'youcoded-tips-armed';
const TIPS_SEEN = 'youcoded-tips-seen';

function read(key: string): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch { /* a blocked store only costs the memory, never the screen */ }
}

/** The wizard just handed off to the app on THIS install: owe the tour and arm tips. */
export function armGuideForFreshInstall(): void {
  write(GUIDE_PENDING, '1');
  write(TIPS_ARMED, '1');
}

export function isGuidePending(): boolean { return read(GUIDE_PENDING) === '1'; }

/** Skip and Done both settle the debt; a replay from Settings never re-arms it. */
export function markGuideDone(): void {
  write(GUIDE_PENDING, null);
  write(GUIDE_DONE, new Date().toISOString());
}

/** When the tour ended (Skip or Done), or null. The themes tip waits a day. */
export function guideDoneAt(): number | null {
  const v = read(GUIDE_DONE);
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Small counters behind two tips: launches (the floater tip on the third)
 *  and sessions started (the projects tip on the fifth). */
export function bumpCounter(name: 'launches' | 'sessions-started'): number {
  const key = `youcoded-guide-count-${name}`;
  const n = (parseInt(read(key) ?? '0', 10) || 0) + 1;
  write(key, String(n));
  return n;
}

export function tipsArmed(): boolean { return read(TIPS_ARMED) === '1'; }
/** The Settings switch, and every tip's "Stop showing tips". */
export function setTipsArmed(on: boolean): void { write(TIPS_ARMED, on ? '1' : null); }

function seenList(): string[] {
  try { const v = JSON.parse(read(TIPS_SEEN) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
export function tipSeen(id: string): boolean { return seenList().includes(id); }
export function markTipSeen(id: string): void {
  const list = seenList();
  if (!list.includes(id)) write(TIPS_SEEN, JSON.stringify([...list, id]));
}

/** Test and workbench reset. */
export function resetGuideState(): void {
  for (const k of [GUIDE_PENDING, GUIDE_DONE, TIPS_ARMED, TIPS_SEEN, 'youcoded-guide-count-launches', 'youcoded-guide-count-sessions-started']) write(k, null);
}
