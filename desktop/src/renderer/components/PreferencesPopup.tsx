import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../state/theme-context';
import { useEscClose } from '../hooks/use-esc-close';
import { Button, Dialog, Toggle, TextInput, Textarea, LoadingState, RadioGroup, SegmentedTabs, SettingRow } from './ui';

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
  showAdvanced?: boolean;     // Hide Advanced button for native sessions (no /config support)
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

export default function PreferencesPopup({ open, onClose, onOpenAdvanced, showAdvanced }: Props) {
  useEscClose(open, onClose);
  const [prefs, setPrefs] = useState<PrefsState>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  // Per-turn metadata toggle is a theme-context preference (localStorage-backed),
  // not a Claude Code settings.json field — source state from useTheme(), not prefs.
  const { showTurnMetadata, setShowTurnMetadata } = useTheme();

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
    <>
      <Dialog open={open} onClose={onClose} title="Claude Code Preferences" size="panel">
        {!loaded ? (
          <LoadingState what="preferences" />
        ) : (
          <>
            {/* Permission default */}
            <section>
              <h3 className="block text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">
                Default Permission Mode
              </h3>
              {/* Change 39: native radios → the Radio primitive inside a
                  RadioGroup (one tab stop + arrow-key nav via roving tabindex).
                  The row stays fully clickable; the Radio is the visual mark. */}
              <RadioGroup
                options={Object.keys(PERMISSION_LABELS) as PermissionDefault[]}
                value={prefs.defaultMode}
                onChange={(m) => save('defaultMode', m as PermissionDefault)}
                aria-label="Default Permission Mode"
                className="space-y-1.5"
              >
                {(Object.keys(PERMISSION_LABELS) as PermissionDefault[]).map((mode) => (
                  <SettingRow
                    key={mode}
                    variant="item"
                    title={PERMISSION_LABELS[mode].label}
                    description={PERMISSION_LABELS[mode].desc}
                    selected={prefs.defaultMode === mode}
                    onSelect={() => save('defaultMode', mode)}
                    radioTabIndex={prefs.defaultMode === mode ? 0 : -1}
                  />
                ))}
              </RadioGroup>
            </section>

            {/* Editor mode */}
            <section>
              <h3 className="block text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">
                Editor Mode
              </h3>
              {/* K3: <=4 short options with no description -> segmented. */}
              <SegmentedTabs
                variant="contained"
                aria-label="Editor Mode"
                value={prefs.editorMode}
                onChange={(id) => save('editorMode', id as EditorMode)}
                tabs={[
                  { id: 'normal', label: 'Normal' },
                  { id: 'vim', label: 'Vim' },
                ]}
              />
            </section>

            {/* Output style */}
            <section>
              <h3 className="block text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">
                Output Style
              </h3>
              {/* Shared FIELD surface (change 20) — was its own rounded/px-3 py-1.5
                  recipe. The uppercase <label> above has no htmlFor, so the field
                  carries its own accessible name. */}
              <TextInput
                value={prefs.outputStyle}
                onChange={(e) => save('outputStyle', e.target.value)}
                placeholder="e.g. concise, explanatory"
                aria-label="Output Style"
                className="w-full"
              />
              <p className="text-2xs text-fg-muted mt-1.5">Preset name that tunes your assistant's response style. Leave blank for default.</p>
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
                label="Show per-turn metadata"
                desc="Display model, token usage, and cache hits below each assistant response. Helpful for debugging long sessions or comparing model efficiency. Off by default."
                checked={showTurnMetadata}
                onChange={(v) => setShowTurnMetadata(v)}
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
              <h3 className="block text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">
                System Prompt
              </h3>
              {/* Same FIELD surface as the input above (change 20). resize-none was
                  already the behavior here and is the Textarea default. */}
              <Textarea
                value={prefs.systemPrompt}
                onChange={(e) => save('systemPrompt', e.target.value)}
                placeholder="Instructions appended to every session..."
                rows={4}
                aria-label="System Prompt"
                className="w-full"
              />
              <p className="text-2xs text-fg-muted mt-1.5">Applied globally. Leave blank to use Claude Code defaults.</p>
            </section>

            {/* Advanced escape hatch — opens Claude Code's native TUI for any option not covered here */}
            {/* /config drives Claude Code's own terminal config UI — native sessions have no such surface, ever (program §2.5). */}
            {showAdvanced !== false && (
            <section className="pt-3 border-t border-edge-dim">
              <Button
                variant="secondary"
                size="lg"
                onClick={() => {
                  onClose();
                  onOpenAdvanced();
                }}
                className="w-full"
              >
                Advanced (terminal) →
              </Button>
              <p className="text-2xs text-fg-muted mt-1.5 text-center">
                Switches to terminal view and runs Claude Code's full <code>/config</code>
              </p>
            </section>
            )}
          </>
        )}
      </Dialog>
    </>,
    document.body,
  );
}

// K2: was the app's only text-sm/text-xs row — a third density between the two
// approved ones, and the outlier that made "settings rows" mean three different
// sizes. These are settings being scanned, so they take the `item` density that
// every other in-menu toggle row already used.
function ToggleRow({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <SettingRow
      variant="item"
      title={label}
      description={desc}
      // Was a hand-rolled 32x16 track with a green-600 on-state; one geometry and
      // the app accent now (changes 15/16). role="switch"/aria-checked come from
      // the primitive; aria-label gives it the name the row text couldn't.
      control={<Toggle checked={checked} onChange={onChange} aria-label={label} />}
    />
  );
}
