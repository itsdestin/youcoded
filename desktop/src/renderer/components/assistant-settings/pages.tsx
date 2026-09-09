import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CLOSE_PROMPT_SUPPRESS_KEY } from '../CloseSessionPrompt';
import ModelPicker, { type ModelChoice } from '../model/ModelPicker';
import { unavailableReason, useAvailabilityData } from '../model/availability';
import PermissionsSection from '../PermissionsSection';
import SpecialistsSection, { SPECIALISTS_EXPLAINER_INTRO, SPECIALISTS_EXPLAINER_SECTIONS } from '../SpecialistsSection';
import { PERMISSIONS_EXPLAINER_INTRO, PERMISSIONS_EXPLAINER_SECTIONS } from '../permissions/permissions-explainer';
import type { ExplainerSection } from '../SettingsExplainer';
import {
  ClaudeCodeBlock, ChatGptBlock, OpenRouterBlock, LocalModelsBlock, SearchProvidersBlock,
  LOCAL_MODELS_INFO,
} from '../ModelProvidersPopup';
import SkipPermissionsSection, { type PermissionOverrides } from './SkipPermissionsSection';
import FolderSwitcher from '../FolderSwitcher';
import { Button, FieldError, SettingRow, Toggle, TypeableSelect } from '../ui';

// The pages of Assistant settings. Five, in one flat list (review round 1,
// 2026-09-05 — P-5 note: one "Cloud providers" page for the three sign-in /
// usage cards, no "Providers" / "Assistant" group labels; P-10 note: web
// search inside General, "too empty to be its own thing"):
//
//   General · Cloud providers · Local models · Permissions · Specialists
//
// Each page is the body of one of the four popups the panel replaces —
// Session Defaults, Model Providers, Permissions, Specialists — re-homed, not
// redrawn: the blocks are the ones the popups rendered.

export type PageId = 'general' | 'cloud' | 'local' | 'permissions' | 'specialists';

export interface AssistantDefaults {
  skipPermissions: boolean;
  model: string;
  projectFolder: string;
  /** Stored on users' machines by the old Advanced list; no longer editable
   *  here (round 1, P-4/P-14). Kept in the type so the build stage can decide
   *  what to do with a value that is on. */
  permissionOverrides?: PermissionOverrides;
  /** Q-3a: one default across every provider. Absent on installs that only
   *  ever set the Claude alias (`model`), which stays the fallback. */
  startModel?: ModelChoice;
  /** What the picker DISPLAYED for `startModel`, stored at pick time so the
   *  Settings row can name it without a catalog lookup on every drawer open
   *  (design review 2, R2-3 — it was rendering the raw model id). Claude picks
   *  do not need it: their four labels are local. */
  startModelLabel?: { provider: string; model: string };
}
export type DefaultsUpdate = Partial<AssistantDefaults>;

export interface PageContext {
  defaults: AssistantDefaults;
  onDefaultsChange: (updates: DefaultsUpdate) => void;
  cwd?: string;
  onOpenClaudePreferences?: () => void;
  /** Closes the whole panel — the Claude Code Preferences button hands off to
   *  another dialog and must not leave this one open underneath it. */
  onClosePanel: () => void;
  /** Switch to another page. */
  goTo: (id: PageId) => void;
}

export interface PageDef {
  id: PageId;
  label: string;
  icon: React.ReactNode;
  /** A short (i) beside the page title — the AnchorTip the popup section carried. */
  info?: { label: string; body: React.ReactNode };
  /** A full-page explainer (Permissions, Specialists): the (i) flips the page
   *  to it, with the dialog's back arrow to return. */
  explainer?: { intro: string; sections: ExplainerSection[] };
  /** Provider pages exist only where the native runtime does — the same gate
   *  the Model Providers row had (false over remote access, false on Android). */
  needsNative?: boolean;
  render: (ctx: PageContext) => React.ReactNode;
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" {...stroke} aria-hidden>{children}</svg>
);

// ── General ──────────────────────────────────────────────────────────────────

const CLAUDE_LABELS: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', 'opus[1m]': 'Opus', fable: 'Fable' };

/** The default model. `startModel` when set (any provider); else the Claude
 *  alias every install has carried since 1.0. */
export function startChoice(defaults: AssistantDefaults): ModelChoice {
  if (defaults.startModel) return defaults.startModel;
  // `model` is an alias ('sonnet') on every real install; a full id
  // ('claude-sonnet-4-6', the workbench fixture) is folded to its alias so the
  // picker can show the row it means instead of the raw id.
  const m = defaults.model || 'sonnet';
  const alias = m in CLAUDE_LABELS ? m : (Object.keys(CLAUDE_LABELS).find((a) => m.includes(a.replace('[1m]', ''))) ?? 'sonnet');
  return { runtime: 'claude', alias };
}

/** One short line for the Settings row: "Claude Code · Sonnet", "ChatGPT · GPT-5.6".
 *  The row cannot afford a catalog lookup on every drawer open, so a native
 *  choice carries the words the picker showed when it was chosen. */
export function startSummary(defaults: AssistantDefaults, labels?: Map<string, { provider: string; model: string }>): string {
  const c = startChoice(defaults);
  if (c.runtime === 'claude') return `Claude Code · ${CLAUDE_LABELS[c.alias] ?? 'Sonnet'}`;
  // Stored at pick time first, then a caller-supplied map, then the raw id as a
  // last resort — which now only happens for a default saved by an older build.
  const stored = defaults.startModelLabel;
  if (stored) return `${stored.provider} · ${stored.model}`;
  const known = labels?.get(`${c.providerId}/${c.modelId}`);
  return known ? `${known.provider} · ${known.model}` : c.modelId;
}

/** Title + hint + a full-width control, the shape both dropdown rows share
 *  (round 2, R2-1: "default model and default project folder should both have
 *  correctly styled dropdowns"; R2-2: the project folder gets the same hint
 *  line the model row has). */
function FieldRow({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="bg-inset/50 rounded-lg px-3 py-2.5 space-y-1.5">
      <div>
        <p className="text-xs font-medium text-fg">{title}</p>
        <p className="text-3xs text-fg-muted">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function ProjectFolderRow({ defaults, onDefaultsChange }: PageContext) {
  // Round 3 (R3-1): "project picker should look like it does in the new session
  // dropdown. same options, folder icon, etc." — so this IS that picker, the
  // same component the new-session form and the buddy window use. With no
  // `onManageProjects` it ends in "Browse for folder…", which is the escape
  // hatch this row needs. `autoSelect={false}`: a settings row must never write
  // a default the user did not choose just by being looked at.
  return (
    <FieldRow
      title="Default project folder"
      hint="This folder will be pre-filled when you start a new conversation, but you may still choose another at any time."
    >
      <FolderSwitcher
        value={defaults.projectFolder}
        onChange={(path) => onDefaultsChange({ projectFolder: path })}
        autoSelect={false}
        panelMatchesTrigger
      />
    </FieldRow>
  );
}

const STEP_GUARD_OPTIONS = [
  { value: '', label: 'None' },
  ...Array.from({ length: 10 }, (_, index) => ({ value: String((index + 1) * 10), label: `${(index + 1) * 10} steps` })),
];

function parseStepGuard(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function StepGuardRow() {
  const api = window.claude.native;
  const [saved, setSaved] = useState<number | null>(null);
  const savedRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null | undefined>(undefined);
  const writingRef = useRef(false);
  const mountedRef = useRef(true);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ioError, setIoError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [retryValue, setRetryValue] = useState<number | null | undefined>();
  useEffect(() => () => { mountedRef.current = false; }, []);
  const load = useCallback(async () => {
    setLoading(true); setIoError(null);
    try {
      const value = await api.getStepGuard();
      if (!mountedRef.current) return;
      savedRef.current = value; setSaved(value); setLoaded(true);
    } catch {
      if (!mountedRef.current) return;
      setLoaded(false); setIoError("The step guard couldn't be loaded.");
    } finally { if (mountedRef.current) setLoading(false); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const drainWrites = useCallback(async () => {
    if (writingRef.current) return;
    writingRef.current = true; setSaving(true);
    // WHY serialize at the bridge boundary: quick commits may be delivered while
    // React still renders the enabled control; latest intent must win in order.
    while (pendingRef.current !== undefined) {
      const value = pendingRef.current;
      pendingRef.current = undefined;
      const previous = savedRef.current;
      setSaved(value); setIoError(null); setValidationError(null); setRetryValue(undefined);
      try {
        const persisted = await api.setStepGuard(value);
        if (!mountedRef.current) return;
        savedRef.current = persisted; setSaved(persisted);
      } catch {
        if (!mountedRef.current) return;
        // WHY a superseding commit wins over the failed request: clearing the
        // queue here would silently discard the user's newer rapid intent.
        if (pendingRef.current !== undefined) {
          setSaved(previous);
          continue;
        }
        setSaved(previous); setRetryValue(value);
        setIoError("The step guard couldn't be saved. Your previous setting is kept.");
        break;
      }
    }
    writingRef.current = false;
    if (mountedRef.current) setSaving(false);
  }, [api]);
  const save = useCallback((value: number | null) => {
    pendingRef.current = value;
    void drainWrites();
  }, [drainWrites]);
  const commit = (raw: string): boolean => {
    if (raw === '') { save(null); return true; }
    const value = parseStepGuard(raw);
    if (value === null) {
      setValidationError('Enter a positive whole number, or choose None.');
      return false;
    }
    save(value);
    return true;
  };
  return <FieldRow title="Step guard" hint="Pause after this many tool-loop steps (rounds), not each parallel tool call. Other safety checks still apply. Choose None to run without this guard.">
    <TypeableSelect aria-label="Step guard" options={STEP_GUARD_OPTIONS} value={saved === null ? '' : String(saved)} onCommit={commit} disabled={loading || saving || !loaded} />
    {loading && <p className="text-3xs text-fg-muted">Loading…</p>}
    {validationError && <FieldError as="p">{validationError}</FieldError>}
    {ioError && <FieldError as="div">{ioError} <Button size="sm" variant="ghost" onClick={() => { if (retryValue !== undefined) save(retryValue); else void load(); }}>Retry</Button></FieldError>}
  </FieldRow>;
}

function GeneralPage(ctx: PageContext) {
  const { defaults, onDefaultsChange } = ctx;
  // WHY the panel judges the saved default (Destin, deck 2026-09-07).
  //
  // P-1 a: a default that cannot run right now is NEVER erased — a local engine
  // that happens to be off, or a sign-in check that has not come back, must not
  // cost him a setting he chose weeks ago. The stored choice stays exactly as
  // written and the row keeps naming it.
  //
  // P-2 b + his note: the new-session form stays silent about it and simply
  // starts with nothing chosen; THIS is the one place that says the default is
  // being ignored, so there is a single place to look rather than two.
  const avail = useAvailabilityData();
  const defaultReason = avail.loaded ? unavailableReason(startChoice(defaults), avail) : null;
  // Close-session prompt suppression — reads/writes localStorage directly since
  // this is a UI preference, not a session default backed by sessionDefaults.
  const [closePromptDisabled, setClosePromptDisabled] = useState(
    () => localStorage.getItem(CLOSE_PROMPT_SUPPRESS_KEY) === '1',
  );

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        {/* Q-3a: the same picker the chat uses, so any connected model can be
            the default. Title and hint are Destin's words from round 1 (P-3
            note). */}
        <FieldRow
          title="Default model"
          hint="This model will be pre-filled in the model picker, but you may still switch models at any time."
        >
          <ModelPicker
            value={startChoice(defaults)}
            onSelect={(choice, label) => onDefaultsChange({
              startModel: choice,
              startModelLabel: choice.runtime === 'native' ? label : undefined,
              // Keep the legacy alias in step for a Claude pick, so everything
              // that still reads `model` (session create, the status bar) agrees.
              ...(choice.runtime === 'claude' ? { model: choice.alias } : {}),
            })}
          />
          {defaultReason && (
            <FieldError as="p" className="leading-relaxed">
              {startSummary(defaults)} — {defaultReason.toLowerCase()}. New conversations start with no
              model chosen until this is fixed or you pick another one. Your choice is kept.
            </FieldError>
          )}
        </FieldRow>
        <ProjectFolderRow {...ctx} />
        {window.claude.native.supported === true && <StepGuardRow />}
        <SettingRow
          variant="item"
          title="Close-session prompt"
          description="Show tag options when closing a session"
          control={
            <Toggle
              checked={!closePromptDisabled}
              onChange={(show) => {
                const next = !show;
                setClosePromptDisabled(next);
                if (next) localStorage.setItem(CLOSE_PROMPT_SUPPRESS_KEY, '1');
                else localStorage.removeItem(CLOSE_PROMPT_SUPPRESS_KEY);
              }}
              aria-label="Close-session prompt"
            />
          }
        />
      </section>

      {/* Round 1, P-10 note: web search lives here. Round 2, R2-1: as one card
          holding the Tavily and Exa rows, not a bare heading over loose cards.
          Only where the native runtime is (the search keys are its). */}
      {(window as any).claude?.native?.supported === true && <SearchProvidersBlock card />}
    </div>
  );
}

// ── The registry ─────────────────────────────────────────────────────────────

export const PAGES: PageDef[] = [
  {
    id: 'general',
    label: 'General',
    icon: <Icon><line x1="4" y1="7" x2="20" y2="7" /><circle cx="8" cy="7" r="2.2" fill="var(--panel)" /><line x1="4" y1="17" x2="20" y2="17" /><circle cx="16" cy="17" r="2.2" fill="var(--panel)" /></Icon>,
    render: (ctx) => <GeneralPage {...ctx} />,
  },
  {
    id: 'cloud',
    label: 'Cloud providers',
    needsNative: true,
    icon: <Icon><path d="M7 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 8.5a3.5 3.5 0 0 1-.5 7H7z" /></Icon>,
    // The three cards stacked as the Model Providers popup stacked them (P-5
    // note: "similar to the current page"), then your own API keys.
    render: (ctx) => (
      <div className="space-y-2">
        <ClaudeCodeBlock onOpenClaudePreferences={ctx.onOpenClaudePreferences} onCloseParent={ctx.onClosePanel} />
        <ChatGptBlock />
        <OpenRouterBlock keysHeading="Your own API keys" />
      </div>
    ),
  },
  {
    id: 'local',
    label: 'Local models',
    needsNative: true,
    info: LOCAL_MODELS_INFO,
    icon: <Icon><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Icon>,
    render: () => <LocalModelsBlock withHeader={false} />,
  },
  {
    id: 'permissions',
    label: 'Permissions',
    explainer: { intro: PERMISSIONS_EXPLAINER_INTRO, sections: PERMISSIONS_EXPLAINER_SECTIONS },
    icon: <Icon><path d="M12 3l7 3v5.5c0 4.3-2.9 8.1-7 9.5-4.1-1.4-7-5.2-7-9.5V6l7-3z" /><path d="M9 12l2 2 4-4" /></Icon>,
    // Two blocks (questions deck Q-2 option a, chosen in round 1's P-5 note):
    // Claude Code's switch first, then the modes and Always-allow list that
    // cover every other provider — labelled so the two systems are not
    // mistaken for one.
    render: (ctx) => (
      <div className="space-y-5">
        <SkipPermissionsSection defaults={ctx.defaults} onDefaultsChange={ctx.onDefaultsChange} />
        <section>
          <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">ChatGPT, OpenRouter and local models</h3>
          <PermissionsSection />
        </section>
      </div>
    ),
  },
  {
    id: 'specialists',
    label: 'Specialists',
    explainer: { intro: SPECIALISTS_EXPLAINER_INTRO, sections: SPECIALISTS_EXPLAINER_SECTIONS },
    icon: <Icon><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" /><path d="M16 5.5a3 3 0 0 1 0 5.6" /><path d="M17.5 14.5c2 .6 3.5 2.4 3.5 4.5" /></Icon>,
    render: (ctx) => <SpecialistsSection cwd={ctx.cwd} />,
  },
];
