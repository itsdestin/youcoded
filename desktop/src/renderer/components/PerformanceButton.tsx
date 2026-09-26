import { useState } from 'react';
import { createPortal } from 'react-dom';
import { usePerformanceConfig } from '../hooks/usePerformanceConfig';
import PerformancePopup from './PerformancePopup';
import { SettingRow } from './ui';
import { useScreenOpen } from '../shoot-mode';

// Performance settings entry. Mirrors the chip+popup pattern used by Sound,
// Appearance, and Sync — a small row in the settings list that opens a popup
// where the actual controls and explainer live. Keeps the settings panel
// scannable and consistent.
//
// Hidden when the system has only one GPU (Apple Silicon, single-iGPU desktops,
// detection failures) so single-GPU users don't see a non-functional control.
// We own the hook here (not in PerformancePopup) so the chip's status label
// stays in sync with the toggle inside the popup — both render off the same
// state instance.
export default function PerformanceButton() {
  const cfg = usePerformanceConfig();
  const [open, setOpen] = useState(false);
  useScreenOpen('settings/performance', () => setOpen(true)); // photo-only build: `shoot` opens it by name

  if (!cfg.loaded || !cfg.multiGpuDetected) return null;

  // Status label reads off saved (the persisted pref). Even though it takes a
  // restart for the Chromium switch to flip, the chip reflects the user's
  // intent immediately — pairs with the popup's "Restart YouCoded to apply"
  // notice when saved !== appliedAtLaunch.
  const stateLabel = cfg.saved ? 'Power saving' : 'Discrete GPU';

  return (
    <>
      <SettingRow
        // Simple CPU/chip glyph — no real semantic image fits "GPU pref" cleanly,
        // so a generic chip icon is the cleanest visual cue.
        icon={
          <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <rect x="9" y="9" width="6" height="6" />
            <line x1="9" y1="2" x2="9" y2="4" />
            <line x1="15" y1="2" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="22" />
            <line x1="15" y1="20" x2="15" y2="22" />
            <line x1="2" y1="9" x2="4" y2="9" />
            <line x1="2" y1="15" x2="4" y2="15" />
            <line x1="20" y1="9" x2="22" y2="9" />
            <line x1="20" y1="15" x2="22" y2="15" />
          </svg>
        }
        title="Performance"
        description={`${stateLabel}${cfg.needsRestart ? ' · restart pending' : ''}`}
        onClick={() => setOpen(true)}
      />

      {/* Portal to document.body so the popup centers over the full viewport.
          SettingsPanel's outer wrapper has a transform/filter that creates a
          containing block for position:fixed descendants — without the portal,
          the popup would center inside the panel instead of the viewport. Same pattern as
          ThemeButton, SoundButton, RemoteButton. */}
      {open && createPortal(
        <PerformancePopup
          onClose={() => setOpen(false)}
          saved={cfg.saved}
          gpuList={cfg.gpuList}
          needsRestart={cfg.needsRestart}
          setPreferPowerSaving={cfg.setPreferPowerSaving}
          restart={cfg.restart}
        />,
        document.body,
      )}
    </>
  );
}
