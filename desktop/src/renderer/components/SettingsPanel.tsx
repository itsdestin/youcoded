declare const __APP_VERSION__: string;
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { isAndroid } from '../platform';
import ThemeScreen from './ThemeScreen';
import SyncSection from './SyncPanel';
import SettingsExplainer, { InfoIconButton, type ExplainerSection } from './SettingsExplainer';
import { useTheme } from '../state/theme-context';
import { MODELS, type ModelAlias } from './StatusBar';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { CLOSE_PROMPT_SUPPRESS_KEY } from './CloseSessionPrompt';
import { ModelInfoTooltip } from './ModelPickerPopup';
import { useScrollFade } from '../hooks/useScrollFade';
import AboutPopup from './AboutPopup';
import { DevelopmentPopup } from './development/DevelopmentPopup';
import { BugReportPopup } from './development/BugReportPopup';
import { ContributePopup } from './development/ContributePopup';

// Plain-language explainer for the Remote Access popup. Shown when the user
// taps the (i) icon in the popup header — see RemoteButton's `showInfo` state.
const REMOTE_ACCESS_EXPLAINER: { intro: string; sections: ExplainerSection[] } = {
  intro:
    "Remote Access lets you use YouCoded from any phone, tablet, or other computer — even when you're across the world. Your main computer keeps doing all the actual work; the other device just shows you what's happening and lets you type.",
  sections: [
    {
      heading: 'What is Tailscale?',
      paragraphs: [
        "Tailscale is a free, secure tunnel that connects your devices like they're on the same WiFi, even when they're far apart. We use it because it's much safer than opening your computer to the open internet.",
        'You install it once on your main computer (that\'s what the "Set Up Remote Access" button does), then sign in with Google or GitHub. After that, you can scan a QR code on your phone to connect.',
      ],
    },
    {
      heading: 'What the settings do',
      bullets: [
        { term: 'Enabled', text: 'Turns the remote server on or off. When off, no other device can connect to this computer.' },
        { term: 'Password', text: "A short word or phrase you'll type on your phone or tablet to prove it's really you. Required by default." },
        { term: 'Keep awake', text: "Stops your computer from going to sleep so it stays ready to respond. Set to a few hours during a session, or 'Off' to let it sleep normally." },
        { term: 'Skip password on Tailscale', text: 'If a device is already on your private Tailscale network, you trust it and skip the password. Convenient, but only turn on if you trust everyone on your Tailscale.' },
      ],
    },
    {
      heading: 'Common issues',
      bullets: [
        { term: '"Tailscale not installed"', text: 'Click "Set Up Remote Access" and follow the prompts. It downloads about 50MB and asks you to sign in through a browser.' },
        { term: '"VPN not active"', text: 'Tailscale is installed but turned off. Open the Tailscale app on your computer and switch it on.' },
        { term: "Phone can't connect", text: 'Make sure Tailscale is also installed on your phone and signed in to the same account. Both devices need it running at the same time.' },
        { term: "QR code won't scan", text: 'Tap "Copy link" instead, send the link to your phone (text it to yourself), and open it in your phone\'s browser.' },
        { term: 'Forgot the password', text: 'Just type a new one into the password box and hit "Set". The old one is replaced — there\'s nothing to recover.' },
        { term: 'Connected device should be removed', text: 'Use the ✕ next to a device under "Connected Devices" to disconnect it. They\'ll need the password again to reconnect.' },
      ],
    },
  ],
};

interface RemoteConfig {
  enabled: boolean;
  port: number;
  hasPassword: boolean;
  trustTailscale: boolean;
  keepAwakeHours: number;
  clientCount: number;
}

const KEEP_AWAKE_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '1h', value: 1 },
  { label: '4h', value: 4 },
  { label: '8h', value: 8 },
  { label: '24h', value: 24 },
];

interface TailscaleInfo {
  installed: boolean;
  connected: boolean;
  ip: string | null;
  hostname: string | null;
  url: string | null;
}

interface ClientInfo {
  id: string;
  ip: string;
  connectedAt: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSendInput: (text: string) => void;
  hasActiveSession: boolean;
  onOpenThemeMarketplace?: () => void;
  onPublishTheme?: (slug: string) => void;
  syncAutoOpen?: boolean;
  onSyncAutoOpenHandled?: () => void;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

// ─── Keyboard Shortcuts reference popup ──────────────────────────────────────

const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: 'Ctrl + `', description: 'Toggle between chat and terminal view' },
  { keys: 'Ctrl + O', description: 'Expand / collapse all tool cards' },
  { keys: 'Shift (hold)', description: 'Open session switcher' },
  { keys: 'Shift + Arrow Up/Down', description: 'Navigate between sessions' },
  { keys: 'Shift (release)', description: 'Switch to highlighted session' },
  { keys: 'Arrow Up/Down', description: 'Scroll chat view' },
  { keys: 'Shift + Tab', description: 'Cycle permission mode' },
  { keys: 'Shift + Space', description: 'Cycle model' },
  { keys: 'Shift + Enter', description: 'Insert newline in input' },
  { keys: 'Enter', description: 'Send message' },
  { keys: '/', description: 'Open skill/command drawer' },
  { keys: 'Escape', description: 'Close drawer or modal' },
  { keys: 'Arrow Left/Right', description: 'Cycle permission prompt buttons' },
];

function ShortcutsPopup({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return createPortal(
    // Overlay layer L2 — theme-driven via Scrim/OverlayPanel.
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 p-5 max-w-sm w-[calc(100%-2rem)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-fg">Keyboard Shortcuts</h3>
          <button onClick={onClose} className="text-fg-muted hover:text-fg transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="space-y-1.5">
          {SHORTCUTS.map(({ keys, description }) => (
            <div key={keys} className="flex items-center justify-between gap-3 py-1.5">
              <span className="text-[11px] text-fg-dim">{description}</span>
              <kbd className="shrink-0 text-[10px] font-mono text-fg-2 bg-inset border border-edge-dim rounded px-1.5 py-0.5">{keys}</kbd>
            </div>
          ))}
        </div>
      </OverlayPanel>
    </>,
    document.body
  );
}

export default function SettingsPanel({ open, onClose, onSendInput, hasActiveSession, onOpenThemeMarketplace, onPublishTheme, syncAutoOpen, onSyncAutoOpenHandled }: Props) {
  // Slide polish: track animation window so CSS can reduce backdrop-filter cost
  // and suppress scrollbar-thumb while the 300ms transform is running. Also
  // keeps the Scrim mounted during the close animation so it can fade out
  // instead of popping. `hasOpened` prevents the first render from showing a
  // stale scrim before the user has ever opened the panel.
  const [animating, setAnimating] = useState(false);
  const [hasOpened, setHasOpened] = useState(open);
  const outerScrollRef = useScrollFade<HTMLDivElement>();
  useEffect(() => {
    if (open) setHasOpened(true);
    setAnimating(true);
    // Fallback timer in case transitionend doesn't fire (e.g., tab backgrounded).
    const t = setTimeout(() => setAnimating(false), 350);
    return () => clearTimeout(t);
  }, [open]);

  const scrimVisible = hasOpened && (open || animating);

  return (
    <>
      {/* Backdrop — L1 drawer scrim, theme-driven via <Scrim>. Kept mounted
          through the close animation so opacity can fade rather than pop. */}
      {scrimVisible && (
        <Scrim
          layer={1}
          onClick={onClose}
          style={{
            WebkitAppRegion: 'no-drag',
            opacity: open ? 1 : 0,
            transition: 'opacity 300ms ease-out',
            pointerEvents: open ? 'auto' : 'none',
          } as React.CSSProperties}
        />
      )}

      {/* Panel — outer handles slide animation (transform), inner carries
          .settings-drawer glass. backdrop-filter on a transformed element
          breaks sampling in Chrome; moving it to an untransformed child
          is the common workaround. `will-change: transform` promotes the
          layer up front so the first frame doesn't hitch on layer creation.
          `data-animating` drives CSS that reduces backdrop-filter cost and
          hides the scrollbar-thumb during the slide (both ramp back in via
          CSS transitions on transitionend). */}
      <div
        className={`fixed top-0 left-0 h-full w-80 z-50 transform transition-transform duration-300 ease-out overlay-no-drag ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ WebkitAppRegion: 'no-drag', willChange: 'transform' } as React.CSSProperties}
        onTransitionEnd={(e) => {
          if (e.propertyName === 'transform') setAnimating(false);
        }}
      >
        <div
          className="settings-drawer flex flex-col h-full border-r border-edge-dim"
          data-animating={animating ? 'true' : undefined}
        >
          {/* Header — sits outside the scrolling body so it doesn't fade when
              content scrolls. `settings-drawer-header` adds extra top padding
              on macOS so the title clears the native traffic lights (which
              sit at window top-left and can't be moved). */}
          <div className="settings-drawer-header shrink-0 flex items-center justify-between px-4 py-3 border-b border-edge">
            <h2 className="text-sm font-bold text-fg">Settings</h2>
            <button
              onClick={onClose}
              className="text-fg-muted hover:text-fg-2 text-lg leading-none w-8 h-8 flex items-center justify-center rounded-sm hover:bg-inset"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              ✕
            </button>
          </div>

          <div ref={outerScrollRef} className="scroll-fade flex-1 min-h-0">
            {isAndroid() ? (
              <AndroidSettings open={open} onClose={onClose} onSendInput={onSendInput} onOpenThemeMarketplace={onOpenThemeMarketplace} onPublishTheme={onPublishTheme} syncAutoOpen={syncAutoOpen} onSyncAutoOpenHandled={onSyncAutoOpenHandled} />
            ) : (
              <DesktopSettings
                open={open}
                onClose={onClose}
                onSendInput={onSendInput}
                hasActiveSession={hasActiveSession}
                onOpenThemeMarketplace={onOpenThemeMarketplace}
                onPublishTheme={onPublishTheme}
                syncAutoOpen={syncAutoOpen}
                onSyncAutoOpenHandled={onSyncAutoOpenHandled}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Toggle component (shared) ──────────────────────────────────────────────

function Toggle({ enabled, onToggle, color = 'green' }: { enabled: boolean; onToggle: () => void; color?: 'green' | 'red' }) {
  const bg = enabled
    ? color === 'red' ? 'bg-red-600' : 'bg-green-600'
    : 'bg-inset';
  return (
    <button
      onClick={onToggle}
      className={`w-8 h-4 rounded-full transition-colors relative ${bg}`}
    >
      <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
        enabled ? 'left-4' : 'left-0.5'
      }`} />
    </button>
  );
}


// ─── Sound settings popout ────────────────────────────────────────────────

import {
  SOUND_MUTED_KEY, SOUND_VOLUME_KEY,
  STOCK_PRESETS, CUSTOM_SOUND_ID,
  getSelectedPresetId, setSelectedPresetId, playPreview,
  getCustomSoundPath, setCustomSoundPath, getCustomSoundDisplayName,
  isCategoryEnabled, setCategoryEnabled,
  type SoundCategory,
} from '../utils/sounds';

/** Preset selector — stock sounds + custom sound file option */
function PresetSelector({ category, selectedId, onSelect, customName }: {
  category: SoundCategory;
  selectedId: string;
  onSelect: (id: string) => void;
  customName: string | null; // display name of the custom sound file, if set
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {STOCK_PRESETS.map((p) => (
        <button
          key={p.id}
          onClick={() => { onSelect(p.id); playPreview(p.id); }}
          className={`px-2 py-1 rounded text-[10px] transition-colors ${
            selectedId === p.id
              ? 'bg-accent text-on-accent font-medium'
              : 'bg-inset text-fg-dim hover:bg-edge'
          }`}
        >
          {p.label}
        </button>
      ))}
      {/* Custom sound — shown as a button when set, or as a "+" to pick one */}
      {customName ? (
        <button
          onClick={() => { onSelect(CUSTOM_SOUND_ID); playPreview(CUSTOM_SOUND_ID, category); }}
          className={`px-2 py-1 rounded text-[10px] transition-colors ${
            selectedId === CUSTOM_SOUND_ID
              ? 'bg-accent text-on-accent font-medium'
              : 'bg-inset text-fg-dim hover:bg-edge'
          }`}
          title={customName}
        >
          {customName}
        </button>
      ) : null}
    </div>
  );
}

/** A single sound category section within the popout */
function SoundCategorySection({ category, label, description, dotColor }: {
  category: SoundCategory;
  label: string;
  description: string;
  dotColor?: string; // Tailwind bg class for the status dot indicator
}) {
  const [enabled, setEnabled] = useState(() => isCategoryEnabled(category));
  const [presetId, setPresetId] = useState(() => getSelectedPresetId(category));
  const [customPath, setCustomPath] = useState(() => getCustomSoundPath(category));

  const handleToggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      setCategoryEnabled(category, next);
      return next;
    });
  }, [category]);

  const handleSelect = useCallback((id: string) => {
    setPresetId(id);
    setSelectedPresetId(category, id);
  }, [category]);

  // Pick a custom sound file via the system file picker
  const handlePickCustom = useCallback(async () => {
    try {
      const path = await window.claude.dialog.openSound();
      if (!path) return;
      setCustomSoundPath(category, path);
      setCustomPath(path);
      // Auto-select the custom sound after picking it
      setPresetId(CUSTOM_SOUND_ID);
      setSelectedPresetId(category, CUSTOM_SOUND_ID);
      // Preview it
      playPreview(CUSTOM_SOUND_ID, category);
    } catch { /* dialog cancelled or not available */ }
  }, [category]);

  // Clear custom sound
  const handleClearCustom = useCallback(() => {
    setCustomSoundPath(category, null);
    setCustomPath(null);
    // If custom was selected, fall back to first stock preset
    if (presetId === CUSTOM_SOUND_ID) {
      const fallback = STOCK_PRESETS[0].id;
      setPresetId(fallback);
      setSelectedPresetId(category, fallback);
    }
  }, [category, presetId]);

  const customName = customPath ? getCustomSoundDisplayName(customPath) : null;

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {dotColor && <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />}
          <span className="text-xs text-fg font-medium">{label}</span>
        </div>
        <Toggle enabled={enabled} onToggle={handleToggle} />
      </div>
      <p className="text-[10px] text-fg-muted mb-2">{description}</p>
      {enabled && (
        <>
          <PresetSelector
            category={category}
            selectedId={presetId}
            onSelect={handleSelect}
            customName={customName}
          />
          {/* Custom sound controls */}
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={handlePickCustom}
              className="px-2 py-1 rounded text-[10px] bg-inset text-fg-dim hover:bg-edge transition-colors flex items-center gap-1"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              {customName ? 'Change file' : 'Custom sound'}
            </button>
            {customName && (
              <button
                onClick={handleClearCustom}
                className="px-2 py-1 rounded text-[10px] text-fg-muted hover:text-fg hover:bg-edge transition-colors"
                title="Remove custom sound"
              >
                Remove
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Sound settings — compact row that opens a popout modal (matches ThemeButton pattern) */
function SoundButton() {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const scrollRef = useScrollFade<HTMLDivElement>();
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem(SOUND_MUTED_KEY) === '1'; } catch { return false; }
  });
  const [volume, setVolume] = useState(() => {
    try {
      const v = parseFloat(localStorage.getItem(SOUND_VOLUME_KEY) || '0.3');
      return isNaN(v) ? 0.3 : Math.max(0, Math.min(1, v));
    } catch { return 0.3; }
  });

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleToggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      try { localStorage.setItem(SOUND_MUTED_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    try { localStorage.setItem(SOUND_VOLUME_KEY, String(v)); } catch {}
  }, []);

  // Summary text for the compact row
  const summaryParts: string[] = [];
  if (muted) { summaryParts.push('Muted'); }
  else { summaryParts.push(`${Math.round(volume * 100)}%`); }

  return (
    <section>
      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Sound</h3>

      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
      >
        {/* Speaker icon */}
        <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
          <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            {muted ? (
              <>
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </>
            ) : (
              <>
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                {volume > 0.5 && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
              </>
            )}
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs text-fg font-medium">Notifications</span>
          <p className="text-[10px] text-fg-muted">{summaryParts.join(' · ')}</p>
        </div>
        <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {open && createPortal(
        <>
          <Scrim layer={2} onClick={() => setOpen(false)} />
          <div
            ref={popupRef}
            className="layer-surface fixed z-[61] overflow-hidden"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'min(380px, 88vw)',
              maxHeight: '80vh',
            }}
          >
            <div className="flex flex-col h-full">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
                <h2 className="text-sm font-bold text-fg">Sound & Notifications</h2>
                <button onClick={() => setOpen(false)} className="text-fg-muted hover:text-fg-2 text-lg leading-none">✕</button>
              </div>

              <div ref={scrollRef} className="scroll-fade">
                <div className="px-4 py-4 space-y-5">
                {/* Master volume */}
                <section>
                  <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Volume</h3>
                  <div className="flex items-center gap-3">
                    {/* Mute toggle */}
                    <button onClick={handleToggleMute} className="text-fg-muted hover:text-fg shrink-0">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                        {muted ? (
                          <>
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <line x1="23" y1="9" x2="17" y2="15" />
                            <line x1="17" y1="9" x2="23" y2="15" />
                          </>
                        ) : (
                          <>
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                          </>
                        )}
                      </svg>
                    </button>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={volume}
                      onChange={handleVolumeChange}
                      className="flex-1 h-1 accent-accent"
                    />
                    <span className="text-[10px] text-fg-muted w-8 text-right">{Math.round(volume * 100)}%</span>
                  </div>
                </section>

                <div className="border-t border-edge-dim" />

                {/* Attention sound — red status dot */}
                <SoundCategorySection
                  category="attention"
                  label="Needs Attention"
                  description="Plays when a session needs approval"
                  dotColor="bg-red-400"
                />

                <div className="border-t border-edge-dim" />

                {/* Ready sound — blue status dot */}
                <SoundCategorySection
                  category="ready"
                  label="Response Ready"
                  description="Plays when a background session has a new response"
                  dotColor="bg-blue-400"
                />
                </div>
              </div>
            </div>
          </div>
        </>,
        document.body,
      )}
    </section>
  );
}

// ─── Tier selector popup (Android) ────────────────────────────────────────

// ─── Theme popup button ────────────────────────────────────────────────────

/** Compact "Appearance" row — opens ThemeScreen in a centered popup modal */
function ThemeButton({ onSendInput, onOpenMarketplace, onPublishTheme }: { onSendInput?: (text: string) => void; onOpenMarketplace?: () => void; onPublishTheme?: (slug: string) => void }) {
  const { activeTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  const { canvas, panel, inset, accent } = activeTheme.tokens;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <section>
      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Appearance</h3>

      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
      >
        <div className="flex rounded-sm overflow-hidden shrink-0" style={{ width: 32, height: 20 }}>
          <div style={{ flex: 1, background: canvas }} />
          <div style={{ flex: 1, background: panel }} />
          <div style={{ flex: 1, background: inset }} />
          <div style={{ flex: 1, background: accent }} />
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs text-fg font-medium">{activeTheme.name}</span>
        </div>
        <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {open && createPortal(
        <>
          <Scrim layer={2} onClick={() => setOpen(false)} />
          <div
            ref={popupRef}
            className="layer-surface fixed z-[61] overflow-hidden"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'min(480px, 88vw)',
              height: 'min(600px, 80vh)',
            }}
          >
            <ThemeScreen onClose={() => setOpen(false)} onSendInput={onSendInput} onOpenMarketplace={onOpenMarketplace} onPublishTheme={(slug) => { setOpen(false); onPublishTheme?.(slug); }} />
          </div>
        </>,
        document.body,
      )}
    </section>
  );
}

// ─── Buddy floater toggle ─────────────────────────────────────────────────
// Small section row that controls the buddy mascot window: off by default,
// persists via localStorage['youcoded-buddy-enabled'] (matches theme/font
// persistence pattern). Toggling fires window.claude.buddy.show/hide;
// App.tsx also reads the flag on mount to auto-show if previously enabled.
function BuddyToggle() {
  const [enabled, setEnabled] = useState<boolean>(() =>
    localStorage.getItem('youcoded-buddy-enabled') === '1',
  );

  const toggle = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    localStorage.setItem('youcoded-buddy-enabled', next ? '1' : '0');
    if (next) window.claude.buddy?.show?.();
    else window.claude.buddy?.hide?.();
  }, [enabled]);

  return (
    <section>
      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Buddy</h3>
      <label className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={toggle}
          className="shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-fg font-medium">Show buddy floater</div>
          <div className="text-[10px] text-fg-muted mt-0.5">A small always-on-top mascot that stays visible even when the app is minimized.</div>
        </div>
      </label>
    </section>
  );
}

// ─── Remote settings popup button ─────────────────────────────────────────

interface RemoteButtonProps {
  config: RemoteConfig | null;
  tailscale: TailscaleInfo | null;
  clients: ClientInfo[];
  loading: boolean;
  hasActiveSession: boolean;
  newPassword: string;
  passwordStatus: 'idle' | 'saving' | 'saved';
  copied: boolean;
  showSetupQR: boolean;
  showAddDevice: boolean;
  onSetNewPassword: (v: string) => void;
  onSetPassword: () => void;
  onToggleEnabled: () => void;
  onToggleTailscaleTrust: () => void;
  onSetKeepAwake: (hours: number) => void;
  onRunSetup: () => void;
  onConfirmSetup: () => void;
  onCancelSetup: () => void;
  setupStatus: 'idle' | 'confirm' | 'installing' | 'authenticating' | 'done' | 'error';
  setupError: string;
  onDisconnectClient: (id: string) => void;
  onCopyLink: () => void;
  onSetShowSetupQR: (v: boolean) => void;
  onSetShowAddDevice: (v: boolean) => void;
}

function RemoteButton({
  config, tailscale, clients, loading, hasActiveSession,
  newPassword, passwordStatus, copied, showSetupQR, showAddDevice,
  onSetNewPassword, onSetPassword, onToggleEnabled, onToggleTailscaleTrust,
  onSetKeepAwake, onRunSetup, onConfirmSetup, onCancelSetup, setupStatus, setupError, onDisconnectClient, onCopyLink,
  onSetShowSetupQR, onSetShowAddDevice,
}: RemoteButtonProps) {
  const [open, setOpen] = useState(false);
  // showInfo flips the popup body to the plain-language explainer view.
  // Reset to false whenever the popup re-opens so users always start on the
  // main settings, not whichever screen they last viewed.
  const [showInfo, setShowInfo] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const scrollRef = useScrollFade<HTMLDivElement>();

  useEffect(() => {
    if (!open) setShowInfo(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const hasClients = clients.length > 0;
  // Green: enabled + Tailscale installed + VPN active. Gray otherwise (disabled, or VPN not connected).
  const isFullyConnected = config?.enabled && tailscale?.installed && tailscale?.connected;
  const statusText = loading
    ? 'Loading...'
    : !config?.enabled
      ? 'Disabled'
      : isFullyConnected
        ? hasClients
          ? `Connected · ${clients.length} client${clients.length > 1 ? 's' : ''}`
          : 'Connected'
        : tailscale?.installed
          ? 'Tailscale VPN not active'
          : 'Enabled · No Tailscale';

  return (
    <section>
      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Remote Access</h3>

      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
      >
        {/* Status indicator dot — green when remote + Tailscale VPN fully active, gray otherwise */}
        <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
          <div className={`w-2.5 h-2.5 rounded-full ${
            isFullyConnected ? 'bg-green-500' : 'bg-fg-muted/40'
          }`} />
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs text-fg font-medium">{statusText}</span>
          {tailscale?.installed && (
            <span className="text-[10px] text-fg-muted ml-2">Tailscale</span>
          )}
        </div>
        <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {open && createPortal(
        <>
          <Scrim layer={2} onClick={() => setOpen(false)} />
          <div
            ref={popupRef}
            className="layer-surface fixed z-[61] overflow-hidden"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'min(480px, 88vw)',
              height: 'min(600px, 80vh)',
            }}
          >
            {showInfo ? (
              <SettingsExplainer
                title="Remote Access"
                intro={REMOTE_ACCESS_EXPLAINER.intro}
                sections={REMOTE_ACCESS_EXPLAINER.sections}
                onBack={() => setShowInfo(false)}
                onClose={() => setOpen(false)}
              />
            ) : (
            <div className="flex flex-col h-full">
              {/* Header — info icon (left of close) reveals the explainer view */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
                <h2 className="text-sm font-bold text-fg">Remote Access</h2>
                <div className="flex items-center gap-1">
                  <InfoIconButton onClick={() => setShowInfo(true)} />
                  <button onClick={() => setOpen(false)} className="text-fg-muted hover:text-fg-2 text-lg leading-none w-6 h-6 flex items-center justify-center">✕</button>
                </div>
              </div>

              {/* Scrollable content */}
              <div ref={scrollRef} className="scroll-fade flex-1">
                <div className="px-4 py-4 space-y-6">
                {loading ? (
                  <div className="flex items-center justify-center py-8 text-fg-muted text-sm">Loading...</div>
                ) : (
                  <>
                    {/* Setup banner — shown when no clients connected */}
                    {!hasClients && (
                      <div className="bg-blue-500/10 border border-blue-500/25 rounded-lg p-3">
                        <p className="text-xs text-blue-400 mb-2">
                          Remote access lets you use YouCoded from any device — phone, tablet, or another computer.
                        </p>

                        {tailscale?.installed && tailscale.url && config?.hasPassword ? (
                          showSetupQR ? (
                            <div className="mt-2">
                              {/* Remind users that Tailscale must be installed + running on the receiving device too */}
                              <div className="bg-amber-500/10 border border-amber-500/25 rounded-md px-2.5 py-2 mb-2">
                                <p className="text-[10px] text-amber-400 font-medium mb-0.5">Before scanning:</p>
                                <p className="text-[10px] text-fg-muted">Download Tailscale on your other device, sign in to the same account, and make sure it's running. The page won't load without it.</p>
                              </div>
                              <p className="text-[10px] text-fg-muted mb-2">Then scan to connect:</p>
                              <div className="flex justify-center bg-white rounded-lg p-3 w-fit mx-auto">
                                <QRCodeSVG value={tailscale.url} size={140} />
                              </div>
                              <p className="text-[10px] text-fg-muted mt-2 text-center font-mono">{tailscale.url}</p>
                              <button
                                onClick={onCopyLink}
                                className="w-full mt-2 px-3 py-1 rounded-sm bg-inset hover:bg-edge text-[10px] text-fg-dim"
                              >
                                {copied ? 'Copied!' : 'Copy link'}
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {/* Persistent reminder — visible whenever Tailscale is ready but no device has connected yet */}
                              <div className="bg-amber-500/10 border border-amber-500/25 rounded-md px-2.5 py-2">
                                <p className="text-[10px] text-amber-400 font-medium mb-0.5">Other device setup required:</p>
                                <p className="text-[10px] text-fg-muted">Download Tailscale on your other device, sign in to the same account, and make sure it's running before scanning. The page won't load without it.</p>
                              </div>
                              <button
                                onClick={() => onSetShowSetupQR(true)}
                                className="w-full px-3 py-1.5 rounded-sm bg-blue-600 hover:bg-blue-500 text-xs font-medium"
                              >
                                Set Up Remote Access
                              </button>
                            </div>
                          )
                        ) : setupStatus === 'confirm' ? (
                          <div className="space-y-2">
                            <p className="text-[10px] text-fg-2 text-center">This will download and install Tailscale (~50MB) for secure remote access.</p>
                            <div className="flex gap-2">
                              <button onClick={onCancelSetup} className="flex-1 px-3 py-1.5 rounded-sm bg-inset hover:bg-edge text-xs">Cancel</button>
                              <button onClick={onConfirmSetup} className="flex-1 px-3 py-1.5 rounded-sm bg-blue-600 hover:bg-blue-500 text-xs font-medium">Install</button>
                            </div>
                          </div>
                        ) : setupStatus === 'installing' ? (
                          <div className="text-center py-1">
                            <p className="text-xs text-fg-2 animate-pulse">Installing Tailscale...</p>
                            <p className="text-[10px] text-fg-faint mt-1">This may take a few minutes</p>
                          </div>
                        ) : setupStatus === 'authenticating' ? (
                          <div className="text-center py-1">
                            <p className="text-xs text-fg-2 animate-pulse">Authenticating...</p>
                            <p className="text-[10px] text-fg-faint mt-1">Check your browser to sign in to Tailscale</p>
                          </div>
                        ) : setupStatus === 'done' ? (
                          <p className="text-xs text-green-400 text-center py-1">Tailscale installed and connected!</p>
                        ) : setupStatus === 'error' ? (
                          <div className="space-y-2">
                            <p className="text-xs text-red-400 text-center">{setupError || 'Setup failed'}</p>
                            <button onClick={onRunSetup} className="w-full px-3 py-1.5 rounded-sm bg-blue-600 hover:bg-blue-500 text-xs font-medium">Retry</button>
                          </div>
                        ) : tailscale?.installed && !tailscale.connected ? (
                          // Fix: Tailscale is installed but VPN is off — tailscale.url is null in this state,
                          // so we used to fall through to the install-button branch and pretend it wasn't installed.
                          <p className="text-[11px] text-fg-2 text-center py-1">
                            Tailscale is installed, but the VPN isn't active. Open the Tailscale app and turn it on, then come back here.
                          </p>
                        ) : tailscale?.installed && !config?.hasPassword ? (
                          // Installed + connected but no password yet — guide the user down to the password field
                          // rather than re-prompting to install.
                          <p className="text-[11px] text-fg-2 text-center py-1">
                            Set a password below to finish enabling remote access.
                          </p>
                        ) : (
                          <button
                            onClick={onRunSetup}
                            className="w-full px-3 py-1.5 rounded-sm bg-blue-600 hover:bg-blue-500 text-xs font-medium"
                          >
                            Set Up Remote Access
                          </button>
                        )}
                      </div>
                    )}

                    {/* Server settings */}
                    <section>
                      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Server</h3>

                      <label className="flex items-center justify-between py-2 cursor-pointer">
                        <span className="text-xs text-fg-2">Enabled</span>
                        <Toggle enabled={!!config?.enabled} onToggle={onToggleEnabled} />
                      </label>

                      <div className="py-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-fg-2">Password</span>
                          {config?.hasPassword && (
                            <span className="text-[10px] text-green-400">Set</span>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <input
                            type="password"
                            placeholder={config?.hasPassword ? 'Change password...' : 'Set password...'}
                            value={newPassword}
                            onChange={(e) => onSetNewPassword(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && onSetPassword()}
                            className="flex-1 px-2 py-1 rounded-sm bg-well border border-edge-dim text-xs text-fg focus:outline-none focus:border-fg-muted"
                          />
                          <button
                            onClick={onSetPassword}
                            disabled={!newPassword.trim() || passwordStatus === 'saving'}
                            className="px-2 py-1 rounded-sm bg-inset hover:bg-edge text-xs disabled:opacity-50"
                          >
                            {passwordStatus === 'saved' ? '✓' : passwordStatus === 'saving' ? '...' : 'Set'}
                          </button>
                        </div>
                      </div>

                      <div className="py-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-fg-2">Keep awake</span>
                        </div>
                        <div className="flex gap-1">
                          {KEEP_AWAKE_OPTIONS.map((opt) => (
                            <button
                              key={opt.value}
                              onClick={() => onSetKeepAwake(opt.value)}
                              className={`flex-1 px-1.5 py-1 rounded-sm text-[10px] transition-colors ${
                                config?.keepAwakeHours === opt.value
                                  ? 'bg-accent text-on-accent font-medium'
                                  : 'bg-inset text-fg-dim hover:bg-edge'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </section>

                    {/* Add Device — requires Tailscale running, otherwise tailscale.url is null */}
                    {tailscale?.installed && tailscale?.connected && tailscale?.url && config?.hasPassword && (
                      <button
                        onClick={() => onSetShowAddDevice(!showAddDevice)}
                        className="w-full px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/25 text-xs text-blue-400 font-medium hover:bg-blue-500/20 transition-colors flex items-center justify-center gap-1.5"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                        Add Device
                      </button>
                    )}

                    {/* Remote Clients section */}
                    {hasClients && (
                      <section>
                        <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Connected Devices</h3>

                        <div className="space-y-1">
                          {clients.map(client => (
                            <div key={client.id} className="flex items-center justify-between py-1.5 px-2 rounded-sm bg-inset/50">
                              <div>
                                <span className="text-xs text-fg-2 font-mono">{client.ip}</span>
                                <span className="text-[10px] text-fg-faint ml-2">{timeAgo(client.connectedAt)}</span>
                              </div>
                              <button
                                onClick={() => onDisconnectClient(client.id)}
                                className="text-fg-faint hover:text-red-400 text-sm leading-none px-1"
                                title="Disconnect"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}

                    {/* Add Device overlay */}
                    {showAddDevice && tailscale?.url && (
                      <section className="bg-inset/50 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-xs font-medium text-fg-2">Add Device</h3>
                          <button
                            onClick={() => onSetShowAddDevice(false)}
                            className="text-fg-muted hover:text-fg-2 text-sm leading-none"
                          >
                            ✕
                          </button>
                        </div>
                        {/* Remind users that Tailscale must be installed + running on the receiving device too */}
                        <div className="bg-amber-500/10 border border-amber-500/25 rounded-md px-2.5 py-2 mb-2">
                          <p className="text-[10px] text-amber-400 font-medium mb-0.5">Before scanning:</p>
                          <p className="text-[10px] text-fg-muted">Download Tailscale on your other device, sign in to the same account, and make sure it's running. The page won't load without it.</p>
                        </div>
                        <p className="text-[10px] text-fg-muted mb-2">Then scan QR or copy link to connect:</p>
                        <div className="flex justify-center bg-white rounded-lg p-3 w-fit mx-auto">
                          <QRCodeSVG value={tailscale.url} size={140} />
                        </div>
                        <p className="text-[10px] text-fg-muted mt-2 text-center font-mono">{tailscale.url}</p>
                        <button
                          onClick={onCopyLink}
                          className="w-full mt-2 px-3 py-1.5 rounded-sm bg-inset hover:bg-edge text-xs"
                        >
                          {copied ? 'Copied!' : 'Copy Link'}
                        </button>
                      </section>
                    )}

                    {/* Tailscale section */}
                    <section>
                      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Tailscale</h3>

                      {tailscale?.installed ? (
                        <>
                          {/* Distinguish "installed and connected" from "installed but VPN off" —
                              previously detection conflated the two and forced the not-installed branch. */}
                          <div className="py-2 flex items-center justify-between">
                            <span className="text-xs text-fg-2">Status</span>
                            {tailscale.connected ? (
                              <span className="text-[10px] text-green-400">
                                Connected{tailscale.hostname ? ` · ${tailscale.hostname}` : ''}
                              </span>
                            ) : (
                              <span className="text-[10px] text-fg-muted">VPN not active</span>
                            )}
                          </div>

                          <div className="py-2 flex items-center justify-between">
                            <span className="text-xs text-fg-2">IP</span>
                            <span className="text-xs text-fg-dim font-mono">{tailscale.ip ?? '—'}</span>
                          </div>

                          <label className="flex items-center justify-between py-2 cursor-pointer">
                            <span className="text-xs text-fg-2">Skip password on Tailscale</span>
                            <Toggle enabled={!!config?.trustTailscale} onToggle={onToggleTailscaleTrust} />
                          </label>
                        </>
                      ) : (
                        <div className="py-2">
                          <p className="text-xs text-fg-muted mb-2">
                            Tailscale is not installed. It creates a secure private network so you can access YouCoded from anywhere.
                          </p>
                          <button
                            onClick={onRunSetup}
                            disabled={setupStatus === 'installing' || setupStatus === 'authenticating'}
                            className="px-3 py-1.5 rounded-sm bg-inset hover:bg-edge text-xs disabled:opacity-50"
                          >
                            {setupStatus === 'installing' ? 'Installing...' : setupStatus === 'authenticating' ? 'Authenticating...' : 'Install Tailscale'}
                          </button>
                        </div>
                      )}
                    </section>
                  </>
                )}
                </div>
              </div>
            </div>
            )}
          </div>
        </>,
        document.body,
      )}
    </section>
  );
}

// ─── Defaults popup button ────────────────────────────────────────────────

const MODEL_LABELS: Record<string, string> = {
  sonnet: 'Sonnet',
  'opus[1m]': 'Opus 1M',
  haiku: 'Haiku',
};

interface PermissionOverrides {
  approveAll: boolean;
  protectedConfigFiles: boolean;
  protectedDirectories: boolean;
  compoundCdRedirect: boolean;
  compoundCdGit: boolean;
}

const OVERRIDES_DEFAULT: PermissionOverrides = {
  approveAll: false,
  protectedConfigFiles: false,
  protectedDirectories: false,
  compoundCdRedirect: false,
  compoundCdGit: false,
};

// Per-category override toggles for the Advanced section
const OVERRIDE_CATEGORIES: { key: keyof Omit<PermissionOverrides, 'approveAll'>; label: string; description: string }[] = [
  { key: 'protectedConfigFiles', label: 'Config files', description: '.bashrc, .gitconfig, .mcp.json' },
  { key: 'protectedDirectories', label: 'Protected directories', description: '.git/, .claude/ paths' },
  { key: 'compoundCdRedirect', label: 'cd + redirect commands', description: 'Compound cd with output redirection' },
  { key: 'compoundCdGit', label: 'cd + git commands', description: 'Compound cd with git operations' },
];

function SkipPermissionsSection({ defaults, onDefaultsChange }: {
  defaults: { skipPermissions: boolean; permissionOverrides?: PermissionOverrides };
  onDefaultsChange: (updates: any) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const overrides = { ...OVERRIDES_DEFAULT, ...defaults.permissionOverrides };

  const updateOverride = useCallback((key: keyof PermissionOverrides, value: boolean) => {
    onDefaultsChange({ permissionOverrides: { ...overrides, [key]: value } });
  }, [overrides, onDefaultsChange]);

  const handleApproveAllToggle = useCallback(() => {
    if (!overrides.approveAll) {
      // Turning ON — show confirmation popup
      setConfirmOpen(true);
    } else {
      // Turning OFF — immediate
      updateOverride('approveAll', false);
    }
  }, [overrides.approveAll, updateOverride]);

  return (
    <section>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase">Skip Permissions</h3>
          <p className="text-[10px] text-fg-faint mt-0.5">New sessions will skip tool approval</p>
        </div>
        <Toggle
          enabled={defaults.skipPermissions}
          onToggle={() => onDefaultsChange({ skipPermissions: !defaults.skipPermissions })}
          color="red"
        />
      </div>
      {defaults.skipPermissions && (
        <>
          <p className="text-[10px] text-[#DD4444] mt-1.5">Claude will execute tools without asking for approval.</p>

          {/* Advanced expandable section */}
          <button
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="flex items-center gap-1.5 mt-3 group"
          >
            <svg
              className="w-3 h-3 text-fg-faint transition-transform"
              style={{ transform: advancedOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
              strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M9 5l7 7-7 7" />
            </svg>
            <span className="text-[10px] text-fg-faint group-hover:text-fg-muted transition-colors">Advanced</span>
          </button>

          {advancedOpen && (
            <div className="mt-2 ml-1 border-l border-edge-dim pl-3 space-y-3">
              {/* Approve All toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-fg-dim font-medium">Auto-approve all</p>
                  <p className="text-[9px] text-fg-faint">Silently approve all protected requests</p>
                </div>
                <Toggle enabled={overrides.approveAll} onToggle={handleApproveAllToggle} color="red" />
              </div>

              {/* Separator */}
              <div className="flex items-center gap-2">
                <div className="flex-1 border-t border-edge-dim" />
                <span className="text-[9px] text-fg-faint">or approve by category</span>
                <div className="flex-1 border-t border-edge-dim" />
              </div>

              {/* Per-category toggles */}
              {OVERRIDE_CATEGORIES.map(({ key, label, description }) => (
                <div key={key} className={`flex items-center justify-between ${overrides.approveAll ? 'opacity-40 pointer-events-none' : ''}`}>
                  <div>
                    <p className="text-[10px] text-fg-dim font-medium">{label}</p>
                    <p className="text-[9px] text-fg-faint">{description}</p>
                  </div>
                  <Toggle enabled={overrides[key]} onToggle={() => updateOverride(key, !overrides[key])} />
                </div>
              ))}
            </div>
          )}

          {/* Confirmation popup for Approve All — L3 destructive, theme-driven glass */}
          {confirmOpen && createPortal(
            <>
              <Scrim layer={3} onClick={() => setConfirmOpen(false)} />
              <OverlayPanel
                layer={3}
                destructive
                className="fixed overflow-hidden"
                style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 'min(340px, 85vw)' }}
              >
                <div className="px-4 py-3 border-b border-red-600/30 bg-red-600/10">
                  {/* Warning: extreme danger header */}
                  <h3 className="text-xs font-bold text-[#DD4444]">&#9888; This is extremely dangerous</h3>
                </div>
                <div className="px-4 py-3 space-y-2">
                  <p className="text-[10px] text-fg-dim leading-relaxed">
                    <strong className="text-[#DD4444]">This setting is not recommended or condoned by Claude, Anthropic, or YouCoded.</strong>{' '}
                    Do not enable this unless you fully understand the consequences.
                  </p>
                  <p className="text-[10px] text-fg-dim leading-relaxed">
                    Full auto-approve silently grants <strong>every</strong> remaining permission request with zero human review. Claude will be able to:
                  </p>
                  <ul className="text-[10px] text-fg-muted space-y-1 ml-3 list-disc">
                    <li>Overwrite your <code className="text-fg-dim">.git/</code> history and repository internals</li>
                    <li>Modify shell config files (<code className="text-fg-dim">.bashrc</code>, <code className="text-fg-dim">.gitconfig</code>, <code className="text-fg-dim">.zshrc</code>)</li>
                    <li>Rewrite <code className="text-fg-dim">.claude/</code> configuration and MCP settings</li>
                    <li>Execute compound commands that bypass path resolution safety checks</li>
                    <li>Execute compound commands that bypass bare repository attack protections</li>
                  </ul>
                  <p className="text-[10px] text-[#DD4444]/80 leading-relaxed font-medium">
                    These protections exist for a reason. Disabling them means a single bad model output could corrupt your repository, hijack your shell environment, or escalate access beyond this project. There is no undo.
                  </p>
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => setConfirmOpen(false)}
                      className="flex-1 px-3 py-1.5 text-[11px] font-medium rounded-md bg-inset hover:bg-edge text-fg-muted transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => { updateOverride('approveAll', true); setConfirmOpen(false); }}
                      className="flex-1 px-3 py-1.5 text-[11px] font-medium rounded-md bg-red-600/70 hover:bg-red-600/90 text-white transition-colors"
                    >
                      I understand, enable anyway
                    </button>
                  </div>
                </div>
              </OverlayPanel>
            </>,
            document.body,
          )}
        </>
      )}
    </section>
  );
}

interface DefaultsButtonProps {
  defaults: { skipPermissions: boolean; model: string; projectFolder: string; geminiEnabled?: boolean; permissionOverrides?: PermissionOverrides };
  onDefaultsChange: (updates: Partial<{ skipPermissions: boolean; model: string; projectFolder: string; geminiEnabled: boolean; permissionOverrides: PermissionOverrides }>) => void;
}

function DefaultsButton({ defaults, onDefaultsChange }: DefaultsButtonProps) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const scrollRef = useScrollFade<HTMLDivElement>();
  // Close-session prompt suppression — reads/writes localStorage directly since
  // this is a UI preference, not a session default backed by sessionDefaults.
  const [closePromptDisabled, setClosePromptDisabled] = useState(
    () => localStorage.getItem(CLOSE_PROMPT_SUPPRESS_KEY) === '1',
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleBrowseFolder = useCallback(async () => {
    try {
      const folder = await (window as any).claude.dialog.openFolder();
      if (folder) onDefaultsChange({ projectFolder: folder });
    } catch {}
  }, [onDefaultsChange]);

  const summaryParts: string[] = [];
  summaryParts.push(MODEL_LABELS[defaults.model] || 'Sonnet');
  if (defaults.skipPermissions) summaryParts.push('Skip Perms');
  if (defaults.geminiEnabled) summaryParts.push('Gemini');

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
      >
        <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
          <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <line x1="4" y1="7" x2="20" y2="7" /><circle cx="8" cy="7" r="2.2" fill="var(--panel)" />
                    <line x1="4" y1="17" x2="20" y2="17" /><circle cx="16" cy="17" r="2.2" fill="var(--panel)" />
                  </svg>
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs text-fg font-medium">Defaults</span>
          <p className="text-[10px] text-fg-muted">{summaryParts.join(' · ')}</p>
        </div>
        <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {open && createPortal(
        <>
          <Scrim layer={2} onClick={() => setOpen(false)} />
          <div
            ref={popupRef}
            className="layer-surface fixed z-[61] overflow-hidden"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'min(380px, 88vw)',
              maxHeight: '80vh',
            }}
          >
            <div className="flex flex-col h-full">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
                <h2 className="text-sm font-bold text-fg">Session Defaults</h2>
                <button onClick={() => setOpen(false)} className="text-fg-muted hover:text-fg-2 text-lg leading-none">✕</button>
              </div>

              <div ref={scrollRef} className="scroll-fade">
                <div className="px-4 py-4 space-y-5">
                {/* Default Model */}
                <section>
                  <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Default Model</h3>
                  <div className="flex gap-1">
                    {MODELS.map((m) => (
                      <button
                        key={m}
                        onClick={() => onDefaultsChange({ model: m })}
                        className={`flex-1 px-1.5 py-1.5 rounded-sm text-[11px] transition-colors flex items-center justify-center ${
                          defaults.model === m
                            ? 'bg-accent text-on-accent font-medium'
                            : 'bg-inset text-fg-dim hover:bg-edge'
                        }`}
                      >
                        {MODEL_LABELS[m] || m}
                        <ModelInfoTooltip model={m} />
                      </button>
                    ))}
                  </div>
                </section>

                {/* Skip Permissions */}
                <SkipPermissionsSection defaults={defaults} onDefaultsChange={onDefaultsChange} />

                {/* Default Project Folder */}
                <section>
                  <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">Project Folder</h3>
                  <button
                    onClick={handleBrowseFolder}
                    className="w-full text-left px-2.5 py-1.5 bg-inset border border-edge-dim rounded-md text-xs text-fg-2 hover:border-edge transition-colors truncate"
                  >
                    {defaults.projectFolder || 'Home directory (default)'}
                  </button>
                  {defaults.projectFolder && (
                    <button
                      onClick={() => onDefaultsChange({ projectFolder: '' })}
                      className="text-[10px] text-fg-faint hover:text-fg-muted mt-1"
                    >
                      Reset to home directory
                    </button>
                  )}
                </section>

                {/* Gemini CLI — opt-in toggle to show Gemini as a session provider */}
                <section>
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase">Gemini CLI</h3>
                      <p className="text-[10px] text-fg-faint mt-0.5">Show Gemini option when creating sessions</p>
                    </div>
                    <button
                      onClick={() => onDefaultsChange({ geminiEnabled: !defaults.geminiEnabled })}
                      className="w-8 h-4.5 rounded-full relative transition-colors shrink-0"
                      style={{ backgroundColor: defaults.geminiEnabled ? '#4285F4' : 'var(--inset)' }}
                    >
                      <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${defaults.geminiEnabled ? 'left-[calc(100%-16px)]' : 'left-0.5'}`} />
                    </button>
                  </div>
                </section>

                {/* Close-session prompt — toggle off to skip the tag-before-closing
                    popup and destroy sessions immediately. Mirrors the "Don't show
                    again" checkbox inside the prompt itself. */}
                <section>
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase">Close-session prompt</h3>
                      <p className="text-[10px] text-fg-faint mt-0.5">Show tag options when closing a session</p>
                    </div>
                    <button
                      onClick={() => {
                        const next = !closePromptDisabled;
                        setClosePromptDisabled(next);
                        if (next) {
                          localStorage.setItem(CLOSE_PROMPT_SUPPRESS_KEY, '1');
                        } else {
                          localStorage.removeItem(CLOSE_PROMPT_SUPPRESS_KEY);
                        }
                      }}
                      className="w-8 h-4.5 rounded-full relative transition-colors shrink-0"
                      style={{ backgroundColor: closePromptDisabled ? 'var(--inset)' : 'var(--accent)' }}
                    >
                      <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${closePromptDisabled ? 'left-0.5' : 'left-[calc(100%-16px)]'}`} />
                    </button>
                  </div>
                </section>
                </div>
              </div>
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

// ─── Tier selector popup ───────────────────────────────────────────────────

// Mirrors PackageTier.kt — descriptions list the actual packages each tier
// installs, matching the native first-run TierPickerScreen labels.
const TIER_OPTIONS = [
  { id: 'CORE', name: 'Core', desc: 'Everything needed for basic Claude Code functionality' },
  { id: 'DEVELOPER', name: 'Developer Essentials', desc: 'fd, fzf, jq, bat, tmux, nano, micro' },
  { id: 'FULL_DEV', name: 'Full Dev Environment', desc: 'neovim, vim, make, cmake, sqlite' },
];

function TierSelector({ tier, onSetTier }: { tier: string; onSetTier: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const scrollRef = useScrollFade<HTMLDivElement>();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const currentTier = TIER_OPTIONS.find(t => t.id === tier) || TIER_OPTIONS[0];

  return (
    <section>
      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Package Tier</h3>

      {/* Current tier row */}
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
      >
        <span className="text-sm shrink-0 leading-none text-fg-dim">⬡</span>
        <div className="flex-1 min-w-0">
          <span className="text-xs text-fg font-medium">{currentTier.name}</span>
          <p className="text-[10px] text-fg-muted">{currentTier.desc}</p>
        </div>
        <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {/* Popup overlay — portaled to document.body so position:fixed centers
          against the viewport, not the SettingsPanel drawer. The drawer (and
          its glass ancestors) establishes a containing block for fixed children
          via transform/backdrop-filter, which is why an inline-rendered popup
          ends up centered inside the panel instead of the viewport. ThemeButton
          above uses the same portal pattern for the same reason. */}
      {open && createPortal(
        <>
          <Scrim layer={2} onClick={() => setOpen(false)} />
          <div
            ref={popupRef}
            className="layer-surface fixed z-[61] overflow-hidden"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'min(340px, 85vw)',
              maxHeight: '80vh',
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
              <h3 className="text-sm font-bold text-fg">Package Tier</h3>
              <button onClick={() => setOpen(false)} className="text-fg-muted hover:text-fg-2 text-lg leading-none">✕</button>
            </div>

            <div ref={scrollRef} className="scroll-fade" style={{ maxHeight: 'calc(80vh - 52px)' }}>
              <div className="p-3 space-y-2">
              {TIER_OPTIONS.map(t => {
                const isActive = tier === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => { onSetTier(t.id); setOpen(false); }}
                    className={`w-full flex items-start gap-3 p-3 rounded-lg border transition-colors ${
                      isActive ? 'border-accent bg-accent/10' : 'border-edge-dim hover:border-edge'
                    }`}
                  >
                    <span className={`text-sm shrink-0 mt-0.5 ${isActive ? 'text-accent' : 'text-fg-faint'}`}>
                      {isActive ? '●' : '○'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium ${isActive ? 'text-fg' : 'text-fg-2'}`}>{t.name}</span>
                        {isActive && <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-sm bg-accent text-on-accent">Active</span>}
                      </div>
                      <p className="text-[10px] text-fg-muted mt-0.5">{t.desc}</p>
                    </div>
                  </button>
                );
              })}
              </div>
            </div>
          </div>
        </>,
        document.body,
      )}
    </section>
  );
}

// ─── Android Settings ───────────────────────────────────────────────────────

interface PairedDevice {
  name: string;
  host: string;
  port: number;
  password: string;
}

function ConnectToDesktopButton() {
  const [open, setOpen] = useState(false);
  const scrollRef = useScrollFade<HTMLDivElement>();
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [remoteConnected, setRemoteConnected] = useState(false);
  const [connectedDeviceName, setConnectedDeviceName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [showConnectForm, setShowConnectForm] = useState(false);
  const [formName, setFormName] = useState('Desktop');
  const [formHost, setFormHost] = useState('');
  const [formPort, setFormPort] = useState('9900');
  const [formPassword, setFormPassword] = useState('');
  const [tailscaleStatus, setTailscaleStatus] = useState<{ connected: boolean; ip?: string } | null>(null);
  const [tailscaleLoading, setTailscaleLoading] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const claude = (window as any).claude;

  // Track connection mode
  useEffect(() => {
    import('../platform').then(({ isRemoteMode, onConnectionModeChange }) => {
      setRemoteConnected(isRemoteMode());
      const unsub = onConnectionModeChange((mode) => {
        setRemoteConnected(mode === 'remote');
      });
      return unsub;
    });
  }, []);

  // Load paired devices on mount
  useEffect(() => {
    claude.android?.getPairedDevices?.()
      .then((devices: any) => setPairedDevices(devices?.devices || devices || []))
      .catch(() => {});
  }, []);

  // Check Tailscale status when popup opens
  useEffect(() => {
    if (!open) return;
    setTailscaleLoading(true);
    setConnectError(null);
    claude.remote?.detectTailscale?.()
      .then((status: any) => setTailscaleStatus(status ?? null))
      .catch(() => setTailscaleStatus(null))
      .finally(() => setTailscaleLoading(false));
  }, [open]);

  const doConnect = useCallback(async (device: PairedDevice) => {
    setConnecting(true);
    setConnectError(null);
    try {
      const { connectToHost } = await import('../remote-shim');
      await connectToHost(device.host, device.port, device.password);
      setConnectedDeviceName(device.name);
      setOpen(false);
    } catch (err: any) {
      setConnectError(err?.message || 'Connection failed');
    } finally {
      setConnecting(false);
    }
  }, []);

  const handleSaveDevice = useCallback(async () => {
    if (!formHost.trim()) return;
    const device: PairedDevice = {
      name: formName.trim() || 'Desktop',
      host: formHost.trim(),
      port: parseInt(formPort) || 9900,
      password: formPassword,
    };
    await claude.android?.savePairedDevice?.(device);
    setPairedDevices(prev => [...prev.filter(d => d.host !== device.host || d.port !== device.port), device]);
    setShowConnectForm(false);
    setFormName('Desktop');
    setFormHost('');
    setFormPort('9900');
    setFormPassword('');
    await doConnect(device);
  }, [formName, formHost, formPort, formPassword, doConnect]);

  const handleRemoveDevice = useCallback(async (device: PairedDevice) => {
    await claude.android?.removePairedDevice?.(device.host, device.port);
    setPairedDevices(prev => prev.filter(d => d.host !== device.host || d.port !== device.port));
  }, []);

  const handleDisconnect = useCallback(async () => {
    setConnecting(true);
    try {
      const { disconnectFromHost } = await import('../remote-shim');
      await disconnectFromHost();
      setConnectedDeviceName('');
    } catch (err: any) {
      setConnectError(err?.message || 'Disconnect failed');
    } finally {
      setConnecting(false);
    }
  }, []);

  const handleScanQr = useCallback(async () => {
    const result = await claude.android?.scanQr?.();
    if (result?.url) {
      try {
        const u = new URL(result.url);
        setFormHost(u.hostname);
        setFormPort(u.port || '9900');
        setShowConnectForm(true);
      } catch { /* invalid URL */ }
    }
  }, []);

  const subtitle = remoteConnected
    ? `Connected · ${connectedDeviceName || 'Desktop'}`
    : pairedDevices.length > 0
      ? `${pairedDevices.length} saved device${pairedDevices.length !== 1 ? 's' : ''}`
      : 'Not configured';

  return (
    <>
      <button
        onClick={() => { setOpen(true); setShowConnectForm(false); }}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
      >
        <div className="relative flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
          <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          {remoteConnected && (
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-green-400 ring-1 ring-panel" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs text-fg font-medium">Connect to Desktop</span>
          <p className={`text-[10px] ${remoteConnected ? 'text-green-400' : 'text-fg-muted'}`}>{subtitle}</p>
        </div>
        <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {open && createPortal(
        <>
          <Scrim layer={2} onClick={() => setOpen(false)} />
          <div
            ref={popupRef}
            className="layer-surface fixed z-[61] overflow-hidden flex flex-col"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'min(380px, 88vw)',
              maxHeight: '80vh',
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
              <h2 className="text-sm font-bold text-fg">Connect to Desktop</h2>
              <button onClick={() => setOpen(false)} className="text-fg-muted hover:text-fg-2 text-lg leading-none">✕</button>
            </div>

            <div ref={scrollRef} className="scroll-fade">
              <div className="px-4 py-4 space-y-4">

              {/* Tailscale warning */}
              {!tailscaleLoading && tailscaleStatus !== null && !tailscaleStatus.connected && (
                <div className="bg-amber-500/10 border border-amber-500/25 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <svg className="w-3.5 h-3.5 text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <span className="text-xs text-amber-400 font-medium">Tailscale not connected</span>
                  </div>
                  <p className="text-[10px] text-fg-dim">Enable Tailscale on this phone before connecting. Both devices must be on the same Tailscale network.</p>
                </div>
              )}

              {/* Connected banner */}
              {remoteConnected && (
                <div className="bg-green-500/10 border border-green-500/25 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                    <span className="text-xs text-green-400 font-medium">
                      Connected to {connectedDeviceName || 'Desktop'}
                    </span>
                  </div>
                  <button
                    onClick={handleDisconnect}
                    disabled={connecting}
                    className="w-full px-3 py-1.5 rounded-sm bg-inset hover:bg-edge text-xs text-fg-2 disabled:opacity-50"
                  >
                    {connecting ? 'Disconnecting...' : 'Disconnect — Return to Local'}
                  </button>
                </div>
              )}

              {/* Error */}
              {connectError && (
                <div className="bg-red-500/10 border border-red-500/25 rounded-lg p-2">
                  <p className="text-[10px] text-red-400">{connectError}</p>
                </div>
              )}

              {/* Saved devices — always listed */}
              {pairedDevices.length > 0 && (
                <section>
                  <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">Saved Devices</h3>
                  <div className="space-y-1">
                    {pairedDevices.map(device => (
                      <div key={`${device.host}:${device.port}`} className="flex items-center justify-between py-2 px-3 rounded-sm bg-inset/50">
                        <button
                          onClick={() => doConnect(device)}
                          disabled={connecting || remoteConnected}
                          className="min-w-0 flex-1 text-left disabled:opacity-50"
                        >
                          <span className="text-xs text-fg block">{device.name}</span>
                          <span className="text-[10px] text-fg-muted font-mono block">{device.host}:{device.port}</span>
                        </button>
                        <button
                          onClick={() => handleRemoveDevice(device)}
                          className="text-fg-faint hover:text-red-400 text-sm leading-none px-1 shrink-0 ml-2"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {connecting && !remoteConnected && (
                <div className="text-center py-2">
                  <span className="text-xs text-fg-dim">Connecting...</span>
                </div>
              )}

              {/* Add new device */}
              {!remoteConnected && !connecting && (
                <section>
                  {pairedDevices.length > 0 && (
                    <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">Add Device</h3>
                  )}
                  {!showConnectForm ? (
                    <div className="space-y-2">
                      <button
                        onClick={handleScanQr}
                        className="w-full px-3 py-2 rounded-sm bg-accent text-on-accent text-xs font-medium active:brightness-110"
                      >
                        Scan QR Code
                      </button>
                      <button
                        onClick={() => setShowConnectForm(true)}
                        className="w-full px-3 py-2 rounded-sm border border-edge text-fg-dim text-xs active:bg-inset"
                      >
                        Enter Manually
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3 bg-inset/50 rounded-lg p-3">
                      <div>
                        <label className="text-[10px] text-fg-muted uppercase tracking-wider block mb-1">Device Name</label>
                        <input
                          type="text"
                          value={formName}
                          onChange={e => setFormName(e.target.value)}
                          placeholder="My Desktop"
                          className="w-full px-2 py-1.5 rounded-sm bg-well border border-edge-dim text-xs text-fg focus:outline-none focus:border-fg-muted"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-fg-muted uppercase tracking-wider block mb-1">Host / IP</label>
                        <input
                          type="text"
                          value={formHost}
                          onChange={e => setFormHost(e.target.value)}
                          placeholder="100.x.x.x"
                          className="w-full px-2 py-1.5 rounded-sm bg-well border border-edge-dim text-xs text-fg focus:outline-none focus:border-fg-muted"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-fg-muted uppercase tracking-wider block mb-1">Port</label>
                        <input
                          type="text"
                          value={formPort}
                          onChange={e => setFormPort(e.target.value)}
                          placeholder="9900"
                          className="w-full px-2 py-1.5 rounded-sm bg-well border border-edge-dim text-xs text-fg focus:outline-none focus:border-fg-muted"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-fg-muted uppercase tracking-wider block mb-1">Password</label>
                        <input
                          type="password"
                          value={formPassword}
                          onChange={e => setFormPassword(e.target.value)}
                          placeholder="Remote access password"
                          className="w-full px-2 py-1.5 rounded-sm bg-well border border-edge-dim text-xs text-fg focus:outline-none focus:border-fg-muted"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setShowConnectForm(false)}
                          className="px-3 py-1.5 rounded-sm bg-inset hover:bg-edge text-xs text-fg-2"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleSaveDevice}
                          disabled={!formHost.trim()}
                          className="flex-1 px-3 py-1.5 rounded-sm bg-accent text-on-accent text-xs font-medium disabled:opacity-50 active:brightness-110"
                        >
                          Save & Connect
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              <p className="text-[10px] text-fg-faint">
                Connect to the YouCoded desktop app on your computer. Set up remote access in the desktop app's settings first.
              </p>
              </div>
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  );
}

function AndroidSettings({ open, onClose, onSendInput, onOpenThemeMarketplace, onPublishTheme, syncAutoOpen, onSyncAutoOpenHandled }: { open: boolean; onClose: () => void; onSendInput: (text: string) => void; onOpenThemeMarketplace?: () => void; onPublishTheme?: (slug: string) => void; syncAutoOpen?: boolean; onSyncAutoOpenHandled?: () => void }) {
  const [loading, setLoading] = useState(true);
  const [tier, setTier] = useState('CORE');
  const [aboutInfo, setAboutInfo] = useState<{ version: string; build: string } | null>(null);
  const [defaults, setDefaults] = useState({ skipPermissions: false, model: 'sonnet', projectFolder: '', permissionOverrides: { ...OVERRIDES_DEFAULT } });
  const [remoteConnected, setRemoteConnected] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showDonateConfirm, setShowDonateConfirm] = useState(false);
  const [showDevMenu, setShowDevMenu] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const [showContribute, setShowContribute] = useState(false);

  const claude = (window as any).claude;

  // Sync remote connection state
  useEffect(() => {
    import('../platform').then(({ isRemoteMode, onConnectionModeChange }) => {
      setRemoteConnected(isRemoteMode());
      const unsub = onConnectionModeChange((mode) => {
        setRemoteConnected(mode === 'remote');
      });
      return unsub;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    // Fix: defer IPC calls until after the 300ms slide-in animation. Firing
    // three parallel bridge calls synchronously visibly stutters the panel.
    const _deferTimer = setTimeout(() => {
    Promise.all([
      claude.android?.getTier?.() ?? 'CORE',
      claude.android?.getAbout?.() ?? { version: 'unknown', build: '' },
      claude.defaults?.get?.() ?? { skipPermissions: false, model: 'sonnet', projectFolder: '', permissionOverrides: { ...OVERRIDES_DEFAULT } },
    ]).then(([t, about, defs]) => {
      setTier(t?.tier || t || 'CORE');
      setAboutInfo(about);
      setDefaults(defs);
      setLoading(false);
    }).catch(() => setLoading(false));
    }, 350);
    return () => clearTimeout(_deferTimer);
  }, [open]);

  const handleSetTier = useCallback(async (newTier: string) => {
    const result = await claude.android?.setTier?.(newTier);
    setTier(newTier);
    if (result?.restartRequired) {
      // The bridge handles restart prompt natively
    }
  }, []);

  const handleDefaultsChange = useCallback(async (updates: Partial<typeof defaults>) => {
    const merged = { ...defaults, ...updates };
    setDefaults(merged);
    await claude.defaults?.set?.(updates);
  }, [defaults]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-fg-muted text-sm">
        Loading...
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 px-4 py-4 space-y-6">

        <ThemeButton onSendInput={onSendInput} onOpenMarketplace={onOpenThemeMarketplace} onPublishTheme={onPublishTheme} />

        <BuddyToggle />

        <SyncSection autoOpen={syncAutoOpen} onAutoOpenHandled={onSyncAutoOpenHandled} />

        {/* Tier & directories are local-only — hide when connected to remote desktop */}
        {!remoteConnected && (
          <>
            <TierSelector tier={tier} onSetTier={handleSetTier} />
          </>
        )}

        <ConnectToDesktopButton />

        {/* Other */}
        <section>
          <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Other</h3>
          <div className="space-y-2">
            <DefaultsButton defaults={defaults} onDefaultsChange={handleDefaultsChange} />

            {/* Development — bug reports, contributions, known issues */}
            <button
              onClick={() => setShowDevMenu(true)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
            >
              <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
                {/* {YC} — curly braces with YC monogram in Cascadia Mono (matches the */}
                {/* "Development" label's font size). Wider viewBox/icon (32×24 → 24×16) */}
                {/* than the other Other-section icons because monospace YC at the */}
                {/* requested size won't fit alongside brackets in a 16×16 box. */}
                <svg className="w-6 h-4 text-fg-muted" viewBox="0 0 32 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 4 C 3 4 3 7 3 9 C 3 11 2 12 1 12 C 2 12 3 13 3 15 C 3 17 3 20 5 20" />
                  <path d="M27 4 C 29 4 29 7 29 9 C 29 11 30 12 31 12 C 30 12 29 13 29 15 C 29 17 29 20 27 20" />
                  <text x="16" y="17" textAnchor="middle" fontFamily="'Cascadia Code', 'Cascadia Mono', Consolas, monospace" fontSize="16" fontWeight="500" fill="currentColor" stroke="none">YC</text>
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs text-fg font-medium">Development</span>
                <p className="text-[10px] text-fg-muted">Report a bug, contribute, or browse known issues</p>
              </div>
              <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <DevelopmentPopup
              open={showDevMenu}
              onClose={() => setShowDevMenu(false)}
              onOpenBug={() => { setShowDevMenu(false); setShowBugReport(true); }}
              onOpenContribute={() => { setShowDevMenu(false); setShowContribute(true); }}
            />
            <BugReportPopup open={showBugReport} onClose={() => setShowBugReport(false)} />
            <ContributePopup open={showContribute} onClose={() => setShowContribute(false)} />

            {/* Keyboard shortcuts intentionally omitted on Android — no physical keyboard. */}

            <button
              onClick={() => setShowDonateConfirm(true)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
            >
              <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
                <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z" />
                  </svg>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs text-fg font-medium">Donate</span>
                <p className="text-[10px] text-fg-muted">Support YouCoded development</p>
              </div>
              <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>

            {/* Donate confirmation modal */}
            {showDonateConfirm && createPortal(
              <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={() => setShowDonateConfirm(false)}>
                <div className="absolute inset-0 layer-scrim" data-layer="2" />
                <div
                  className="layer-surface relative p-6 max-w-xs w-full mx-4 text-center"
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="text-xs text-fg-muted mb-1">Donations supported via</p>
                  <div className="flex items-center justify-center gap-2 mb-5">
                    {/* Custom coffee-mug icon: body + handle + rising steam. Ties to "Buy Me a Coffee" label via BMC yellow. */}
                    <svg className="w-5 h-5 text-[#FFDD00]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 2v2M11 2v2M15 2v2" />
                      <path d="M3 8h14v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z" />
                      <path d="M17 11h2a2.5 2.5 0 0 1 0 5h-2" />
                    </svg>
                    <span className="text-sm font-bold text-fg">Buy Me a Coffee</span>
                  </div>
                  <p className="text-[11px] text-fg-dim mb-5">Okay to open donation link?</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowDonateConfirm(false)}
                      className="flex-1 text-xs font-medium py-2.5 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        window.open('https://buymeacoffee.com/itsdestin', '_blank');
                        setShowDonateConfirm(false);
                      }}
                      className="flex-1 text-xs font-medium py-2.5 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all"
                    >
                      Open
                    </button>
                  </div>
                </div>
              </div>,
              document.body
            )}

            {aboutInfo && (
              <>
                <button
                  onClick={() => setShowAbout(true)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
                >
                  <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
                    <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-fg font-medium">About</span>
                    <p className="text-[10px] text-fg-muted">YouCoded {aboutInfo.version}{aboutInfo.build ? ` · ${aboutInfo.build}` : ''}</p>
                  </div>
                  <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                <AboutPopup
                  open={showAbout}
                  onClose={() => setShowAbout(false)}
                  platform="android"
                  version={aboutInfo.version}
                  build={aboutInfo.build}
                />
              </>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

// ─── Desktop Settings (existing, unchanged) ─────────────────────────────────

function DesktopSettings({ open, onClose, onSendInput, hasActiveSession, onOpenThemeMarketplace, onPublishTheme, syncAutoOpen, onSyncAutoOpenHandled }: {
  open: boolean;
  onClose: () => void;
  onSendInput: (text: string) => void;
  hasActiveSession: boolean;
  onOpenThemeMarketplace?: () => void;
  onPublishTheme?: (slug: string) => void;
  syncAutoOpen?: boolean;
  onSyncAutoOpenHandled?: () => void;
}) {
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleInfo | null>(null);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [newPassword, setNewPassword] = useState('');
  const [passwordStatus, setPasswordStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [loading, setLoading] = useState(true);
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [showSetupQR, setShowSetupQR] = useState(false);
  const [copied, setCopied] = useState(false);
  const [defaults, setDefaults] = useState({ skipPermissions: false, model: 'sonnet', projectFolder: '', permissionOverrides: { ...OVERRIDES_DEFAULT } });
  const [setupStatus, setSetupStatus] = useState<'idle' | 'confirm' | 'installing' | 'authenticating' | 'done' | 'error'>('idle');
  const [setupError, setSetupError] = useState('');
  const [showDonateConfirm, setShowDonateConfirm] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showDevMenu, setShowDevMenu] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const [showContribute, setShowContribute] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setShowAddDevice(false);
    setShowSetupQR(false);
    const claude = (window as any).claude;
    if (!claude?.remote) { setLoading(false); return; }
    // Fix: defer IPC calls until after the 300ms slide-in animation. detectTailscale
    // in particular blocks the main thread long enough to visibly stutter the panel.
    const _deferTimer = setTimeout(() => {
    Promise.all([
      claude.remote.getConfig(),
      claude.remote.detectTailscale(),
      claude.remote.getClientList(),
      claude.defaults?.get?.() ?? { skipPermissions: false, model: 'sonnet', projectFolder: '', permissionOverrides: { ...OVERRIDES_DEFAULT } },
    ]).then(([cfg, ts, cls, defs]: [RemoteConfig, TailscaleInfo, ClientInfo[], any]) => {
      setConfig(cfg);
      setTailscale(ts);
      setClients(cls);
      setDefaults(defs);
      setLoading(false);
    }).catch(() => setLoading(false));
    }, 350);
    return () => clearTimeout(_deferTimer);
  }, [open]);

  const handleSetPassword = useCallback(async () => {
    if (!newPassword.trim()) return;
    setPasswordStatus('saving');
    try {
      await (window as any).claude.remote.setPassword(newPassword);
      setConfig(prev => prev ? { ...prev, hasPassword: true } : prev);
      setNewPassword('');
      setPasswordStatus('saved');
      setTimeout(() => setPasswordStatus('idle'), 2000);
    } catch {
      setPasswordStatus('idle');
    }
  }, [newPassword]);

  const handleToggleEnabled = useCallback(async () => {
    if (!config) return;
    const updated = await (window as any).claude.remote.setConfig({ enabled: !config.enabled });
    setConfig(prev => prev ? { ...prev, ...updated } : prev);
  }, [config]);

  const handleToggleTailscaleTrust = useCallback(async () => {
    if (!config) return;
    const updated = await (window as any).claude.remote.setConfig({ trustTailscale: !config.trustTailscale });
    setConfig(prev => prev ? { ...prev, ...updated } : prev);
  }, [config]);

  const handleSetKeepAwake = useCallback(async (hours: number) => {
    const updated = await (window as any).claude.remote.setConfig({ keepAwakeHours: hours });
    setConfig(prev => prev ? { ...prev, ...updated } : prev);
  }, []);

  const handleRunSetup = useCallback(() => {
    setSetupStatus('confirm');
    setSetupError('');
  }, []);

  const handleCancelSetup = useCallback(() => {
    setSetupStatus('idle');
    setSetupError('');
  }, []);

  const handleConfirmSetup = useCallback(async () => {
    try {
      // Check if already installed before trying to install
      const check = await (window as any).claude.remote.detectTailscale();
      if (check?.installed) {
        // Already installed — skip to auth
        setSetupStatus('authenticating');
        await (window as any).claude.remote.authTailscale();
        setSetupStatus('done');
        setTailscale(check);
        setTimeout(() => setSetupStatus('idle'), 3000);
        return;
      }

      setSetupStatus('installing');
      const result = await (window as any).claude.remote.installTailscale();
      if (result?.success) {
        setSetupStatus('authenticating');
        await (window as any).claude.remote.authTailscale();
        setSetupStatus('done');
        const ts = await (window as any).claude.remote.detectTailscale();
        setTailscale(ts);
        setTimeout(() => setSetupStatus('idle'), 3000);
      } else {
        setSetupError(result?.error || 'Installation failed');
        setSetupStatus('error');
      }
    } catch (err) {
      setSetupError(String(err));
      setSetupStatus('error');
    }
  }, []);

  const handleDisconnectClient = useCallback(async (clientId: string) => {
    await (window as any).claude.remote.disconnectClient(clientId);
    setClients(prev => prev.filter(c => c.id !== clientId));
    setConfig(prev => prev ? { ...prev, clientCount: Math.max(0, prev.clientCount - 1) } : prev);
  }, []);

  const handleCopyLink = useCallback(() => {
    if (tailscale?.url) {
      navigator.clipboard.writeText(tailscale.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [tailscale]);

  const handleDefaultsChange = useCallback(async (updates: Partial<typeof defaults>) => {
    const merged = { ...defaults, ...updates };
    setDefaults(merged);
    await (window as any).claude.defaults?.set?.(updates);
  }, [defaults]);

  return (
    <>
      <div className="flex-1 px-4 py-4 space-y-6">

        <ThemeButton onSendInput={onSendInput} onOpenMarketplace={onOpenThemeMarketplace} onPublishTheme={onPublishTheme} />

        <BuddyToggle />

        <SoundButton />

        <SyncSection autoOpen={syncAutoOpen} onAutoOpenHandled={onSyncAutoOpenHandled} />

        <RemoteButton
          config={config}
          tailscale={tailscale}
          clients={clients}
          loading={loading}
          hasActiveSession={hasActiveSession}
          newPassword={newPassword}
          passwordStatus={passwordStatus}
          copied={copied}
          showSetupQR={showSetupQR}
          showAddDevice={showAddDevice}
          onSetNewPassword={setNewPassword}
          onSetPassword={handleSetPassword}
          onToggleEnabled={handleToggleEnabled}
          onToggleTailscaleTrust={handleToggleTailscaleTrust}
          onSetKeepAwake={handleSetKeepAwake}
          onRunSetup={handleRunSetup}
          onConfirmSetup={handleConfirmSetup}
          onCancelSetup={handleCancelSetup}
          setupStatus={setupStatus}
          setupError={setupError}
          onDisconnectClient={handleDisconnectClient}
          onCopyLink={handleCopyLink}
          onSetShowSetupQR={setShowSetupQR}
          onSetShowAddDevice={setShowAddDevice}
        />

        {/* Other */}
        <section>
          <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Other</h3>
          <div className="space-y-2">
            <DefaultsButton defaults={defaults} onDefaultsChange={handleDefaultsChange} />

            {/* Development — bug reports, contributions, known issues */}
            <button
              onClick={() => setShowDevMenu(true)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
            >
              <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
                {/* {YC} — curly braces with YC monogram in Cascadia Mono (matches the */}
                {/* "Development" label's font size). Wider viewBox/icon (32×24 → 24×16) */}
                {/* than the other Other-section icons because monospace YC at the */}
                {/* requested size won't fit alongside brackets in a 16×16 box. */}
                <svg className="w-6 h-4 text-fg-muted" viewBox="0 0 32 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 4 C 3 4 3 7 3 9 C 3 11 2 12 1 12 C 2 12 3 13 3 15 C 3 17 3 20 5 20" />
                  <path d="M27 4 C 29 4 29 7 29 9 C 29 11 30 12 31 12 C 30 12 29 13 29 15 C 29 17 29 20 27 20" />
                  <text x="16" y="17" textAnchor="middle" fontFamily="'Cascadia Code', 'Cascadia Mono', Consolas, monospace" fontSize="16" fontWeight="500" fill="currentColor" stroke="none">YC</text>
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs text-fg font-medium">Development</span>
                <p className="text-[10px] text-fg-muted">Report a bug, contribute, or browse known issues</p>
              </div>
              <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <DevelopmentPopup
              open={showDevMenu}
              onClose={() => setShowDevMenu(false)}
              onOpenBug={() => { setShowDevMenu(false); setShowBugReport(true); }}
              onOpenContribute={() => { setShowDevMenu(false); setShowContribute(true); }}
            />
            <BugReportPopup open={showBugReport} onClose={() => setShowBugReport(false)} />
            <ContributePopup open={showContribute} onClose={() => setShowContribute(false)} />

            {/* Keyboard Shortcuts */}
            <button
              onClick={() => setShowShortcuts(true)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
            >
              <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
                <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h8" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs text-fg font-medium">Keyboard Shortcuts</span>
                <p className="text-[10px] text-fg-muted">View all hotkeys</p>
              </div>
              <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <ShortcutsPopup open={showShortcuts} onClose={() => setShowShortcuts(false)} />

            <button
              onClick={() => setShowDonateConfirm(true)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
            >
              <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
                <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z" />
                  </svg>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs text-fg font-medium">Donate</span>
                <p className="text-[10px] text-fg-muted">Support YouCoded development</p>
              </div>
              <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>

            {/* Donate confirmation modal */}
            {showDonateConfirm && createPortal(
              <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={() => setShowDonateConfirm(false)}>
                <div className="absolute inset-0 layer-scrim" data-layer="2" />
                <div
                  className="layer-surface relative p-6 max-w-xs w-full mx-4 text-center"
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="text-xs text-fg-muted mb-1">Donations supported via</p>
                  <div className="flex items-center justify-center gap-2 mb-5">
                    {/* Custom coffee-mug icon: body + handle + rising steam. Ties to "Buy Me a Coffee" label via BMC yellow. */}
                    <svg className="w-5 h-5 text-[#FFDD00]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 2v2M11 2v2M15 2v2" />
                      <path d="M3 8h14v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z" />
                      <path d="M17 11h2a2.5 2.5 0 0 1 0 5h-2" />
                    </svg>
                    <span className="text-sm font-bold text-fg">Buy Me a Coffee</span>
                  </div>
                  <p className="text-[11px] text-fg-dim mb-5">Okay to open donation link?</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowDonateConfirm(false)}
                      className="flex-1 text-xs font-medium py-2.5 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        window.open('https://buymeacoffee.com/itsdestin', '_blank');
                        setShowDonateConfirm(false);
                      }}
                      className="flex-1 text-xs font-medium py-2.5 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all"
                    >
                      Open
                    </button>
                  </div>
                </div>
              </div>,
              document.body
            )}

            {/* About — popup on click, styled like other settings popups */}
            <button
              onClick={() => setShowAbout(true)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
            >
              <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
                <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs text-fg font-medium">About</span>
                <p className="text-[10px] text-fg-muted">YouCoded {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''}</p>
              </div>
              <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <AboutPopup
              open={showAbout}
              onClose={() => setShowAbout(false)}
              platform="desktop"
              version={typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''}
            />
          </div>
        </section>
      </div>
    </>
  );
}

