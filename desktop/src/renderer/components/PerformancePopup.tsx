// desktop/src/renderer/components/PerformancePopup.tsx
import React from 'react';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import SettingsExplainer, { type ExplainerSection } from './SettingsExplainer';

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

interface Props { onClose: () => void; }

export default function PerformancePopup({ onClose }: Props) {
  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel layer={2} className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] max-h-[80vh] overflow-y-auto p-5">
        {/* onBack and onClose both close: this popup is standalone (no parent
            settings view to back into), so the back arrow and ✕ act identically. */}
        <SettingsExplainer
          title="Performance"
          intro={PERFORMANCE_EXPLAINER.intro}
          sections={PERFORMANCE_EXPLAINER.sections}
          onBack={onClose}
          onClose={onClose}
        />
      </OverlayPanel>
    </>
  );
}
