import { useCallback, useState } from 'react';
import { ThemeMascot, WelcomeAppIcon } from '../Icons';
import FolderSwitcher from '../FolderSwitcher';
import { MODELS } from '../StatusBar';

// Same labels as App.tsx's welcome form — keep in sync if that list changes.
const WELCOME_MODEL_LABELS: Record<string, string> = {
  sonnet: 'Sonnet',
  'opus[1m]': 'Opus 1M',
  haiku: 'Haiku',
};

/**
 * Buddy empty-state — mirrors the main app's no-active-session screen
 * (mascot + "No Active Session" + New Session/Resume buttons) with an
 * expandable form identical in logic to App.tsx's welcome form, just
 * restyled compactly for 320×480.
 *
 * Fields (expanded): FolderSwitcher, model pill group, skip-permissions
 * toggle, Cancel / Create buttons. Identical create flow to main's form
 * so the two welcome screens are interchangeable.
 */
interface Props {
  /** Called with the newly-created session id so BuddyChat can subscribe + set view. */
  onSessionCreated: (sessionId: string) => void;
}

export function BuddyWelcome({ onSessionCreated }: Props) {
  const [formOpen, setFormOpen] = useState(false);
  const [cwd, setCwd] = useState('');
  const [dangerous, setDangerous] = useState(false);
  const [model, setModel] = useState<string>('sonnet');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill from the user's saved defaults when the form opens. Mirrors
  // App.tsx:1657-1660 (the main form pulls from sessionDefaults). We read
  // once on demand — the form opens rarely enough that useEffect on mount
  // would waste work most of the time.
  const openForm = useCallback(async () => {
    setError(null);
    try {
      const defaults = await window.claude.defaults?.get?.();
      setCwd(defaults?.projectFolder ?? '');
      setDangerous(defaults?.skipPermissions ?? false);
      setModel(defaults?.model ?? 'sonnet');
    } catch {
      // Fall through to defaults-of-defaults
    }
    setFormOpen(true);
  }, []);

  const submit = useCallback(async () => {
    if (creating) return;
    if (!cwd) {
      setError('Pick a project folder first.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const info = await (window.claude.session.create as any)({
        name: 'New Session',
        cwd,
        skipPermissions: dangerous,
        model,
        provider: 'claude',
      });
      if (info?.id) {
        onSessionCreated(info.id);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Could not start a session.');
      setCreating(false);
    }
  }, [creating, cwd, dangerous, model, onSessionCreated]);

  const openResume = useCallback(() => {
    // Buddy is too small to host the full ResumeBrowser modal. Wiring a
    // peer-window "focus main + open resume" flow is a separate pass
    // (needs new IPC + App.tsx listener); for now surface a short hint
    // so the button reads as intentional rather than broken.
    setError('Open Resume from the main window for now.');
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 10,
        padding: '0 16px',
      }}
    >
      {!formOpen ? (
        // Collapsed state — mirrors App.tsx:1652-1676
        <>
          <ThemeMascot variant="welcome" fallback={WelcomeAppIcon} className="w-24 h-24 text-fg-dim" />
          <p style={{ fontSize: 14, color: 'var(--fg-muted)', margin: 0 }}>No Active Session</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', marginTop: 4 }}>
            <button
              onClick={openForm}
              className="panel-glass"
              style={{
                width: '100%',
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 500,
                borderRadius: 10,
                border: 'none',
                cursor: 'pointer',
                background: 'var(--accent)',
                color: 'var(--on-accent)',
              }}
            >
              New Session
            </button>
            <button
              onClick={openResume}
              className="panel-glass"
              style={{
                width: '100%',
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 500,
                borderRadius: 10,
                border: 'none',
                cursor: 'pointer',
                background: 'var(--inset)',
                color: 'var(--fg-dim)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Resume Session</span>
            </button>
          </div>
          {error && (
            <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: 0, textAlign: 'center' }}>
              {error}
            </p>
          )}
        </>
      ) : (
        // Expanded form — mirrors App.tsx:1594-1651 with compacted styles.
        <div className="layer-surface" style={{ width: '100%', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <label style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--fg-muted)', display: 'block', marginBottom: 4 }}>
              Project Folder
            </label>
            <FolderSwitcher value={cwd} onChange={setCwd} />
          </div>
          <div>
            <label style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--fg-muted)', display: 'block', marginBottom: 4 }}>
              Model
            </label>
            <div style={{ display: 'flex', gap: 4 }}>
              {MODELS.map((m) => (
                <button
                  key={m}
                  onClick={() => setModel(m)}
                  style={{
                    flex: 1,
                    padding: '4px 4px',
                    fontSize: 10,
                    borderRadius: 6,
                    border: 'none',
                    cursor: 'pointer',
                    background: model === m ? 'var(--accent)' : 'var(--inset)',
                    color: model === m ? 'var(--on-accent)' : 'var(--fg-dim)',
                    fontWeight: model === m ? 500 : 400,
                  }}
                >
                  {WELCOME_MODEL_LABELS[m] || m}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <label style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--fg-muted)' }}>
              Skip Permissions
            </label>
            <button
              onClick={() => setDangerous(!dangerous)}
              style={{
                width: 32,
                height: 18,
                borderRadius: 999,
                border: 'none',
                cursor: 'pointer',
                background: dangerous ? '#DD4444' : 'var(--inset)',
                position: 'relative',
              }}
              aria-pressed={dangerous}
              aria-label="Skip permissions"
            >
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  left: dangerous ? 'calc(100% - 16px)' : 2,
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: '#fff',
                  transition: 'left 150ms ease',
                }}
              />
            </button>
          </div>
          {dangerous && (
            <p style={{ fontSize: 10, color: '#DD4444', margin: 0 }}>
              Claude will execute tools without asking for approval.
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              onClick={() => setFormOpen(false)}
              disabled={creating}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                borderRadius: 8,
                border: 'none',
                cursor: creating ? 'default' : 'pointer',
                background: 'var(--inset)',
                color: 'var(--fg-dim)',
              }}
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={creating}
              style={{
                flex: 1,
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 500,
                borderRadius: 8,
                border: 'none',
                cursor: creating ? 'default' : 'pointer',
                background: dangerous ? '#DD4444' : 'var(--accent)',
                color: dangerous ? '#fff' : 'var(--on-accent)',
                opacity: creating ? 0.6 : 1,
              }}
            >
              {creating ? 'Creating…' : dangerous ? 'Create (Dangerous)' : 'Create Session'}
            </button>
          </div>
          {error && (
            <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: 0, textAlign: 'center' }}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
