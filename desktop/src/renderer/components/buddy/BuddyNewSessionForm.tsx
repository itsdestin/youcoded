import { useCallback, useEffect, useState } from 'react';
import FolderSwitcher from '../FolderSwitcher';
import { Button, Toggle } from '../ui';
import { SkipPermissionsCaption } from '../SkipPermissionsCaption';
import ModelPicker, { type ModelChoice } from '../model/ModelPicker';
import {
  NativeExtras, defaultRuntime, loadLastBinding, persistLastBinding, useNativeBinding, usePreset,
  type Binding, type Runtime,
} from '../RuntimeBinding';
import { buildSessionCreateArgs } from '../../../shared/session-create-args';

interface Props {
  /** Invoked with the new session id after session.create resolves. */
  onCreated: (sessionId: string) => void;
  /** User-initiated dismissal (Cancel button, Escape, click-away). */
  onCancel: () => void;
}

/**
 * Shared new-session form used by the buddy chat window in two places:
 *   1. BuddyWelcome expanded state (no active session)
 *   2. SessionPill dropdown's "+ New session…" expansion
 *
 * WHY THE 2026-09-10 REWRITE. This form used to be a hand-copy of the welcome
 * form's fields, and its own comment pointed at App.tsx line numbers that had
 * drifted ~2,000 lines. In the gap the main form replaced its four-alias button
 * row with <ModelPicker>, its hand-rolled 32x18 red track with <Toggle
 * tone="danger">, and its inline-styled buttons with <Button>. The buddy kept
 * all three hand-rolled, so its Skip Permissions track was a literal #DD4444
 * that no theme pack could restyle — and, worse, it hardcoded provider
 * 'claude'. ChatGPT and local models were unreachable from the floater, and a
 * saved non-Claude default was silently swapped for Claude Sonnet with nothing
 * on screen saying so.
 *
 * The fix is to hand-copy NOTHING. Every control here is the shared component
 * the main form uses, the runtime is DERIVED from the model pick through the
 * same useNativeBinding/usePreset hooks, and the create payload is built by
 * shared/session-create-args.ts. Only the wrapper layout is buddy-specific,
 * because the window is 320px wide.
 *
 * Pinned by tests/buddy-new-session-form.test.tsx.
 */
export function BuddyNewSessionForm({ onCreated, onCancel }: Props) {
  const [cwd, setCwd] = useState('');
  const [dangerous, setDangerous] = useState(false);
  const [model, setModel] = useState<string>('sonnet');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Runtime + native binding, exactly as both main-window forms do it. `active`
  // is true because this component only exists while its form is open — the
  // main forms pass their own open-flag because their state outlives the form.
  const [runtime, setRuntime] = useState<Runtime>(() => defaultRuntime());
  const [binding, setBinding] = useState<Binding | null>(() => loadLastBinding());
  const nb = useNativeBinding({ active: true, runtime, binding, setBinding });
  const { preset, setPreset } = usePreset({ active: true, cwd });

  // Same bridge the welcome form uses: the picker speaks ModelChoice, the create
  // call speaks runtime + alias-or-binding. Derived, not stored, so there is
  // only ever one answer to "what will this launch".
  const modelChoice: ModelChoice | null = runtime === 'native'
    ? (nb.effectiveBinding
        ? { runtime: 'native', providerId: nb.effectiveBinding.providerId, modelId: nb.effectiveBinding.modelId }
        : null)
    : { runtime: 'claude', alias: model };

  const applyModelChoice = useCallback((c: ModelChoice) => {
    if (c.runtime === 'claude') {
      setRuntime('claude');
      setModel(c.alias);
    } else {
      setRuntime('native');
      nb.setBinding({ providerId: c.providerId, modelId: c.modelId });
    }
  }, [nb]);

  // Hydrate defaults once on mount. We read lazily (not in a parent effect)
  // because the form is conditionally rendered and we only care about the
  // defaults *at the moment it opens*.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const defaults = await window.claude.defaults?.get?.();
        if (cancelled) return;
        setCwd(defaults?.projectFolder ?? '');
        setDangerous(defaults?.skipPermissions ?? false);
        setModel(defaults?.model ?? 'sonnet');
        // WHY startModel and not just `model`: `defaults.model` only ever holds
        // a CLAUDE alias, so reading it alone is what made a saved ChatGPT or
        // local default open a Claude Sonnet session instead. startModel is the
        // portable ref that actually records the pick; routing it through the
        // picker's own setter moves the runtime with it.
        if (defaults?.startModel) applyModelChoice(defaults.startModel as ModelChoice);
      } catch {
        // Defaults are best-effort — FolderSwitcher will still auto-select
        // the first known folder via its own load() on mount.
      }
    })();
    return () => { cancelled = true; };
    // Mount-only on purpose: applyModelChoice closes over nb, which changes every
    // render, and re-running this would stomp the user's own pick with the default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = useCallback(async () => {
    if (creating) return;
    if (!cwd) {
      setError('Pick a project folder first.');
      return;
    }
    if (runtime === 'native' && !nb.effectiveBinding) return; // guarded by `disabled` too
    setCreating(true);
    setError(null);
    try {
      if (runtime === 'native' && nb.effectiveBinding) persistLastBinding(nb.effectiveBinding);
      const info = await (window.claude.session.create as any)(buildSessionCreateArgs({
        name: 'New Session',
        cwd,
        runtime,
        model,
        skipPermissions: dangerous,
        binding: nb.effectiveBinding,
        preset,
      }));
      if (info?.id) onCreated(info.id);
      else {
        // The create never acked. Non-committal per docs/error-message-standards.md
        // — the cause isn't known on this side.
        setError("Couldn't start a session.");
        setCreating(false);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Could not start a session.');
      setCreating(false);
    }
  }, [creating, cwd, dangerous, model, runtime, nb.effectiveBinding, preset, onCreated]);

  // Skip Permissions is CLAUDE-CODE ONLY — it bypasses the CLI's permission
  // flow, and a native session has neither a PTY nor that flow. Same gate as
  // the welcome form, SessionStrip's form and the Resume Browser's per-row one.
  const showSkipPermissions = runtime !== 'native';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">
          Project Folder
        </label>
        {/* No onManageProjects on purpose: the buddy window has no
            ArtifactProvider and so no Project View to send anyone to.
            FolderSwitcher renders its "Add a folder…" escape hatch instead
            precisely when this prop is absent (see the WHY there). */}
        <FolderSwitcher value={cwd} onChange={setCwd} />
      </div>
      <div>
        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">
          Model
        </label>
        <ModelPicker value={modelChoice} onSelect={applyModelChoice} />
      </div>
      {/* Native-only extras that are NOT model selection (harness preset,
          local-engine memory-fit warning). They appear because a native model
          was picked, not because a runtime was declared. */}
      {runtime === 'native' && nb.nativeSupported && (
        <NativeExtras nb={nb} preset={preset} onPreset={setPreset} />
      )}
      {showSkipPermissions && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">
              Skip Permissions
            </label>
            {/* Was a hand-rolled 32x18 track with a raw #DD4444 on-state and a
                literal #fff knob. The shared Toggle on the danger tone lets
                theme packs restyle it, same as the main form. The <label>
                beside it isn't bound to this control, so it carries its own
                aria-label. */}
            <Toggle
              checked={dangerous}
              onChange={setDangerous}
              tone="danger"
              aria-label="Skip Permissions"
            />
          </div>
          {dangerous && <SkipPermissionsCaption />}
        </>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={creating}>
          Cancel
        </Button>
        <Button
          onClick={submit}
          disabled={creating || nb.nativeCreateBlocked}
          variant={dangerous && showSkipPermissions ? 'danger' : 'primary'}
          size="sm"
          className="flex-1"
        >
          {creating ? 'Creating…' : (dangerous && showSkipPermissions) ? 'Create (Dangerous)' : 'Create Session'}
        </Button>
      </div>
      {error && (
        <p className="text-3xs text-fg-muted" style={{ margin: 0, textAlign: 'center' }}>
          {error}
        </p>
      )}
    </div>
  );
}
