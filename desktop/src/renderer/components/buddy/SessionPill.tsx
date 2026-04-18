import { useEffect, useState, useCallback } from 'react';
import type { AttentionSummary, SessionInfo } from '../../../shared/types';

interface Props {
  viewedSessionId: string | null;
  onChange: (sessionId: string) => void;
  attentionSummary: AttentionSummary | null;
}

export function SessionPill({ viewedSessionId, onChange, attentionSummary }: Props) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

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
  // events, request a transcript replay so the bubble feed can catch up, and
  // notify the parent so it can unsubscribe the previous session.
  const selectSession = useCallback(async (sid: string) => {
    await window.claude.buddy.setSession(sid);
    await window.claude.buddy.subscribe(sid);
    window.claude.detach.requestTranscriptReplay(sid);
    onChange(sid);
    setOpen(false);
  }, [onChange]);

  // Create a new session using the user's default project folder as cwd.
  // If no project folder is configured, bail out silently — we don't want to
  // create a session with an empty cwd.
  const createSession = useCallback(async () => {
    const defaults = await window.claude.defaults?.get?.();
    const cwd = defaults?.projectFolder ?? '';
    if (!cwd) return;
    const info = await window.claude.session.create({
      name: basename(cwd),
      cwd,
      skipPermissions: defaults?.skipPermissions ?? false,
    });
    // session.create returns SessionInfo — pull the id directly.
    if (info?.id) await selectSession(info.id);
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
          {/* Click-away backdrop — closes the dropdown without capturing the click */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99 }}
            onClick={() => setOpen(false)}
          />
          <div
            className="layer-surface"
            style={{
              position: 'absolute',
              top: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              marginTop: 6,
              width: 240,
              padding: 6,
              borderRadius: 16,
              zIndex: 100,
            }}
          >
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

            {/* New session entry */}
            <button
              onClick={createSession}
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
 * Map a session's attention state to a status dot color.
 * Purple = active/ok, amber = waiting, red = error/stuck, blue = idle shell,
 * grey = dead. Colors are hardcoded per project convention (theme-independent).
 */
function attentionColorFromSummary(sessionId: string, summary: AttentionSummary | null): string {
  const attn = summary?.perSession?.[sessionId];
  if (!attn) return '#9575ff'; // purple: active, no attention data yet
  if (attn.awaitingApproval) return '#f5a623'; // amber: needs permission
  switch (attn.attentionState) {
    case 'error':
    case 'stuck':         return '#ef4444'; // red: something's wrong
    case 'awaiting-input': return '#f5a623'; // amber: waiting for user input
    case 'shell-idle':    return '#60a5fa'; // blue: idle at shell prompt
    case 'session-died':  return '#6b7280'; // grey: dead
    default:              return '#9575ff'; // purple: ok / running
  }
}
