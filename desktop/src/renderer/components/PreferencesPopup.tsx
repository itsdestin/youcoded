import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from './overlays/Overlay';

// Native replacement for Claude Code's /config TUI. Reads/writes fields in
// ~/.claude/settings.json via the settings:* IPC bridge.
// Opens from:
//   • Typing /config in chat view (SlashCommandDispatcher)
//   • "Claude Code Preferences" button in SettingsPanel
// In terminal view, /config passes through to the PTY instead (see dispatcher).
//
// Scope: the most-used ~5 options. "Advanced" button at the bottom switches
// to terminal view and sends /config to open Claude Code's full native TUI
// for anything not covered here.

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenAdvanced: () => void; // Switches to terminal view and sends /config to PTY
}

type PermissionDefault = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
type EditorMode = 'normal' | 'vim';

// Fields stored in ~/.claude/settings.json. Field names match Claude Code's schema.
interface PrefsState {
  defaultMode: PermissionDefault;
  editorMode: EditorMode;
  showTurnDuration: boolean;
  preferReducedMotion: boolean;
  outputStyle: string;        // Claude Code supports arbitrary strings here
  systemPrompt: string;       // Multiline — appended to all sessions
}

const DEFAULTS: PrefsState = {
  defaultMode: 'default',
  editorMode: 'normal',
  showTurnDuration: true,
  preferReducedMotion: false,
  outputStyle: '',
  systemPrompt: '',
};

const PERMISSION_LABELS: Record<PermissionDefault, { label: string; desc: string }> = {
  default: { label: 'Default', desc: 'Ask before each tool use' },
  acceptEdits: { label: 'Accept Edits', desc: 'Auto-approve file edits' },
  plan: { label: 'Plan', desc: 'Plan-only mode, no execution' },
  bypassPermissions: { label: 'Bypass', desc: 'Skip all permission prompts (risky)' },
};

export default function PreferencesPopup({ open, onClose, onOpenAdvanced }: Props) {
  const [prefs, setPrefs] = useState<PrefsState>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  // Load all fields in parallel when opening. Fields missing from settings.json
  // return undefined; we fall back to DEFAULTS so the UI always has values.
  useEffect(() => {
    if (!open) return;
    setLoaded(false);
    const api = (window.claude as any).settings;
    if (!api) {
      setPrefs(DEFAULTS);
      setLoaded(true);
      return;
    }
    Promise.all([
      api.get('permissions.defaultMode'),
      api.get('editorMode'),
      api.get('showTurnDuration'),
      api.get('preferReducedMotion'),
      api.get('outputStyle'),
      api.get('systemPrompt'),
    ]).then(([defaultMode, editorMode, showTurnDuration, preferReducedMotion, outputStyle, systemPrompt]) => {
      setPrefs({
        defaultMode: (defaultMode as PermissionDefault) ?? DEFAULTS.defaultMode,
        editorMode: (editorMode as EditorMode) ?? DEFAULTS.editorMode,
        showTurnDuration: typeof showTurnDuration === 'boolean' ? showTurnDuration : DEFAULTS.showTurnDuration,
        preferReducedMotion: typeof preferReducedMotion === 'boolean' ? preferReducedMotion : DEFAULTS.preferReducedMotion,
        outputStyle: (outputStyle as string) ?? DEFAULTS.outputStyle,
        systemPrompt: (systemPrompt as string) ?? DEFAULTS.systemPrompt,
      });
      setLoaded(true);
    }).catch(() => {
      setPrefs(DEFAULTS);
      setLoaded(true);
    });
  }, [open]);

  // Write-through: every change is persisted immediately. No "save" button —
  // matches Claude Code's own /config TUI behavior.
  const save = useCallback(<K extends keyof PrefsState>(key: K, value: PrefsState[K]) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    const api = (window.claude as any).settings;
    if (!api) return;
    const fieldMap: Record<keyof PrefsState, string> = {
      defaultMode: 'permissions.defaultMode',
      editorMode: 'editorMode',
      showTurnDuration: 'showTurnDuration',
      preferReducedMotion: 'preferReducedMotion',
      outputStyle: 'outputStyle',
      systemPrompt: 'systemPrompt',
    };
    // Writes don't need to await — UI is already updated optimistically.
    // If write fails, next open will reload from disk and correct UI drift.
    api.set(fieldMap[key], value).catch(() => {});
  }, []);

  if (!open) return null;

  return createPortal(
    // Overlay layer L2 via <Scrim>/<OverlayPanel>; scrim, blur, shadow all
    // driven by theme tokens — previously hardcoded bg-black/40.
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-md w-[calc(100%-2rem)] max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-panel border-b border-edge flex items-center justify-between px-5 py-3 z-10">
          <h3 className="text-sm font-semibold text-fg">Claude Code Preferences</h3>
          <button onClick={onClose} className="text-fg-muted hover:text-fg transition-colors w-7 h-7 flex items-center justify-center rounded-sm hover:bg-inset">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {!loaded ? (
          <div className="p-8 text-center text-sm text-fg-muted">Loading…</div>
        ) : (
          <div className="p-5 space-y-5">
            {/* Permission default */}
            <section>
              <label className="block text-xs font-medium text-fg-muted tracking-wider uppercase mb-2">
                Default Permission Mode
              </label>
              <div className="space-y-1.5">
                {(Object.keys(PERMISSION_LABELS) as PermissionDefault[]).map((mode) => (
                  <label key={mode} className="flex items-start gap-3 p-2 rounded hover:bg-inset cursor-pointer">
                    <input
                      type="radio"
                      name="defaultMode"
                      className="mt-0.5"
                      checked={prefs.defaultMode === mode}
                      onChange={() => save('defaultMode', mode)}
                    />
                    <div>
                      <div className="text-sm text-fg">{PERMISSION_LABELS[mode].label}</div>
                      <div className="text-xs text-fg-muted">{PERMISSION_LABELS[mode].desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </section>

            {/* Editor mode */}
            <section>
              <label className="block text-xs font-medium text-fg-muted tracking-wider uppercase mb-2">
                Editor Mode
              </label>
              <div className="flex gap-2">
                {(['normal', 'vim'] as EditorMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => save('editorMode', m)}
                    className={`flex-1 py-1.5 px-3 text-sm rounded transition-colors ${
                      prefs.editorMode === m
                        ? 'bg-accent text-on-accent'
                        : 'bg-inset text-fg-2 hover:bg-well'
                    }`}
                  >
                    {m === 'normal' ? 'Normal' : 'Vim'}
                  </button>
                ))}
              </div>
            </section>

            {/* Output style */}
            <section>
              <label className="block text-xs font-medium text-fg-muted tracking-wider uppercase mb-2">
                Output Style
              </label>
              <input
                type="text"
                value={prefs.outputStyle}
                onChange={(e) => save('outputStyle', e.target.value)}
                placeholder="e.g. concise, explanatory"
                className="w-full bg-inset border border-edge-dim rounded px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent"
              />
              <p className="text-[11px] text-fg-muted mt-1.5">Preset name that tunes Claude's response style. Leave blank for default.</p>
            </section>

            {/* Toggles */}
            <section className="space-y-2">
              <ToggleRow
                label="Show turn duration"
                desc={'Displays "Cooked for Xs" after each response'}
                checked={prefs.showTurnDuration}
                onChange={(v) => save('showTurnDuration', v)}
              />
              <ToggleRow
                label="Reduced motion"
                desc="Minimizes animations for accessibility"
                checked={prefs.preferReducedMotion}
                onChange={(v) => save('preferReducedMotion', v)}
              />
            </section>

            {/* System prompt */}
            <section>
              <label className="block text-xs font-medium text-fg-muted tracking-wider uppercase mb-2">
                System Prompt
              </label>
              <textarea
                value={prefs.systemPrompt}
                onChange={(e) => save('systemPrompt', e.target.value)}
                placeholder="Instructions appended to every session..."
                rows={4}
                className="w-full bg-inset border border-edge-dim rounded px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent resize-none"
              />
              <p className="text-[11px] text-fg-muted mt-1.5">Applied globally. Leave blank to use Claude Code defaults.</p>
            </section>

            {/* Advanced escape hatch — opens Claude Code's native TUI for any option not covered here */}
            <section className="pt-3 border-t border-edge-dim">
              <button
                onClick={() => {
                  onClose();
                  onOpenAdvanced();
                }}
                className="w-full py-2 px-3 text-sm bg-inset text-fg-2 hover:bg-well border border-edge-dim rounded transition-colors"
              >
                Advanced (terminal) →
              </button>
              <p className="text-[11px] text-fg-muted mt-1.5 text-center">
                Switches to terminal view and runs Claude Code's full <code>/config</code>
              </p>
            </section>
          </div>
        )}
      </OverlayPanel>
    </>,
    document.body,
  );
}

function ToggleRow({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3 p-2 rounded hover:bg-inset">
      <div className="flex-1">
        <div className="text-sm text-fg">{label}</div>
        <div className="text-xs text-fg-muted">{desc}</div>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`shrink-0 w-8 h-4 rounded-full transition-colors relative ${checked ? 'bg-green-600' : 'bg-inset border border-edge-dim'}`}
        role="switch"
        aria-checked={checked}
      >
        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${checked ? 'left-4' : 'left-0.5'}`} />
      </button>
    </div>
  );
}
