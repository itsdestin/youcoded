// pending-action.ts — "do it on the screen now, undo it if the computer says no" (one-core R6-2, instant buttons on a phone).
//
// WHY (Destin, 2026-09-24 plan, R6): a phone button used to wait for the computer's round trip before the screen changed, which feels laggy over a
// tailnet. Stop, a permission answer, close, send and the permission-mode chip now change the phone's own screen at once, marked as waiting, and
// this one helper decides how each ends:
//   - the computer answered yes (a reply, or the record's own published state agrees)  -> the waiting mark is dropped, the change stays;
//   - the computer refused or errored                                                   -> the change is undone, and the caller says so;
//   - the answer never came (the connection dropped, or it timed out)                    -> the screen WAITS, never guesses, and asks the
//     computer's record (R5's resume: the missed events plus the asks still open) once it can; whatever the record shows is what the screen keeps.
//
// This holds only what THIS screen did and has not had confirmed (a handle per action). It never copies session state: the record, through the
// screens' ordinary fills and live events, stays the one source of truth, and `check()` reads the screen as the record last filled it. Nothing is
// ever resent by this file: a refused or unconfirmed change is undone, and doing it again is the person's button.
//
// Used only where `isRemoteMode()` (a phone, or the Android app paired to a computer). The computer's own window talks to main over local IPC,
// where the round trip is invisible, and keeps its behaviour exactly.
import { useSyncExternalStore } from 'react';
import { isRemoteMode } from '../platform';

/** Why a change was put back. `refused`: the computer said no or errored (`detail` is its own words, never a guess); `absent`: it never answered
 *  and the record, asked afterwards, does not show the change; `redirected`: the computer took it in another shape (a queued message). */
type PendingUndo = { kind: 'refused'; detail?: string } | { kind: 'absent' } | { kind: 'redirected' };

/** How the transport ended: `answered` (the computer said yes), `sent` (a channel with no reply: the record will say), or a reason to put it back. */
type SendResult = 'answered' | 'sent' | { undo: PendingUndo };

export interface PendingAction {
  /** One live action per key (`stop:<session>`, `perm:<request>`, `close:<session>`, `mode:<session>`, `send:<id>`): a second press while the first
   *  is unconfirmed does nothing, so a change is never applied twice. */
  key: string;
  /** The conversation this belongs to; asked about (resumed) before a check when the answer was lost. */
  sessionId?: string;
  /** Draw the change now. */
  apply(): void;
  /** Send it. A rejection with `outcomeUnknown` (a drop, a timeout) means "the computer may have it": the screen waits. Any other rejection is a refusal. */
  send(): Promise<SendResult> | SendResult;
  /** The change stays (the mark is dropped by the helper either way). */
  confirm?(): void;
  /** Put the screen back, and say so. */
  undo(reason: PendingUndo): void;
  /** Does the record, as this screen now holds it, show the change? Called after the answer was lost, once the screen is as current as it can be. */
  check(): 'present' | 'absent' | Promise<'present' | 'absent'>;
  /** The answer was lost and another path settles it (a chat message's own "Not sure this was sent" note): forget this handle after calling it. */
  handOff?(): void;
  /** How long to wait for the record to show a change from a channel with no reply, before asking it. */
  settleAfterMs?: number;
  /** The record's own published state can settle the change on its own, without waiting for a reply (a stop whose turn ended, a mode the host read).
   *  `done()` is asked whenever `subscribe`'s callback fires; a record fact that has no store to subscribe to (the mode a host read) calls `confirmPending`. */
  observe?: { done(): boolean; subscribe?(notify: () => void): () => void };
}

export type PendingEnd = 'confirmed' | 'undone' | 'waiting' | 'duplicate';

interface Entry { a: PendingAction; phase: 'sending' | 'waiting'; timer?: ReturnType<typeof setTimeout>; unsub?: () => void; failedChecks?: number }

const live = new Map<string, Entry>();
const subs = new Set<() => void>();
let version = 0;
const emit = () => { version++; for (const cb of [...subs]) cb(); };

/** How long a reply-less change waits for the record before the screen asks it (a slow tailnet hop is well inside this). */
const DEFAULT_SETTLE_MS = 8000;
const MAX_FAILED_CHECKS = 3;

/** Fills a conversation again from the record without resetting anything the record agrees with (`session:open` with `have`): App registers it. */
let resumeSession: ((sessionId: string) => Promise<unknown>) | null = null;
export function registerPendingResume(fn: ((sessionId: string) => Promise<unknown>) | null): void { resumeSession = fn; }

/** True when this screen should draw a change before the computer answers: a phone, or the Android app paired to a computer. */
export function optimisticScreen(): boolean { return isRemoteMode(); }

/** The connection is up (or this screen has no connection to lose). Only a screen with a real socket can say otherwise. */
export function connected(): boolean {
  const s = typeof window !== 'undefined' ? (window as { claude?: { session?: { canSend?: () => boolean } } }).claude?.session : undefined;
  return s?.canSend?.() !== false;
}

function end(e: Entry, how: 'confirmed' | 'undone', reason?: PendingUndo): PendingEnd {
  if (live.get(e.a.key) !== e) return how;       // already ended by another path (a record event, a reconnect check): never end twice
  if (e.timer) clearTimeout(e.timer);
  e.unsub?.();
  live.delete(e.a.key);
  // The mark goes first, so an undo's own redraw never races a stale "waiting" look.
  emit();
  if (how === 'confirmed') e.a.confirm?.(); else e.a.undo(reason ?? { kind: 'absent' });
  return how;
}

/** Ask the record (resume first, so the screen is as current as the computer can make it), then keep or undo the change. */
async function settle(e: Entry, opts: { resume: boolean }): Promise<PendingEnd> {
  if (live.get(e.a.key) !== e) return 'confirmed';
  try {
    if (opts.resume && e.a.sessionId && resumeSession) await resumeSession(e.a.sessionId);
  } catch { /* the fill said how it went (the strip); the screen's own state is still the best the record has given */ }
  let seen: 'present' | 'absent';
  try { seen = await e.a.check(); } catch {
    // The record could not be asked (the connection is flaky): try again a little later, and after a few failures put the change back rather than leave the
    // screen showing something nobody could confirm (a hidden conversation, a mode, an answered card).
    e.failedChecks = (e.failedChecks ?? 0) + 1;
    return e.failedChecks < MAX_FAILED_CHECKS ? wait(e) : end(e, 'undone', { kind: 'absent' });
  }
  if (live.get(e.a.key) !== e) return 'confirmed';
  return seen === 'present' ? end(e, 'confirmed') : end(e, 'undone', { kind: 'absent' });
}

function wait(e: Entry): PendingEnd {
  e.phase = 'waiting';
  const ms = e.a.settleAfterMs ?? DEFAULT_SETTLE_MS;
  // Offline: the reconnect's check (reconcilePending) settles it. Online: give the record a moment to publish, then ask it.
  e.timer = setTimeout(() => { if (connected()) void settle(e, { resume: true }); }, ms);
  return 'waiting';
}

/**
 * Apply a change now and see it through. Resolves when the transport has ended: `confirmed`, `undone`, or `waiting` (the answer was lost: the
 * record settles it, see `reconcilePending`). A key already in flight returns `duplicate` and does nothing.
 */
export async function runPending(a: PendingAction): Promise<PendingEnd> {
  if (live.has(a.key)) return 'duplicate';
  const e: Entry = { a, phase: 'sending' };
  live.set(a.key, e);
  a.apply();
  if (a.observe?.subscribe) e.unsub = a.observe.subscribe(() => { if (a.observe!.done()) end(e, 'confirmed'); });
  emit();
  let result: SendResult;
  try {
    result = await a.send();
  } catch (err) {
    if ((err as { outcomeUnknown?: boolean } | null)?.outcomeUnknown) {
      if (a.handOff) { if (live.get(a.key) === e) { e.unsub?.(); live.delete(a.key); emit(); } a.handOff(); return 'waiting'; }
      return wait(e);
    }
    return end(e, 'undone', { kind: 'refused', detail: (err as { message?: string } | null)?.message });
  }
  if (result === 'answered') return end(e, 'confirmed');
  if (result === 'sent') return wait(e);
  return end(e, 'undone', result.undo);
}

/** The record published something that settles a change (an event the screen drew): drop the mark and keep it. Safe to call for a key that is not live. */
export function confirmPending(key: string): void {
  const e = live.get(key);
  if (e) end(e, 'confirmed');
}

/**
 * The screen is as current as it can be (a reconnect's fills just finished): every change whose answer was lost is settled against what the
 * record put on the screen. Nothing is sent. `resume` asks the record again first, for a caller that has not just filled.
 */
export async function reconcilePending(opts: { resume?: boolean } = {}): Promise<void> {
  const waiting = [...live.values()].filter((e) => e.phase === 'waiting' || (e.phase === 'sending' && !connected()));
  await Promise.all(waiting.map((e) => settle(e, { resume: opts.resume === true })));
}

/** True while this change is applied on the screen and not yet confirmed. */
export function isPending(key: string): boolean { return live.has(key); }

/** Keys of the unconfirmed changes that start with `prefix` (a stable set until something starts or ends). */
const cache = new Map<string, { v: number; set: ReadonlySet<string> }>();
function keysWith(prefix: string): ReadonlySet<string> {
  // One snapshot per (prefix, version), and the SAME object while its contents are unchanged: a screen reading `close:` is not redrawn when a
  // stop starts (useSyncExternalStore needs identity-stable snapshots, and the app root must not redraw for changes it does not draw).
  const before = cache.get(prefix);
  if (before && before.v === version) return before.set;
  const keys = [...live.keys()].filter((k) => k.startsWith(prefix));
  if (before && before.set.size === keys.length && keys.every((k) => before.set.has(k))) { before.v = version; return before.set; }
  const set = new Set(keys);
  cache.set(prefix, { v: version, set });
  return set;
}

const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };

/** The unconfirmed changes whose key starts with `prefix`, for drawing the waiting mark (and, for a close, hiding the pill). */
export function usePendingKeys(prefix: string): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => keysWith(prefix), () => keysWith(prefix));
}

/** Tests only: forget every handle, so one test's leftovers never reach the next. */
export function resetPendingForTests(): void {
  for (const e of live.values()) if (e.timer) clearTimeout(e.timer);
  live.clear(); subs.clear(); cache.clear(); version = 0; resumeSession = null;
}
