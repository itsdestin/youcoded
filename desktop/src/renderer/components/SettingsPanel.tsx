declare const __APP_VERSION__: string;
// Baked in by Vite from YOUCODED_BUILD_CHANNEL. '' for release builds, 'BETA'
// for desktop-test-build.yml artifacts. See src/shared/version-line.ts.
declare const __BUILD_CHANNEL__: string;
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { RemoteAccessView, RemoteAccessAction, RemoteAccessPreview } from './remote/preview-types';

import { QRCodeSVG } from 'qrcode.react';
import { isAndroid } from '../platform';
import { useCurrentPlatform } from '../state/platform';
import ThemeScreen from './ThemeScreen';
import SyncSection from './SyncPanel';
import SettingsExplainer, { InfoIconButton, type ExplainerSection } from './SettingsExplainer';
import { useTheme } from '../state/theme-context';
import { useScrollFade } from '../hooks/useScrollFade';
import { Scrim } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import AboutPopup from './AboutPopup';
import { DevelopmentPopup } from './development/DevelopmentPopup';
import { BugReportPopup } from './development/BugReportPopup';
import { ContributePopup } from './development/ContributePopup';
import PerformanceButton from './PerformanceButton';
import AccountSection from './AccountSection';
import { DonateConfirm } from './DonateConfirm';
import AssistantSettingsRow from './assistant-settings/AssistantSettings';
import type { AssistantDefaults } from './assistant-settings/pages';
import { formatVersionLine } from '../../shared/version-line';
// The Linux/KDE buddy helper's three-state answer. Typed centrally so the popup
// and the launch path in App.tsx cannot drift apart on what `needed` means.
import type { BuddyHelperStatus } from '../../shared/types';
// UiToggle is aliased because this file still exports its own `Toggle` (the
// compat wrapper below) that AboutPopup imports by that name.
import { Button, CloseButton, Toggle as UiToggle, TextInput, InputGroup, LoadingState, RadioGroup, SegmentedTabs, Dialog, SettingRow, Callout, StatusStrip, ErrorState, FieldError } from './ui';

// Both are Vite `define` substitutions, so they're constants at module scope.
// The typeof guard covers paths where the define isn't applied (unit tests).
const desktopVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
const desktopChannel = typeof __BUILD_CHANNEL__ !== 'undefined' ? __BUILD_CHANNEL__ : '';

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
        { term: 'Connected device should be removed', text: 'Use the Disconnect button next to a device under "Connected Devices". They\'ll need the password again to reconnect.' },
      ],
    },
  ],
};

interface RemoteConfig {
  enabled: boolean;
  port: number;
  hasPassword: boolean;
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

/**
 * A row in the device list. Contract R7/R11: a device that has paired stays here, named,
 * marked Online or Offline, until it is unpaired. The old shape was a live CONNECTION —
 * an address and how long ago it connected — so a device that closed its browser vanished
 * and could never be unpaired.
 */
/** What the listener is actually doing, straight from the server. */
interface RemoteStatus {
  state: 'listening' | 'stopped' | 'failed';
  reason?: string;
  port: number;
}

interface RemoteDeviceRow {
  id: string;
  name: string;
  online: boolean;
  createdAt: number;
  lastSeenAt: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSendInput: (text: string) => void;
  /** Run a slash command through the slash dispatcher — the path that reaches a
   *  native session's harness. onSendInput pipes raw text at a PTY those
   *  sessions do not have, which is why the theme-build button was dead there. */
  onRunCommand?: (command: string) => void;
  hasActiveSession: boolean;
  // Task 10: Settings → Specialists needs the active conversation's working
  // folder so the roster it shows includes that project's OWN .claude/agents
  // specialists, not just the two global sources. Undefined when there is no
  // active session — the section just shows the global sources then.
  // Desktop-only (see the DesktopSettings-only render below).
  activeSessionCwd?: string;
  onOpenThemeMarketplace?: () => void;
  onPublishTheme?: (slug: string) => void;
  // Opens Claude Code's preferences popup (/config). Consumed by the Model
  // Providers popup's Claude Code section. Desktop-only.
  onOpenClaudePreferences?: () => void;
  syncAutoOpen?: boolean;
  onSyncAutoOpenHandled?: () => void;
  // Deep-link the Model Providers popup open on panel mount — used by the
  // provider-error bubble's "Open Settings" jump. Desktop-only (the Model
  // Providers section isn't mounted in AndroidSettings).
  providersAutoOpen?: boolean;
  onProvidersAutoOpenHandled?: () => void;
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
  { keys: 'Ctrl + `', description: 'Toggle between chat and terminal' },   // P-7: 'view' trimmed so the label holds one line at 420px
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
  useEscClose(open, onClose);
  if (!open) return null;
  return createPortal(
    <>
      {/* P-8/P-7 (2026-08-28): was size="prompt" (340px) with its own header and
          scrollBody={false} — at that width four labels wrapped to two lines AND
          the last three of the thirteen rows fell outside the dialog's 476px cap
          with no scroll region anywhere, so they could never be read. The shared
          header + scrolling body (scrollBody defaults true) fixes the reachability;
          "panel" (420px) stops the wrapping. The grid keeps the key chips in their
          own column so a long label can never push one out of line. */}
      <Dialog open onClose={onClose} size="panel" title="Keyboard Shortcuts">
        <div className="grid grid-cols-[1fr_auto] gap-x-4 items-center">
          {SHORTCUTS.map(({ keys, description }) => (
            <React.Fragment key={keys}>
              <span className="text-2xs text-fg-dim py-1.5">{description}</span>
              <kbd className="justify-self-end text-3xs font-mono text-fg-2 bg-inset border border-edge-dim rounded px-1.5 py-0.5">{keys}</kbd>
            </React.Fragment>
          ))}
        </div>
      </Dialog>
    </>,
    document.body
  );
}

export default function SettingsPanel({ open, onClose, onSendInput, onRunCommand, hasActiveSession, activeSessionCwd, onOpenThemeMarketplace, onPublishTheme, onOpenClaudePreferences, syncAutoOpen, onSyncAutoOpenHandled, providersAutoOpen, onProvidersAutoOpenHandled }: Props) {
  useEscClose(open, onClose);
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
        // max-sm:w-full — below 640px this becomes a full-screen page rather
        // than a 320px drawer. The flat w-80 was most of the "settings look
        // odd on mobile" problem: its own child popups already clamp to
        // min(380px, 88vw), so on a phone they rendered WIDER than the drawer
        // that launched them and straddled it, visually detached from the row
        // that was tapped. Full-width makes the drawer the widest surface again.
        className={`fixed top-0 left-0 h-full w-80 max-sm:w-full z-50 transform transition-transform duration-300 ease-out overlay-no-drag ${
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
              sit at window top-left and can't be moved).

              Change 50 REVERSED (Destin, 2026-07-24, after seeing it in dev): the
              headerless drawer was approved on 2026-07-16 and built, then rejected
              on sight. Esc and click-outside do work, but the title row is what
              tells you WHICH drawer this is, and the ✕ is the affordance a
              non-technical user actually looks for. Design rule 12 therefore gets
              NO Settings-drawer exception — the drawer keeps its header like every
              other overlay. Do not re-delete this without asking.

              The ✕ itself does not revert: it comes back as the shared
              <CloseButton> rather than the bare `text-lg w-8 h-8` button it was,
              because every other closer in the app went through that component in
              tranche 2 (change 76). It also gains a focus ring and an accessible
              name — the old one announced as just "✕". */}
          <div className="settings-drawer-header shrink-0 flex items-center justify-between px-4 py-3 border-b border-edge">
            <h2 className="text-sm font-bold text-fg">Settings</h2>
            <CloseButton
              onClick={onClose}
              label="Close settings"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            />
          </div>

          <div ref={outerScrollRef} className="scroll-fade flex-1 min-h-0">
            {isAndroid() ? (
              <AndroidSettings open={open} onClose={onClose} onSendInput={onSendInput} onRunCommand={onRunCommand} onOpenThemeMarketplace={onOpenThemeMarketplace} onPublishTheme={onPublishTheme} syncAutoOpen={syncAutoOpen} onSyncAutoOpenHandled={onSyncAutoOpenHandled} />
            ) : (
              <DesktopSettings
                open={open}
                onClose={onClose}
                onSendInput={onSendInput}
                onRunCommand={onRunCommand}
                hasActiveSession={hasActiveSession}
                activeSessionCwd={activeSessionCwd}
                onOpenThemeMarketplace={onOpenThemeMarketplace}
                onPublishTheme={onPublishTheme}
                onOpenClaudePreferences={onOpenClaudePreferences}
                syncAutoOpen={syncAutoOpen}
                onSyncAutoOpenHandled={onSyncAutoOpenHandled}
                providersAutoOpen={providersAutoOpen}
                onProvidersAutoOpenHandled={onProvidersAutoOpenHandled}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Toggle component (shared) ──────────────────────────────────────────────
// Was a hand-rolled 32x16 track (green-600 on / red-600 for danger) with its own
// knob math; now a thin wrapper over the shared <Toggle> primitive so there is
// one 36x20 geometry app-wide (changes 15-17). Kept as a named export — and with
// its original `enabled`/`onToggle`/`color` signature — because AboutPopup's
// analytics opt-out imports `Toggle` from this file.
//
// color="red" maps to tone="danger" (the theme's destructive token, replacing the
// raw red-600); the default maps to the app accent, replacing green-600.

export function Toggle({ enabled, onToggle, color = 'green', label, disabled }: { enabled: boolean; onToggle: () => void; color?: 'green' | 'red'; label?: string; disabled?: boolean }) {
  return (
    <UiToggle
      // The primitive already dims and blocks a disabled switch; this wrapper just
      // never passed it through, so a caller could not express "shown, not operable".
      disabled={disabled}
      checked={enabled}
      // The primitive hands back the next state; every call site here is a plain
      // flip, so we discard it and keep the existing zero-arg handlers intact.
      onChange={() => onToggle()}
      tone={color === 'red' ? 'danger' : 'default'}
      // None of these switches had an accessible name before (a <button> inside a
      // <label> does not inherit one); call sites pass the visible row text.
      aria-label={label}
    />
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

/** Preset selector — stock sounds + custom sound file option.
 *
 *  Selecting a sound PLAYS it. That is deliberate (Destin's call 2026-07-26):
 *  with one shared list behind a category toggle, "assign" and "audition" are
 *  the same intent, so a separate play button was just a second thing to aim
 *  at. The whole tile is the hit target — the radio is a visual mark, not the
 *  only place you can click. */
function PresetSelector({ selectedId, onSelect, customName }: {
  selectedId: string;
  onSelect: (id: string) => void;
  customName: string | null; // display name of the custom sound file, if set
}) {
  // Option ids in visual order, so RadioGroup's arrow keys walk the same list
  // the user sees. The custom entry only exists once a file has been picked.
  const optionIds = customName
    ? [...STOCK_PRESETS.map((p) => p.id), CUSTOM_SOUND_ID]
    : STOCK_PRESETS.map((p) => p.id);

  // K2: these are `item` rows — one of N being chosen between — with the Radio
  // in the icon slot (K3's "any option needs a description" form). SettingRow
  // renders the Radio and keeps the whole tile as the hit target.
  return (
    <RadioGroup
      options={optionIds}
      value={selectedId}
      onChange={onSelect}
      aria-label="Notification sound"
      className="space-y-1"
    >
      {STOCK_PRESETS.map((p) => (
        <SettingRow
          key={p.id}
          variant="item"
          title={p.label}
          // The tone signature is data, not prose — font-mono keeps the note
          // names aligned down the list.
          description={p.desc}
          descriptionClassName="text-fg-muted font-mono"
          selected={selectedId === p.id}
          onSelect={() => onSelect(p.id)}
          radioTabIndex={selectedId === p.id ? 0 : -1}
        />
      ))}
      {/* Custom sound — only present once the user has picked a file. */}
      {customName ? (
        <SettingRow
          variant="item"
          title={customName}
          // The only unbounded title in the app — a filename the user chose.
          truncateTitle
          description="Custom sound"
          selected={selectedId === CUSTOM_SOUND_ID}
          onSelect={() => onSelect(CUSTOM_SOUND_ID)}
          radioTabIndex={selectedId === CUSTOM_SOUND_ID ? 0 : -1}
        />
      ) : null}
    </RadioGroup>
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

  // Selecting auditions it. Previously the only way to hear a stock sound was
  // to assign it, which was the bug; the fix is that assigning is now also how
  // you listen, rather than adding a second control to aim at.
  const handleSelect = useCallback((id: string) => {
    setPresetId(id);
    setSelectedPresetId(category, id);
    playPreview(id, category);
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
      {/* The category's name lives in the tab above; this row carries only its
          on/off switch and what it does. */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 min-w-0">
          {dotColor && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />}
          <p className="text-3xs text-fg-muted">{description}</p>
        </div>
        <Toggle enabled={enabled} onToggle={handleToggle} label={label} />
      </div>
      {enabled && (
        <>
          <PresetSelector
            selectedId={presetId}
            onSelect={handleSelect}
            customName={customName}
          />
          {/* Custom sound controls */}
          <div className="flex items-center gap-2 mt-2">
            <Button variant="secondary" size="sm" onClick={handlePickCustom}>
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              {customName ? 'Change file' : 'Custom sound'}
            </Button>
            {/* ghost, not danger-outline: this only clears a sound preference. */}
            {customName && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearCustom}
                title="Remove custom sound"
              >
                Remove
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Per-category copy for the sound popup's toggle. Keyed so the tab, the
 *  description and the status dot can never drift apart. */
const SOUND_CATEGORY_META: Record<SoundCategory, { label: string; description: string; dotColor: string }> = {
  attention: {
    label: 'Needs Attention',
    description: 'Plays when a session needs approval',
    dotColor: 'bg-red-400',
  },
  ready: {
    label: 'Response Ready',
    description: 'Plays when a background session has a new response',
    dotColor: 'bg-blue-400',
  },
};

/** Sound settings — compact row that opens a popout modal (matches ThemeButton pattern) */
function SoundButton() {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  // Which notification the shared sound list is currently editing.
  const [soundCategory, setSoundCategory] = useState<SoundCategory>('attention');
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
    <>
      <SettingRow
        icon={
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
        }
        title="Sound"
        description={summaryParts.join(' · ')}
        onClick={() => setOpen(true)}
      />

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Sound & Notifications"
        size="panel"
        panelRef={popupRef}
      >
                {/* Master volume */}
                <section>
                  <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-3">Volume</h3>
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
                    <span className="text-3xs text-fg-muted w-8 text-right">{Math.round(volume * 100)}%</span>
                  </div>
                </section>

                {/* One shared sound list behind a category toggle, rather than
                    two independent lists of the same 15 presets stacked on top
                    of each other. `key` remounts the section on switch so its
                    useState initializers re-read that category's saved values. */}
                <section>
                  <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-3">Notification</h3>
                  <SegmentedTabs
                    variant="contained"
                    aria-label="Notification type"
                    value={soundCategory}
                    onChange={(id) => setSoundCategory(id as SoundCategory)}
                    tabs={[
                      { id: 'attention', label: 'Needs Attention' },
                      { id: 'ready', label: 'Response Ready' },
                    ]}
                    className="mb-3"
                  />
                  <SoundCategorySection
                    key={soundCategory}
                    category={soundCategory}
                    label={SOUND_CATEGORY_META[soundCategory].label}
                    description={SOUND_CATEGORY_META[soundCategory].description}
                    dotColor={SOUND_CATEGORY_META[soundCategory].dotColor}
                  />
                </section>
      </Dialog>
    </>
  );
}

// ─── Tier selector popup (Android) ────────────────────────────────────────

// ─── Theme popup button ────────────────────────────────────────────────────

/** Compact "Appearance" row — opens ThemeScreen in a centered popup modal */
function ThemeButton({ onSendInput, onRunCommand, onOpenMarketplace, onPublishTheme }: { onSendInput?: (text: string) => void; onRunCommand?: (command: string) => void; onOpenMarketplace?: () => void; onPublishTheme?: (slug: string) => void }) {
  const { activeTheme, allThemes } = useTheme();
  const [open, setOpen] = useState(false);
  // ThemeScreen fills this Dialog but does not own it, so it cannot reach the
  // shell's header. Both view flags live here and drive title/onBack; the
  // component gets them back as props. Same lift K12 did for `showInfo`,
  // extended to the theme editor so its header can go too.
  const [showInfo, setShowInfo] = useState(false);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const editingTheme = editingSlug ? (allThemes.find((t) => t.slug === editingSlug) ?? null) : null;
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
    <>
      <SettingRow
        icon={
          <div className="flex rounded-sm overflow-hidden w-full h-full">
            <div style={{ flex: 1, background: canvas }} />
            <div style={{ flex: 1, background: panel }} />
            <div style={{ flex: 1, background: inset }} />
            <div style={{ flex: 1, background: accent }} />
          </div>
        }
        title="Appearance"
        description={activeTheme.name}
        onClick={() => setOpen(true)}
      />

      {/* D1: one header for all three of ThemeScreen's views. */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={
          showInfo ? 'About Appearance'
            : editingTheme ? `Edit: ${editingTheme.name}`
              : 'Themes'
        }
        onBack={
          showInfo ? () => setShowInfo(false)
            : editingTheme ? () => setEditingSlug(null)
              : undefined
        }
        headerActions={!showInfo && !editingTheme ? <InfoIconButton onClick={() => setShowInfo(true)} /> : undefined}
        aria-label="Appearance"
        // A panel, not a document. Its theme cards are a 6px gradient strip and
        // a truncated name -- there is no canvas to size for, so the grid sets
        // no meaningful width floor. At panel width the 2-up cards are 194px,
        // which is ample for a strip plus a label and two 20px icons. Sizing it
        // as a document made it 600px wide for content that needed none of it.
        size="panel"
        fill
        panelRef={popupRef}
      >
        <ThemeScreen
          onClose={() => setOpen(false)}
          onSendInput={onSendInput}
          onRunCommand={onRunCommand}
          onOpenMarketplace={onOpenMarketplace}
          onPublishTheme={(slug) => { setOpen(false); onPublishTheme?.(slug); }}
          showInfo={showInfo}
          editingSlug={editingSlug}
          onEditSlug={setEditingSlug}
        />
      </Dialog>
    </>
  );
}

// ─── Buddy floater button ──────────────────────────────────────────────────
// Row + popup that controls the buddy mascot window: off by default, persists
// via localStorage['youcoded-buddy-enabled'] (matches theme/font persistence
// pattern). Toggling fires window.claude.buddy.show/hide; App.tsx also reads
// the flag on mount to auto-show if previously enabled. Follows the same
// row-opens-popup pattern as Sound/Appearance/Remote Access instead of being
// a bare checkbox — see docs/active/specs/2026-07-15-settings-panel-card-redesign-design.md.
function BuddyIcon() {
  // Simplified outline mascot silhouette (rounded head + dot eyes + arm/leg
  // stubs) — deliberately NOT the full WelcomeAppIcon/AppIcon/ThemeMascot
  // illustration, which is too detailed for a 16px monochrome row icon.
  return (
    <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="4" width="14" height="12" rx="4" />
      <circle cx="9.3" cy="10" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="10" r="0.6" fill="currentColor" stroke="none" />
      <path d="M2 9v3M22 9v3" />
      <path d="M9 20h2M13 20h2" />
    </svg>
  );
}

// Fix: the buddy floater is desktop-Electron only, and every buddy method on
// remote-shim is an error-THROWING stub — `?.` guards existence, not throwing,
// so getStatus() below threw straight out of the mount effect (synchronously,
// before .catch could ever attach) and took the app down via RootErrorBoundary.
// Rather than sprinkle try/catch over four call sites, don't render a
// desktop-only control on clients that can't use it. window.claude.window is
// the Electron-only surface the shim deliberately omits; getPlatform() is not
// usable because the shim sets __PLATFORM__ to the host's 'desktop' on auth:ok.
const isDesktopShell = () => !!(window as any).claude?.window;

// Exported for tests/buddy-helper-states.test.tsx, which drives design §4's
// three-state table through this component directly. Rendering the whole
// SettingsPanel to reach one popup would pull in every other settings screen.
export function BuddyButton() {
  const [enabled, setEnabled] = useState<boolean>(() =>
    localStorage.getItem('youcoded-buddy-enabled') === '1',
  );
  // The preference is the single source of truth, and this row is not its only
  // writer — see the status-broadcast effect below for the full list.
  const syncEnabledToPreference = useCallback(() => {
    setEnabled(localStorage.getItem('youcoded-buddy-enabled') === '1');
  }, []);
  // "Hidden until restart": the bar's hide button dismisses the buddy for
  // this run only (localStorage preference untouched). Main broadcasts
  // buddy:status-changed so this row updates live, with an inline Show-now
  // recovery (show() clears the dismissed flag main-side).
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  // Gates the KDE helper lookup below. The real OS platform, not the app-shell
  // 'electron'/'android'/'browser' axis in ../platform, because it must not fire
  // on Windows or macOS desktop builds.
  const platform = useCurrentPlatform();

  // The Linux/KDE helper (docs/active/design/2026-09-04-linux-buddy-helper/ §4).
  // THREE facts, not two:
  //   needed    — this app cannot move its own windows here (native Wayland only)
  //   supported — a helper could work on this desktop at all (KDE 6 on Wayland)
  //   installed — the helper script is loaded in the compositor right now
  // null until we've asked; on Windows and macOS we never ask, and none of this
  // renders. Reading `supported` WITHOUT `needed` is the mistake this comment
  // exists to prevent: on Linux X11 the desktop reports supported:false (KWin is
  // not Wayland) while the buddy works perfectly, so a gate on `supported` alone
  // would tell those users their buddy is "not yet supported" and take it away.
  const [helper, setHelper] = useState<BuddyHelperStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  // The undo half (decide-uninstall#D-1). Separate flags from the install ones:
  // the two actions live in different states of the popup and must never share a
  // spinner or an error line.
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Why the buddy would not appear, in the desktop's own words (design §5). The
  // main process is what refuses — the settings switch is not the only thing
  // that turns the buddy on — so this holds ITS reason rather than a guess made
  // here. Cleared on the next attempt.
  const [showError, setShowError] = useState<string | null>(null);

  // Re-asked every time the popup opens, not once at launch (B5 review, F2).
  // `supported` is not a stable fact: a DBus timeout during a busy boot comes
  // back as "not supported", and asking once would then read "Not yet supported
  // on this desktop" with a dead switch for the rest of the session, on a
  // desktop the helper fully supports. The row is mounted for the whole session,
  // so "once" really did mean "once, at app launch". One DBus call per open.
  useEffect(() => {
    if (!isDesktopShell() || platform !== 'linux' || !open) return;
    let alive = true;
    window.claude.buddy?.helperStatus?.()
      .then((h: BuddyHelperStatus) => { if (alive) setHelper(h); })
      .catch(() => {});
    return () => { alive = false; };
  }, [platform, open]);

  useEffect(() => {
    if (!isDesktopShell()) return;
    let alive = true;
    window.claude.buddy?.getStatus?.()
      .then((s: { dismissed: boolean; visible?: boolean }) => {
        if (!alive) return;
        setDismissed(!!s?.dismissed);
        syncEnabledToPreference();
      })
      .catch(() => {});
    const off = window.claude.buddy?.onStatusChanged?.(
      (s: { dismissed: boolean; visible?: boolean }) => {
        setDismissed(!!s?.dismissed);
        // WHY re-read the preference on every broadcast (B5 review, F1): this
        // row is mounted for the whole session and seeded its switch ONCE, from
        // localStorage, during the first render — before three other things can
        // turn the buddy off. The one-shot "hidden after the update" migration
        // writes the preference from App.tsx; so does a refused show() on the
        // launch path; and main puts the buddy away by itself if the KDE script
        // stops running mid-session. None of them could reach this switch.
        //
        // The user-visible cost was the headline flow of the whole feature:
        // update, buddy correctly gone, open Settings — and the row says "On —
        // floating on your desktop" with the switch on. The first click reads as
        // "turn off" and does nothing visible; only the second offers the
        // helper. A switch that says on while nothing is on screen is a switch
        // that lies, which is the standard the refusal path already meets.
        syncEnabledToPreference();
      },
    );
    return () => { alive = false; off?.(); };
  }, []);

  // The "Pin buddy above other windows (KDE only)" switch was removed on
  // 2026-09-04 (review B-2). It existed because raising the window was the only
  // thing the app could do on Wayland; the helper now pins the buddy itself, and
  // without the helper the buddy cannot be switched on at all — so the control
  // had nothing left to control.
  //
  // Correction 2026-09-04 (design §7): the sentence that used to sit here said
  // kwin-keep-above.ts "stays; the helper is what drives them". That is wrong and
  // would have sent a future session to the wrong file. kwin-keep-above.ts is
  // DEAD on this path — both its call sites pass the overlay window's caption,
  // and chooseBuddyStrategy never picks the overlay strategy on Linux. The helper
  // script sets keepAbove on the buddy window itself and does not call it.

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // WHY a generation counter (B5 review, F7): switching on now AWAITS main,
  // which itself awaits a DBus round trip before creating the window. Two quick
  // clicks — on, then off — let the hide land first, after which the pending
  // show() resolves and puts the buddy on screen with the switch reading Off.
  // A stale resolution is ignored rather than allowed to overwrite the newer
  // intent.
  const applyGeneration = useRef(0);

  const applyEnabled = useCallback(async (next: boolean) => {
    const generation = ++applyGeneration.current;
    setEnabled(next);
    setShowError(null);
    localStorage.setItem('youcoded-buddy-enabled', next ? '1' : '0');
    if (!next) {
      window.claude.buddy?.hide?.();
      return;
    }
    // WHY switching on is no longer fire-and-forget (design §5): the app itself
    // can refuse to put the buddy on screen — on a Wayland desktop with no
    // helper it would appear stuck in one spot and refuse to be dragged, which
    // is the whole bug this feature removes. If it refuses, the switch must not
    // be left sitting in the "on" position: a switch that says on while nothing
    // is on screen is a switch that lies.
    let refusal: { ok: boolean; reason?: string } | void;
    try {
      refusal = await window.claude.buddy?.show?.();
      if (generation !== applyGeneration.current) return; // the user changed their mind
    } catch {
      // A throwing bridge (remote/Android stubs) is not a refusal, and this
      // control does not render there anyway — leave the switch as the user set
      // it rather than snapping it back for a reason we cannot name.
      return;
    }
    if (refusal && refusal.ok === false) {
      setEnabled(false);
      localStorage.setItem('youcoded-buddy-enabled', '0');
      // The desktop's OWN sentence, shown as it was written. Never replaced with
      // a guess here (docs/error-message-standards.md).
      if (refusal.reason) setShowError(refusal.reason);
    }
  }, []);

  const toggle = useCallback(() => {
    const next = !enabled;
    // WHY switching ON is intercepted: on a Linux desktop where the app cannot
    // move its own windows, the buddy cannot be dragged unless a small helper
    // sits in the user's KDE settings, and adding that changes their desktop.
    // Deck Q-1 — ask at the moment the buddy is turned on, never during
    // first-run and never silently.
    //
    // Gated on `needed`, NOT on "this is Linux" and not on `supported`: a KDE
    // user on X11, or on Wayland whose windows are really XWayland ones, moves
    // his own buddy perfectly well today and must never be stopped by a consent
    // card for something he does not need.
    if (next && helper?.needed && helper.supported && !helper.installed) {
      setInstallError(null);
      setConsent(true);
      return;
    }
    void applyEnabled(next);
  }, [enabled, helper, applyEnabled]);

  const addHelper = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const r = await window.claude.buddy?.installHelper?.();
      if (r?.ok) {
        // Keep `needed`/`supported` from the answer we already have instead of
        // re-asserting them: this path is only reachable when both were true,
        // and rebuilding the whole status here is how the third fact would get
        // silently dropped the next time one is added.
        setHelper((h) => ({ ...(h ?? { needed: true, supported: true }), installed: true }));
        setConsent(false);
        await applyEnabled(true);
        return;
      }
    } catch { /* falls through to the same honest message */ }
    // Fix 2026-09-04 (design §11): the button used to stay on "Adding…" forever
    // when the install failed — `installing` was only ever set true, so the only
    // way back was to close and reopen the popup. Clear it before showing the
    // error so "Add helper" is clickable again for a retry.
    setInstalling(false);
    // Non-committal on purpose (docs/error-message-standards.md): we know the
    // install did not succeed, we do not know why, so we do not guess a cause.
    setInstallError("Couldn't add the helper to your KDE settings.");
  }, [applyEnabled]);

  // R10, amended by decide-uninstall#D-1: removal is the user's to run, from this
  // popup, on any Linux. The old consent card promised the helper went away when
  // YouCoded was uninstalled, which is false — the AppImage build has no uninstall
  // step at all — so this control is what makes the new sentence true.
  //
  // On success the buddy is switched OFF as well: no helper, no buddy (R4). Doing
  // it here rather than leaving the buddy running keeps the popup honest, since
  // the moment the script leaves KWin the buddy can no longer be moved.
  //
  // …but ONLY where the helper is what makes the buddy movable. This button also
  // appears in the state where no helper is needed at all — the user added one on
  // Wayland and has since logged into X11 — and there the buddy moves by itself.
  // Switching it off there would take away something that was working, for no
  // reason the user could trace back to the button they pressed.
  const removeHelper = useCallback(async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      const r = await window.claude.buddy?.removeHelper?.();
      if (r?.ok) {
        // `needed` and `supported` are preserved, not re-asserted. This control
        // is reachable in a state where NO helper is needed here at all — the
        // user added it on Wayland and is now logged into X11 — and hardcoding
        // `needed: true` there would flip a working buddy into the consent flow
        // the moment they removed a helper they were not using.
        setHelper((h) => ({ ...(h ?? { needed: false, supported: false }), installed: false }));
        if (helper?.needed) await applyEnabled(false);
        setRemoving(false);
        return;
      }
    } catch { /* falls through to the same honest message */ }
    setRemoving(false);
    // Same shape as the install failure above, and for the same reason: we know
    // it did not succeed and we do not know why, so we say exactly that and
    // nothing more (docs/error-message-standards.md).
    setRemoveError("Couldn't remove the helper from your KDE settings.");
  }, [applyEnabled, helper]);

  const showNow = useCallback(() => {
    // Routed through applyEnabled so a refusal is handled the same way here as
    // it is at the switch: show() clears the dismissed flag main-side, but it
    // can also come back "no" (design §5), and the row must not go on claiming
    // the buddy is on when the desktop just declined to put it there.
    void applyEnabled(true);
  }, [applyEnabled]);

  // ── Design §4's three-state table, resolved once and read everywhere below ──
  //
  // THE ONE THAT MATTERS MOST is that all of this stays false when no helper is
  // needed. Windows, macOS, Linux/X11 and Linux-Wayland-through-XWayland all
  // report needed:false, and there this popup must look exactly as it looked
  // before the helper existed — no consent card, no disabled row, no mention of
  // a helper at all. The earlier version of this file keyed off `supported`
  // alone, which is false on X11 for the unrelated reason that KWin is not
  // running Wayland, and would have greeted every KDE X11 user with "Not yet
  // supported on this desktop" and a dead switch — taking away a buddy that
  // works today.
  //
  // The one exception is Remove helper, which follows `installed` on its own:
  // someone can add the helper on Wayland and then log into X11, and R10
  // promises they can take it out again from these settings whenever they like.
  const helperUnsupported = !!helper?.needed && !helper.supported;
  const canRemoveHelper = !!helper?.installed;

  // On a Linux desktop the helper cannot run on, the buddy is genuinely
  // unavailable rather than off — deck Q-2R. Saying "Off" there would invite
  // the user to switch on something that cannot work.
  const status = helperUnsupported
    ? 'Not yet supported on this desktop'
    : !enabled
    ? 'Off'
    : dismissed
    ? 'Hidden until restart'
    : 'On — floating on your desktop';

  // Desktop-only control: hidden on remote/Android, where every buddy method
  // throws. Placed after all hooks so hook order stays unconditional.
  if (!isDesktopShell()) return null;

  return (
    <>
      <SettingRow
        icon={<BuddyIcon />}
        title="Buddy Floater"
        description={status}
        // The failure line is cleared on the way IN, so a warning from an earlier
        // attempt is never the first thing in a freshly-opened popup. This row is
        // always mounted (only the dialog closes), so the state would otherwise
        // survive indefinitely.
        onClick={() => { setRemoveError(null); setShowError(null); setOpen(true); }}
      />

      {/* maxHeight="none" preserves this one's existing behavior — it was the only
          popup of the seven with no height ceiling, and it has no scroll container,
          so inheriting the shell's 80vh default would silently CLIP the popup's
          taller states instead of letting it grow. (Written for the Linux
          keep-above row, which review B-2 deleted; the consent card and the
          Remove helper action are what make this popup tall now.) */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Buddy Floater"
        size="prompt"
        scrollBody={false}
        panelRef={popupRef}
      >
            {/* K2: this popup was the worst offender in the app — it used TWO
                different description placements within itself (one <p> below the
                row, one <p> inside the left column). Both are left-column
                descriptions now, and the border-t between them goes: the rows
                are carded, so the rule was drawing a line between two things
                that were already separated. */}
            {/* Deck Q-1: the one-time ask lives HERE — at the moment the buddy is
                switched on. Not in first-run setup, and never silently, because
                saying yes writes a file into the user's own KDE settings. */}
            {consent ? (
              <div className="px-4 py-4 space-y-3">
                <div className="text-sm font-medium text-fg">Let the buddy be moved?</div>
                <div className="text-xs text-fg-dim leading-relaxed">
                  On Linux, apps aren&rsquo;t allowed to move their own windows. YouCoded can add a
                  small helper to your KDE settings that moves it on the buddy&rsquo;s behalf.
                  Without this helper, the buddy floater cannot be enabled.
                  <br /><br />
                  {/* Replaced 2026-09-04 (decide-uninstall#D-1, design §6). The old
                      sentence ended "and it is removed when you uninstall YouCoded",
                      which is not true for most Linux users: the AppImage build has
                      no uninstall step, and on deb/rpm/pacman the cleanup would run
                      as root against a per-user KDE config. Destin picked the honest
                      wording plus the Remove helper control below. Verbatim — do not
                      reword without another deck. */}
                  It only ever touches the buddy&rsquo;s own window. You can remove it again any
                  time from this menu.
                </div>
                {installError && <Callout tone="warning">{installError}</Callout>}
                <div className="flex gap-2 pt-1">
                  <Button onClick={addHelper} disabled={installing}>
                    {installing ? 'Adding\u2026' : 'Add helper'}
                  </Button>
                  <Button variant="ghost" onClick={() => setConsent(false)}>Not now</Button>
                </div>
              </div>
            ) : (
            <div className="px-4 py-4 space-y-2">
              {/* Deck Q-2R: on a Linux desktop the helper cannot run on, this is
                  not a switch the user should be invited to flip — the buddy
                  cannot be positioned there at all. Row goes read-only and says
                  so, instead of offering an action that would do nothing. */}
              {helperUnsupported ? (
                <SettingRow
                  variant="item"
                  title="Show buddy floater"
                  description="Not yet supported on this desktop. The buddy needs KDE Plasma on Linux — other desktops do not let apps place their own windows."
                  disabled
                />
              ) : (
                <SettingRow
                  variant="item"
                  title="Show buddy floater"
                  description={
                    <>
                      A small always-on-top mascot that stays visible even when the app is minimized.
                      {enabled && dismissed && (
                        <>
                          <br />
                          Hidden until restart{' \u00b7 '}
                          <button onClick={showNow} className="text-accent hover:underline">Show now</button>
                        </>
                      )}
                    </>
                  }
                  control={<Toggle enabled={enabled} onToggle={toggle} label="Show buddy floater" />}
                />
              )}

              {/* The switch bounced back because the app refused to put the buddy
                  on screen (design §5). The sentence is the desktop's own — this
                  file does not write one, and does not guess a cause. */}
              {showError && <Callout tone="warning">{showError}</Callout>}

              {/* R10 (amended by decide-uninstall#D-1): the undo for "Add helper".
                  It renders ONLY when the helper is actually in the user's KDE
                  settings, so the single-row popup Destin signed off (R6) is still
                  exactly what a new Linux user sees — this second control cannot
                  appear until they have added the helper themselves. It is also
                  never shown on Windows or macOS, where there is no helper.

                  Gated on `installed` ALONE, not on `needed` (design §4, second
                  row). Someone can add the helper on Wayland and then log into
                  X11: the script is still sitting in their KDE settings, and if
                  this button vanished with the rest of the helper UI, hand-editing
                  a KDE config file would be the only way to get it back out. */}
              {canRemoveHelper && (
                <>
                  {removeError && <Callout tone="warning">{removeError}</Callout>}
                  <div className="flex justify-end">
                    <Button variant="ghost" size="sm" onClick={removeHelper} disabled={removing}>
                      {removing ? 'Removing\u2026' : 'Remove helper'}
                    </Button>
                  </div>
                </>
              )}
            </div>
            )}
      </Dialog>
    </>
  );
}

// ─── Remote settings popup button ─────────────────────────────────────────

/**
 * The mock secure-setup stages, drawn with the banner's OWN vocabulary — a status strip for
 * a state, a warning callout for something to read first, an ErrorState for a failure.
 * WHY no bespoke panel: round-2 review rejected one for not looking like the app.
 */
function renderPreviewSetup(view: RemoteAccessView, act: (action: RemoteAccessAction) => void) {
  if (view.stage === 'consent') {
    // WHY the address is shown whole: the public record is the machine name, and a user
    // cannot approve publishing a name we did not put in front of them.
    let host = '';
    try { const u = new URL(view.address); if (u.protocol === 'https:') host = u.hostname; } catch { /* shown as unavailable */ }
    return (
      <div className="space-y-2">
        <Callout tone="warning" title="Before continuing:">
          This computer&apos;s connection name — <span className="font-mono">{host || 'unavailable'}</span> — becomes part of a public certificate record. Your conversations and files stay private.
        </Callout>
        <Button onClick={() => act({ type: 'check' })} className="w-full" disabled={!host}>
          Approve and continue
        </Button>
      </div>
    );
  }
  if (view.stage === 'checking') {
    return <StatusStrip tone="busy" detail="Keep YouCoded open">Checking this computer&apos;s connection…</StatusStrip>;
  }
  if (view.stage === 'conflict') {
    return (
      <ErrorState
        mode="recoverable"
        message="Tailscale is already using this address for another service. Nothing was replaced. Check that service before trying again."
        onRetry={() => act({ type: 'check' })}
        variant="inline"
      />
    );
  }
  if (view.stage === 'error') {
    return (
      <ErrorState
        mode="general"
        title="Unable to check the connection."
        explainer="The check didn't report a reason. Diagnosing will collect the connection log so Claude can look at what happened."
        onReportBug={() => act({ type: 'report' })}
        onDiagnose={() => act({ type: 'diagnose' })}
      />
    );
  }
  if (view.stage === 'disabled') {
    return (
      <StatusStrip tone="idle" action={<Button size="sm" onClick={() => act({ type: 'check' })}>Turn on</Button>}>
        Remote access is off.
      </StatusStrip>
    );
  }
  if (view.prerequisite === 'not-installed') {
    return (
      <StatusStrip tone="idle" action={<Button size="sm" onClick={() => act({ type: 'prerequisite' })}>Install Tailscale</Button>}>
        Not set up yet.
      </StatusStrip>
    );
  }
  if (view.prerequisite === 'sign-in-required') {
    return (
      <StatusStrip tone="warn" action={<Button size="sm" onClick={() => act({ type: 'prerequisite' })}>Sign in</Button>}>
        Tailscale is installed, but you&apos;re not signed in yet.
      </StatusStrip>
    );
  }
  return (
    <StatusStrip tone="idle" action={<Button size="sm" onClick={() => act({ type: 'consent' })}>Set up</Button>}>
      Not set up yet.
    </StatusStrip>
  );
}

interface RemoteButtonProps {
  mockView?: RemoteAccessView;
  mockAction?: (action: RemoteAccessAction) => void;
  config: RemoteConfig | null;
  tailscale: TailscaleInfo | null;
  clients: RemoteDeviceRow[];
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
  /** Why the server refused to start, shown under the Enabled toggle. */
  enableError: string;
  onSetKeepAwake: (hours: number) => void;
  onRunSetup: () => void;
  onConfirmSetup: () => void;
  onCancelSetup: () => void;
  setupStatus: 'idle' | 'confirm' | 'installing' | 'authenticating' | 'done' | 'error';
  setupError: string;
  onUnpairDevice: (deviceId: string) => void;
  status: RemoteStatus | null;
  onCopyLink: () => void;
  onSetShowSetupQR: (v: boolean) => void;
  onSetShowAddDevice: (v: boolean) => void;
  /**
   * Opens the app's existing bug-report surface (BugReportPopup, which wraps
   * dev:summarize-issue + dev:submit-issue). Both actions on a general
   * ErrorState land here: "Report bug" files it, "Diagnose with Claude" is the
   * same popup's summarize path, which collects the logs. One destination, no
   * invented flow.
   */
  onReportIssue: () => void;
}

function RemoteButton(props: RemoteButtonProps) {
  // WHY the controls stay and are disabled rather than hidden: host administration is
  // refused over the remote socket, so leaving them live means a phone taps them and gets
  // an error every time; hiding them contradicts contract row R4, which promises Enabled,
  // Password and Keep awake stay exactly where they are. Disabled, with the reason, is the
  // only option that is both true and keeps the panel recognisable.
  const [hostOnly, setHostOnly] = useState(false);
  useEffect(() => {
    let live = true;
    void import('../platform').then(({ isRemoteMode, onConnectionModeChange }) => {
      if (!live) return;
      setHostOnly(isRemoteMode());
      onConnectionModeChange(mode => { if (live) setHostOnly(mode === 'remote'); });
    });
    return () => { live = false; };
  }, []);
  let {
  config, tailscale, clients, loading,
  newPassword, passwordStatus, copied, showSetupQR, showAddDevice,
  onSetNewPassword, onSetPassword, onToggleEnabled, enableError,
  onSetKeepAwake, onRunSetup, onConfirmSetup, onCancelSetup, setupStatus, setupError, onUnpairDevice, status, onCopyLink,
  onSetShowSetupQR, onSetShowAddDevice, onReportIssue,
  } = props;
  const [open, setOpen] = useState(!!props.mockView);
  const [mockPassword, setMockPassword] = useState('');
  const [mockSaved, setMockSaved] = useState(false);
  const [mockAwake, setMockAwake] = useState(4); // WHY 4: matches the Before capture's fixture, so the deck shows only the changes under review
  const [mockAdd, setMockAdd] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  // showInfo flips the popup body to the plain-language explainer view.
  // Reset to false whenever the popup re-opens so users always start on the
  // main settings, not whichever screen they last viewed.
  const [showInfo, setShowInfo] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  // No scroll ref here any more — Dialog owns the scroll region and its edge
  // fades for both views.

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

  // WHY this explicit MOCK_ONLY gate: reviewed mockups must not replace real host settings before the contract/backend exists.
  const previewApi = (window.claude?.remote as unknown as { preview?: () => RemoteAccessPreview } | undefined)?.preview;
  const servicePreview = typeof previewApi === 'function' ? previewApi() : undefined;
  const preview = props.mockView && props.mockAction ? { act: props.mockAction } : servicePreview;
  const storedView = React.useSyncExternalStore(
    servicePreview?.subscribe ?? (() => () => {}), servicePreview?.getView ?? (() => null),
  );
  const previewView = props.mockView ?? storedView;
  // WHY reuse the original body: mock review must retain familiar controls, while every write stays local.
  if (previewView && preview) {
    loading = false;
    config = { enabled: previewView.stage !== 'disabled', hasPassword: true, port: 9900, keepAwakeHours: mockAwake, clientCount: previewView.devices.length };
    tailscale = { installed: previewView.prerequisite !== 'not-installed', connected: previewView.prerequisite === 'ready' || !previewView.prerequisite, ip: '100.82.14.7', hostname: 'home-laptop', url: previewView.stage === 'ready' ? previewView.address : null };
    newPassword = mockPassword; passwordStatus = mockSaved ? 'saved' : 'idle';
    onSetNewPassword = value => { setMockPassword(value); setMockSaved(false); };
    onSetPassword = () => { if (mockPassword.trim()) { setMockSaved(true); setMockPassword(''); } };
    onSetKeepAwake = setMockAwake;
    onToggleEnabled = () => preview.act({ type: previewView.stage === 'disabled' ? 'check' : 'disable' });
    showAddDevice = mockAdd && previewView.stage === 'ready'; onSetShowAddDevice = setMockAdd;
    onRunSetup = () => preview.act({ type: 'prerequisite' });
    onCopyLink = () => { void navigator.clipboard.writeText(previewView.address); };
    enableError = '';
  }
  const deviceRows: RemoteDeviceRow[] = previewView
    ? previewView.devices.map(d => ({ id: d.id, name: d.name, online: d.online, createdAt: 0, lastSeenAt: 0 }))
    : clients;
  const unpair = (deviceId: string) => {
    if (previewView && preview) preview.act({ type: 'revoke', deviceId });
    else onUnpairDevice(deviceId);
  };
  const hasClients = deviceRows.length > 0;
  // WHY this reads `status` and not `config.enabled`: the indicator used to go green
  // because the switch was on, so a server whose port never bound still reported Connected
  // and the reason was only in a log nobody sees.
  const listening = status?.state === 'listening';
  const isFullyConnected = previewView ? previewView.stage === 'ready' : listening && tailscale?.installed && tailscale?.connected;
  const statusText = loading
    ? 'Loading...'
    : status?.state === 'failed'
      ? 'Not running'
      : !config?.enabled || status?.state === 'stopped'
        ? 'Disabled'
        : isFullyConnected
          ? hasClients
            ? `Connected · ${deviceRows.filter(d => d.online).length} online`
            : 'Connected'
          : tailscale?.installed
            ? 'Tailscale VPN not active'
            : 'Enabled · No Tailscale';

  // Tailscale is the transport under a fully-connected session — the old UI
  // showed a separate "Tailscale" tag next to the title whenever installed;
  // folding it into the subtitle only when it adds information (fully
  // connected) avoids a redundant "Tailscale VPN not active · Tailscale".
  const previewLabels = { setup: 'Set up secure access', consent: 'Approval needed', checking: 'Checking connection…', ready: 'Ready to connect', conflict: 'Address in use', error: 'Check failed', disabled: 'Remote access is off' };
  const subtitle = previewView ? previewLabels[previewView.stage] : isFullyConnected ? `${statusText} · Tailscale` : statusText;

  return (
    <>
      <SettingRow
        // Status indicator dot — green when remote + Tailscale VPN fully active, gray otherwise
        icon={<div className={`w-2.5 h-2.5 rounded-full ${isFullyConnected ? 'bg-green-500' : 'bg-fg-muted/40'}`} />}
        title="Remote Access"
        description={subtitle}
        onClick={() => setOpen(true)}
      />

      {/* D1, finished: BOTH views use the shell's header and scroll body now.
          The main view used to paint its own — an h2, a CloseButton, and a
          `.scroll-fade flex-1` wrapper — which is the exact set of things D1
          exists to own, and the exact set two of SettingsPopup's seven callers
          got wrong. `space-y-6` rather than Dialog's default `space-y-5`, so
          the section rhythm here is unchanged. */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={showInfo ? 'About Remote Access' : 'Remote Access'}
        onBack={showInfo ? () => setShowInfo(false) : undefined}
        // WHY: Workbench catch-all APIs can return a truthy Promise; only a rendered preview view replaces the legacy Info action.
        headerActions={showInfo ? undefined : <InfoIconButton onClick={() => setShowInfo(true)} />}
        size="panel"
        fill
        panelRef={popupRef}
      >
            {showInfo ? (previewView ? <p className="text-xs text-fg-2">Connect your other device to Tailscale, then use Add Device to open YouCoded and pair. Paired devices can use the assistant, not just read conversations. Keep this computer awake while connecting.</p> : (
              <SettingsExplainer
                intro={REMOTE_ACCESS_EXPLAINER.intro}
                sections={REMOTE_ACCESS_EXPLAINER.sections}
              />
            )) : (
            <div className="space-y-4">
                {loading ? (
                  <LoadingState what="remote access" />
                ) : (
                  <>
                    {/* Setup banner — shown when no clients connected */}
                    {(previewView ? previewView.stage !== 'ready' : !hasClients) && (
                      // Info callouts are accent-tinted, warnings are amber. The
                      // amber "setup required" boxes below stay amber — they're a
                      // true warning status, not information.
                      <div className="bg-accent/10 border border-accent/25 rounded-lg p-3">
                        <p className="text-xs text-fg-2 mb-2">
                          Remote access lets you use YouCoded from any device — phone, tablet, or another computer.
                        </p>

                        {previewView && preview ? renderPreviewSetup(previewView, preview.act) : tailscale?.installed && tailscale.url && config?.hasPassword ? (
                          showSetupQR ? (
                            <div className="mt-2">
                              {/* Remind users that Tailscale must be installed + running on the receiving device too */}
                              <Callout tone="warning" title="Before scanning:" className="mb-2">
                                Download Tailscale on your other device, sign in to the same account, and make sure it&apos;s running. The page won&apos;t load without it.
                              </Callout>
                              <p className="text-3xs text-fg-muted mb-2">Then scan to connect:</p>
                              <div className="flex justify-center bg-white rounded-lg p-3 w-fit mx-auto">
                                <QRCodeSVG value={tailscale.url} size={140} />
                              </div>
                              <p className="text-3xs text-fg-muted mt-2 text-center font-mono">{tailscale.url}</p>
                              <Button variant="secondary" size="sm" onClick={onCopyLink} className="w-full mt-2">
                                {copied ? 'Copied!' : 'Copy link'}
                              </Button>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {/* Persistent reminder — visible whenever Tailscale is ready but no device has connected yet */}
                              <Callout tone="warning" title="Other device setup required:">
                                Download Tailscale on your other device, sign in to the same account, and make sure it&apos;s running before scanning. The page won&apos;t load without it.
                              </Callout>
                              {/* Was bg-blue-600 with NO text-color class, so the
                                  label inherited the theme fg — near-black on blue
                                  on Creme. Button primary carries text-on-accent. */}
                              <Button onClick={() => onSetShowSetupQR(true)} className="w-full">
                                Set Up Remote Access
                              </Button>
                            </div>
                          )
                        ) : setupStatus === 'confirm' ? (
                          <div className="space-y-2">
                            <p className="text-3xs text-fg-2 text-center">This will download and install Tailscale (~50MB) for secure remote access.</p>
                            <div className="flex gap-2">
                              <Button variant="secondary" onClick={onCancelSetup} className="flex-1">Cancel</Button>
                              <Button onClick={onConfirmSetup} className="flex-1">Install</Button>
                            </div>
                          </div>
                        ) : setupStatus === 'installing' ? (
                          // K5. Every branch below was its own shape: centred
                          // green text, centred muted text, a bare button with no
                          // message at all. The WORDS were mostly fine — seven of
                          // eleven carry over verbatim. It was eleven shapes.
                          <StatusStrip tone="busy" detail="This may take a few minutes">
                            Installing Tailscale…
                          </StatusStrip>
                        ) : setupStatus === 'authenticating' ? (
                          <StatusStrip tone="busy" detail="Check your browser to sign in to Tailscale">
                            Waiting for Tailscale sign-in…
                          </StatusStrip>
                        ) : setupStatus === 'done' ? (
                          // Was "Tailscale installed and connected!" — the only
                          // exclamation mark in the settings family. A status
                          // strip says what you can do next (Destin, 2026-07-28).
                          <StatusStrip tone="ok">Tailscale is connected. You can pair a device now.</StatusStrip>
                        ) : setupStatus === 'error' ? (
                          // `{setupError || 'Setup failed'}` replaced a missing
                          // reason with a hardcoded guess and left the user two
                          // words and no next step — the exact pattern
                          // docs/error-message-standards.md forbids. When we HAVE
                          // the real reason we show it with Retry; when we do not,
                          // we say so without inventing a cause and hand over the
                          // two actions the standard mandates.
                          setupError ? (
                            <ErrorState
                              mode="recoverable"
                              message={setupError}
                              onRetry={onRunSetup}
                              variant="inline"
                            />
                          ) : (
                            <ErrorState
                              mode="general"
                              title="Unable to set up remote access."
                              explainer="The Tailscale installer didn't report a reason. Diagnosing will collect the setup log so Claude can look at what happened."
                              onReportBug={onReportIssue}
                              onDiagnose={onReportIssue}
                            />
                          )
                        ) : tailscale?.installed && !tailscale.connected ? (
                          // Fix: Tailscale is installed but VPN is off — tailscale.url is null in this state,
                          // so we used to fall through to the install-button branch and pretend it wasn't installed.
                          <StatusStrip tone="warn">
                            Tailscale is installed, but the VPN isn&apos;t active. Open the Tailscale app and turn it on, then come back here.
                          </StatusStrip>
                        ) : tailscale?.installed && !config?.hasPassword ? (
                          // Installed + connected but no password yet — guide the user down to the password field
                          // rather than re-prompting to install.
                          <StatusStrip tone="warn">
                            Set a password below to finish enabling remote access.
                          </StatusStrip>
                        ) : (
                          // Was a bare button with no message. A status strip
                          // says what state you are in, then offers the way out.
                          <StatusStrip
                            tone="idle"
                            action={<Button size="sm" onClick={onRunSetup}>Set up</Button>}
                          >
                            Not set up yet.
                          </StatusStrip>
                        )}
                      </div>
                    )}

                    {/* Server settings */}
                    <section>
                      <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-3">Server</h3>

                      {/* onClick keeps the whole-row hit target the <label> used
                          to give this; SettingRow stops the toggle's own click
                          from bubbling back into it. */}
                      <SettingRow
                        variant="item"
                        title="Enabled"
                        onClick={hostOnly ? undefined : onToggleEnabled}
                        control={<Toggle enabled={!!config?.enabled} onToggle={onToggleEnabled} disabled={hostOnly} label="Remote access server enabled" />}
                      />
                      {hostOnly && (
                        <p className="text-2xs text-fg-muted pb-2">Change these on the computer itself.</p>
                      )}
                      {/* The server is started from the toggle now, so it can fail
                          (port already bound, permission denied). Show the real
                          reason here — the toggle has already snapped back off. */}
                      {enableError && (
                        <FieldError as="p" size="2xs" className="pb-2">{enableError}</FieldError>
                      )}
                      {/* A bind failure was logged and nowhere else. Specific and accurate
                          when the OS gave us a reason; never a guess. */}
                      {!enableError && status?.state === 'failed' && (
                        <FieldError as="p" size="2xs" className="pb-2">
                          {status.reason ? `Not running: ${status.reason}` : 'Not running.'}
                        </FieldError>
                      )}

                      <div className="py-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-fg-2">Password</span>
                          {config?.hasPassword && (
                            <span className="text-3xs text-green-400">Set</span>
                          )}
                        </div>
                        {/* The Set button moves INSIDE the field (change 77): this is a
                            field with a single submit action, which is exactly the
                            InputGroup shape. The field also loses its bg-well surface,
                            rounded-sm radius, and gray focus:border-fg-muted. */}
                        <InputGroup size="sm">
                          <InputGroup.Field
                            type="password"
                            placeholder={config?.hasPassword ? 'Change password...' : 'Set password...'}
                            value={newPassword}
                            onChange={(e) => onSetNewPassword(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && onSetPassword()}
                            aria-label="Remote access password"
                            disabled={hostOnly}
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={onSetPassword}
                            disabled={hostOnly || !newPassword.trim() || passwordStatus === 'saving'}
                          >
                            {passwordStatus === 'saved' ? '✓' : passwordStatus === 'saving' ? '...' : 'Set'}
                          </Button>
                        </InputGroup>
                      </div>

                      <div className="py-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-fg-2">Keep awake</span>
                        </div>
                        {/* K3: four short options -> segmented. SegmentedTabs keys
                            on string ids and keepAwakeHours is a number, so both
                            directions convert at the boundary. */}
                        <SegmentedTabs
                          variant="contained"
                          aria-label="Keep awake"
                          value={String(config?.keepAwakeHours ?? 0)}
                          onChange={(id) => onSetKeepAwake(Number(id))}
                          tabs={KEEP_AWAKE_OPTIONS.map((opt) => ({
                            id: String(opt.value),
                            label: opt.label,
                          }))}
                        />
                      </div>
                    </section>

                    {/* Add Device — requires Tailscale running, otherwise tailscale.url is null.
                        Was a soft-blue tinted outline (bg-blue-500/10 + text-blue-400) that matched
                        no variant. Destin's call (spec §11.8 A): plain `secondary`. Unlike the
                        orange billing button, nothing here is a warning — the blue was decorative,
                        not signal. */}
                    {(previewView || (tailscale?.installed && tailscale?.connected && tailscale?.url && config?.hasPassword)) && (
                      <Button
                        disabled={!!previewView && previewView.stage !== 'ready'}
                        onClick={() => onSetShowAddDevice(!showAddDevice)}
                        variant="secondary"
                        className="w-full py-2"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                        Add Device
                      </Button>
                    )}

                    {/* Remote Clients section */}
                    {hasClients && (
                      <section>
                        <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">Devices</h3>

                        <div className="space-y-1">
                          {deviceRows.map(row => (
                            // K6: an item list is a K2 row with a status dot in the icon
                            // slot. One shape for the mockup and the real panel — a preview
                            // that renders differently is not evidence about the app.
                            <SettingRow
                              key={row.id}
                              variant="item"
                              icon={<span className={`w-2 h-2 rounded-full shrink-0 ${row.online ? 'bg-green-500' : 'bg-fg-faint'}`} />}
                              title={row.name}
                              description={revoking === row.id
                                ? 'Unpair this device? It must pair again to reconnect.'
                                : row.online ? 'Online' : 'Offline'}
                              control={revoking === row.id
                                ? <div className="flex gap-1">
                                    <Button variant="ghost" size="sm" onClick={() => setRevoking(null)}>Cancel</Button>
                                    <Button variant="danger-outline" size="sm" onClick={() => { unpair(row.id); setRevoking(null); }}>Confirm unpair</Button>
                                  </div>
                                : <Button variant="ghost" size="sm" aria-label={`Unpair ${row.name}`} onClick={() => setRevoking(row.id)}>Unpair</Button>}
                            />
                          ))}
                        </div>
                      </section>
                    )}

                    {/* Add Device overlay */}
                    {showAddDevice && tailscale?.url && (
                      <section className="bg-inset/50 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-xs font-medium text-fg-2">Add Device</h3>
                          {/* NOT a K6 action — this dismisses the whole
                              sub-panel, so it is a CloseButton, which already
                              carries a label and a focus ring. */}
                          <CloseButton onClick={() => onSetShowAddDevice(false)} label="Close Add Device" />
                        </div>
                        {/* Remind users that Tailscale must be installed + running on the receiving device too */}
                        <Callout tone="warning" title="Before scanning:" className="mb-2">
                          Download Tailscale on your other device, sign in to the same account, and make sure it&apos;s running. The page won&apos;t load without it.
                        </Callout>
                        <p className="text-3xs text-fg-muted mb-2">Then scan QR or copy link to connect:</p>
                        <div className="flex justify-center bg-white rounded-lg p-3 w-fit mx-auto">
                          <QRCodeSVG value={tailscale.url} size={140} />
                        </div>
                        <p className="text-3xs text-fg-muted mt-2 text-center font-mono">{tailscale.url}</p>
                        <Button variant="secondary" onClick={onCopyLink} className="w-full mt-2">
                          {copied ? 'Copied!' : 'Copy Link'}
                        </Button>
                      </section>
                    )}

                    {/* Tailscale section */}
                    <section>
                      <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">Tailscale</h3>

                      {tailscale?.installed ? (
                        // space-y-1 replaces the py-2 each bare row used to carry
                        // its own spacing with — the rows are carded now, so the
                        // gap belongs between them, not inside them.
                        <div className="space-y-1">
                          {/* Distinguish "installed and connected" from "installed but VPN off" —
                              previously detection conflated the two and forced the not-installed branch. */}
                          {/* K2 value rows. Status keeps its green/muted colour —
                              that is state, not chrome — but takes the value
                              slot's size so it lines up with the IP below it
                              instead of sitting a step smaller. */}
                          <SettingRow
                            variant="item"
                            title="Status"
                            value={
                              tailscale.connected ? (
                                <span className="text-green-400">
                                  Connected{tailscale.hostname ? ` · ${tailscale.hostname}` : ''}
                                </span>
                              ) : (
                                <span className="text-fg-muted">VPN not active</span>
                              )
                            }
                          />
                          <SettingRow variant="item" title="IP" value={tailscale.ip ?? '—'} />
                        </div>
                      ) : (
                        <div className="py-2">
                          <p className="text-xs text-fg-muted mb-2">
                            Tailscale is not installed. It creates a secure private network so you can access YouCoded from anywhere.
                          </p>
                          {/* WHY hidden in the preview: the setup banner above already offers
                              Install, and two identical actions in one dialog is the duplicate
                              this review is meant to remove, not reproduce. */}
                          {!previewView && <Button
                            variant="secondary"
                            onClick={onRunSetup}
                            disabled={setupStatus === 'installing' || setupStatus === 'authenticating'}
                          >
                            {setupStatus === 'installing' ? 'Installing...' : setupStatus === 'authenticating' ? 'Authenticating...' : 'Install Tailscale'}
                          </Button>}
                        </div>
                      )}
                    </section>
                  </>
                )}
            </div>
            )}
      </Dialog>
    </>
  );
}

// ─── Tier selector popup ───────────────────────────────────────────────────

/** Same dialog and body as Settings; the candidate provides no real settings callbacks. */
export function RemoteAccessMockPanel({ view, onAction }: { view: RemoteAccessView; onAction: (action: RemoteAccessAction) => void }) {
  const noop = () => {};
  return <RemoteButton mockView={view} mockAction={onAction} config={null} tailscale={null} clients={[]} loading={false} hasActiveSession={false} newPassword="" passwordStatus="idle" copied={false} showSetupQR={false} showAddDevice={false} onSetNewPassword={noop} onSetPassword={noop} onToggleEnabled={noop} enableError="" onSetKeepAwake={noop} onRunSetup={noop} onConfirmSetup={noop} onCancelSetup={noop} setupStatus="idle" setupError="" onUnpairDevice={noop} status={null} onCopyLink={noop} onSetShowSetupQR={noop} onSetShowAddDevice={noop} onReportIssue={noop} />;
}

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
    <>
      {/* Current tier row — title is the static "Package Tier" label, subtitle
          is the current tier's name (was reversed: the tier name used to be
          the title with no static label, the one anti-pattern this component
          shared with pre-redesign Appearance/Remote Access/Buddy Floater). */}
      <SettingRow
        icon={<span className="text-sm leading-none text-fg-dim">⬡</span>}
        title="Package Tier"
        description={currentTier.name}
        onClick={() => setOpen(true)}
      />

      {/* Popup overlay — portaled to document.body so position:fixed centers
          against the viewport, not the SettingsPanel drawer. The drawer (and
          its glass ancestors) establishes a containing block for fixed children
          via transform/backdrop-filter, which is why an inline-rendered popup
          ends up centered inside the panel instead of the viewport. ThemeButton
          above uses the same portal pattern for the same reason. */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Package Tier"
        size="prompt"
        panelRef={popupRef}
      >
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
                        {isActive && <span className="text-4xs font-medium px-1.5 py-0.5 rounded-sm bg-accent text-on-accent">Active</span>}
                      </div>
                      <p className="text-3xs text-fg-muted mt-0.5">{t.desc}</p>
                    </div>
                  </button>
                );
              })}
      </Dialog>
    </>
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
      <SettingRow
        icon={
          <div className="relative flex items-center justify-center">
            <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            {remoteConnected && (
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-green-400 ring-1 ring-panel" />
            )}
          </div>
        }
        title="Connect to Desktop"
        description={subtitle}
        descriptionClassName={remoteConnected ? 'text-green-400' : undefined}
        onClick={() => { setOpen(true); setShowConnectForm(false); }}
      />

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Connect to Desktop"
        size="panel"
        panelRef={popupRef}
      >

              {/* Tailscale warning */}
              {!tailscaleLoading && tailscaleStatus !== null && !tailscaleStatus.connected && (
                <Callout
                  tone="warning"
                  title={
                    // The glyph rides in the title node rather than getting its
                    // own slot: it is the ONLY callout in the app that has one,
                    // so a slot would be a prop that exists for a single caller.
                    <span className="flex items-center gap-2">
                      <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                      Tailscale not connected
                    </span>
                  }
                >
                  Enable Tailscale on this phone before connecting. Both devices must be on the same Tailscale network.
                </Callout>
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
                  <Button
                    variant="secondary"
                    onClick={handleDisconnect}
                    disabled={connecting}
                    className="w-full"
                  >
                    {connecting ? 'Disconnecting...' : 'Disconnect — Return to Local'}
                  </Button>
                </div>
              )}

              {/* Error */}
              {connectError && (
                // Was raw `red-500` around text that already used the destructive
                // TOKEN — the surface and its own body disagreed about which red
                // they were. Change 17 moved the app's reds onto the token so
                // theme packs can restyle them; this one survived that sweep.
                <Callout tone="danger">{connectError}</Callout>
              )}

              {/* Saved devices — always listed */}
              {pairedDevices.length > 0 && (
                <section>
                  <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">Saved Devices</h3>
                  <div className="space-y-1">
                    {pairedDevices.map(device => (
                      // K6. The row was already two controls in a flex box: a
                      // borderless <button> wrapping the name so the whole thing
                      // connects, plus a bare ✕. SettingRow expresses exactly
                      // that — onClick makes the row the hit target and stops the
                      // control's click from bubbling into it, so Remove no
                      // longer risks also firing Connect.
                      <SettingRow
                        key={`${device.host}:${device.port}`}
                        variant="item"
                        title={device.name}
                        description={`${device.host}:${device.port}`}
                        descriptionClassName="text-fg-muted font-mono"
                        onClick={() => doConnect(device)}
                        disabled={connecting || remoteConnected}
                        control={
                          <Button variant="ghost" size="sm" onClick={() => handleRemoveDevice(device)}>
                            Remove
                          </Button>
                        }
                      />
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
                    <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">Add Device</h3>
                  )}
                  {!showConnectForm ? (
                    <div className="space-y-2">
                      {/* Both only had an active: state, so on desktop nothing
                          happened on hover at all. */}
                      <Button onClick={handleScanQr} className="w-full">
                        Scan QR Code
                      </Button>
                      <Button variant="secondary" onClick={() => setShowConnectForm(true)} className="w-full">
                        Enter Manually
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3 bg-inset/50 rounded-lg p-3">
                      {/* All four fields were the same bg-well / rounded-sm /
                          focus:border-fg-muted recipe; they're the shared FIELD surface
                          now (change 20). The Cancel + Save row below stays outside as a
                          form footer — it sits under the whole form, not beside one
                          field, so it is NOT an InputGroup. */}
                      <div>
                        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase block mb-1">Device Name</label>
                        <TextInput
                          size="sm"
                          value={formName}
                          onChange={e => setFormName(e.target.value)}
                          placeholder="My Desktop"
                          aria-label="Device Name"
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase block mb-1">Host / IP</label>
                        <TextInput
                          size="sm"
                          value={formHost}
                          onChange={e => setFormHost(e.target.value)}
                          placeholder="100.x.x.x"
                          aria-label="Host / IP"
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase block mb-1">Port</label>
                        <TextInput
                          size="sm"
                          value={formPort}
                          onChange={e => setFormPort(e.target.value)}
                          placeholder="9900"
                          aria-label="Port"
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase block mb-1">Password</label>
                        <TextInput
                          size="sm"
                          type="password"
                          value={formPassword}
                          onChange={e => setFormPassword(e.target.value)}
                          placeholder="Remote access password"
                          aria-label="Remote access password"
                          className="w-full"
                        />
                      </div>
                      <div className="flex gap-2">
                        {/* Collapses the add-device form rather than closing the
                            panel, so it isn't a redundant text cancel. */}
                        <Button variant="secondary" onClick={() => setShowConnectForm(false)}>
                          Cancel
                        </Button>
                        <Button onClick={handleSaveDevice} disabled={!formHost.trim()} className="flex-1">
                          Save &amp; Connect
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              <p className="text-3xs text-fg-muted">
                Connect to the YouCoded desktop app on your computer. Set up remote access in the desktop app's settings first.
              </p>
      </Dialog>
    </>
  );
}

function AndroidSettings({ open, onSendInput, onRunCommand, onOpenThemeMarketplace, onPublishTheme, syncAutoOpen, onSyncAutoOpenHandled }: { open: boolean; onClose: () => void; onSendInput: (text: string) => void; onRunCommand?: (command: string) => void; onOpenThemeMarketplace?: () => void; onPublishTheme?: (slug: string) => void; syncAutoOpen?: boolean; onSyncAutoOpenHandled?: () => void }) {
  const [loading, setLoading] = useState(true);
  const [tier, setTier] = useState('CORE');
  const [aboutInfo, setAboutInfo] = useState<{ version: string; build: string } | null>(null);
  const [defaults, setDefaults] = useState<AssistantDefaults>({ skipPermissions: false, model: 'sonnet', projectFolder: '' });
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
      claude.defaults?.get?.() ?? { skipPermissions: false, model: 'sonnet', projectFolder: '' },
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
      <div className="flex-1 px-4 py-4 space-y-2">

        {/* Account leads the stack — your identity is the first thing settings should show (Destin, 2026-07-08) */}
        <AccountSection />

        <ThemeButton onSendInput={onSendInput} onRunCommand={onRunCommand} onOpenMarketplace={onOpenThemeMarketplace} onPublishTheme={onPublishTheme} />

        {/* No <BuddyButton /> on Android — the floater relies on an Electron always-on-top window that Android doesn't support yet */}

        <PerformanceButton />

        <SyncSection autoOpen={syncAutoOpen} onAutoOpenHandled={onSyncAutoOpenHandled} />

        {/* Tier & directories are local-only — hide when connected to remote desktop */}
        {!remoteConnected && (
          <>
            <TierSelector tier={tier} onSetTier={handleSetTier} />
          </>
        )}

        <ConnectToDesktopButton />

        {/* Q-6b (2026-09-05): the same Assistant settings row as desktop, with
            the pages the phone can serve today — General. */}
        <AssistantSettingsRow platform="android" defaults={defaults} onDefaultsChange={handleDefaultsChange} />

        {/* Development — bug reports, contributions, known issues */}
        <SettingRow
          icon={
            // {YC} — curly braces with YC monogram in Cascadia Mono (matches
            // the "Development" label's font size).
            <svg className="w-6 h-4 text-fg-muted" viewBox="0 0 32 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 4 C 3 4 3 7 3 9 C 3 11 2 12 1 12 C 2 12 3 13 3 15 C 3 17 3 20 5 20" />
              <path d="M27 4 C 29 4 29 7 29 9 C 29 11 30 12 31 12 C 30 12 29 13 29 15 C 29 17 29 20 27 20" />
              <text x="16" y="17" textAnchor="middle" fontFamily="'Cascadia Code', 'Cascadia Mono', Consolas, monospace" fontSize="16" fontWeight="500" fill="currentColor" stroke="none">YC</text>
            </svg>
          }
          title="Development"
          description="Report a bug, contribute, or browse known issues"
          onClick={() => setShowDevMenu(true)}
        />
        <DevelopmentPopup
          open={showDevMenu}
          onClose={() => setShowDevMenu(false)}
          onOpenBug={() => { setShowDevMenu(false); setShowBugReport(true); }}
          onOpenContribute={() => { setShowDevMenu(false); setShowContribute(true); }}
        />
        <BugReportPopup open={showBugReport} onClose={() => setShowBugReport(false)} />
        <ContributePopup open={showContribute} onClose={() => setShowContribute(false)} />

        {/* Keyboard shortcuts intentionally omitted on Android — no physical keyboard. */}

        <SettingRow
          icon={
            <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z" />
            </svg>
          }
          title="Donate"
          description="Support YouCoded development"
          onClick={() => setShowDonateConfirm(true)}
        />

        <DonateConfirm open={showDonateConfirm} onClose={() => setShowDonateConfirm(false)} />

        {aboutInfo && (
          <>
            <SettingRow
              icon={
                <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              }
              title="About"
              description={formatVersionLine({ version: aboutInfo.version, build: aboutInfo.build })}
              onClick={() => setShowAbout(true)}
            />
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
    </>
  );
}

// ─── Desktop Settings (existing, unchanged) ─────────────────────────────────

function DesktopSettings({ open, onSendInput, onRunCommand, hasActiveSession, activeSessionCwd, onOpenThemeMarketplace, onPublishTheme, onOpenClaudePreferences, syncAutoOpen, onSyncAutoOpenHandled, providersAutoOpen, onProvidersAutoOpenHandled }: {
  open: boolean;
  onClose: () => void;
  onSendInput: (text: string) => void;
  onRunCommand?: (command: string) => void;
  hasActiveSession: boolean;
  // Task 10: threaded to SpecialistsButton → SpecialistsSection.
  activeSessionCwd?: string;
  onOpenThemeMarketplace?: () => void;
  onPublishTheme?: (slug: string) => void;
  // Opens Claude Code's preferences popup (/config). Consumed by the Model
  // Providers popup's Claude Code section. Desktop-only.
  onOpenClaudePreferences?: () => void;
  syncAutoOpen?: boolean;
  onSyncAutoOpenHandled?: () => void;
  // Deep-link the Model Providers popup open (provider-error bubble jump).
  providersAutoOpen?: boolean;
  onProvidersAutoOpenHandled?: () => void;
}) {
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleInfo | null>(null);
  const [clients, setClients] = useState<RemoteDeviceRow[]>([]);
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatus | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [passwordStatus, setPasswordStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [loading, setLoading] = useState(true);
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [showSetupQR, setShowSetupQR] = useState(false);
  const [copied, setCopied] = useState(false);
  const [defaults, setDefaults] = useState<AssistantDefaults>({ skipPermissions: false, model: 'sonnet', projectFolder: '' });
  const [setupStatus, setSetupStatus] = useState<'idle' | 'confirm' | 'installing' | 'authenticating' | 'done' | 'error'>('idle');
  const [setupError, setSetupError] = useState('');
  // Populated when IPC.REMOTE_SET_CONFIG reports the server failed to bind.
  const [enableError, setEnableError] = useState('');
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
      claude.remote.devices?.list?.() ?? [],
      claude.remote.getStatus?.() ?? null,
      claude.defaults?.get?.() ?? { skipPermissions: false, model: 'sonnet', projectFolder: '' },
    ]).then(([cfg, ts, cls, st, defs]: [RemoteConfig, TailscaleInfo, RemoteDeviceRow[], RemoteStatus | null, any]) => {
      setConfig(cfg);
      setTailscale(ts);
      setClients(cls);
      setRemoteStatus(st);
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
    setEnableError('');
    const updated = await (window as any).claude.remote.setConfig({ enabled: !config.enabled });
    // Main rolls `enabled` back to false when the server can't bind and returns
    // the OS error; spreading `updated` therefore also un-sticks the toggle.
    if (updated?.error) setEnableError(String(updated.error));
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

  useEffect(() => {
    // WHY subscribe as well as fetch: a bind failure happens once, seconds after launch.
    // Fetching alone shows it only if the panel happened to be open at that moment.
    const off = (window as any).claude?.remote?.onStatus?.((st: RemoteStatus) => setRemoteStatus(st));
    return () => { if (typeof off === 'function') off(); };
  }, []);

  const handleUnpairDevice = useCallback(async (deviceId: string) => {
    // WHY the row goes even when the device is offline: unpairing is a change to the
    // record, not to a connection. Disconnect used to be the only option and left the
    // credential valid, so the device came straight back.
    await (window as any).claude.remote.devices.unpair(deviceId);
    setClients(prev => prev.filter(c => c.id !== deviceId));
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
      <div className="flex-1 px-4 py-4 space-y-2">

        {/* Account leads the stack — your identity is the first thing settings should show (Destin, 2026-07-08).
            GitHub (and future providers) live INSIDE it on the Connected
            accounts page — a sibling GitHub row read as a second, contradictory
            sign-in (Destin feedback, 2026-07-22). */}
        <AccountSection />

        <ThemeButton onSendInput={onSendInput} onRunCommand={onRunCommand} onOpenMarketplace={onOpenThemeMarketplace} onPublishTheme={onPublishTheme} />

        <BuddyButton />

        <SoundButton />

        <PerformanceButton />

        <SyncSection autoOpen={syncAutoOpen} onAutoOpenHandled={onSyncAutoOpenHandled} />

        {/* Assistant settings (2026-09-05): ONE row where Model Providers,
            Defaults, Permissions and Specialists were four. The deep link that
            used to open Model Providers now opens this panel on its first
            provider page. Provider pages self-gate on native.supported, so over
            remote access the panel still shows General, Permissions and
            Specialists — the three that never had the gate. */}
        <AssistantSettingsRow
          defaults={defaults}
          onDefaultsChange={handleDefaultsChange}
          cwd={activeSessionCwd}
          onOpenClaudePreferences={onOpenClaudePreferences}
          autoOpen={providersAutoOpen}
          autoOpenPage="cloud"
          onAutoOpenHandled={onProvidersAutoOpenHandled}
        />

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
          enableError={enableError}
          onSetKeepAwake={handleSetKeepAwake}
          onRunSetup={handleRunSetup}
          onConfirmSetup={handleConfirmSetup}
          onCancelSetup={handleCancelSetup}
          setupStatus={setupStatus}
          setupError={setupError}
          onUnpairDevice={handleUnpairDevice}
          status={remoteStatus}
          onCopyLink={handleCopyLink}
          onSetShowSetupQR={setShowSetupQR}
          onSetShowAddDevice={setShowAddDevice}
          onReportIssue={() => setShowBugReport(true)}
        />




        {/* Development — bug reports, contributions, known issues */}
        <SettingRow
          icon={
            // {YC} — curly braces with YC monogram in Cascadia Mono (matches
            // the "Development" label's font size).
            <svg className="w-6 h-4 text-fg-muted" viewBox="0 0 32 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 4 C 3 4 3 7 3 9 C 3 11 2 12 1 12 C 2 12 3 13 3 15 C 3 17 3 20 5 20" />
              <path d="M27 4 C 29 4 29 7 29 9 C 29 11 30 12 31 12 C 30 12 29 13 29 15 C 29 17 29 20 27 20" />
              <text x="16" y="17" textAnchor="middle" fontFamily="'Cascadia Code', 'Cascadia Mono', Consolas, monospace" fontSize="16" fontWeight="500" fill="currentColor" stroke="none">YC</text>
            </svg>
          }
          title="Development"
          description="Report a bug, contribute, or browse known issues"
          onClick={() => setShowDevMenu(true)}
        />
        <DevelopmentPopup
          open={showDevMenu}
          onClose={() => setShowDevMenu(false)}
          onOpenBug={() => { setShowDevMenu(false); setShowBugReport(true); }}
          onOpenContribute={() => { setShowDevMenu(false); setShowContribute(true); }}
        />
        <BugReportPopup open={showBugReport} onClose={() => setShowBugReport(false)} />
        <ContributePopup open={showContribute} onClose={() => setShowContribute(false)} />

        {/* Keyboard Shortcuts */}
        <SettingRow
          icon={
            <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h8" />
            </svg>
          }
          title="Keyboard Shortcuts"
          description="View all hotkeys"
          onClick={() => setShowShortcuts(true)}
        />
        <ShortcutsPopup open={showShortcuts} onClose={() => setShowShortcuts(false)} />

        <SettingRow
          icon={
            <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z" />
            </svg>
          }
          title="Donate"
          description="Support YouCoded development"
          onClick={() => setShowDonateConfirm(true)}
        />

        <DonateConfirm open={showDonateConfirm} onClose={() => setShowDonateConfirm(false)} />

        {/* About — popup on click, styled like other settings popups */}
        <SettingRow
          icon={
            <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          }
          title="About"
          description={formatVersionLine({ version: desktopVersion, channel: desktopChannel })}
          onClick={() => setShowAbout(true)}
        />
        <AboutPopup
          open={showAbout}
          onClose={() => setShowAbout(false)}
          platform="desktop"
          version={desktopVersion}
          channel={desktopChannel}
        />
      </div>
    </>
  );
}

