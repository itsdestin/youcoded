import React, { useState } from 'react';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useScrollFade } from '../hooks/useScrollFade';
import type { ExplainerSection } from './SettingsExplainer';

// Explainer copy lives here as a const because it pairs tightly with the
// controls above it — both are about GPU choice. Sections render inline in
// the popup body below the toggle/restart/detected-GPU controls.
const PERFORMANCE_EXPLAINER: { intro: string; sections: ExplainerSection[] } = {
  intro:
    "Your laptop has more than one graphics processor (GPU). YouCoded uses " +
    "the more powerful one by default for smoother chat, terminal scrolling, " +
    "and theme effects. If your laptop runs hot or your battery drains " +
    "faster than you'd like, you can switch to power-saving mode here — but " +
    "most performance issues actually trace back to GPU choice, so try this " +
    "before reaching for other settings.",
  sections: [
    {
      heading: 'Why YouCoded uses the discrete GPU',
      paragraphs: [
        "Integrated GPUs share system memory and thermal budget with your CPU. " +
        "When the integrated GPU works hard, your CPU slows down too — they're " +
        "physically the same chip and they share the cooling system. So a slow " +
        "GPU often shows up as both slow rendering AND a slow CPU.",
        "YouCoded also runs more concurrent visual work than most apps: each " +
        "chat session has its own terminal, themes can include animated " +
        "wallpapers and blur effects, and the chat history scrolls smoothly. " +
        "On a laptop with a discrete GPU, that work belongs on the discrete " +
        "card — it has its own memory and cooling and won't compete with " +
        "everything else your computer is doing.",
      ],
    },
    {
      heading: 'Other places to look for power savings',
      bullets: [
        { term: 'Themes', text: "Pick a theme without glassmorphism / blur, or enable Reduced Effects in Appearance — biggest GPU savings after this toggle." },
        { term: 'Close unused sessions', text: 'Each Claude session uses memory and a terminal, even when idle.' },
        { term: 'Windows', text: 'Settings → System → Display → Graphics → add YouCoded.exe → set "High performance" or "Power saving" per app. The OS setting overrides this toggle.' },
        { term: 'macOS', text: 'Apple Silicon switches automatically. On Intel Macs, System Settings → Battery → "Automatic graphics switching" controls this globally.' },
        { term: 'Linux (NVIDIA Optimus)', text: "Use prime-run or set __NV_PRIME_RENDER_OFFLOAD=1 when launching YouCoded. Chromium's switch alone doesn't reach the NVIDIA driver." },
      ],
    },
    {
      heading: 'Why a restart is needed',
      paragraphs: [
        "Graphics binding is set when YouCoded launches. Toggling at runtime " +
        "would require throwing away the current GPU context and reinitializing " +
        "every window, which Electron doesn't support. Restart is the clean path.",
      ],
    },
  ],
};

interface Props {
  onClose: () => void;
  saved: boolean;
  gpuList: string[];
  needsRestart: boolean;
  setPreferPowerSaving: (value: boolean) => Promise<void>;
  restart: () => Promise<void>;
}

// Performance popup. Combines the GPU pref toggle, restart notice, and
// detected-GPU footer with the explainer copy in a single scrollable body —
// matching the chip+popup pattern of Sound, Appearance, and Sync.
//
// State (saved/needsRestart/etc.) is owned by the parent PerformanceButton
// so the chip's status label stays in sync with the toggle inside the popup.
export default function PerformancePopup({
  onClose, saved, gpuList, needsRestart, setPreferPowerSaving, restart,
}: Props) {
  const bodyRef = useScrollFade<HTMLDivElement>();
  const [restarting, setRestarting] = useState(false);

  const handleToggle = () => {
    // Hook owns optimistic rollback + re-throw on persistence failure.
    // Suppress here because we have no error-toast surface yet — if the
    // write fails, the visual state has already corrected itself via the
    // hook's revert; surfacing the rejection in the console is just noise.
    setPreferPowerSaving(!saved).catch(() => { /* see WHY above */ });
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await restart();
    } catch {
      // On Electron the process exits before this resolves — we never reach
      // here. On remote browsers the WebSocket disconnect rejects the call,
      // which lands here and we clear the spinner.
      setRestarting(false);
    }
  };

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel layer={2} className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header — matches the SettingsExplainer header so the popup
            visually fits with the rest of the settings UI. */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
          <h2 className="text-sm font-bold text-fg">Performance</h2>
          <button
            onClick={onClose}
            className="text-fg-muted hover:text-fg-2 text-lg leading-none w-6 h-6 flex items-center justify-center"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Scrollable body. Controls at top, explainer below. */}
        <div ref={bodyRef} className="scroll-fade flex-1">
          <div className="px-4 py-4 space-y-4">
            <p className="text-xs text-fg-2">GPU choice affects performance.</p>

            {/* Toggle row — switch role for accessibility, matches the
                project's binary-settings pattern (e.g. PreferencesPopup). */}
            <button
              type="button"
              role="switch"
              aria-checked={saved}
              onClick={handleToggle}
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
              <div className="px-3 py-2 rounded-lg bg-inset flex items-center justify-between gap-3">
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
              <p className="text-[11px] text-fg-muted">
                Detected GPUs: {gpuList.join(', ')}
              </p>
            )}

            {/* Visual divider between controls and explainer. */}
            <hr className="border-edge-dim" />

            <p className="text-xs text-fg-2 leading-relaxed">{PERFORMANCE_EXPLAINER.intro}</p>

            {PERFORMANCE_EXPLAINER.sections.map((section, i) => (
              <section key={i}>
                <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">
                  {section.heading}
                </h3>
                {section.paragraphs?.map((p, j) => (
                  <p key={j} className="text-xs text-fg-2 leading-relaxed mb-2 last:mb-0">{p}</p>
                ))}
                {section.bullets && (
                  <ul className="space-y-1.5 mt-1">
                    {section.bullets.map((b, j) => (
                      <li key={j} className="text-xs text-fg-2 leading-relaxed pl-3 relative before:content-['•'] before:absolute before:left-0 before:text-fg-faint">
                        {b.term && <span className="font-semibold text-fg">{b.term}</span>}
                        {b.term && ' — '}
                        {b.text}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </div>
      </OverlayPanel>
    </>
  );
}
