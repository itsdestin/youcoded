import { useEffect, useState, useCallback, useRef } from 'react';
import { memoWhileClosed } from './memo-while-closed';
import { createPortal } from 'react-dom';
import { useTheme } from '../state/theme-context';
import { useEscClose } from '../hooks/use-esc-close';
import { useSaveNotice } from '../hooks/useSaveNotice';
import { Button, CARD_LEVEL_1, Dialog, Toggle, TextInput, Textarea, LoadingState, RadioGroup, SegmentedTabs, SectionLabel, SettingRow } from './ui';

// Native replacement for Claude Code's /config TUI. Reads/writes fields in
// ~/.claude/settings.json via the settings:* IPC bridge.
// Opens from:
//   • Typing /config in chat view (SlashCommandDispatcher)
//   • "Claude Code preferences" button in SettingsPanel
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

/** Words for each setting in a "Couldn't save …" notice. */
const LABELS: Record<keyof PrefsState, string> = {
  defaultMode: 'the default permission mode',
  editorMode: 'the editor mode',
  showTurnDuration: 'the turn duration setting',
  preferReducedMotion: 'the reduced motion setting',
  outputStyle: 'the output style',
  systemPrompt: 'the system prompt',
};

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
  acceptEdits: { label: 'Accept edits', desc: 'Auto-approve file edits' },
  plan: { label: 'Plan', desc: 'Plan-only mode, no execution' },
  bypassPermissions: { label: 'Bypass', desc: 'Skip all permission prompts (risky)' },
};

function PreferencesPopup({ open, onClose, onOpenAdvanced, showAdvanced }: Props) {
  useEscClose(open, onClose);
  const [prefs, setPrefs] = useState<PrefsState>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  // N1: failed saves are said beside their control; `saved` is each field's last value known to be on disk (what a failure snaps back to).
  const { run, notice } = useSaveNotice(open);
  const saved = useRef<PrefsState>(DEFAULTS);
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
      const loadedPrefs: PrefsState = {
        defaultMode: (defaultMode as PermissionDefault) ?? DEFAULTS.defaultMode,
        editorMode: (editorMode as EditorMode) ?? DEFAULTS.editorMode,
        showTurnDuration: typeof showTurnDuration === 'boolean' ? showTurnDuration : DEFAULTS.showTurnDuration,
        preferReducedMotion: typeof preferReducedMotion === 'boolean' ? preferReducedMotion : DEFAULTS.preferReducedMotion,
        outputStyle: (outputStyle as string) ?? DEFAULTS.outputStyle,
        systemPrompt: (systemPrompt as string) ?? DEFAULTS.systemPrompt,
      };
      saved.current = loadedPrefs;
      latest.current = loadedPrefs;
      setPrefs(loadedPrefs);
      setLoaded(true);
    }).catch(() => {
      latest.current = DEFAULTS;
      setPrefs(DEFAULTS);
      setLoaded(true);
    });
  }, [open]);

  // Write-through: every change is persisted. No "save" button - matches Claude Code's own /config TUI behavior.
  // `latest` is what the person has CHOSEN right now (Try again re-sends this, never the value that failed); `saved` is what is known to be on disk.
  const latest = useRef<PrefsState>(DEFAULTS);
  const timers = useRef<Partial<Record<keyof PrefsState, ReturnType<typeof setTimeout>>>>({});
  const TEXT_KEYS: ReadonlyArray<keyof PrefsState> = ['outputStyle', 'systemPrompt'];

  const saveRef = useRef<(key: keyof PrefsState, value: never) => void>(() => {});
  const persist = useCallback((key: keyof PrefsState) => {
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
    const value = latest.current[key];
    // The UI already shows the value (optimistic). `settings:set` answers false (or rejects) when the write did not happen: then a
    // notice appears beside the control. A choice control goes back to the last value known saved; a TEXT field keeps what the person
    // typed (snapping back would wipe their writing), and Try again sends the text as it is now. A slow write shows nothing.
    void run(
      key, LABELS[key],
      async () => { const r = await api.set(fieldMap[key], value); if (r !== false) saved.current = { ...saved.current, [key]: value }; return r; },
      () => { if (TEXT_KEYS.includes(key)) return; latest.current = { ...latest.current, [key]: saved.current[key] }; setPrefs((p) => ({ ...p, [key]: saved.current[key] })); },
      () => {
        // Try again re-does the failed choice - unless the person has chosen something else for this control since it snapped back,
        // in which case what they have chosen NOW is what is sent (never a stale value).
        const changedSince = latest.current[key] !== saved.current[key];
        if (TEXT_KEYS.includes(key) || changedSince) persist(key);
        else saveRef.current(key, value as never);
      },
    );
  }, [run]);

  const save = useCallback(<K extends keyof PrefsState>(key: K, value: PrefsState[K]) => {
    latest.current = { ...latest.current, [key]: value };
    setPrefs((p) => ({ ...p, [key]: value }));
    if (TEXT_KEYS.includes(key)) {
      // Text is saved when the person pauses or leaves the field, not on every keystroke (a failure per keystroke would be noise).
      clearTimeout(timers.current[key]);
      timers.current[key] = setTimeout(() => { delete timers.current[key]; persist(key); }, 800);
      return;
    }
    persist(key);
  }, [persist]);
  saveRef.current = save as never;
  const flush = useCallback((key: keyof PrefsState) => {
    if (timers.current[key] === undefined) return;
    clearTimeout(timers.current[key]); delete timers.current[key]; persist(key);
  }, [persist]);
  // Closing with a pause still pending sends it once, so a typed line is not lost; nothing is said about its result after the popup is gone.
  useEffect(() => () => {
    for (const k of Object.keys(timers.current) as (keyof PrefsState)[]) {
      clearTimeout(timers.current[k]); delete timers.current[k];
      void (window.claude as any).settings?.set?.(({ outputStyle: 'outputStyle', systemPrompt: 'systemPrompt' } as Record<string, string>)[k] ?? k, latest.current[k])?.catch?.(() => {});
    }
  }, [open]);

  if (!open) return null;

  return createPortal(
    <>
      <Dialog screen="chat/preferences" open={open} onClose={onClose} title="Claude Code preferences" size="panel">
        {!loaded ? (
          <LoadingState what="preferences" />
        ) : (
          <>
            {/* Permission default */}
            <section>
              {/* WHY SectionLabel, sentence case (fix batch 2, 2026-09-26): the design
                  guide's small label — 12px, grey, normal case, no spaced-out
                  capitals (decisions.md "Heading ladder"). Same for the three below. */}
              <SectionLabel className="mb-2">Default permission mode</SectionLabel>
              {/* Change 39: native radios → the Radio primitive inside a
                  RadioGroup (one tab stop + arrow-key nav via roving tabindex).
                  The row stays fully clickable; the Radio is the visual mark. */}
              <RadioGroup
                options={Object.keys(PERMISSION_LABELS) as PermissionDefault[]}
                value={prefs.defaultMode}
                onChange={(m) => save('defaultMode', m as PermissionDefault)}
                aria-label="Default permission mode"
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
              {notice('defaultMode', 'mt-2')}
            </section>

            {/* Editor mode */}
            <section>
              <SectionLabel className="mb-2">Editor mode</SectionLabel>
              {/* K3: <=4 short options with no description -> segmented. */}
              <SegmentedTabs
                variant="contained"
                aria-label="Editor mode"
                value={prefs.editorMode}
                onChange={(id) => save('editorMode', id as EditorMode)}
                tabs={[
                  { id: 'normal', label: 'Normal' },
                  { id: 'vim', label: 'Vim' },
                ]}
              />
              {notice('editorMode', 'mt-2')}
            </section>

            {/* Output style */}
            <section>
              <SectionLabel className="mb-2">Output style</SectionLabel>
              {/* Shared FIELD surface (change 20) — was its own rounded/px-3 py-1.5
                  recipe. The label above has no htmlFor, so the field
                  carries its own accessible name. */}
              {/* WHY a card round the field and its line (final-review#ST-21/#PR-7, the one popup
                  rule): they sat bare under the label. Same for System prompt and Advanced. */}
              <div className={`${CARD_LEVEL_1} p-3 space-y-1.5`}>
              <TextInput
                value={prefs.outputStyle}
                onChange={(e) => save('outputStyle', e.target.value)}
                onBlur={() => flush('outputStyle')}
                placeholder="e.g. concise, explanatory"
                aria-label="Output style"
                className="w-full"
              />
              {notice('outputStyle')}
              <p className="text-2xs text-fg-muted">Preset name that tunes your assistant's response style. Leave blank for default.</p>
              </div>
            </section>

            {/* Toggles */}
            <section className="space-y-2">
              <ToggleRow
                label="Show turn duration"
                desc={'Displays "Cooked for Xs" after each response'}
                checked={prefs.showTurnDuration}
                onChange={(v) => save('showTurnDuration', v)}
              />
              {notice('showTurnDuration')}
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
              {notice('preferReducedMotion')}
            </section>

            {/* System prompt */}
            <section>
              <SectionLabel className="mb-2">System prompt</SectionLabel>
              {/* Same FIELD surface as the input above (change 20). resize-none was
                  already the behavior here and is the Textarea default. */}
              <div className={`${CARD_LEVEL_1} p-3 space-y-1.5`}>
              <Textarea
                value={prefs.systemPrompt}
                onChange={(e) => save('systemPrompt', e.target.value)}
                onBlur={() => flush('systemPrompt')}
                placeholder="Instructions appended to every session..."
                rows={4}
                aria-label="System prompt"
                className="w-full"
              />
              {notice('systemPrompt')}
              <p className="text-2xs text-fg-muted">Applied globally. Leave blank to use Claude Code defaults.</p>
              </div>
            </section>

            {/* Advanced escape hatch — opens Claude Code's native TUI for any option not covered here */}
            {/* /config drives Claude Code's own terminal config UI — native sessions have no such surface, ever (program §2.5). */}
            {showAdvanced !== false && (
            // Card-levels sweep (2026-09-27): dropped the `border-t` — no full-width
            // line inside a popup; the Dialog body's own `space-y-5` already
            // separates this from the section above.
            <section className={`${CARD_LEVEL_1} p-3 space-y-1.5`}>
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
              <p className="text-2xs text-fg-muted text-center">
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

// WHY (2026-10-05): mounted by the shell all the time, so every session switch rebuilt this closed popup.
// memoWhileClosed ignores prop changes until `open` flips (memo-while-closed.ts).
export default memoWhileClosed(PreferencesPopup);
