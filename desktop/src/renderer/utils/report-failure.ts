import { announceFailed } from './announce';
import { plainMessage } from './ipc-error';

// The ONE way the screen side says "that did not work" (R-1, code review 2026-11-18, Destin: H-1 / H-2).
//
// WHY it exists: ~480 places in the app caught a failure and said nothing, and about 25 of them left a screen
// that lied (a switch showing ON that never saved) or work that was lost. Each fix used to mean inventing its own
// toast. This helper makes the right thing the short thing:
//   - 'toast'    small pop-up "Couldn't <what>." for minor things (Destin H-1). The real cause goes to the console.
//   - 'inline'   the caller draws the red <ErrorState> box (work could be lost); this only logs and hands back
//                the plain sentence so the box never shows a guessed cause.
//   - 'log-only' harmless failures nobody could act on (Destin H-2): recorded, never shown.
// Never invents a cause (docs/error-message-standards.md): the pop-up states only the plain fact.
export interface FailureReport {
  /** What the person was trying to do, in plain words, no "Couldn't": "save Fast mode". */
  what: string;
  /** The caught error, kept for the log and for the box's detail line. */
  cause?: unknown;
  /** Where in the app this happened, for the log: "ModelPicker.applyFast". */
  where: string;
  show: 'toast' | 'inline' | 'log-only';
}

// Same failure twice within this window is told once (a retry loop must not stack pop-ups).
const DEDUPE_MS = 30_000;
const lastShown = new Map<string, number>();

/** Returns the plain sentence for the real cause (or '' when none), for an inline box's detail line. */
export function reportFailure(r: FailureReport): string {
  const detail = r.cause === undefined ? '' : plainMessage(r.cause, '');
  const key = `${r.where}|${r.what}`;
  const now = Date.now();
  const recent = (lastShown.get(key) ?? -Infinity) > now - DEDUPE_MS;
  if (r.show === 'toast' && !recent) { lastShown.set(key, now); announceFailed(r.what, r.cause); }
  else console.warn(`[app] ${r.where}: couldn't ${r.what}${detail ? `: ${detail}` : ''}`);
  return detail;
}

/** Tests only. */
export function resetFailureDedupeForTests(): void { lastShown.clear(); }
