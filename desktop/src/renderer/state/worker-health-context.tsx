// worker-health-context.tsx
// Tracks whether the marketplace Worker backend is reachable.
//
// Components call reportResult(ok) after each Worker API call.
// After 30 seconds of no successful response AND at least one error,
// reachable flips to false. A single success anywhere restores it.
//
// The indicator in Marketplace.tsx reads useWorkerHealth() and renders
// a small red dot + tooltip when reachable === false.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// ── Context shape ─────────────────────────────────────────────────────────────

interface WorkerHealthCtx {
  /** false only after 30s of no successes AND at least one error. */
  reachable: boolean;
  /** Unix ms timestamp of the last failure, or null. */
  lastError: number | null;
  /** Call this after every Worker API call. ok=true on success, false on network error. */
  reportResult(ok: boolean): void;
}

const WorkerHealthContext = createContext<WorkerHealthCtx | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

const UNREACHABLE_AFTER_MS = 30_000;

/** Derive the reachable boolean from stored timestamps + current time. */
function deriveReachable(
  lastSuccess: number | null,
  lastError: number | null,
  now: number
): boolean {
  if (lastError === null) return true;             // never errored
  if (lastSuccess !== null && lastSuccess > lastError) return true; // recovered
  if (now - lastError < UNREACHABLE_AFTER_MS) return true;          // within grace
  return false;
}

export function WorkerHealthProvider({ children }: { children: React.ReactNode }) {
  const [lastSuccess, setLastSuccess] = useState<number | null>(null);
  const [lastError, setLastError] = useState<number | null>(null);
  // reachable is stored as state so it re-renders when the timer fires
  const [reachable, setReachable] = useState(true);

  // Refs for stable read inside callbacks/timers
  const lastSuccessRef = useRef<number | null>(null);
  const lastErrorRef = useRef<number | null>(null);

  const reportResult = useCallback((ok: boolean) => {
    const now = Date.now();
    if (ok) {
      lastSuccessRef.current = now;
      setLastSuccess(now);
      // A success always restores reachability immediately
      setReachable(true);
    } else {
      lastErrorRef.current = now;
      setLastError(now);
      // Re-derive — at the moment of failure we're still within grace period
      setReachable(deriveReachable(lastSuccessRef.current, now, now));
    }
  }, []);

  // Schedule a re-evaluation at the grace-period boundary so the indicator
  // appears automatically without requiring another API call.
  useEffect(() => {
    if (lastError === null) return; // no error recorded yet
    if (lastSuccess !== null && lastSuccess > lastError) return; // already recovered

    const elapsed = Date.now() - lastError;
    if (elapsed >= UNREACHABLE_AFTER_MS) {
      // Already past the threshold — flip immediately
      setReachable(false);
      return;
    }

    // Schedule a flip at the exact boundary
    const remaining = UNREACHABLE_AFTER_MS - elapsed;
    const timer = setTimeout(() => {
      setReachable(deriveReachable(lastSuccessRef.current, lastErrorRef.current, Date.now()));
    }, remaining);

    return () => clearTimeout(timer);
  }, [lastError, lastSuccess]);

  const value = useMemo<WorkerHealthCtx>(
    () => ({ reachable, lastError, reportResult }),
    [reachable, lastError, reportResult]
  );

  return (
    <WorkerHealthContext.Provider value={value}>
      {children}
    </WorkerHealthContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useWorkerHealth(): WorkerHealthCtx {
  const ctx = useContext(WorkerHealthContext);
  if (!ctx) {
    throw new Error('useWorkerHealth must be used inside <WorkerHealthProvider>');
  }
  return ctx;
}
