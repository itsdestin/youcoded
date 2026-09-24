import { useState } from 'react';
import type { ToolCallState } from '../../../shared/types';

/**
 * The two things a person can do to a running helper — from its card, and
 * from the specialists popup (SpecialistsChip), same component both places. Both go
 * through the same host methods the assistant's own task_id calls use
 * (steerSpecialist / interruptSpecialist) — one mechanism, two callers.
 */
// Task 12 / spec: the backend caps a steer note at 2,000 characters. The box
// used to give no indication of that until the send actually failed — this
// is the single source of truth for the visible counter and the Send gate.
const MAX = 2000;

export function SpecialistActions({ sessionId, run, compact = false }: {
  sessionId: string;
  run: NonNullable<ToolCallState['specialistRun']>;
  /** Popup rows: ghost text buttons at rest, the note box only when opened. */
  compact?: boolean;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'note' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = run.title.split(' ')[0];
  const send = async () => {
    const text = note.trim();
    // Fix: the 2,000-char cap used to be enforced only by the Send button's
    // `disabled` attribute — pressing Enter in the textarea called send()
    // directly and skipped that check entirely, so a user who saw the
    // greyed-out button and pressed Enter anyway still fired an over-cap
    // request. Guarding here means send() itself refuses, no matter which
    // path (button, Enter, or anything added later) tries to call it.
    if (!text || note.length > MAX) return;
    setBusy('note'); setError(null);
    try {
      const res = await window.claude.specialists.steer(sessionId, run.childId, text);
      if (res && res.ok === false) { setError(res.error || `Couldn’t deliver the note to ${first}.`); }
      else { setNote(''); setNoteOpen(false); }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const stop = async () => {
    setBusy('stop'); setError(null);
    try {
      const res = await window.claude.specialists.interrupt(sessionId, run.childId);
      if (res && res.ok === false) setError(res.error || `Couldn’t stop ${first}.`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const btn = compact
    ? 'text-2xs px-2 py-0.5 rounded-md border border-edge text-fg-dim hover:text-fg-2 hover:bg-inset transition-colors disabled:opacity-50'
    : 'text-xs px-2 py-0.5 rounded-md border border-edge hover:bg-inset/60 transition-colors text-fg-2 disabled:opacity-50';
  return (
    <div className={compact ? 'space-y-1' : 'space-y-1.5'} data-testid="specialist-actions">
      <div className={`flex items-center ${compact ? 'gap-1.5' : 'gap-2'}`}>
        <button type="button" onClick={() => setNoteOpen(v => !v)} className={btn} aria-expanded={noteOpen}>
          {compact ? 'Note' : `Send ${first} a note`}
        </button>
        <button type="button" onClick={stop} disabled={busy !== null} className={btn}>
          {busy === 'stop' ? 'Stopping…' : 'Stop'}
        </button>
      </div>
      {noteOpen && (
        <div className="space-y-1">
          <div className="flex items-start gap-2">
            {/* No `maxLength` here on purpose: it would silently truncate a
                paste — the counter below would read "2,200 / 2,000" while
                the rest of what the user pasted just vanished with no
                warning. The counter plus the disabled Send button already
                say the note is too long; that's honest, a silent truncation
                is not. */}
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              rows={2}
              // Destin's 2026-08-26/27 copy review: "it's applied", so the clause has a subject.
              placeholder={`Anything ${first} should know mid-run — it's applied at its next step`}
              className="flex-1 min-w-0 text-xs rounded-md border border-edge bg-canvas px-2 py-1 text-fg resize-y"
            />
            <button
              type="button"
              onClick={send}
              // Fix: Send used to only gate on emptiness, so a paste over the
              // 2,000-char backend cap looked sendable right up until the
              // request came back with an error. Gating here means the cap
              // is visible before the user tries, not after.
              disabled={busy !== null || !note.trim() || note.length > MAX}
              // A filled accent button with a dead hover; same steps as Button's primary.
              className="text-xs px-2 py-1 rounded-md bg-accent text-on-accent hover:bg-accent/90 active:bg-accent/80 transition-colors disabled:opacity-50"
            >
              {busy === 'note' ? 'Sending…' : 'Send'}
            </button>
          </div>
          <div className="text-right">
            <span className="text-3xs text-fg-muted">{note.length.toLocaleString()} / {MAX.toLocaleString()}</span>
          </div>
        </div>
      )}
      {/* Fix: `danger` isn't a real token (globals.css defines no --color-danger),
          so this error rendered in ordinary body text with no red at all.
          `destructive-fg` matches how every other inline error in the app is styled
          (e.g. AddProjectModal, ContextEditorOverlay). */}
      {error && <div className="text-xs text-destructive-fg">{error}</div>}
    </div>
  );
}

