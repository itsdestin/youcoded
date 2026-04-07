declare const __APP_VERSION__: string;
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { isAndroid } from '../platform';
import ThemeScreen from './ThemeScreen';
import { useTheme } from '../state/theme-context';
import { MODELS, type ModelAlias } from './StatusBar';

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
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export default function SettingsPanel({ open, onClose, onSendInput, hasActiveSession, onOpenThemeMarketplace, onPublishTheme }: Props) {
  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        className={`fixed top-0 left-0 h-full w-80 bg-panel border-r border-edge-dim z-50 transform transition-transform duration-300 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
            <h2 className="text-sm font-bold text-fg">Settings</h2>
            <button
              onClick={onClose}
              className="text-fg-muted hover:text-fg-2 text-lg leading-none"
            >
              ✕
            </button>
          </div>

          {isAndroid() ? (
            <AndroidSettings open={open} onClose={onClose} onSendInput={onSendInput} onOpenThemeMarketplace={onOpenThemeMarketplace} onPublishTheme={onPublishTheme} />
          ) : (
            <DesktopSettings
              open={open}
              onClose={onClose}
              onSendInput={onSendInput}
              hasActiveSession={hasActiveSession}
              onOpenThemeMarketplace={onOpenThemeMarketplace}
              onPublishTheme={onPublishTheme}
            />
          )}
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


// ─── Sound settings ───────────────────────────────────────────────────────

const SOUND_MUTED_KEY = 'destincode-sound-muted';
const SOUND_VOLUME_KEY = 'destincode-sound-volume';

function SoundSettings() {
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem(SOUND_MUTED_KEY) === '1'; } catch { return false; }
  });
  const [volume, setVolume] = useState(() => {
    try {
      const v = parseFloat(localStorage.getItem(SOUND_VOLUME_KEY) || '0.3');
      return isNaN(v) ? 0.3 : Math.max(0, Math.min(1, v));
    } catch { return 0.3; }
  });

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

  const handleTestSound = useCallback(() => {
    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      [523.25, 659.25].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(ctx.currentTime + i * 0.12);
        osc.stop(ctx.currentTime + i * 0.12 + 0.3);
      });
      setTimeout(() => ctx.close(), 1000);
    } catch {}
  }, [volume]);

  return (
    <section>
      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Sound</h3>
      <div className="space-y-3 px-3 py-3 rounded-lg bg-inset/50">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-fg font-medium">Completion Sound</span>
            <p className="text-[10px] text-fg-muted">Play a chime when Claude finishes</p>
          </div>
          <Toggle enabled={!muted} onToggle={handleToggleMute} />
        </div>

        {!muted && (
          <>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-fg-muted w-10 shrink-0">Volume</span>
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
            <button
              onClick={handleTestSound}
              className="text-[10px] text-accent hover:underline"
            >
              Test Sound
            </button>
          </>
        )}
      </div>
    </section>
  );
}

// ─── Tier selector popup (Android) ────────────────────────────────────────

// ─── Theme popup button ────────────────────────────────────────────────────

/** Compact "Appearance" row — opens ThemeScreen in a centered popup modal */
function ThemeButton({ onSendInput, onOpenMarketplace, onPublishTheme }: { onSendInput?: (text: string) => void; onOpenMarketplace?: () => void; onPublishTheme?: (slug: string) => void }) {
  const { activeTheme, font } = useTheme();
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  const fontName = font.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
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
          <span className="text-[10px] text-fg-muted ml-2">{fontName}</span>
        </div>
        <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {open && createPortal(
        <>
          <div className="fixed inset-0 bg-black/30 z-[60]" onClick={() => setOpen(false)} />
          <div
            ref={popupRef}
            className="fixed z-[61] rounded-xl bg-panel border border-edge shadow-2xl overflow-hidden"
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
  onDisconnectClient: (id: string) => void;
  onCopyLink: () => void;
  onSetShowSetupQR: (v: boolean) => void;
  onSetShowAddDevice: (v: boolean) => void;
}

function RemoteButton({
  config, tailscale, clients, loading, hasActiveSession,
  newPassword, passwordStatus, copied, showSetupQR, showAddDevice,
  onSetNewPassword, onSetPassword, onToggleEnabled, onToggleTailscaleTrust,
  onSetKeepAwake, onRunSetup, onDisconnectClient, onCopyLink,
  onSetShowSetupQR, onSetShowAddDevice,
}: RemoteButtonProps) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const hasClients = clients.length > 0;
  const statusText = loading
    ? 'Loading...'
    : !config?.enabled
      ? 'Disabled'
      : hasClients
        ? `${clients.length} client${clients.length > 1 ? 's' : ''} connected`
        : 'Enabled · No clients';

  return (
    <section>
      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Remote Access</h3>

      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
      >
        {/* Status indicator dot */}
        <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
          <div className={`w-2.5 h-2.5 rounded-full ${
            !config?.enabled ? 'bg-fg-muted/40' : hasClients ? 'bg-green-500' : 'bg-amber-500'
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
          <div className="fixed inset-0 bg-black/30 z-[60]" onClick={() => setOpen(false)} />
          <div
            ref={popupRef}
            className="fixed z-[61] rounded-xl bg-panel border border-edge shadow-2xl overflow-hidden"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'min(480px, 88vw)',
              height: 'min(600px, 80vh)',
            }}
          >
            <div className="flex flex-col h-full">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
                <h2 className="text-sm font-bold text-fg">Remote Access</h2>
                <button onClick={() => setOpen(false)} className="text-fg-muted hover:text-fg-2 text-lg leading-none">✕</button>
              </div>

              {/* Scrollable content */}
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
                {loading ? (
                  <div className="flex items-center justify-center py-8 text-fg-muted text-sm">Loading...</div>
                ) : (
                  <>
                    {/* Setup banner — shown when no clients connected */}
                    {!hasClients && (
                      <div className="bg-blue-500/10 border border-blue-500/25 rounded-lg p-3">
                        <p className="text-xs text-blue-400 mb-2">
                          Remote access lets you use DestinCode from any device — phone, tablet, or another computer.
                        </p>

                        {tailscale?.installed && tailscale.url && config?.hasPassword ? (
                          showSetupQR ? (
                            <div className="mt-2">
                              <p className="text-[10px] text-fg-muted mb-2">Scan to connect a device:</p>
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
                            <button
                              onClick={() => onSetShowSetupQR(true)}
                              className="w-full px-3 py-1.5 rounded-sm bg-blue-600 hover:bg-blue-500 text-xs font-medium"
                            >
                              Set Up Remote Access
                            </button>
                          )
                        ) : (
                          <>
                            <button
                              onClick={onRunSetup}
                              disabled={!hasActiveSession}
                              className="w-full px-3 py-1.5 rounded-sm bg-blue-600 hover:bg-blue-500 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                              title={!hasActiveSession ? 'Create a session first' : ''}
                            >
                              Set Up Remote Access
                            </button>
                            {!hasActiveSession && (
                              <p className="text-[10px] text-fg-muted mt-1 text-center">Create a session first to run setup</p>
                            )}
                          </>
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

                    {/* Remote Clients section */}
                    {hasClients && (
                      <section>
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase">Clients</h3>
                          <button
                            onClick={() => onSetShowAddDevice(true)}
                            className="text-[10px] text-blue-400 hover:text-blue-300"
                          >
                            + Add Device
                          </button>
                        </div>

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
                        <p className="text-[10px] text-fg-muted mb-2">Scan QR or copy link to connect a new device:</p>
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
                          <div className="py-2 flex items-center justify-between">
                            <span className="text-xs text-fg-2">Status</span>
                            <span className="text-[10px] text-green-400">
                              Connected{tailscale.hostname ? ` · ${tailscale.hostname}` : ''}
                            </span>
                          </div>

                          <div className="py-2 flex items-center justify-between">
                            <span className="text-xs text-fg-2">IP</span>
                            <span className="text-xs text-fg-dim font-mono">{tailscale.ip}</span>
                          </div>

                          <label className="flex items-center justify-between py-2 cursor-pointer">
                            <span className="text-xs text-fg-2">Skip password on Tailscale</span>
                            <Toggle enabled={!!config?.trustTailscale} onToggle={onToggleTailscaleTrust} />
                          </label>
                        </>
                      ) : (
                        <div className="py-2">
                          <p className="text-xs text-fg-muted mb-2">
                            Tailscale is not installed. It creates a secure private network so you can access DestinCode from anywhere.
                          </p>
                          <button
                            onClick={onRunSetup}
                            disabled={!hasActiveSession}
                            className="px-3 py-1.5 rounded-sm bg-inset hover:bg-edge text-xs disabled:opacity-50"
                          >
                            Install with Setup Skill
                          </button>
                        </div>
                      )}
                    </section>
                  </>
                )}
              </div>
            </div>
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

interface DefaultsButtonProps {
  defaults: { skipPermissions: boolean; model: string; projectFolder: string };
  onDefaultsChange: (updates: Partial<{ skipPermissions: boolean; model: string; projectFolder: string }>) => void;
}

function DefaultsButton({ defaults, onDefaultsChange }: DefaultsButtonProps) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

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
          <div className="fixed inset-0 bg-black/30 z-[60]" onClick={() => setOpen(false)} />
          <div
            ref={popupRef}
            className="fixed z-[61] rounded-xl bg-panel border border-edge shadow-2xl overflow-hidden"
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

              <div className="px-4 py-4 space-y-5 overflow-y-auto">
                {/* Default Model */}
                <section>
                  <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Default Model</h3>
                  <div className="flex gap-1">
                    {MODELS.map((m) => (
                      <button
                        key={m}
                        onClick={() => onDefaultsChange({ model: m })}
                        className={`flex-1 px-1.5 py-1.5 rounded-sm text-[11px] transition-colors ${
                          defaults.model === m
                            ? 'bg-accent text-on-accent font-medium'
                            : 'bg-inset text-fg-dim hover:bg-edge'
                        }`}
                      >
                        {MODEL_LABELS[m] || m}
                      </button>
                    ))}
                  </div>
                </section>

                {/* Skip Permissions */}
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
                    <p className="text-[10px] text-[#DD4444] mt-1.5">Claude will execute tools without asking for approval.</p>
                  )}
                </section>

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

const TIER_OPTIONS = [
  { id: 'CORE', name: 'Core', desc: 'Personal assistant — journal, inbox, briefings' },
  { id: 'DEVELOPER', name: 'Developer', desc: 'Core + git, tests, code review' },
  { id: 'FULL_DEV', name: 'Full Dev', desc: 'Everything — all dev tools included' },
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

      {/* Popup overlay */}
      {open && (
        <>
          <div className="fixed inset-0 bg-black/30 z-[60]" onClick={() => setOpen(false)} />
          <div
            ref={popupRef}
            className="fixed z-[61] rounded-xl bg-panel border border-edge shadow-2xl overflow-hidden"
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

            <div className="p-3 space-y-2 overflow-y-auto" style={{ maxHeight: 'calc(80vh - 52px)' }}>
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
        </>
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

function AndroidSettings({ open, onClose, onSendInput, onOpenThemeMarketplace, onPublishTheme }: { open: boolean; onClose: () => void; onSendInput: (text: string) => void; onOpenThemeMarketplace?: () => void; onPublishTheme?: (slug: string) => void }) {
  const [loading, setLoading] = useState(true);
  const [tier, setTier] = useState('CORE');
  const [directories, setDirectories] = useState<{ label: string; path: string }[]>([]);
  const [aboutInfo, setAboutInfo] = useState<{ version: string; build: string } | null>(null);
  const [defaults, setDefaults] = useState({ skipPermissions: false, model: 'sonnet', projectFolder: '' });
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [showConnectForm, setShowConnectForm] = useState(false);
  const [formName, setFormName] = useState('Desktop');
  const [formHost, setFormHost] = useState('');
  const [formPort, setFormPort] = useState('9900');
  const [formPassword, setFormPassword] = useState('');
  const [remoteConnected, setRemoteConnected] = useState(false);
  const [connectedDeviceName, setConnectedDeviceName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

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
    setShowConnectForm(false);
    Promise.all([
      claude.android?.getTier?.() ?? 'CORE',
      claude.android?.getDirectories?.() ?? [],
      claude.android?.getAbout?.() ?? { version: 'unknown', build: '' },
      claude.android?.getPairedDevices?.() ?? [],
      claude.defaults?.get?.() ?? { skipPermissions: false, model: 'sonnet', projectFolder: '' },
    ]).then(([t, dirs, about, devices, defs]) => {
      setTier(t?.tier || t || 'CORE');
      setDirectories(dirs?.directories || dirs || []);
      setAboutInfo(about);
      setPairedDevices(devices?.devices || devices || []);
      setDefaults(defs);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [open]);

  const handleSetTier = useCallback(async (newTier: string) => {
    const result = await claude.android?.setTier?.(newTier);
    setTier(newTier);
    if (result?.restartRequired) {
      // The bridge handles restart prompt natively
    }
  }, []);

  const handleRemoveDirectory = useCallback(async (path: string) => {
    await claude.android?.removeDirectory?.(path);
    setDirectories(prev => prev.filter(d => d.path !== path));
  }, []);

  const doConnect = useCallback(async (device: PairedDevice) => {
    setConnecting(true);
    setConnectError(null);
    try {
      const { connectToHost } = await import('../remote-shim');
      await connectToHost(device.host, device.port, device.password);
      setConnectedDeviceName(device.name);
      onClose();
    } catch (err: any) {
      setConnectError(err?.message || 'Connection failed');
    } finally {
      setConnecting(false);
    }
  }, [onClose]);

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
    // Connect immediately after saving
    await doConnect(device);
  }, [formName, formHost, formPort, formPassword, doConnect]);

  const handleRemoveDevice = useCallback(async (device: PairedDevice) => {
    await claude.android?.removePairedDevice?.(device.host, device.port);
    setPairedDevices(prev => prev.filter(d => d.host !== device.host || d.port !== device.port));
  }, []);

  const handleConnectToDesktop = useCallback(async (device: PairedDevice) => {
    await doConnect(device);
  }, [doConnect]);

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

        {/* Tier & directories are local-only — hide when connected to remote desktop */}
        {!remoteConnected && (
          <>
            <TierSelector tier={tier} onSetTier={handleSetTier} />

            {/* Project Directories */}
            <section>
              <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Project Directories</h3>
              {directories.length > 0 ? (
                <div className="space-y-1">
                  {directories.map(dir => (
                    <div key={dir.path} className="flex items-center justify-between py-1.5 px-2 rounded-sm bg-inset/50">
                      <div className="min-w-0 flex-1">
                        <span className="text-xs text-fg-2 block truncate">{dir.label}</span>
                        <span className="text-[10px] text-fg-faint block truncate font-mono">{dir.path}</span>
                      </div>
                      <button
                        onClick={() => handleRemoveDirectory(dir.path)}
                        className="text-fg-faint hover:text-red-400 text-sm leading-none px-1 shrink-0 ml-2"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-fg-faint">No custom directories. Home (~) is always available.</p>
              )}
            </section>
          </>
        )}

        {/* Connect to Desktop */}
        <section>
          <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Connect to Desktop</h3>

          {/* Connection status banner */}
          {remoteConnected && (
            <div className="bg-green-500/10 border border-green-500/25 rounded-lg p-3 mb-3">
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

          {connectError && (
            <div className="bg-red-500/10 border border-red-500/25 rounded-lg p-2 mb-3">
              <p className="text-[10px] text-red-400">{connectError}</p>
            </div>
          )}

          {/* Paired devices — hidden when connected to remote */}
          {!remoteConnected && pairedDevices.length > 0 && (
            <div className="space-y-1 mb-3">
              {pairedDevices.map(device => (
                <div key={`${device.host}:${device.port}`} className="flex items-center justify-between py-2 px-3 rounded-sm bg-inset/50">
                  <button
                    onClick={() => handleConnectToDesktop(device)}
                    disabled={connecting}
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
          )}

          {connecting && (
            <div className="text-center py-3">
              <span className="text-xs text-fg-dim">Connecting...</span>
            </div>
          )}

          {!remoteConnected && !connecting && !showConnectForm ? (
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

          <p className="text-[10px] text-fg-faint mt-3">
            Connect to the DestinCode desktop app on your computer. Set up remote access in the desktop app's settings first.
          </p>
        </section>

        {/* Other */}
        <section>
          <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Other</h3>
          <div className="space-y-2">
            <DefaultsButton defaults={defaults} onDefaultsChange={handleDefaultsChange} />

            <a
              href="https://buymeacoffee.com/itsdestin"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
            >
              <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
                <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z" />
                  </svg>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs text-fg font-medium">Donate</span>
                <p className="text-[10px] text-fg-muted">Support DestinCode development</p>
              </div>
              <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </a>

            {aboutInfo && (
              <div className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 text-left">
                <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
                  <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-fg font-medium">About</span>
                  <p className="text-[10px] text-fg-muted">DestinCode {aboutInfo.version}{aboutInfo.build ? ` · ${aboutInfo.build}` : ''}</p>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

// ─── Desktop Settings (existing, unchanged) ─────────────────────────────────

function DesktopSettings({ open, onClose, onSendInput, hasActiveSession, onOpenThemeMarketplace, onPublishTheme }: {
  open: boolean;
  onClose: () => void;
  onSendInput: (text: string) => void;
  hasActiveSession: boolean;
  onOpenThemeMarketplace?: () => void;
  onPublishTheme?: (slug: string) => void;
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
  const [defaults, setDefaults] = useState({ skipPermissions: false, model: 'sonnet', projectFolder: '' });

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setShowAddDevice(false);
    setShowSetupQR(false);
    const claude = (window as any).claude;
    if (!claude?.remote) { setLoading(false); return; }
    Promise.all([
      claude.remote.getConfig(),
      claude.remote.detectTailscale(),
      claude.remote.getClientList(),
      claude.defaults?.get?.() ?? { skipPermissions: false, model: 'sonnet', projectFolder: '' },
    ]).then(([cfg, ts, cls, defs]: [RemoteConfig, TailscaleInfo, ClientInfo[], any]) => {
      setConfig(cfg);
      setTailscale(ts);
      setClients(cls);
      setDefaults(defs);
      setLoading(false);
    }).catch(() => setLoading(false));
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
    if (!hasActiveSession) return;
    onSendInput('/remote-setup');
    onClose();
  }, [hasActiveSession, onSendInput, onClose]);

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

        <SoundSettings />

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

            <a
              href="https://buymeacoffee.com/itsdestin"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
            >
              <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
                <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z" />
                  </svg>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs text-fg font-medium">Donate</span>
                <p className="text-[10px] text-fg-muted">Support DestinCode development</p>
              </div>
              <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </a>

            <div className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 text-left">
              <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
                <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs text-fg font-medium">About</span>
                <p className="text-[10px] text-fg-muted">DestinCode {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''}</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
