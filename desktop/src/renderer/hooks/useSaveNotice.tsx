import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorState } from '../components/ui';
import { plainMessage } from '../utils/ipc-error';

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
  const seq = useRef<Record<string, number>>({});

  // Closing (or reopening) starts a new generation: pending results from the old one are ignored, and no notice survives.
  useEffect(() => {
    generation.current += 1;
    setFailures({});
    return () => { generation.current += 1; };
  }, [open]);

  /** Run one save of `key`. `save` resolves false / `{ok:false}` / rejects on failure. `retry` re-does the user's action. */
  const run = useCallback(async (
    key: string,
    label: string,
    save: () => Promise<unknown>,
    snapBack: () => void,
    retry: () => void,
  ) => {
    const gen = generation.current;
    const mine = (seq.current[key] = (seq.current[key] ?? 0) + 1);
    let failed = false;
    let details = '';
    try {
      const r = await save();
      if (r === false || (r && typeof r === 'object' && (r as { ok?: unknown }).ok === false)) {
        failed = true;
        const err = (r as { error?: unknown } | null)?.error;
        details = typeof err === 'string' ? err : '';
      }
    } catch (e) {
      failed = true;
      details = plainMessage(e, '');
    }
    if (gen !== generation.current || mine !== seq.current[key]) return; // popup closed, or a newer save of this control took over
    if (!failed) {
      setFailures((f) => { if (!f[key]) return f; const { [key]: _gone, ...rest } = f; return rest; });
      return;
    }
    snapBack();
    setFailures((f) => ({ ...f, [key]: { message: `Couldn't save ${label}`, details: details || undefined, retry } }));
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
