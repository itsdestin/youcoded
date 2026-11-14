import { useEffect, useState, useCallback, useRef } from 'react';
import { memoWhileClosed } from './memo-while-closed';
import { createPortal } from 'react-dom';
import { useTheme } from '../state/theme-context';
import { useEscClose } from '../hooks/use-esc-close';
import { useSaveNotice } from '../hooks/useSaveNotice';
import { announce } from '../utils/announce';
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

/** The longest a reopening popup waits for the previous close-time write before it loads anyway. */
const CLOSE_WRITE_WAIT_MS = 2500;

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
    if (!open) return undefined;
    // A later load wins: a slow earlier one must not overwrite it (and a close-time write is waited for, so reopening reads what was just saved).
    let cancelled = false;
    setLoaded(false);
    const api = (window.claude as any).settings;
    if (!api) {
      setPrefs(DEFAULTS);
      setLoaded(true);
      return;
    }
    // Wait for a close-time write, but not forever: a write that never settles must not leave "Loading preferences" up.
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    Promise.race([closing.current, new Promise<void>((r) => { giveUp = setTimeout(r, CLOSE_WRITE_WAIT_MS); })]).then(() => (cancelled ? undefined : Promise.all([
      api.get('permissions.defaultMode'),
      api.get('editorMode'),
      api.get('showTurnDuration'),
      api.get('preferReducedMotion'),
      api.get('outputStyle'),
      api.get('systemPrompt'),
    ]))).then((vals) => {
      if (!vals || cancelled) return;
      const [defaultMode, editorMode, showTurnDuration, preferReducedMotion, outputStyle, systemPrompt] = vals as unknown[];
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
      if (cancelled) return;
      latest.current = DEFAULTS;
      setPrefs(DEFAULTS);
      setLoaded(true);
    });
    return () => { cancelled = true; clearTimeout(giveUp); };
  }, [open]);

  // Write-through: every change is persisted. No "save" button - matches Claude Code's own /config TUI behavior.
  // `latest` is what the person has CHOSEN right now (Try again re-sends this, never the value that failed); `saved` is what is known to be on disk.
  const latest = useRef<PrefsState>(DEFAULTS);
  const timers = useRef<Partial<Record<keyof PrefsState, ReturnType<typeof setTimeout>>>>({});
  const TEXT_KEYS: ReadonlyArray<keyof PrefsState> = ['outputStyle', 'systemPrompt'];
  const TEXT_FIELD: Record<string, string> = { outputStyle: 'outputStyle', systemPrompt: 'systemPrompt' };
  const TEXT_WORDS: Record<string, string> = { outputStyle: 'your output style', systemPrompt: 'your system prompt' };

  const saveRef = useRef<(key: keyof PrefsState, value: never) => void>(() => {});
  /** Bumped whenever the popup closes; a save that finishes under a newer number finished after the popup was gone. */
  const openGen = useRef(0);
  /** Every text write still running (from a blur, the pause timer, the close, or pagehide); a reopening popup waits for all of them. */
  const inflight = useRef<Set<Promise<unknown>>>(new Set());
  const wSeq = useRef<Record<string, number>>({});
  const wRunning = useRef<Record<string, number>>({});
  const wNewestFailed = useRef<Record<string, boolean>>({});
  const wClosed = useRef<Record<string, boolean>>({});
  /**
   * One text write, tracked per field. The toast for a failure after the popup closed follows the SAME rule as the inline notice:
   * the NEWEST write of a field decides, once every write of that field has settled, so an older write failing while a newer one
   * reached the disk says nothing (that would be a false alarm), and two failing writes of one field say it exactly once.
   * `quiet`: pagehide, where nothing can be shown. `afterClose`: the write itself starts at close.
   */
  const trackText = useCallback(async (key: keyof PrefsState, doWrite: () => Promise<unknown>, opts: { quiet?: boolean; afterClose?: boolean }) => {
    const gen = openGen.current;
    const mine = (wSeq.current[key] = (wSeq.current[key] ?? 0) + 1);
    wRunning.current[key] = (wRunning.current[key] ?? 0) + 1;
    if (opts.afterClose) wClosed.current[key] = true;
    let failed = false; let result: unknown; let error: unknown; let threw = false;
    const settled = (async () => {
      try {
        result = await doWrite();
        failed = result === false || (!!result && typeof result === 'object' && (result as { ok?: unknown }).ok === false);
      } catch (e) { failed = true; threw = true; error = e; }
    })();
    inflight.current.add(settled);
    await settled;
    inflight.current.delete(settled);
    wRunning.current[key] -= 1;
    if (openGen.current !== gen) wClosed.current[key] = true; // the popup closed at some point while this was running
    if (mine === wSeq.current[key]) wNewestFailed.current[key] = failed;
    if (wRunning.current[key] === 0) {
      // No invented cause: only the plain fact that it did not save.
      if (wClosed.current[key] && wNewestFailed.current[key] && !opts.quiet) announce(`Couldn't save ${TEXT_WORDS[key] ?? 'that setting'}.`);
      wClosed.current[key] = false; wNewestFailed.current[key] = false;
    }
    if (threw) throw error;
    return result;
  }, []);
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
      async () => {
        const write = async () => { const r = await api.set(fieldMap[key], value); if (r !== false) saved.current = { ...saved.current, [key]: value }; return r; };
        // Text goes through the shared tracker so a failure after the popup is gone is toasted by the same rule from every path.
        return TEXT_KEYS.includes(key) ? trackText(key, write, {}) : write();
      },
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
  // Text with a pause still pending (typed, not yet sent). Written straight to settings, with no popup notice, by the three paths below.
  /** Send every pending text now. `report` says a failure in the app's toast (the popup is gone, so its own notice cannot). */
  const writePending = useCallback((report: boolean): Promise<void> => {
    const keys = Object.keys(timers.current) as (keyof PrefsState)[];
    const api = (window.claude as any).settings;
    return Promise.all(keys.map(async (k) => {
      clearTimeout(timers.current[k]); delete timers.current[k];
      try { await trackText(k, () => api?.set?.(TEXT_FIELD[k] ?? k, latest.current[k]), { quiet: !report, afterClose: report }); } catch { /* reported by trackText */ }
    })).then(() => undefined);
  }, [trackText]);
  /** The close-time write still running, so a reopening popup can wait for it before it reads the settings back. */
  const closing = useRef<Promise<void>>(Promise.resolve());
  // Closing (or unmounting) with a pause still pending sends it once, so a typed line is not lost; a failure is toasted.
  useEffect(() => () => {
    openGen.current += 1; // writes still running now finish "after close": trackText toasts a failure if the newest one failed
    if (Object.keys(timers.current).length) void writePending(true);
    // ALL running text writes (earlier ones and the one just started) are waited for. Only assigned when there is something running:
    // the same cleanup also runs when the popup OPENS, and must not replace a real wait with a finished one.
    const waits = [...inflight.current];
    if (waits.length) closing.current = Promise.all(waits).then(() => undefined);
  }, [open, writePending]);
  // The window going away inside the pause: the page is hidden, so fire the write (no toast possible, no waiting). Listens only while open.
  useEffect(() => {
    if (!open) return undefined;
    const onHide = () => { if (Object.keys(timers.current).length) void writePending(false); };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [open, writePending]);

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
