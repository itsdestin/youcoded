import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useScrollFade } from '../hooks/useScrollFade';

// Shared About popup for Desktop and Android settings. Previously this was an
// inline collapsible inside SettingsPanel on both platforms, which didn't match
// the rest of the settings menu popups (PreferencesPopup, ModelPicker, etc.).
// Now it's a proper layer-2 overlay: centered, theme-driven glass surface,
// scrim-to-dismiss, Escape-to-close.

interface AboutPopupProps {
  open: boolean;
  onClose: () => void;
  platform: 'desktop' | 'android';
  version: string;
  build?: string;
}

const DESKTOP_LIBS: { lib: string; license: string; source: string }[] = [
  { lib: 'Electron', license: 'MIT', source: 'github.com/electron/electron' },
  { lib: 'React', license: 'MIT', source: 'github.com/facebook/react' },
  { lib: 'Vite', license: 'MIT', source: 'github.com/vitejs/vite' },
  { lib: 'xterm.js', license: 'MIT', source: 'github.com/xtermjs/xterm.js' },
  { lib: 'node-pty', license: 'MIT', source: 'github.com/microsoft/node-pty' },
  { lib: 'Tailwind CSS', license: 'MIT', source: 'github.com/tailwindlabs/tailwindcss' },
  { lib: 'highlight.js', license: 'BSD 3-Clause', source: 'github.com/highlightjs/highlight.js' },
  { lib: 'partysocket / PartyKit', license: 'MIT / ISC', source: 'github.com/partykit/partykit' },
  { lib: 'Cascadia Code', license: 'SIL OFL', source: 'github.com/microsoft/cascadia-code' },
];

const ANDROID_LIBS: { lib: string; license: string; source: string }[] = [
  { lib: 'Termux terminal-emulator', license: 'GPLv3', source: 'github.com/termux/termux-app' },
  { lib: 'Termux terminal-view', license: 'GPLv3', source: 'github.com/termux/termux-app' },
  { lib: 'AndroidX / Jetpack Compose', license: 'Apache 2.0', source: 'developer.android.com' },
  { lib: 'Apache Commons Compress', license: 'Apache 2.0', source: 'commons.apache.org' },
  { lib: 'CommonMark', license: 'BSD 2-Clause', source: 'github.com/commonmark/commonmark-java' },
  { lib: 'XZ for Java', license: 'Public Domain', source: 'tukaani.org/xz' },
  { lib: 'Zstd-JNI', license: 'BSD', source: 'github.com/luben/zstd-jni' },
  { lib: 'Cascadia Mono', license: 'SIL OFL', source: 'github.com/microsoft/cascadia-code' },
];

export default function AboutPopup({ open, onClose, platform, version, build }: AboutPopupProps) {
  const scrollRef = useScrollFade<HTMLDivElement>();

  // Escape-to-close, matching PreferencesPopup/ModelPickerPopup convention.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const libs = platform === 'desktop' ? DESKTOP_LIBS : ANDROID_LIBS;
  const versionLine = `YouCoded ${version}${build ? ` · ${build}` : ''}`;

  return createPortal(
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        aria-labelledby="about-popup-title"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-md w-[calc(100%-2rem)] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* See-through header — matches ModelPickerPopup / StatusBar popups.
            No bg-panel here: the opaque header rectangle would clip sharp top
            corners over the parent's rounded .layer-surface. */}
        <div className="shrink-0 border-b border-edge flex items-center justify-between px-5 py-3">
          <div>
            <h3 id="about-popup-title" className="text-sm font-semibold text-fg">About</h3>
            <p className="text-[10px] text-fg-muted mt-0.5">{versionLine}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-fg-muted hover:text-fg transition-colors w-7 h-7 flex items-center justify-center rounded-sm hover:bg-inset"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Padding lives on an inner wrapper so scroll-fade has no padding;
            sticky fade pseudos then sit flush with the scroll-fade's outer edge. */}
        <div ref={scrollRef} className="scroll-fade">
          <div className="p-5 space-y-5">
          {/* Disclaimer — identical on both platforms */}
          <section className="space-y-1.5">
            <h4 className="text-[10px] font-medium text-fg-muted uppercase tracking-wider">Disclaimer</h4>
            <p className="text-[11px] text-fg-dim leading-relaxed">
              YouCoded is an independent, community-built project. It is not affiliated with, endorsed by, or officially supported by Anthropic.
            </p>
            <p className="text-[11px] text-fg-dim leading-relaxed">
              "Claude" and "Claude Code" are trademarks of Anthropic, PBC.
            </p>
            <p className="text-[11px] text-fg-dim leading-relaxed">
              Thanks to the Anthropic team for building Claude Code. This project exists because of their work.
            </p>
          </section>

          <hr className="border-edge-dim" />

          {/* Privacy — platform-specific */}
          <section className="space-y-1.5">
            <h4 className="text-[10px] font-medium text-fg-muted uppercase tracking-wider">Privacy</h4>
            {platform === 'desktop' ? (
              <>
                <p className="text-[11px] text-fg-dim leading-relaxed">
                  YouCoded does not collect, transmit, or store any telemetry or personal data. All Claude interactions happen between the Claude Code CLI on your machine and Anthropic's servers using your own sign-in.
                </p>
                <p className="text-[11px] text-fg-dim leading-relaxed">
                  Remote access (when enabled) serves the UI over your local network or Tailscale. Remote connections are NOT TLS-encrypted — use Tailscale for sensitive conversations since it provides WireGuard encryption end-to-end.
                </p>
                <p className="text-[11px] text-fg-dim leading-relaxed">
                  Multiplayer games connect to a PartyKit server (Cloudflare) only while a lobby or game is open. No game traffic is retained server-side beyond the active room.
                </p>
              </>
            ) : (
              <>
                <p className="text-[11px] text-fg-dim leading-relaxed">
                  Your API key is stored locally on your device using Android Keystore encryption. It is never transmitted to or collected by YouCoded.
                </p>
                <p className="text-[11px] text-fg-dim leading-relaxed">
                  YouCoded does not collect, transmit, or store any personal data. All Claude Code interactions happen directly between the on-device CLI and Anthropic's API servers using your own API key.
                </p>
                <p className="text-[11px] text-fg-dim leading-relaxed">
                  During initial setup, Termux runtime packages are downloaded from packages.termux.dev over HTTPS with SHA256 verification.
                </p>
              </>
            )}
          </section>

          <hr className="border-edge-dim" />

          {/* Licenses — platform-specific intro + lib list */}
          <section className="space-y-1.5">
            <h4 className="text-[10px] font-medium text-fg-muted uppercase tracking-wider">Licenses</h4>
            {platform === 'desktop' ? (
              <>
                <p className="text-[11px] text-fg-dim leading-relaxed">
                  The YouCoded desktop application is licensed under the MIT License.
                </p>
                <p className="text-[11px] text-fg-dim leading-relaxed">
                  Note: The YouCoded Android application is distributed under GPLv3 because it links against Termux. The desktop application has no such dependency and is MIT throughout.
                </p>
              </>
            ) : (
              <>
                <p className="text-[11px] text-fg-dim leading-relaxed">
                  The YouCoded Android application is distributed under the GNU General Public License v3.0 (GPLv3) because it links against Termux terminal components, which are GPLv3.
                </p>
                <p className="text-[11px] text-fg-dim leading-relaxed">
                  The YouCoded source code itself — including the shared React interface that powers this app — is offered under the MIT License. The Android distribution as a whole is GPLv3; the underlying source remains MIT upstream.
                </p>
              </>
            )}
            <div className="mt-2 space-y-1 pl-2">
              {libs.map(({ lib, license, source }) => (
                <div key={lib}>
                  <span className="text-[10px] text-fg-2 font-medium">{lib}</span>
                  <span className="text-[10px] text-fg-faint ml-1">· {license} · {source}</span>
                </div>
              ))}
            </div>
          </section>
          </div>
        </div>
      </OverlayPanel>
    </>,
    document.body,
  );
}
