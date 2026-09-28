// CommentCard — one comment thread: author + timestamp,
// the note, replies (including an assistant reply), and resolve/reopen.
// Used both in the margin (desktop) and inside a popover (narrow viewport).
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { InputGroup } from '../ui/InputGroup';
import { ErrorState } from '../ui/states';
import { CompleteToggle } from '../SessionCardDetails';
import { formatRelativeTime } from '../../utils/format-time';
import type { DocComment } from '../../state/doc-comments-store';
import { Avatar, authorName, authorNameInline } from './Avatar';
import { ReplyField } from './ReplyField';
import { EditDeleteButtons, InlineEditField, DeleteConfirmRow, deleteCommentLabel } from './CommentActions';

interface Props {
  comment: DocComment;
  autoFocus?: boolean;
  onTextChange: (text: string) => void;
  // Data-loss fix (Destin, 2026-09-28): typing no longer persists anything
  // by itself (doc-comments-store.ts's `setCommentText`/`commitDraft` own
  // WHY) — this card is the ONLY place a still-uncommitted draft's blur ever
  // happens, so it's the one that must ask the store to actually save the
  // typed text. Optional so fixture/test callers with no real store behind
  // them (CommentCard.test.tsx) don't have to wire a no-op every time.
  onCommit?: () => void;
  onReply: (text: string) => void;
  onResolve: () => void;
  onReopen: () => void;
  onDelete: () => void;
  // Edit/delete build (E-1..E-6, docs/active/design/2026-09-24-doc-comments/
  // doc-comments.edit-delete.questions.answers.json). Distinct from the
  // existing `onDelete` above, which only ever cancels a still-empty,
  // never-persisted draft (no confirm) — these act on a REAL comment/reply
  // and go through the store's edit/delete mutations, confirm-first for
  // delete (E-4). Optional so fixture/test callers that don't exercise
  // edit/delete (CommentCard.test.tsx's existing cases) need not wire them.
  onEditText?: (text: string) => void;
  onDeleteComment?: () => void;
  onEditReply?: (replyId: string, text: string) => void;
  onDeleteReply?: (replyId: string) => void;
}

// T6 (docs/active/specs/2026-09-26-doc-comments-build-design.md §2.3): once
// T14's resolveSelector can't find a comment's saved text/cell anymore, the
// card still shows (R6: nothing silently lost) but needs to say WHY there's
// no highlight to click through to. error-message-standards.md: never guess a
// cause — this line states only what's actually known (the text/cell isn't
// there) and quotes (truncated) what the comment was about, so the words
// aren't lost along with the highlight.
function truncateQuote(quote: string, max = 60): string {
  const trimmed = quote.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()}…`;
}

function DetachedNote({ comment }: { comment: DocComment }) {
  const isCell = Boolean(comment.cell);
  const message = isCell ? 'Cell no longer exists in this file.' : 'Text no longer found in this file.';
  const quoted = !isCell && comment.quote ? truncateQuote(comment.quote) : null;
  return (
    <p className="mt-1 text-2xs text-fg-muted" data-detached-note>
      {message}
      {quoted && <> “{quoted}”</>}
    </p>
  );
}

// F3 (T14 review, performance.md rule 4): past use-quote-marks.ts's/
// use-code-comment-anchors.ts's MAX_ANCHOR_TEXT_CHARS bound, a comment is
// never actually checked — 'unchecked' says exactly that, distinct from
// 'detached' ("no longer found"), which would be a guessed cause this file's
// size can't actually support (error-message-standards.md: never invent a
// cause).
function UncheckedNote() {
  return (
    <p className="mt-1 text-2xs text-fg-muted" data-unchecked-note>
      This file is too large to show where this comment points.
    </p>
  );
}

/** The one place that decides which (if either) status note a card shows —
 *  keeps CommentCard's two render branches (open/resolved) from having to
 *  repeat the same status-to-note mapping. */
function StatusNote({ comment }: { comment: DocComment }) {
  if (comment.status === 'unchecked') return <UncheckedNote />;
  if (comment.status === 'detached') return <DetachedNote comment={comment} />;
  return null;
}

export function CommentCard({
  comment, autoFocus, onTextChange, onCommit, onReply, onResolve, onReopen, onDelete,
  onEditText, onDeleteComment, onEditReply, onDeleteReply,
}: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Edit/delete build: purely local, explicitly-triggered UI state — never
  // derived from `comment.text`/`comment.replies` (that derivation is exactly
  // what caused the draft-focus bug this file's `editingDraft` comment
  // describes: a flag that flips on a KEYSTROKE unmounts the textarea mid-
  // typing). These flip only on an Edit/Delete/Save/Cancel/Escape click, so a
  // `docComments:changed` refresh landing mid-edit re-renders this card with
  // fresh `comment` props but never touches — and never unmounts — whichever
  // of these is open.
  const [isEditingComment, setIsEditingComment] = useState(false);
  const [confirmingDeleteComment, setConfirmingDeleteComment] = useState(false);
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [confirmingDeleteReplyId, setConfirmingDeleteReplyId] = useState<string | null>(null);

  // A freshly added comment (from "Add comment" on a selection) opens with
  // its note box already focused — Docs-style, so typing starts immediately
  // with no extra click.
  useEffect(() => {
    if (autoFocus) textRef.current?.focus();
  }, [autoFocus]);

  // Bug fix (Destin, testing the dev instance: "the chat input sometimes
  // steals focus in the middle of me typing a comment"). Cause: `isDraft`
  // used to be `comment.text.trim() === '' && …`, recomputed from the LIVE
  // `comment.text` on every render — so the very first keystroke (which
  // makes `comment.text` non-empty) flipped it to `false`, and the JSX below
  // swaps element types on that flip (`<Textarea>` → a plain `<p>`). React
  // unmounts the old subtree on a type change, which drops DOM focus onto
  // `document.body` with no focused field left — the NEXT keystroke then
  // has nothing to skip in InputBar's global auto-focus listener
  // (`isTypingTarget`/`isInteractiveTarget` both read `document.body` as
  // "not typing anywhere"), so it grabs focus into the chat composer and
  // that character lands there instead. A `docComments:changed` push or a
  // re-anchor pass replacing this comment with a fresh object (same id, same
  // content) never re-triggered `useState`'s initializer either, so both
  // causes are closed by the same fix: whether the box is still being
  // composed is now LOCAL state, captured once when this comment id first
  // mounts, and only ever cleared on blur (see the Textarea's `onBlur`
  // below) — never by a keystroke or an unrelated store update.
  const [editingDraft, setEditingDraft] = useState(
    () => comment.text.trim() === '' && comment.replies.length === 0 && !comment.resolved,
  );
  // A reply landing (or a resolve) while this card was still "composing" —
  // e.g. the assistant replied before the debounced persist even fired —
  // must still fall through to the normal display+reply layout; those two
  // states already assume no comment showing a reply/resolved treatment is
  // also mid-compose.
  const isDraft = editingDraft && comment.replies.length === 0 && !comment.resolved;

  // Draft's own send/discard (Destin, 2026-09-28: same send control as
  // replies, and the bottom-of-card Delete button goes away — Escape or a
  // blur while still empty is now the ONLY way to drop a never-posted
  // draft, so it can't get stuck open with nothing in it). `postDraft` is
  // shared by Enter, the arrow button and blur; blur additionally discards
  // an empty draft since it's the click-away path once the Delete button is
  // gone. Neither branch touches `editingDraft` on a keystroke (still only
  // Enter/blur/Escape), so the focus-steal regression this file's own
  // `editingDraft` WHY describes stays closed.
  const postDraft = () => { if (comment.text.trim()) { setEditingDraft(false); onCommit?.(); } };
  const discardDraftIfEmpty = () => { if (!comment.text.trim()) onDelete(); };

  // Round 10 (Destin: "the 'resolved' button should be an icon, like the
  // complete button for resume browser, at the top right of each comment
  // area"): the SAME CompleteToggle the Resume card uses — hollow circle-check
  // to resolve, filled to show it's resolved (click again to reopen). A draft
  // has nothing to resolve yet, so it gets no toggle.
  const resolveToggle = !isDraft && (
    <CompleteToggle
      done={comment.resolved}
      name="this comment"
      onToggle={(next) => (next ? onResolve() : onReopen())}
      titles={{ set: 'Resolved. Click to reopen.', unset: 'Resolve this comment?' }}
      className="shrink-0"
    />
  );
  // E-1: Edit/Delete icons sit NEXT TO the resolve toggle, in the same
  // top-right cluster — not a ⋯ menu. A draft has neither (nothing persisted
  // yet to edit or delete — its own Delete-the-draft button is at the bottom,
  // unchanged). `onEditText`/`onDeleteComment` are optional (see Props' own
  // WHY), so a caller that hasn't wired them yet (or a bare test) just gets
  // the resolve toggle alone, same as before this build.
  const topRightActions = !isDraft && (
    // cursor-pointer: the same fix as ICON_BUTTON/CompleteToggle
    // (CommentActions.tsx WHY) — this row's own gap-0.5 sliver between the
    // Edit/Delete group and the resolve toggle is otherwise a THIRD cursor
    // value in the sweep.
    <div className="flex items-center gap-0.5 shrink-0 cursor-pointer">
      {onEditText && onDeleteComment && (
        <EditDeleteButtons
          onEdit={() => { setIsEditingComment(true); setConfirmingDeleteComment(false); }}
          onDelete={() => { setConfirmingDeleteComment(true); setIsEditingComment(false); }}
          editLabel="Edit comment"
          deleteLabel="Delete comment"
        />
      )}
      {resolveToggle}
    </div>
  );
  // Round 11 (Destin: "remove the quote section at the top of each
  // comment"): in Comments mode each card already sits beside its highlight
  // and lights it up on hover, so repeating the quoted words was noise. The
  // resolve toggle moves onto the author row, top right.
  // `cell`: a spreadsheet comment names its cell ("B4") after the time, muted
  // — the pane lists cells in sheet order, and with no quoted text on the
  // card the reference is the only way to tell which cell a card is about
  // without clicking it. Only the thread's own header gets it, not replies.
  // A multi-sheet workbook's comment names its tab too ("By rep · B4").
  const cellRef = comment.cell ? (comment.sheet ? `${comment.sheet} · ${comment.cell}` : comment.cell) : undefined;
  // The reference sits on its own muted line under name · time: beside them,
  // "By rep · B4" squeezed the author's name down to "Pr…" (polish pass).
  const header = (c: { author: DocComment['author']; createdAt: number }, cell?: string) => (
    <>
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="font-medium text-fg truncate">{authorName(c.author)}</span>
        <span className="text-2xs text-fg-muted shrink-0">{formatRelativeTime(c.createdAt)}</span>
      </div>
      {cell && <div className="text-2xs text-fg-muted truncate">{cell}</div>}
    </>
  );

  // Shared by both the open and resolved branches below — a reply's own
  // Edit/Delete icons (E-1) work identically either way, and E-4's confirm
  // (delete on resolved is useful too — Destin's own decision) is the same
  // inline block in both. `muted`: resolved-thread replies read as `fg-muted`
  // text, same as the resolved branch's own comment text; open ones stay `fg-2`.
  const replyRow = (r: DocComment['replies'][number], muted: boolean) => {
    const isEditingThis = editingReplyId === r.id;
    const isConfirmingThis = confirmingDeleteReplyId === r.id;
    return (
      <div key={r.id} className="flex items-start gap-2 mt-2 pl-1 group">
        <Avatar author={r.author} />
        <div className="flex-1 min-w-0">
          {header(r)}
          {isEditingThis ? (
            <InlineEditField
              text={r.text}
              onSave={(text) => { onEditReply?.(r.id, text); setEditingReplyId(null); }}
              onCancel={() => setEditingReplyId(null)}
            />
          ) : (
            <p className={`mt-0.5 whitespace-pre-wrap ${muted ? 'text-fg-muted' : 'text-fg-2'}`}>{r.text}</p>
          )}
          {isConfirmingThis && (
            <DeleteConfirmRow
              label="Delete this reply?"
              onConfirm={() => { onDeleteReply?.(r.id); setConfirmingDeleteReplyId(null); }}
              onCancel={() => setConfirmingDeleteReplyId(null)}
            />
          )}
        </div>
        {onEditReply && onDeleteReply && !isEditingThis && !isConfirmingThis && (
          <EditDeleteButtons
            onEdit={() => { setEditingReplyId(r.id); setConfirmingDeleteReplyId(null); }}
            onDelete={() => { setConfirmingDeleteReplyId(r.id); setEditingReplyId(null); }}
            editLabel="Edit reply"
            deleteLabel="Delete reply"
          />
        )}
      </div>
    );
  };

  if (comment.resolved) {
    // Bug fix (Destin, testing the dev instance: "when a comment is resolved,
    // replies and such in the chain can't be seen in 'show resolved' view"):
    // this branch used to truncate the note to one line and drop
    // `comment.replies` entirely — a resolved thread with replies looked
    // identical to one with none, and the replies were unreachable (no way
    // back to them short of reopening). Docs-style resolved threads stay
    // fully readable, just muted: full text, every reply, no reply box (a
    // resolved thread doesn't invite new replies — reopen first). The filled
    // toggle top-right is still the only way back.
    return (
      // Design-guide review (round 7): a card inside a side pane is `inset`
      // with an `edge-dim` border and no shadow (§2.1/§2.4 — the tool-card
      // recipe); muted text says "done" without fading the whole card below
      // the contrast floor.
      <div className="rounded-lg border border-edge-dim bg-inset p-3 text-xs">
        <div className="flex items-start gap-2 group">
          <Avatar author={comment.author} />
          <div className="flex-1 min-w-0">
            {header(comment, cellRef)}
            {isEditingComment ? (
              <InlineEditField
                text={comment.text}
                onSave={(text) => { onEditText?.(text); setIsEditingComment(false); }}
                onCancel={() => setIsEditingComment(false)}
              />
            ) : (
              <p className="mt-0.5 text-fg-muted whitespace-pre-wrap">{comment.text}</p>
            )}
            <StatusNote comment={comment} />
          </div>
          {topRightActions}
        </div>
        <p className="mt-1.5 text-fg-muted">Resolved by {authorNameInline(comment.resolvedBy ?? 'user')}</p>

        {/* delete on a resolved thread is useful too (Destin's own decision,
            E-1..E-6 answers) — same confirm block as the open branch below. */}
        {confirmingDeleteComment && (
          <DeleteConfirmRow
            label={deleteCommentLabel(comment.replies.length)}
            onConfirm={() => { onDeleteComment?.(); setConfirmingDeleteComment(false); }}
            onCancel={() => setConfirmingDeleteComment(false)}
          />
        )}

        {comment.replies.map((r) => replyRow(r, true))}

        {/* F7 fix (T5 review): a failed reopen rolls back to `resolved: true`,
            so its error lands on THIS branch — one error per comment, shown
            where the comment actually is, never a global toast
            (error-message-standards.md: specific detail + Retry). */}
        {comment.error && (
          <ErrorState className="mt-1.5" message={comment.error.message} onRetry={comment.error.onRetry} />
        )}
      </div>
    );
  }



  return (
    <div className="rounded-lg border border-edge-dim bg-inset p-3 text-xs w-full">
      <div className="flex items-start gap-2 group">
        <Avatar author={comment.author} />
        <div className="flex-1 min-w-0">
          {header(comment, cellRef)}
          {isEditingComment ? (
            <InlineEditField
              text={comment.text}
              onSave={(text) => { onEditText?.(text); setIsEditingComment(false); }}
              onCancel={() => setIsEditingComment(false)}
            />
          ) : isDraft ? (
            // Same send control as ReplyField (the round arrow inside the
            // field, InputGroup's own "border on the wrapper, field goes
            // bare" shape) instead of a separate Cancel/Delete row below —
            // Destin, 2026-09-28. Enter posts, matching ReplyField; Escape
            // discards only while still empty (the row below this used to
            // be the only way to do that); a real blur (click/tab away)
            // posts a non-empty draft or discards an empty one, so the card
            // can never sit open with nothing in it once the button is gone.
            <InputGroup size="sm" className="mt-1 w-full">
              <textarea
                ref={textRef}
                rows={2}
                value={comment.text}
                onChange={(e) => onTextChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postDraft(); }
                  else if (e.key === 'Escape') { e.preventDefault(); discardDraftIfEmpty(); }
                }}
                // WHY blur does both jobs: a real blur (click/tab away) is
                // the one moment this panel-hosted draft ever gets saved
                // (Data-loss fix, 2026-09-28 — typing no longer persists on
                // its own, see Props' `onCommit` WHY) OR, now that the
                // bottom Delete button is gone, the click-away path that
                // drops a never-typed-in draft instead of leaving it stuck.
                onBlur={() => { postDraft(); discardDraftIfEmpty(); }}
                placeholder="Add a comment…"
                // Bare, like InputGroup.Field — the wrapper above carries
                // the border/background; a resize handle or a second border
                // from the Textarea primitive doesn't belong inside it.
                // data-edit-menu (was the artifact-edit-textarea class, which design lint rejects on a bare textarea): reuses the artifact editor's
                // right-click routing (build-menu.ts) — Electron ships no
                // default context menu, so without this marker cut/copy/
                // paste here would do nothing.
                className="flex-1 min-w-0 bg-transparent border-0 outline-none resize-none text-2xs text-fg placeholder:text-fg-muted py-1.5"
                data-edit-menu
              />
              <Button
                size="icon-xs"
                aria-label="Post comment"
                disabled={!comment.text.trim()}
                onClick={postDraft}
                className="mr-0.5 self-end mb-0.5"
              >
                <svg className="w-2.5 h-2.5 text-on-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </Button>
            </InputGroup>
          ) : (
            <p className="mt-0.5 text-fg-2 whitespace-pre-wrap">{comment.text}</p>
          )}
          {!isDraft && <StatusNote comment={comment} />}
        </div>
        {topRightActions}
      </div>

      {/* E-4: delete asks first, inline, right where the reply box would
          otherwise be — the reply box itself hides while it's up (replying to
          something about to be deleted reads as a trap). */}
      {confirmingDeleteComment && (
        <DeleteConfirmRow
          label={deleteCommentLabel(comment.replies.length)}
          onConfirm={() => { onDeleteComment?.(); setConfirmingDeleteComment(false); }}
          onCancel={() => setConfirmingDeleteComment(false)}
        />
      )}

      {comment.replies.map((r) => replyRow(r, false))}

      {/* F7 fix (T5 review): a failed add (still a draft, `isDraft`) or a
          failed reply/resolve (rolled back to `resolved: false`, landing
          here) both show their own error inline — one per comment, no
          clobbering, since it lives ON the comment object itself. */}
      {comment.error && (
        <ErrorState className="mt-2" message={comment.error.message} onRetry={comment.error.onRetry} />
      )}

      {/* The reply box is shared with the Reading-mode hover card (ReplyField.tsx). */}
      {!isDraft && !confirmingDeleteComment && <ReplyField onSend={onReply} />}
    </div>
  );
}
