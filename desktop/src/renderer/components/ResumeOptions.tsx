// "How do I relaunch this?" — the model picker, the two launch switches and the
// Resume button, as the Resume browser draws them. Shared by the Resume
// browser (its expanded card and the action card under its preview) and the
// Projects page's conversation preview.
//
// WHY extracted (2026-09-16): Destin asked for the Projects preview's resume to
// "allow the user to pick the model" like the Resume browser does. Copying the
// block is how surfaces drift ("this should look like it does in our other
// existing new/resume surfaces", 2026-09-11), so both now render this one.
import { useState } from 'react';
import { Button, Toggle } from './ui';
import ModelPicker, { type ModelChoice } from './model/ModelPicker';
import { SkipPermissionsInfoTooltip } from './SkipPermissionsInfoTooltip';
import { SkipPermissionsCaption } from './SkipPermissionsCaption';
import { useFirstTimeGate } from './FirstTimeWarning';
import type { PastSession } from '../../shared/types';
import type { ModelBinding } from '../../shared/provider-types';
import { claudeAliasForModelId } from '../../shared/model-ids';

/** App's resume entry point (App.tsx handleResumeSession). `false` = it did not
 *  launch (App has already said why), so the caller stays open for a retry. */
export type ResumeHandler = (
  sessionId: string, projectSlug: string, projectPath: string, model: string, dangerous: boolean,
  launchInNewWindow?: boolean, provider?: string, nativeBinding?: ModelBinding,
) => void | boolean | Promise<void | boolean>;

/** The launch choices, held for as long as the host is open — moving between
 *  conversations keeps the Claude model and the switches, as it always has in
 *  the Resume browser. */
export function useResumeOptions(defaultModel?: string, defaultSkipPermissions?: boolean) {
  const [model, setModel] = useState<string>(defaultModel || 'sonnet');
  const [dangerous, setDangerousRaw] = useState(defaultSkipPermissions || false);
  // First-time Skip Permissions warning (spec §5).
  const { gate, dialog } = useFirstTimeGate('skip-permissions');
  // A native resume ALWAYS goes through the model picker (Destin's ruling:
  // never auto-launch a binding). OWNED by the conversation it was picked for:
  // the next conversation's picker only pre-fills when it sees no value, so an
  // unowned pick left it on "Choose a model…" (Destin, 2026-09-11).
  const [binding, setBinding] = useState<{ sessionId: string; binding: ModelBinding } | null>(null);
  const [newWindow, setNewWindow] = useState(false);
  // The conversation whose resume is in flight — keeps its button busy until
  // App answers (Task 6 review ack-gap).
  const [resumingId, setResumingId] = useState<string | null>(null);

  // Start a row on the model it last ran on, not the app-wide default —
  // resuming an Opus conversation used to silently offer Sonnet. Falls back to
  // the default when the row records no model, or one outside the aliases the
  // picker offers. Claude Code rows only: a native row's recorded id can be an
  // OpenRouter id that merely CONTAINS a family word
  // (`anthropic/claude-sonnet-4.5`), and it would set the Claude alias on no
  // evidence.
  const modelForRow = (s: PastSession): string => {
    const recorded = s.provider !== 'native' ? s.lastUsedModel?.modelId : undefined;
    return (recorded ? claudeAliasForModelId(recorded) : null) || defaultModel || 'sonnet';
  };

  /** Fresh choices for `s` (or the app defaults with no row): its own model,
   *  the default Skip Permissions, same window, no native pick. */
  const resetFor = (s: PastSession | null) => {
    setModel(s ? modelForRow(s) : (defaultModel || 'sonnet'));
    setDangerousRaw(defaultSkipPermissions || false);
    setNewWindow(false);
    setBinding(null);
  };

  const bindingFor = (s: PastSession): ModelBinding | null =>
    (binding && binding.sessionId === s.sessionId ? binding.binding : null);

  const choiceFor = (s: PastSession): ModelChoice | null => {
    if (s.provider === 'native') {
      const b = bindingFor(s);
      return b ? { runtime: 'native', providerId: b.providerId, modelId: b.modelId } : null;
    }
    return model ? { runtime: 'claude', alias: model } : null;
  };

  const select = (s: PastSession, c: ModelChoice) => {
    if (c.runtime === 'native') setBinding({ sessionId: s.sessionId, binding: { providerId: c.providerId, modelId: c.modelId } });
    else setModel(c.alias);
  };

  // Turning Skip Permissions ON goes through the first-time warning; Cancel
  // there leaves it off. Turning it off never asks.
  const setDangerous = (next: boolean) => (next ? gate(() => setDangerousRaw(true)) : setDangerousRaw(false));

  /** Resume `s` through `onResume`; resolves to whether it launched. Native
   *  sessions ignore the Claude model and Skip Permissions (no PTY), but the
   *  row's provider and its picked binding route App down the native path. */
  const resume = async (s: PastSession, onResume: ResumeHandler): Promise<boolean> => {
    setResumingId(s.sessionId);
    try {
      const result = await onResume(s.sessionId, s.projectSlug, s.projectPath, model, dangerous, newWindow, s.provider, bindingFor(s) ?? undefined);
      return result !== false; // undefined (non-awaiting wiring) or true → launched
    } finally {
      setResumingId(null);
    }
  };

  return { choiceFor, select, dangerous, setDangerous, newWindow, setNewWindow, bindingFor, resumingId, resume, resetFor, dialog };
}

export type ResumeOptionsApi = ReturnType<typeof useResumeOptions>;

export function ResumeOptionsForm({ session: s, options, onResume, flush, allowNewWindow = true }: {
  session: PastSession;
  options: ResumeOptionsApi;
  onResume: () => void;
  /** False where a resume always opens a tab — the side panel's, whose resume
   *  goes through chat search's path (Destin: "just new tab in session"). */
  allowNewWindow?: boolean;
  /** Drop the top hairline — for a host that draws its own border above. */
  flush?: boolean;
}) {
  // Launch in new window — hidden on remote/Android (single-window).
  const detachAvailable = allowNewWindow && typeof (window as any).claude?.detach?.openDetached === 'function';
  const dangerous = s.provider !== 'native' && options.dangerous;
  // A native row stays disabled until a model binding exists (manual pick or a
  // prefill auto-select) — never resume with no binding to launch.
  const nativeNeedsPick = s.provider === 'native' && !options.bindingFor(s);
  const busy = options.resumingId === s.sessionId;
  return (
    <div className={flush ? '' : 'border-t border-edge-dim'}>
      <div className="p-3 flex flex-col gap-2">
        {/* ONE model control for both runtimes, SCOPED to the row's own
            runtime — a resume cannot move a conversation across runtimes. */}
        <div onClick={(e) => e.stopPropagation()}>
          <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Model</label>
          <ModelPicker
            // One picker per conversation: it fills in `prefill` only once per
            // mount, so without the key only the FIRST conversation shown got
            // its last-used model (Destin, 2026-09-11).
            key={s.sessionId}
            value={options.choiceFor(s)}
            onSelect={(c) => options.select(s, c)}
            includeClaude={s.provider !== 'native'}
            includeNative={s.provider === 'native'}
            prefill={s.lastUsedModel}
            onManageModels={() => window.dispatchEvent(new CustomEvent('youcoded:open-model-providers'))}
          />
        </div>

        {/* Skip Permissions is Claude-Code-only — a native session has no PTY
            permission flow. */}
        {s.provider !== 'native' && (
          <>
            <div className="flex items-center justify-between">
              <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase inline-flex items-center">
                Skip Permissions
                <SkipPermissionsInfoTooltip />
              </label>
              {/* "danger" tone, so themes can restyle the red. */}
              <Toggle checked={options.dangerous} onChange={options.setDangerous} tone="danger" aria-label="Skip Permissions" />
            </div>
            {options.dangerous && <SkipPermissionsCaption />}
          </>
        )}

        {detachAvailable && (
          <div className="flex items-center justify-between">
            <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Launch in New Window</label>
            <Toggle checked={options.newWindow} onChange={options.setNewWindow} aria-label="Launch in New Window" />
          </div>
        )}

        {/* Filled danger for skip-permissions — same call as SessionStrip's
            Create button (spec §11, change 62). */}
        <Button
          variant={dangerous ? 'danger' : 'primary'}
          size="lg"
          onClick={onResume}
          disabled={nativeNeedsPick || busy}
          className="w-full py-1.5"
        >
          {busy ? 'Resuming…' : dangerous ? 'Resume (Dangerous)' : 'Resume Session'}
        </Button>
      </div>
    </div>
  );
}
