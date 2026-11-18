import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorState } from '../components/ui';
import { plainMessage, isUnsupportedHere } from '../utils/ipc-error';

/** One failed save of a small setting, as shown beside its control. */
interface SaveFailure { message: string; details?: string; retry: () => void }

/**
 * "Couldn't save X" notices for small settings and toggles inside a popup (card #134, Destin's N1: a notice box inside the
 * popup, next to the control). His requirements, which this hook is built around:
 *  - ONLY a real failure: a save that is merely slow shows nothing (no timers here), and a save that resolves `false`, answers
 *    `{ ok:false }` or rejects is the only thing that counts as failed.
 *  - No false alarms from races: a result that arrives after the popup closed (or after the component unmounted) is ignored,
 *    and so is a result for a save that a NEWER save of the same control has already superseded.
 *  - The control snaps back to its true value: `snapBack` runs on a real failure.
 *  - The notice goes away when a later save of that control succeeds, when Try again succeeds, and when the popup closes
 *    (reopening shows none).
 * `open` is whether the popup is showing; a popup that is always mounted passes its open flag.
 */
export function useSaveNotice(open: boolean) {
  const [failures, setFailures] = useState<Record<string, SaveFailure>>({});
  const generation = useRef(0);
  /** Per control: the number of the newest save, how many are still running, and how the newest one ended. */
  const seq = useRef<Record<string, number>>({});
  const inFlight = useRef<Record<string, number>>({});
  const newest = useRef<Record<string, { failed: boolean; details: string; unsupported: boolean }>>({});

  // Closing (or reopening) starts a new generation: pending results from the old one are ignored, and no notice survives.
  useEffect(() => {
    generation.current += 1;
    seq.current = {}; inFlight.current = {}; newest.current = {};
    setFailures((f) => (Object.keys(f).length ? {} : f)); // no new object when there is nothing to clear
    return () => { generation.current += 1; };
  }, [open]);

  /** Run one save of `key`. `save` resolves false / `{ok:false}` / rejects on failure. `retry` re-does the user's action with the
   *  control's CURRENT value (the caller reads it fresh; do not capture the value that just failed). */
  const run = useCallback(async (
    key: string,
    label: string,
    save: () => Promise<unknown>,
    snapBack: () => void,
    retry: () => void,
  ) => {
    const gen = generation.current;
    const mine = (seq.current[key] = (seq.current[key] ?? 0) + 1);
    inFlight.current[key] = (inFlight.current[key] ?? 0) + 1;
    let failed = false;
    let unsupported = false; // not allowed / not available on this client: the control goes back, but no "Couldn't save" notice
    let details = '';
    try {
      const r = await save();
      if (isUnsupportedHere(r)) { failed = true; unsupported = true; }
      if (r === false || (r && typeof r === 'object' && (r as { ok?: unknown }).ok === false)) {
        failed = true;
        const err = (r as { error?: unknown } | null)?.error;
        details = typeof err === 'string' ? err : '';
      }
    } catch (e) {
      failed = true;
      if (isUnsupportedHere(e)) unsupported = true; else details = plainMessage(e, '');
    }
    if (gen !== generation.current) return; // popup closed, or unmounted: nothing to say
    inFlight.current[key] -= 1;
    // Only the NEWEST save decides what the person sees; an older one just records nothing.
    if (mine === seq.current[key]) newest.current[key] = { failed, details, unsupported };
    // Wait until every save of this control has settled, so a late result of an older one can never leave the screen and the
    // disk disagreeing: whatever ended last, the control then shows the last value known saved unless the newest save worked.
    if (inFlight.current[key] > 0) return;
    const outcome = newest.current[key];
    if (!outcome || !outcome.failed) {
      setFailures((f) => { if (!f[key]) return f; const { [key]: _gone, ...rest } = f; return rest; });
      return;
    }
    snapBack();
    if (outcome.unsupported) return;
    setFailures((f) => ({ ...f, [key]: { message: `Couldn't save ${label}`, details: outcome.details || undefined, retry } }));
  }, []);

  /** The notice for one control, or null. Try again clears it and re-does the action. */
  const notice = (key: string, className?: string) => {
    const f = failures[key];
    if (!f) return null;
    return (
      <ErrorState variant="inline" className={className} message={f.message} details={f.details}
        onRetry={() => { setFailures((x) => { const { [key]: _gone, ...rest } = x; return rest; }); f.retry(); }} />
    );
  };

  return { run, notice };
}
