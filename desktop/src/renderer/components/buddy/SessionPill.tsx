import { useEffect, useState, useCallback } from 'react';
import type { AttentionSummary, SessionInfo } from '../../../shared/types';
import { BuddyNewSessionForm } from './BuddyNewSessionForm';

interface Props {
  viewedSessionId: string | null;
  onChange: (sessionId: string) => void;
  attentionSummary: AttentionSummary | null;
}

export function SessionPill({ viewedSessionId, onChange, attentionSummary }: Props) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // Dropdown has two modes: session list (default) or inline new-session
  // form. The form mirrors the main window's SessionStrip new-session form
  // (folder picker with known projects, model selector, skip permissions)
  // so there's no stray silent-fail path when no default project folder
  // is configured. Shared with BuddyWelcome via BuddyNewSessionForm.
  const [formOpen, setFormOpen] = useState(false);

  // Load sessions from the window directory and stay updated as it changes.
  useEffect(() => {
    const load = async () => {
      const dir = await window.claude.detach.getDirectory();
      if (!dir?.windows) return;
      // Flatten all sessions across all windows, deduplicating by id in case
      // a session ever appears in more than one entry (defensive).
      const all: SessionInfo[] = [];
      const seen = new Set<string>();
      for (const entry of dir.windows) {
        for (const s of (entry.sessions ?? [])) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          all.push(s);
        }
      }
      setSessions(all);
    };
    load();
    // Subscribe to directory push events so the list stays fresh when sessions
    // are created, destroyed, or moved between windows.
    const unsub = window.claude.detach.onDirectoryUpdated(load);
    return unsub;
  }, []);

  // Switch the buddy view to a different session: tell main, subscribe to its
  // events, and notify the parent so it can unsubscribe the previous session.
  // requestTranscriptReplay is owned by BubbleFeed's effect — calling it here
  // would race past listener-registration and drop replay events.
  const selectSession = useCallback(async (sid: string) => {
    await window.claude.buddy.setSession(sid);
    await window.claude.buddy.subscribe(sid);
    onChange(sid);
    setOpen(false);
  }, [onChange]);

  // Session created via the inline form — subscribe + select + close.
  // Mirrors the welcome-screen path (BuddyChat.handleSessionCreated) so the
  // two entry points are interchangeable.
  const handleFormCreated = useCallback(async (sid: string) => {
    setFormOpen(false);
    await selectSession(sid);
  }, [selectSession]);

  const viewed = sessions.find((s) => s.id === viewedSessionId) ?? null;
  const label = viewed ? (viewed.name || basename(viewed.cwd)) : 'no session';
  const dotColor = viewedSessionId
    ? attentionColorFromSummary(viewedSessionId, attentionSummary)
    : 'var(--fg-muted)';

  return (
    <div style={{ position: 'relative', alignSelf: 'center' }}>
      <button
        className="layer-surface"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 14px',
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 500,
          cursor: 'pointer',
          border: 'none',
          color: 'var(--fg)',
          background: 'var(--panel)',
        }}
        onClick={() => setOpen((o) => !o)}
      >
        {/* Status dot — color comes from attention state, stays hardcoded per project convention */}
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
        <span>{label}</span>
        <span style={{ opacity: 0.5, fontSize: 10 }}>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <>
          {/* Click-away backdrop — closes the dropdown without capturing the click.
              Also resets the inline form so reopening the pill always lands on
              the session list, not mid-form. */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99 }}
            onClick={() => { setOpen(false); setFormOpen(false); }}
          />
          <div
            className="layer-surface"
            style={{
              position: 'absolute',
              top: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              marginTop: 6,
              // Widen when the form is open so FolderSwitcher + model pills
              // aren't cramped. 240px is too tight for three model buttons.
              width: formOpen ? 280 : 240,
              padding: formOpen ? 10 : 6,
              borderRadius: 16,
              zIndex: 100,
            }}
          >
            {formOpen ? (
              <BuddyNewSessionForm
                onCreated={handleFormCreated}
                onCancel={() => setFormOpen(false)}
              />
            ) : (
              <>
                {sessions.map((s) => {
                  const attn = attentionSummary?.perSession?.[s.id];
                  // Build a short tag for sessions that need attention.
                  const tag = attn?.awaitingApproval ? 'awaiting'
                    : (attn?.attentionState && attn.attentionState !== 'ok') ? attn.attentionState
                    : null;
                  return (
                    <button
                      key={s.id}
                      onClick={() => selectSession(s.id)}
                      style={{
                        display: 'flex',
                        width: '100%',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 10px',
                        fontSize: 12,
                        // Highlight the currently-viewed session with inset background.
                        background: s.id === viewedSessionId ? 'var(--inset)' : 'transparent',
                        border: 'none',
                        borderRadius: 10,
                        cursor: 'pointer',
                        color: 'var(--fg)',
                      }}
                    >
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: attentionColorFromSummary(s.id, attentionSummary),
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.name || basename(s.cwd)}
                      </span>
                      {tag && (
                        <span style={{ fontSize: 10, color: 'var(--fg-muted)', flexShrink: 0 }}>
                          {tag}
                        </span>
                      )}
                    </button>
                  );
                })}

                {/* Divider */}
                <div style={{ height: 1, background: 'var(--edge-dim)', margin: '4px 0' }} />

                {/* New session entry — expands the inline form (not a silent
                    create). The form mirrors the main window's session strip
                    form so buddy and main stay interchangeable. */}
                <button
                  onClick={() => setFormOpen(true)}
                  style={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    fontSize: 12,
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 10,
                    cursor: 'pointer',
                    color: 'var(--fg)',
                  }}
                >
                  <span style={{ width: 12, textAlign: 'center', flexShrink: 0 }}>+</span>
                  <span>New session…</span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Extract the last path segment (folder/file name) for display. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Map a session's status dot to its hex color. We just forward the color
 * the main window's session switcher computed for this session (pushed via
 * AttentionReport.status) so the buddy dot is visually identical to the
 * same session's dot in the main window. Hex values here match the main
 * window's INDICATOR_COLOR map in SessionStrip.tsx — keep them in sync.
 * Default is gray for sessions that haven't reported yet.
 *
 * Colors match main convention and are theme-independent per project rule:
 * status colors (green/red/blue/amber) stay hardcoded across all themes.
 */
function attentionColorFromSummary(sessionId: string, summary: AttentionSummary | null): string {
  const status = summary?.perSession?.[sessionId]?.status;
  switch (status) {
    case 'green': return '#4CAF50';  // thinking or running tool
    case 'red':   return '#DD4444';  // awaiting approval
    case 'blue':  return '#60A5FA';  // has unseen activity
    case 'gray':
    default:      return '#666666';  // idle / no report yet
  }
}
