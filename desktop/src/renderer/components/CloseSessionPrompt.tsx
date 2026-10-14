import { useCallback, useEffect, useState } from 'react';
import { memoWhileClosed } from './memo-while-closed';
import { triggerTip } from './guide/tips';
import { useTagRegistry } from '../hooks/useTagRegistry';
import { SessionHeaderCard, SessionListsCard, SessionTagsCard } from './tags/SessionDetails';
import SessionRenameDialog from './SessionRenameDialog';
import { Button, Callout, Dialog, FoldRow, Toggle } from './ui';
import { META_UNSUPPORTED_FALLBACK, type SessionMetaResult } from '../../shared/types';
import { plainMessage } from '../utils/ipc-error';

// The two reserved flags, serialised in this order into buildResult's `flags`.
// Priority shows as "Pin to top" (pick-menus-2#PM2-3); Complete is the prompt's own question.
type FlagName = 'priority' | 'complete';
const FLAG_ORDER: FlagName[] = ['priority', 'complete'];

interface Props {
  open: boolean;
  sessionName?: string;
  sessionId?: string | null;
  onCancel: () => void;
  // onConfirm receives a DELTA in every field. The prompt preloads the session's
  // current flags/tags/note (so what is already applied shows as applied) and
  // reports only what the user changed off that baseline: `flags` carries the
  // reserved flags whose value MOVED, addTagIds/removeTagIds the tags toggled
  // on/off, and noteChanged gates the note write.
  //
  // `flags` used to be a set-only FlagName[] — every listed flag was written
  // true and nothing could be cleared. That was fine while the two reserved
  // flags were a "mark on close" action that always started off. It stopped
  // being fine when Priority became a tag in this picker (2026-07-31): it now
  // preloads as applied, so un-toggling it has to be able to clear it, exactly
  // like un-toggling a real tag does.
  onConfirm: (result: {
    flags: Partial<Record<FlagName, boolean>>;
    addTagIds: string[]; removeTagIds: string[]; note: string; noteChanged: boolean;
  }) => void;
}

// localStorage key used to suppress this prompt permanently. Exported so
// App.tsx can check it before deciding whether to show the prompt.
export const CLOSE_PROMPT_SUPPRESS_KEY = 'youcoded-close-prompt-disabled';
const SUPPRESS_KEY = CLOSE_PROMPT_SUPPRESS_KEY;

// Shown when the user closes an active session. Preloads the session's current
// tags + note (so applied tags stay selected — nothing changes unless the user
// toggles it), and lets them set Pin to top / Mark complete in the same step.
//
// WHY it is Session details now (backlog row 17, Destin 2026-10-04 "want to work on this
// page more"; deck close-session-1): every other surface edits a session's name, note, tags
// and pin in Session details, whose Tags card is edited in place — this prompt was the last
// one on the older editor (a summary card that swapped into a second form, with Mark
// complete pushed below the fold). It now shows the same cards: the session's own card (no
// label — the card about the popup's subject), the Tags card, then one card for the two
// yes/no facts. Unlike Session details nothing here writes until Close session: the cards
// edit local state and the caller writes the delta (tag renames/colours still write at once,
// as everywhere).
function CloseSessionPrompt({ open, sessionName, sessionId, onCancel, onConfirm }: Props) {
  const [sel, setSel] = useState<Record<FlagName, boolean>>({ priority: false, complete: false });
  // "Don't show again" — persisted to localStorage so the caller can skip this
  // prompt on future closes. Default off so users see it at least once.
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const registry = useTagRegistry();
  const [tagIds, setTagIds] = useState<Set<string>>(new Set());
  // The notes tip's moment: the first time this prompt shows (guide/tips.ts).
  useEffect(() => { if (open) triggerTip('notes'); }, [open]);
  // Rename opens the shared rename popup over this one (Session details' name card does the
  // same). It writes at once, like a tag rename; the name shown follows the session list.
  const [renaming, setRenaming] = useState(false);
  // Try again on a failed read re-runs the load below.
  const [attempt, setAttempt] = useState(0);
  // A failed read's own words, shown only under Details (submit-ticket-5#ST5-9: the
  // operation's text is for a bug report, not the message). Null when the read worked.
  const [readError, setReadError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // The session's tags/note as loaded on open — the baseline for the delta, so
  // Cancel changes nothing and Confirm only writes what the user toggled.
  const [original, setOriginal] = useState<{ tags: Set<string>; note: string; flags: Record<FlagName, boolean> }>(
    { tags: new Set(), note: '', flags: { priority: false, complete: false } },
  );
  // False for sessions whose meta the backend refuses to store — as of Task 5
  // that's Android only (desktop native sessions are real store records now).
  // This prompt writes flags/tags/note and then IMMEDIATELY destroys the
  // session, so there is never a read-back to reveal a refused write — the
  // only honest option is to not offer the controls at all. See
  // META_UNSUPPORTED_FALLBACK.
  const [metaSupported, setMetaSupported] = useState(true);
  // Host-supplied wording — Android's reason differs from the desktop's.
  const [metaReason, setMetaReason] = useState(META_UNSUPPORTED_FALLBACK);
  // Gate the meta section on the getMeta round-trip completing. Without this the
  // NoteEditor mounts optimistically, and text typed before the response arrives
  // is committed by its unmount-commit effect when the section then disappears —
  // producing a note write that gets refused. Cheap: the IPC is sub-frame.
  const [metaLoaded, setMetaLoaded] = useState(false);

  // On open, preload the session's current flags + tags + note so whatever is
  // already applied SHOWS as applied.
  //
  // Reserved flags used to be excluded from this preload deliberately — they
  // were a "mark on close" action rather than state read back. That stopped
  // holding when Priority became an ordinary-looking tag in this picker: a
  // session already flagged Priority would have shown it unapplied, and
  // toggling it on then off would have done nothing. getMeta carries flags as
  // of 2026-07-31, so both are read and both round-trip through the delta.
  const EMPTY_FLAGS: Record<FlagName, boolean> = { priority: false, complete: false };
  useEffect(() => {
    if (!open) return;
    setSel({ ...EMPTY_FLAGS });
    setRenaming(false);
    setDontShowAgain(false);
    setReadError(null);
    setMetaSupported(true);
    setMetaLoaded(false);
    const blank = { tags: new Set<string>(), note: '', flags: { ...EMPTY_FLAGS } };
    if (!sessionId) { setTagIds(new Set()); setNote(''); setOriginal(blank); setMetaLoaded(true); return; }
    let cancelled = false;
    // WHY a failed read is shown as one (error inventory 2026-09-10, false message 12):
    // both hosts and this catch used to answer blanks, so the prompt showed "No note"
    // for a conversation that had one — and that blank was the delta's baseline, so
    // typing a note REPLACED the stored one nobody was shown. A failed read now takes
    // the existing "can't be changed here" state: the reason shows, the controls do
    // not, and the blank baseline means confirming writes no note and no tags.
    const unreadable = (reason: string) => {
      setTagIds(new Set()); setNote(''); setOriginal(blank);
      setMetaSupported(false);
      setReadError(reason);
      setMetaLoaded(true);
    };
    Promise.resolve((window as any).claude.session.getMeta(sessionId))
      .then((m: SessionMetaResult) => {
        if (cancelled) return;
        if (m?.unreadable) { unreadable(m.unreadable); return; }
        const tags = new Set(m?.tags ?? []);
        // Missing `flags` = Android or an older remote peer. Absent reads as
        // "none set", never as an error.
        const flags: Record<FlagName, boolean> = {
          priority: !!m?.flags?.priority,
          complete: !!m?.flags?.complete,
        };
        setTagIds(new Set(tags));
        setNote(m?.note ?? '');
        setSel({ ...flags });
        setOriginal({ tags, note: m?.note ?? '', flags });
        // Missing field = older backend; assume supported rather than hiding the UI.
        setMetaSupported(m?.supported !== false);
        setMetaReason(m?.unsupportedReason || META_UNSUPPORTED_FALLBACK);
        setMetaLoaded(true);
      })
      .catch((err: unknown) => { if (!cancelled) unreadable(plainMessage(err)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId, attempt]);

  // Reserved flags to set + the tag delta (add/remove vs. the loaded baseline) +
  // the note. useCallback keeps a stable identity so the Enter effect below
  // doesn't re-subscribe its keydown listener every render.
  const buildResult = useCallback(() => ({
    flags: Object.fromEntries(
      FLAG_ORDER.filter((f) => sel[f] !== original.flags[f]).map((f) => [f, sel[f]]),
    ) as Partial<Record<FlagName, boolean>>,
    addTagIds: [...tagIds].filter((id) => !original.tags.has(id)),
    removeTagIds: [...original.tags].filter((id) => !tagIds.has(id)),
    note,
    noteChanged: note !== original.note,
  }), [sel, tagIds, note, original]);

  // WHY one confirm for the button and Enter: Enter used to call onConfirm directly and so
  // skipped "Don't show again" — the prompt came back next time although the switch was on.
  const confirm = () => {
    // Persist the suppress preference first so the caller can skip the prompt on the next close.
    if (dontShowAgain) localStorage.setItem(SUPPRESS_KEY, '1');
    onConfirm(buildResult());
  };

  if (!open) return null;

  const toggleTag = (id: string, next: boolean) =>
    setTagIds((prev) => { const s = new Set(prev); if (next) s.add(id); else s.delete(id); return s; });
  const name = sessionName || 'Untitled session';
  const tagsProps = { registry, appliedIds: tagIds, onToggleTag: toggleTag };
  const rename = sessionId ? () => setRenaming(true) : undefined;

  return (
    <>
      {/* The shared popup at Session details' width (`panel`, 420px — still a narrow popup),
          titled by what it does. The session's name moved from the subtitle into its own
          card, as on Session details and the detail pages (guide: the item's name is in the
          top card, not the title). */}
      {/* WHY the shared body, footer and Enter (close-session-friction proposals 1 and 2): this
          prompt wired its own scroll band (it had a hard cut under the footer until round 1) and
          its own window Enter listener (it closed the session from a focused tag). The Dialog
          now owns both: the body scrolls under the see-through fade, the footer stays put, and
          Enter is `onEnter` — only when this is the top popup and no control has the keyboard.
          No useEscClose of its own: the Dialog's entry must be the top one for Enter. */}
      <Dialog screen="chat/close-session" open onClose={onCancel} size="panel" title="Close session"
        onEnter={confirm}
        footer={
          // P-15 (review 2026-08-26): the dialog has a ✕, so no Cancel. "Don't show again" sits
          // bottom-left beside the one filled button — allowed by the guide because the button
          // balances it on the same line (principle 6).
          <div className="flex items-center justify-between gap-3">
            {/* Persists the suppress flag so App.tsx skips this prompt on future closes. */}
            <label className="flex items-center gap-2 text-2xs text-fg-muted whitespace-nowrap cursor-pointer">
              <Toggle checked={dontShowAgain} onChange={setDontShowAgain} aria-label="Don't show again" />
              Don't show again
            </label>
            <Button size="sm" className="whitespace-nowrap" onClick={confirm}>Close session</Button>
          </div>
        }>
            {!metaLoaded ? null : !metaSupported ? (
              <>
                {/* WHY the notice and its Details fold sit INSIDE the name card (Destin,
                    final-review#CH-11: "this details box is weird/unique i think?"): the
                    Details fold stood alone on the popup as a first-level box holding one
                    word — no other screen draws that. The reference is a detail page's
                    failed install, whose notice box and Details fold sit inside the item's
                    top card (DetailPage InstallFailed); the guide puts a notice about one
                    thing inside that thing. One plain sentence saying what still works,
                    Try again inside it when it was a failed read, the operation's own words
                    folded under Details (submit-ticket-5#ST5-9). A host that simply cannot
                    store them (Android) is information, not an error: its own sentence, no
                    button. Name only above it: the note could not be read (or cannot be
                    stored here), so nothing may suggest it is empty or editable. */}
                <SessionHeaderCard name={name} note="">
                  {readError !== null ? (
                    <>
                      <Callout tone="danger" actionsPlacement="below"
                        actions={<Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>
                        Couldn’t load this conversation’s tags and note, so they can’t be changed here. Closing it still works.
                      </Callout>
                      {readError && <FoldRow title="Details">
                        <p className="text-2xs text-fg-2 font-mono break-all">{readError}</p>
                      </FoldRow>}
                    </>
                  ) : (
                    <Callout tone="info">{metaReason}</Callout>
                  )}
                </SessionHeaderCard>
              </>
            ) : (
              <>
                {/* Pending writes: the note and tags edit local state; Close session commits. */}
                <SessionHeaderCard name={name} onRename={rename} note={note} onNote={setNote} />
                <SessionTagsCard {...tagsProps} />
                {/* "In your lists" — the same card as Session details (close-session-2#CS2-2,
                    #CS2-5). Here its switches edit local state, written on Close session. */}
                <SessionListsCard
                  pin={{ pinned: sel.priority, onPin: (next) => setSel((prev) => ({ ...prev, priority: next })) }}
                  complete={{ done: sel.complete, onComplete: (next) => setSel((prev) => ({ ...prev, complete: next })) }} />
              </>
            )}
      </Dialog>
      {renaming && sessionId && <SessionRenameDialog id={sessionId} name={name} onClose={() => setRenaming(false)} />}
    </>
  );
}

// WHY (2026-10-05): mounted by the shell all the time, so every session switch rebuilt this closed popup.
// memoWhileClosed ignores prop changes until `open` flips (memo-while-closed.ts).
export default memoWhileClosed(CloseSessionPrompt);
