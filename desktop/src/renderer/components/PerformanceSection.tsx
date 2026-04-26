// desktop/src/renderer/components/PerformanceSection.tsx
import React, { useState } from 'react';
import { usePerformanceConfig } from '../hooks/usePerformanceConfig';
import { InfoIconButton } from './SettingsExplainer';
import PerformancePopup from './PerformancePopup';

// The Performance section in SettingsPanel. Hidden when only one GPU is
// detected (or when GPU enumeration failed) so single-GPU systems don't see
// a non-functional control. The (i) info icon opens an explainer popup that
// frames the GPU-vs-iGPU tradeoff and lists OS-level overrides.
export default function PerformanceSection() {
  const { loaded, saved, multiGpuDetected, gpuList, needsRestart,
          setPreferPowerSaving, restart } = usePerformanceConfig();
  const [showInfo, setShowInfo] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Hide entirely if config hasn't loaded yet OR only one GPU is present.
  // Single-GPU systems include desktops with iGPU only, Apple Silicon Macs,
  // and Linux systems where Chromium reported one device. Detection failures
  // (rejected promise, empty gpuDevice array) also fall through to hidden.
  if (!loaded || !multiGpuDetected) return null;

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await restart();
    } catch {
      setRestarting(false);
    }
  };

  return (
    <div className="mb-6">
      <div className="flex items-center mb-3 gap-2">
        <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase">
          Performance
        </h3>
        <InfoIconButton onClick={() => setShowInfo(true)} />
      </div>

      <p className="text-xs text-fg-2 mb-3">GPU choice affects performance.</p>

      <button
        type="button"
        role="switch"
        aria-checked={saved}
        onClick={() => {
          // Hook owns optimistic rollback + re-throw on persistence failure.
          // We swallow here intentionally — without an error toast surface yet,
          // the visual state has already corrected itself via the hook's revert,
          // and an unhandled rejection in the console is just noise.
          setPreferPowerSaving(!saved).catch(() => { /* see WHY above */ });
        }}
        className="w-full text-left flex items-start gap-3 p-3 rounded-lg hover:bg-inset transition-colors"
      >
        <span className={`mt-0.5 inline-block w-4 h-4 rounded border ${
          saved ? 'bg-accent border-accent' : 'border-edge'
        }`} />
        <span className="flex-1">
          <span className="block text-sm text-fg">Prefer power saving</span>
          <span className="block text-xs text-fg-muted mt-0.5">
            Use the integrated GPU instead of the discrete one. Saves battery,
            but UI animations may stutter.
          </span>
        </span>
      </button>

      {needsRestart && (
        <div className="mt-2 px-3 py-2 rounded-lg bg-inset flex items-center justify-between gap-3">
          <span className="text-xs text-fg-2">⟳ Restart YouCoded to apply.</span>
          <button
            type="button"
            onClick={handleRestart}
            disabled={restarting}
            className="text-xs px-3 py-1 rounded bg-accent text-on-accent disabled:opacity-60"
          >
            {restarting ? 'Restarting…' : 'Restart now'}
          </button>
        </div>
      )}

      {gpuList.length > 0 && (
        <p className="text-[11px] text-fg-muted mt-3">
          Detected GPUs: {gpuList.join(', ')}
        </p>
      )}

      {showInfo && (
        <PerformancePopup onClose={() => setShowInfo(false)} />
      )}
    </div>
  );
}
