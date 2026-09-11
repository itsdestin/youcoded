import { useCallback, useEffect, useState } from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import { triggerTip } from './guide/tips';
import { useTagRegistry } from '../hooks/useTagRegistry';
import { TagNoteEditor } from './tags/TagNoteEditor';
import { PRIORITY_TAG, PRIORITY_HINT } from './tags/built-in-tags';
import { TagChip } from './tags/TagChip';
import { TagGlyph, NotePageGlyph, PencilGlyph } from './tags/glyphs';
import type { TagRecord } from '../../shared/tags';
import { TagManagerPopup } from './tags/TagManagerPopup';
import { Button, Dialog, SettingRow, Toggle } from './ui';
import { META_UNSUPPORTED_FALLBACK, type SessionMetaResult } from '../../shared/types';
import { plainMessage } from '../utils/ipc-error';
import { isTypingTarget } from '../utils/is-typing-target';

// The two reserved flags no longer share a control here (2026-07-31). Complete
// is the dialog's actual question, so it gets the one prominent check button;
// Priority is a tag and sits in the tag list. FLAG_ORDER survives only as the
// serialization order for buildResult's `flags` array — the labels it used to
// carry now live at each control.
type FlagName = 'priority' | 'complete';
const FLAG_ORDER: FlagName[] = ['priority', 'complete'];

const COMPLETE_TITLE = 'Mark complete';
const COMPLETE_HINT = 'Hides it from the resume list unless you turn on Show Complete.';

/** The check-in-a-circle from the Resume Browser card, so the same act looks the
 *  same in both places. Filled when set; the check knocks out with var(--canvas)
 *  rather than a hardcoded white so it survives a dark or community theme. */
function CompleteGlyph({ done, className = '' }: { done: boolean; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" fill={done ? 'currentColor' : 'none'} />
      <path d="M8 12.5l2.5 2.5L16 9.5" stroke={done ? 'var(--canvas)' : 'currentColor'} />
    </svg>
  );
}

// WHY: SaveButton was a leftover from an earlier draft of this dialog — the
// component was defined but never rendered. Removed during the 2026-08-06
// unused-code sweep. The collapsed summary has no save control of its own.

/** Chosen from four candidates in the workbench, 2026-07-31: a Toggle rather
 *  than a card or a checkbox, because it is the shape Skip Permissions and Show
 *  Complete already use and the app should have one way of asking a yes/no.
 *
 *  Built on SettingRow, not hand-rolled. `setting-row-authority.test.tsx` says a
 *  label with a switch beside it IS a SettingRow — and this is exactly that, so
 *  it belongs in the primitive rather than in that test's exception list. The
 *  full suite caught the hand-rolled version; `verify.sh`'s related-tests pass
 *  did not, because the authority test names no file this branch touched.
 *
 *  `className` restores the bordered-card treatment the workbench comparison
 *  settled on: SettingRow's own base is the borderless `bg-inset/50` in-panel
 *  row, which is right in a settings LIST but too quiet for the one decision
 *  this dialog exists to ask. Structure from the primitive, weight from here. */
function MarkComplete({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <SettingRow
      variant="item"
      icon={<CompleteGlyph done={checked} className={`w-5 h-5 shrink-0 transition-colors ${checked ? 'text-accent' : 'text-fg-faint'}`} />}
      title={COMPLETE_TITLE}
      description={COMPLETE_HINT}
      control={<Toggle checked={checked} onChange={onChange} aria-label={COMPLETE_TITLE} />}
      className="border border-edge-dim !bg-inset hover:border-edge"
    />
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
// toggles it), and lets them set Priority/Complete in the same step.
export default function CloseSessionPrompt({ open, sessionName, sessionId, onCancel, onConfirm }: Props) {
  const [sel, setSel] = useState<Record<FlagName, boolean>>({ priority: false, complete: false });
  // "Don't show again" — persisted to localStorage so the caller can skip this
  // prompt on future closes. Default off so users see it at least once.
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const registry = useTagRegistry();
  const [tagIds, setTagIds] = useState<Set<string>>(new Set());
  // Tag registry editing lives in its own surface now (it used to be a ✎ on
  // each TagPicker row). Layer 3 because this prompt is itself a layer-2 Dialog.
  const [manageOpen, setManageOpen] = useState(false);
  // The notes tip's moment: the first time this prompt shows (guide/tips.ts).
  useEffect(() => { if (open) triggerTip('notes'); }, [open]);
  // The tag/note EDITOR is collapsed by default (see the summary block below).
  // Not persisted and not remembered across opens: each close starts from the
  // summary, because the common case is closing a session without filing it.
  const [editing, setEditing] = useState(false);
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
    setEditing(false);   // every close starts from the summary, not the editor
    setDontShowAgain(false);
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
      setMetaReason(`Couldn't load this conversation's tags and note, so they can't be changed here: ${reason}`);
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
  }, [open, sessionId]);

  // Reserved flags to set + the tag delta (add/remove vs. the loaded baseline) +
  // the note. useCallback keeps a stable identity so the Enter effect below
  // doesn't re-subscribe its keydown listener every render.
  // What the collapsed summary shows. Priority rides `sel` rather than `tagIds`
  // because it is a reserved flag, so it has to be folded in here by hand.
  const appliedTags = [...tagIds]
    .map((id) => registry.byId.get(id))
    .filter((t): t is TagRecord => !!t);

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
      onConfirm(buildResult());
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, buildResult, onConfirm]);

  if (!open) return null;

  return (
    <>
      {/* P-15: title + session name come from the shared Dialog header now, so
          this prompt gets the same header (and the ✕) every other dialog has
          instead of a hand-rolled copy of it. */}
      <Dialog open onClose={onCancel} size="prompt" title="Close session" subtitle={sessionName} scrollBody={false}>
          {/* min-h-0 + overflow-y-auto: this dialog passes scrollBody={false}
              because it renders its own header and footer, and Dialog's own doc
              is explicit that doing so makes the SCROLL REGION the caller's
              job — "the symptom is a dialog that clips with no way to reach the
              bottom". It did exactly that once the tag editor opened on a short
              viewport (found 2026-07-31 reviewing captures at 900px): the
              header and footer are fixed, so only this middle band may grow,
              and without min-h-0 a flex child refuses to shrink below its
              content and pushes "Close session" off the panel. */}
          <div className="px-4 py-4 flex flex-col gap-3 min-h-0 overflow-y-auto">
            {!metaLoaded ? null : !metaSupported ? (
              <p className="text-2xs text-fg-muted leading-snug">{metaReason}</p>
            ) : (
              <>
              {/* Tags and note lead — closing a session is mostly a filing
                  action — but the full editor is a tag list and a textarea,
                  which is a lot of form in front of a dialog whose primary
                  button is "Close session". So the default is a SUMMARY of what
                  is applied, and the editor opens in place.
                  Settled over ten workbench comparison rounds (view=compare,
                  surface close-prompt-body): a card whose contents swap while
                  the card itself stays put, glyphs instead of section labels,
                  the note quoted and clamped to two lines, and the editor as a
                  single well closed by a Save pill. */}
              {editing ? (
                  // Priority as a built-in, as in the Resume Browser's tag sheet
                  // and the in-session chip. Unlike those two this one is
                  // DEFERRED: the dialog collects a result and the caller writes
                  // it on confirm, so this toggles local state instead of
                  // calling setFlag. Cancel must leave nothing behind.
                  //
                  // "Save" collapses back to the summary and writes NOTHING —
                  // the dialog's own button is what commits. Pinned in a test,
                  // because the label invites someone to wire it to onConfirm.
                  <TagNoteEditor
                    appliedIds={tagIds}
                    onToggleTag={(id, next) => setTagIds((prev) => { const s = new Set(prev); if (next) s.add(id); else s.delete(id); return s; })}
                    registry={registry}
                    onManageTags={() => setManageOpen(true)}
                    note={note}
                    onNote={setNote}
                    footer={{ label: 'Save', onClick: () => setEditing(false) }}
                    builtIns={[{
                      tag: PRIORITY_TAG,
                      hint: PRIORITY_HINT,
                      applied: sel.priority,
                      onToggle: (next) => setSel((prev) => ({ ...prev, priority: next })),
                    }]}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    aria-label="Edit tags and note"
                    // The card lives HERE now, not on a shared wrapper: the
                    // editor brings its own (TagNoteEditor), and both states
                    // draw the same border/fill/padding so the dialog body
                    // still doesn't change shape when you click in.
                    className="group relative w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5"
                  >
                    {/* Fixed 16px glyph column so the chips and the note text
                        start on the SAME left edge — letting each row set its
                        own indent left them a pixel or two apart. */}
                    <span className="grid grid-cols-[16px_1fr] items-start gap-x-1.5 gap-y-1.5 pr-6">
                      <TagGlyph className="w-3 h-3 text-fg-muted mt-0.5" />
                      <span className="flex flex-wrap items-center gap-1 min-w-0">
                        {sel.priority && <TagChip tag={PRIORITY_TAG} />}
                        {appliedTags.map((t) => <TagChip key={t.id} tag={t} />)}
                        {!sel.priority && appliedTags.length === 0 && (
                          <span className="text-2xs text-fg-muted">No tags</span>
                        )}
                      </span>
                      <NotePageGlyph className="w-3 h-3 text-fg-muted mt-0.5" />
                      {note.trim() ? (
                        // Quoted and clamped to two lines: roughly a sentence
                        // gets through and the card can grow by one line and no
                        // further, so "Close session" stays where the user left it.
                        <span className="text-2xs text-fg-muted italic leading-snug line-clamp-2 min-w-0">
                          “{note.trim()}”
                        </span>
                      ) : (
                        <span className="text-2xs text-fg-muted min-w-0">No note</span>
                      )}
                    </span>
                    <span className="absolute top-2.5 right-3 text-fg-faint group-hover:text-fg transition-colors">
                      <PencilGlyph className="w-3.5 h-3.5" />
                    </span>
                  </button>
                )}

              {/* Mark complete sits LAST: the tags above are optional filing,
                  this is the actual "are you done with it?" question, and it
                  reads better immediately above the button that acts on it. */}
              <MarkComplete
                checked={sel.complete}
                onChange={(next) => setSel((prev) => ({ ...prev, complete: next }))}
              />
              </>
            )}
          </div>
          {/* P-15 (review 2026-08-26): the dialog has a ✕ now, so "Cancel" is
              redundant and gone. "Don't show again" stays bottom-left where it
              always was, on the shared Toggle (a real switch), and with only one
              button on the right nothing wraps at the prompt width any more. */}
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
      <TagManagerPopup open={manageOpen} onClose={() => setManageOpen(false)} registry={registry} layer={3} />
    </>
  );
}
