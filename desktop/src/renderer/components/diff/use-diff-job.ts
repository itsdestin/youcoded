import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOnScreen } from '../../state/on-screen-context';
import { diffQueue } from './diff-jobs';
import type { DiffRow } from './diff-rows';

export function useDiffJob(oldStr: string, newStr: string, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const key = useMemo(() => enabled ? { oldStr, newStr } : null, [oldStr, newStr, enabled, attempt]);
  const [result, setResult] = useState<{ key: typeof key; rows?: DiffRow[]; error?: string } | null>(null);
  const onScreen = useOnScreen();
  const completed = useRef<typeof key>(null);
  useEffect(() => {
    // Hidden ChatViews stay mounted. Stop pending CPU work there, but keep a
    // completed answer so returning to a tab does not recompute it.
    if (!key) { completed.current = null; setResult(null); return; }
    if (!onScreen || completed.current === key) return;
    setResult(null);
    let cancelled = false;
    const job = diffQueue.request(key);
    void job.promise.then((rows) => {
      if (!cancelled && rows) { completed.current = key; setResult({ key, rows }); }
    }, (error: Error) => {
      if (!cancelled) setResult({ key, error: error.message });
    });
    return () => { cancelled = true; job.cancel(); };
  }, [key, onScreen]);
  // WHY identity-gate in render: effects run after commit. A new comparison
  // must never paint the previous file's rows or error for even one frame.
  const current = result?.key === key ? result : null;
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { rows: current?.rows, error: current?.error, loading: enabled && onScreen && !current, retry };
}
