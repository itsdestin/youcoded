import { useCallback, useEffect, useRef, useState } from 'react';
import type { PerformanceConfigSnapshot } from '../../shared/types';

interface UsePerformanceConfigResult {
  loaded: boolean;
  saved: boolean;            // current persisted value
  appliedAtLaunch: boolean;  // value the running process actually used
  multiGpuDetected: boolean;
  gpuList: string[];
  needsRestart: boolean;     // saved !== appliedAtLaunch
  setPreferPowerSaving: (value: boolean) => Promise<void>;
  restart: () => Promise<void>;
}

const DEFAULT_SNAPSHOT: PerformanceConfigSnapshot = {
  preferPowerSaving: false,
  appliedAtLaunch: false,
  multiGpuDetected: false,
  gpuList: [],
};

export function usePerformanceConfig(): UsePerformanceConfigResult {
  const [loaded, setLoaded] = useState(false);
  const [snapshot, setSnapshot] = useState<PerformanceConfigSnapshot>(DEFAULT_SNAPSHOT);
  // The last value known to be on disk, and the number of the newest request (review of N1): a failed save must put the toggle back to
  // what is really saved, not to "the opposite of what was just asked", which is wrong when two quick toggles both fail.
  const savedPref = useRef(false);
  const newestRequest = useRef(0);
  const running = useRef(0);

  useEffect(() => {
    let cancelled = false;
    window.claude.performance.get().then((s) => {
      if (cancelled) return;
      savedPref.current = s.preferPowerSaving;
      setSnapshot(s);
      setLoaded(true);
    }).catch(() => {
      if (cancelled) return;
      setLoaded(true); // surface defaults — section will hide due to multiGpuDetected:false
    });
    return () => { cancelled = true; };
  }, []);

  const setPreferPowerSaving = useCallback(async (value: boolean) => {
    // Optimistic update: flip saved synchronously so the toggle responds
    // immediately. If the IPC fails, revert AND re-throw — the re-throw is
    // load-bearing. Without it, an awaiting consumer in PerformanceSection
    // sees a clean resolution even when persistence failed, so error UX
    // (toast, rollback indicator) never fires. Don't "simplify" by swallowing.
    const mine = ++newestRequest.current;
    running.current += 1;
    setSnapshot((prev) => ({ ...prev, preferPowerSaving: value }));
    try {
      await window.claude.performance.set(value);
      savedPref.current = value;
    } catch (err) {
      // Only the newest request puts the toggle back at once (an older failure must not undo a newer, working choice).
      if (mine === newestRequest.current) setSnapshot((prev) => ({ ...prev, preferPowerSaving: savedPref.current }));
      throw err;
    } finally {
      // When the LAST running save settles, the toggle shows the last value known saved, so a late success of an older save can never leave
      // the screen and the disk disagreeing.
      running.current -= 1;
      if (running.current === 0) setSnapshot((prev) => (prev.preferPowerSaving === savedPref.current ? prev : { ...prev, preferPowerSaving: savedPref.current }));
    }
  }, []);

  const restart = useCallback(async () => {
    await window.claude.app.restart();
  }, []);

  return {
    loaded,
    saved: snapshot.preferPowerSaving,
    appliedAtLaunch: snapshot.appliedAtLaunch,
    multiGpuDetected: snapshot.multiGpuDetected,
    gpuList: snapshot.gpuList,
    needsRestart: snapshot.preferPowerSaving !== snapshot.appliedAtLaunch,
    setPreferPowerSaving,
    restart,
  };
}
