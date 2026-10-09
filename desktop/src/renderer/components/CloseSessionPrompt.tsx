import { useCallback, useEffect, useState } from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import { useScrollFade } from '../hooks/useScrollFade';
import { triggerTip } from './guide/tips';
import { useTagRegistry } from '../hooks/useTagRegistry';
import { PinRow, SessionHeaderCard, SessionTagsCard, SessionTagsFold } from './tags/SessionDetails';
import SessionRenameDialog from './SessionRenameDialog';
import { Button, Callout, CARD_LEVEL_1, Dialog, FoldRow, SettingRow, Toggle } from './ui';
import { META_UNSUPPORTED_FALLBACK, type SessionMetaResult } from '../../shared/types';
import { plainMessage } from '../utils/ipc-error';
import { isTypingTarget } from '../utils/is-typing-target';
import { workbenchCloseTagsFolded } from '../close-prompt-practice';

// The two reserved flags, serialised in this order into buildResult's `flags`.
// Priority shows as "Pin to top" (pick-menus-2#PM2-3); Complete is the prompt's own question.
type FlagName = 'priority' | 'complete';
const FLAG_ORDER: FlagName[] = ['priority', 'complete'];

const COMPLETE_TITLE = 'Mark complete';
const COMPLETE_HINT = 'Hides it from the resume list unless you turn on Show complete.';

/** The Resume card's check-in-a-circle, so marking complete looks the same in both places.
 *  WHY kept as the row's icon: it shares a card with Pin to top, whose pin icon would
 *  otherwise leave the two rows' words starting at different edges. The check knocks out
 *  with var(--canvas), never a fixed white, so it survives dark and community themes. */
function CompleteGlyph({ done, className = '' }: { done: boolean; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" fill={done ? 'currentColor' : 'none'} />
      <path d="M8 12.5l2.5 2.5L16 9.5" stroke={done ? 'var(--canvas)' : 'currentColor'} />
    </svg>
  );
}

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
export default function CloseSessionPrompt({ open, sessionName, sessionId, onCancel, onConfirm }: Props) {
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
  // WHY its own fade: this dialog owns its scroll band (scrollBody={false}, so its footer stays
  // put), and Dialog's fade only reaches the body it owns. With a tag's edit box open the band
  // scrolls, and without this it ended in a hard cut under the footer (guide: the content
  // fades at the hidden edge, never a solid strip). The masked fade (`.scroll-mask`, the
  // content itself fading), never the painted band — scroll-mask.test.ts. Declared before the
  // early return.
  const bodyRef = useScrollFade<HTMLDivElement>();
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

  // ESC is routed through the central useEscClose stack so overlay LIFO and
  // chat-passthrough preventDefault work uniformly. Enter still needs its own
  // window listener because it submits rather than closes.
  useEscClose(open, onCancel);
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      // Don't hijack Enter while the user is typing in the tag search or the note.
      if (isTypingTarget(e.target as Element)) return;
      // WHY a focused control keeps its own Enter: the cards are now full of buttons (a tag
      // opens its edit box, "+ New tag", "+ Add a note", a tag's ×). Enter on one of them used
      // to reach this listener too and close the session mid-edit — and Enter on Close session
      // itself fired it twice (its click and this). The rename popup sits on top: its Enter
      // is its own.
      const el = e.target as Element | null;
      if (renaming || e.defaultPrevented || el?.closest?.('button, [role="button"], [role="switch"], a, select')) return;
      onConfirm(buildResult());
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, buildResult, onConfirm, renaming]);

  if (!open) return null;

  const toggleTag = (id: string, next: boolean) =>
    setTagIds((prev) => { const s = new Set(prev); if (next) s.add(id); else s.delete(id); return s; });
  const name = sessionName || 'Untitled session';
  const tagsProps = { registry, appliedIds: tagIds, onToggleTag: toggleTag };

  return (
    <>
      {/* The shared popup at Session details' width (`panel`, 420px — still a narrow popup),
          titled by what it does. The session's name moved from the subtitle into its own
          card, as on Session details and the detail pages (guide: the item's name is in the
          top card, not the title). */}
      <Dialog screen="chat/close-session" open onClose={onCancel} size="panel" title="Close session" scrollBody={false}>
          {/* min-h-0 + overflow-y-auto: this dialog passes scrollBody={false}
              because it renders its own footer, and Dialog's own doc is explicit
              that doing so makes the SCROLL REGION the caller's job — "the symptom
              is a dialog that clips with no way to reach the bottom". The header
              and footer are fixed, so only this middle band may grow; without
              min-h-0 a flex child refuses to shrink below its content and pushes
              "Close session" off the panel on a short window. */}
          <div ref={bodyRef} className="scroll-mask px-4 py-4 flex flex-col gap-4 min-h-0">
            {!metaLoaded ? null : !metaSupported ? (
              <>
                {/* Name only: the note could not be read (or cannot be stored here), so
                    nothing may suggest it is empty or editable. */}
                <SessionHeaderCard name={name} note="" />
                {/* WHY the notice box in place of the cards (guide: a problem replaces the
                    card it is about; was a bare grey line on the popup): one plain sentence
                    saying what still works, Try again inside it when it was a failed read,
                    the operation's own words folded under Details (submit-ticket-5#ST5-9).
                    A host that simply cannot store them (Android) is information, not an
                    error: its own sentence, no button. */}
                {readError !== null ? (
                  <div className="flex flex-col gap-2">
                    <Callout tone="danger" actionsPlacement="below"
                      actions={<Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>
                      Couldn’t load this conversation’s tags and note, so they can’t be changed here. Closing it still works.
                    </Callout>
                    {readError && <FoldRow title="Details">
                      <p className="text-2xs text-fg-2 font-mono break-all">{readError}</p>
                    </FoldRow>}
                  </div>
                ) : (
                  <Callout tone="info">{metaReason}</Callout>
                )}
              </>
            ) : (
              <>
                {/* Pending writes: the note and tags edit local state; Close session commits. */}
                <SessionHeaderCard name={name} onRename={sessionId ? () => setRenaming(true) : undefined} note={note} onNote={setNote} />
                {workbenchCloseTagsFolded() ? <SessionTagsFold {...tagsProps} /> : <SessionTagsCard {...tagsProps} />}
                {/* Pin to top and Mark complete in ONE card: both are yes/no facts about this
                    session (guide: a group that is one idea keeps one card). Mark complete
                    sits last, right above the button that acts on it. Unlabelled, like
                    Session details' Pin card. */}
                <div className={`${CARD_LEVEL_1} px-3 py-1`}>
                  <PinRow pin={{ pinned: sel.priority, onPin: (next) => setSel((prev) => ({ ...prev, priority: next })) }} />
                  <SettingRow header variant="item" title={COMPLETE_TITLE} description={COMPLETE_HINT}
                    icon={<CompleteGlyph done={sel.complete} className={`w-3.5 h-3.5 transition-colors ${sel.complete ? 'text-accent' : 'text-fg-muted'}`} />}
                    control={<Toggle checked={sel.complete} onChange={(next) => setSel((prev) => ({ ...prev, complete: next }))} aria-label={COMPLETE_TITLE} />} />
                </div>
              </>
            )}
          </div>
          {/* P-15 (review 2026-08-26): the dialog has a ✕, so no Cancel. "Don't show
              again" sits bottom-left beside the one filled button — allowed by the guide
              because the button balances it on the same line (principle 6). */}
          <div className="px-4 pb-4 flex items-center justify-between gap-3">
            {/* Don't show again — persists suppress flag to localStorage so App.tsx
                skips this prompt on future closes and destroys sessions directly. */}
            <label className="flex items-center gap-2 text-2xs text-fg-muted whitespace-nowrap cursor-pointer">
              <Toggle checked={dontShowAgain} onChange={setDontShowAgain} aria-label="Don't show again" />
              Don't show again
            </label>
            <Button
              size="sm"
              className="whitespace-nowrap"
              onClick={() => {
                // Persist suppress preference before confirming so the caller
                // can immediately skip the prompt on the next close.
                if (dontShowAgain) {
                  localStorage.setItem(SUPPRESS_KEY, '1');
                }
                onConfirm(buildResult());
              }}
            >
              Close session
            </Button>
          </div>
      </Dialog>
      {renaming && sessionId && <SessionRenameDialog id={sessionId} name={name} onClose={() => setRenaming(false)} />}
    </>
  );
}
