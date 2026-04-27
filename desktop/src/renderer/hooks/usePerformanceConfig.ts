import { useCallback, useEffect, useState } from 'react';
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

  useEffect(() => {
    let cancelled = false;
    window.claude.performance.get().then((s) => {
      if (cancelled) return;
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
    setSnapshot((prev) => ({ ...prev, preferPowerSaving: value }));
    try {
      await window.claude.performance.set(value);
    } catch (err) {
      setSnapshot((prev) => ({ ...prev, preferPowerSaving: !value }));
      throw err;
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
