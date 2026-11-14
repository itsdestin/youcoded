import { useCallback, useEffect, useRef } from 'react';
import { announceFailed } from '../utils/announce';

/**
 * Save the new-session defaults (Settings → Assistant settings → General) and say so when a save fails (card #134).
 *
 * WHY: the page showed the new value the instant it was picked, then awaited the save with nothing watching it — a save that
 * failed left the screen showing a value that was never stored, until the next restart quietly changed it back.
 * Rules (Destin: no false alarms, newest attempt decides, clears itself):
 *  - Only a real failure counts: the call rejecting, or answering false / { ok:false }. A slow save says nothing.
 *  - The screen goes back to the last value KNOWN to be saved (not "the opposite of the click"), and only once every save of
 *    the batch has settled, so an older failure arriving late cannot undo a newer success of the same setting.
 *  - The words are a toast (these controls sit on pages with no room for a box; the toast clears itself), and nothing is said
 *    after the panel unmounted.
 */
export function useDefaultsSaver<D extends object>(
  defaults: D,
  setDefaults: (d: D) => void,
  save: (updates: Partial<D>) => Promise<unknown> | undefined,
) {
  const saved = useRef<D>(defaults);
  const shown = useRef<D>(defaults);
  const inFlight = useRef(0);
  const failedInBatch = useRef(false);
  const lastWhy = useRef<unknown>(undefined);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // A re-read from the host (a quiet refresh on open) is the new truth while nothing is being saved.
  if (inFlight.current === 0) { saved.current = defaults; shown.current = defaults; }

  return useCallback(async (updates: Partial<D>) => {
    const merged = { ...shown.current, ...updates } as D;
    shown.current = merged;
    setDefaults(merged);
    inFlight.current += 1;
    let failed = false;
    let why: unknown;
    try {
      const r = await save(updates);
      // The defaults channel answers the merged object on success and `null` when the write failed (prefs-service writeDefaults
      // catches every write error). `undefined` = no such channel here (older host): not a failure. false / { ok:false } also count.
      if (r === null || r === false || (r && typeof r === 'object' && (r as { ok?: unknown }).ok === false)) { failed = true; why = (r as { error?: unknown } | null)?.error; }
    } catch (e) { failed = true; why = e; }
    inFlight.current -= 1;
    if (failed) { failedInBatch.current = true; lastWhy.current = why; } else saved.current = { ...saved.current, ...updates } as D;
    if (inFlight.current > 0) return;
    // Everything has settled. Only if the screen now shows something that is NOT what is saved was there a real problem: an older
    // failure that a newer save of the same setting overwrote leaves them equal, and says nothing.
    const hadFailure = failedInBatch.current; failedInBatch.current = false;
    if (!hadFailure || !alive.current || JSON.stringify(shown.current) === JSON.stringify(saved.current)) return;
    shown.current = saved.current;
    setDefaults(saved.current);
    announceFailed('save this setting', lastWhy.current);
  }, [save, setDefaults]);
}
