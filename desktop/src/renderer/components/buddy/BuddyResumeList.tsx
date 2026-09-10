import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui';
import ModelPicker, { type ModelChoice } from '../model/ModelPicker';
import { persistLastBinding } from '../RuntimeBinding';
import { runLeaseTakeoverGate } from '../../state/resume-lease-gate';
import { takeoverDialogCopy, type TakeoverDialogPhase } from '../takeover-dialog-copy';
import { buildSessionCreateArgs } from '../../../shared/session-create-args';
import { RESUMING_CLAUDE, RESUMING_NATIVE } from '../../../shared/session-title';

/** The subset of session.browse()'s row this list reads. The full shape lives
 *  on ResumeBrowser; restating only what is used keeps the two from coupling. */
interface PastSession {
  sessionId: string;
  name: string;
  projectSlug: string;
  projectPath: string;
  lastModified: number;
  flags?: Partial<Record<string, boolean>>;
  provider?: string;
  /** The conversation's project folder is not on this device — nothing to resume into. */
  missingProject?: boolean;
  /** The folder is here but the transcript hasn't been pulled down yet. */
  notSyncedYet?: boolean;
  /** The model this conversation last ran a turn with — pre-fills the picker
   *  when that model exists on THIS device. No match leaves it un-prefilled. */
  lastUsedModel?: import('../../../shared/types').PortableModelRef;
}

interface Props {
  /** Called with the newly-created session id once a resume launches. */
  onResumed: (sessionId: string) => void;
  /** Back to the welcome buttons. */
  onCancel: () => void;
}

/** How many conversations the floater lists. The full browser (search, project
 *  filters, tags, notes) stays in the main window — this is the recent shelf. */
const MAX_ROWS = 20;

/**
 * Resume a past conversation from inside the buddy floater.
 *
 * WHY THIS EXISTS (Destin, 2026-09-10). The floater's "Resume Session" button
 * was a placeholder written in July: clicking it printed "Open Resume from the
 * main window for now" and did nothing else. Asked what it should do, Destin
 * chose a short list inside the buddy over bouncing to the main window — the
 * point of the floater is finishing a job without leaving it.
 *
 * Deliberately NOT the Resume Browser. That modal is search + project filters +
 * tag picker + notes + rename, and none of it fits 320px. This is the last
 * {@link MAX_ROWS} conversations, newest first, tap to pick one back up. Anything
 * more is what the main window is for.
 *
 * Two rules it must honour, both of which are the reason it reuses shared code
 * rather than reimplementing the flow:
 *   · Native resume ALWAYS offers the model selector and NEVER auto-launches a
 *     stored binding (Destin's ruling, Task 6). So does this list.
 *   · The conversation-lease takeover gate never hard-blocks and tells the
 *     truth about which of the three states it is in — see resume-lease-gate.ts.
 *
 * Pinned by tests/buddy-resume-list.test.tsx.
 */
export function BuddyResumeList({ onResumed, onCancel }: Props) {
  const [rows, setRows] = useState<PastSession[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The lease gate's question, rendered inline — the buddy has no modal layer. */
  const [takeover, setTakeover] = useState<{ device: string; phase: TakeoverDialogPhase } | null>(null);
  const takeoverResolveRef = useRef<((choice: boolean) => void) | null>(null);

  const [defaultAlias, setDefaultAlias] = useState('sonnet');
  const [defaultDangerous, setDefaultDangerous] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const past = await (window as any).claude.session.browse();
        if (cancelled) return;
        setRows(Array.isArray(past) ? past : []);
      } catch {
        if (!cancelled) { setRows([]); setLoadFailed(true); }
      }
    })();
    (async () => {
      try {
        const d = await window.claude.defaults?.get?.();
        if (cancelled || !d) return;
        setDefaultAlias(d.model ?? 'sonnet');
        setDefaultDangerous(d.skipPermissions ?? false);
      } catch { /* best-effort — the alias below falls back to sonnet */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Newest first, completed ones hidden. `complete` is the flag the main browser
  // hides behind its "Show Complete" switch; with no room for that switch here,
  // honour the flag's intent rather than showing conversations the user filed away.
  const visible = useMemo(() => (rows ?? [])
    .filter((s) => !s.flags?.complete)
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, MAX_ROWS), [rows]);

  const askTakeover = useCallback((device: string, phase: TakeoverDialogPhase) =>
    new Promise<boolean>((resolve) => {
      // One resolver slot, same reentrancy guard App uses: a second ask while one
      // is pending resolves the first as declined so nothing awaits forever.
      takeoverResolveRef.current?.(false);
      takeoverResolveRef.current = resolve;
      setTakeover({ device, phase });
    }), []);

  const answerTakeover = useCallback((answer: boolean) => {
    setTakeover(null);
    const r = takeoverResolveRef.current;
    takeoverResolveRef.current = null;
    r?.(answer);
  }, []);

  /** What a row will launch on, once expanded. Native rows start with nothing
   *  chosen — that is the "never auto-launch a binding" rule, not an oversight. */
  const rowChoice = useCallback((s: PastSession): ModelChoice | null => {
    if (s.provider === 'native') return choice?.runtime === 'native' ? choice : null;
    return choice ?? { runtime: 'claude', alias: defaultAlias };
  }, [choice, defaultAlias]);

  const resume = useCallback(async (s: PastSession) => {
    const picked = rowChoice(s);
    if (!picked) return; // native row with no model chosen — the button is disabled
    setResuming(s.sessionId);
    setError(null);
    setWarning(null);
    try {
      const proceed = await runLeaseTakeoverGate({
        claudeSessionId: s.sessionId,
        askTakeover,
        onWarn: setWarning,
      });
      if (!proceed) { setResuming(null); return; }

      const native = picked.runtime === 'native';
      if (native) persistLastBinding({ providerId: picked.providerId, modelId: picked.modelId });
      const info = await (window.claude.session.create as any)(buildSessionCreateArgs({
        // The RESUMING_* constants, not a bare literal: main's title feeder has
        // to RECOGNISE these as placeholders or auto-titling stays blocked for
        // the whole resumed conversation (shared/session-title.ts).
        name: native ? RESUMING_NATIVE : RESUMING_CLAUDE,
        cwd: s.projectPath,
        runtime: picked.runtime,
        model: native ? undefined : picked.alias,
        skipPermissions: defaultDangerous,
        binding: native ? { providerId: picked.providerId, modelId: picked.modelId } : null,
        resumeSessionId: s.sessionId,
      }));
      if (!info?.id) {
        // Non-committal: the exact cause isn't known on this side, and main
        // emits its own session-error for the refusal cases (which DO return an
        // id, so they don't land here). See docs/error-message-standards.md.
        setError("Couldn't resume this conversation.");
        setResuming(null);
        return;
      }
      onResumed(info.id);
    } catch {
      setError("Couldn't resume this conversation.");
      setResuming(null);
    }
  }, [rowChoice, askTakeover, defaultDangerous, onResumed]);

  // ── The inline takeover ask. Replaces main's modal; same words. ────────────
  if (takeover) {
    const copy = takeoverDialogCopy(takeover.phase, takeover.device);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 4px' }}>
        <p className="text-xs text-fg" style={{ margin: 0, lineHeight: 1.45 }}>{copy.lead}</p>
        {copy.consequence && (
          <p className="text-3xs text-fg-muted" style={{ margin: 0, lineHeight: 1.45 }}>{copy.consequence}</p>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" size="sm" onClick={() => answerTakeover(false)}>Never mind</Button>
          <Button variant="primary" size="sm" className="flex-1" onClick={() => answerTakeover(true)}>Take over</Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Recent</label>
        <button
          onClick={onCancel}
          className="text-3xs text-fg-muted hover:text-fg transition-colors"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          Back
        </button>
      </div>

      {rows === null ? (
        <p className="text-3xs text-fg-muted" style={{ margin: 0 }}>Loading…</p>
      ) : loadFailed ? (
        <p className="text-3xs text-fg-muted" style={{ margin: 0 }}>Couldn&rsquo;t load your conversations.</p>
      ) : visible.length === 0 ? (
        <p className="text-3xs text-fg-muted" style={{ margin: 0 }}>No conversations to pick up yet.</p>
      ) : (
        <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, minHeight: 0 }}>
          {visible.map((s) => {
            const blocked = s.missingProject || s.notSyncedYet;
            const expanded = expandedId === s.sessionId;
            const picked = rowChoice(s);
            return (
              <div key={s.sessionId}>
                <button
                  disabled={!!blocked}
                  onClick={() => {
                    // Opening a different row drops the previous row's pick: a
                    // model chosen for one conversation must never silently
                    // become the model another one resumes on.
                    setChoice(null);
                    setExpandedId(expanded ? null : s.sessionId);
                  }}
                  style={{
                    display: 'flex', width: '100%', alignItems: 'baseline', gap: 6,
                    padding: '6px 8px', border: 'none', borderRadius: 8,
                    background: expanded ? 'var(--inset)' : 'transparent',
                    cursor: blocked ? 'default' : 'pointer',
                    opacity: blocked ? 0.55 : 1,
                    color: 'var(--fg)', textAlign: 'left',
                  }}
                >
                  <span className="text-xs" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.name || basename(s.projectPath)}
                  </span>
                  <span className="text-3xs text-fg-muted" style={{ flexShrink: 0 }}>{relativeTime(s.lastModified)}</span>
                </button>
                <div className="text-3xs text-fg-muted" style={{ padding: '0 8px 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {/* Say WHY a row can't be picked up rather than leaving a dead
                      grey line — the two states are genuinely different. */}
                  {s.missingProject
                    ? `Its project folder isn't on this device`
                    : s.notSyncedYet
                      ? `Hasn't synced to this device yet`
                      : basename(s.projectPath)}
                </div>
                {expanded && !blocked && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 8px 8px' }}>
                    <ModelPicker
                      value={picked}
                      onSelect={setChoice}
                      // Opens on the model this conversation last ran with, when
                      // that model exists here. Never a fallback guess — see the
                      // prop's own note.
                      prefill={s.lastUsedModel}
                      // A resume cannot move a conversation between runtimes —
                      // the transcript belongs to the engine that wrote it.
                      includeClaude={s.provider !== 'native'}
                      includeNative={s.provider === 'native'}
                      emptyLabel="Choose a model…"
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!picked || resuming === s.sessionId}
                      onClick={() => resume(s)}
                    >
                      {resuming === s.sessionId ? 'Resuming…' : 'Resume'}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {warning && <p className="text-3xs text-warning-fg" style={{ margin: 0 }}>{warning}</p>}
      {error && <p className="text-3xs text-fg-muted" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}

/** Last path segment, for naming a conversation by its folder. */
function basename(path: string): string {
  const parts = (path || '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Compact age — the row has room for about six characters. */
function relativeTime(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}
