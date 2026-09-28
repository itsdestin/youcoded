// CommentCard — one comment thread: author + timestamp,
// the note, replies (including an assistant reply), and resolve/reopen.
// Used both in the margin (desktop) and inside a popover (narrow viewport).
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Textarea';
import { ErrorState } from '../ui/states';
import { CompleteToggle } from '../SessionCardDetails';
import { formatRelativeTime } from '../../utils/format-time';
import type { DocComment } from '../../state/doc-comments-store';
import { Avatar, authorName, authorNameInline } from './Avatar';
import { ReplyField } from './ReplyField';

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

export function CommentCard({ comment, autoFocus, onTextChange, onCommit, onReply, onResolve, onReopen, onDelete }: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null);

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
        <div className="flex items-start gap-2">
          <Avatar author={comment.author} />
          <div className="flex-1 min-w-0">
            {header(comment, cellRef)}
            <p className="mt-0.5 text-fg-muted whitespace-pre-wrap">{comment.text}</p>
            <StatusNote comment={comment} />
          </div>
          {resolveToggle}
        </div>
        <p className="mt-1.5 text-fg-muted">Resolved by {authorNameInline(comment.resolvedBy ?? 'user')}</p>

        {comment.replies.map((r) => (
          <div key={r.id} className="flex items-start gap-2 mt-2 pl-1">
            <Avatar author={r.author} />
            <div className="flex-1 min-w-0">
              {header(r)}
              <p className="mt-0.5 text-fg-muted whitespace-pre-wrap">{r.text}</p>
            </div>
          </div>
        ))}

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
      <div className="flex items-start gap-2">
        <Avatar author={comment.author} />
        <div className="flex-1 min-w-0">
          {header(comment, cellRef)}
          {isDraft ? (
            <Textarea
              ref={textRef}
              size="sm"
              rows={2}
              value={comment.text}
              onChange={(e) => onTextChange(e.target.value)}
              // WHY: the one place `editingDraft` ever turns off — a real
              // blur (click/tab away), never a keystroke. Empty text stays a
              // draft either way (nothing to "post" yet — matches the old
              // behaviour when this card is reopened with real content).
              // Data-loss fix (2026-09-28): a real blur is ALSO now the one
              // moment this panel-hosted draft ever gets saved — typing no
              // longer persists on its own (see Props' `onCommit` WHY), so
              // without this call a comment created here (CommentsMargin's
              // spreadsheet-cell / margin drafts) would never reach disk.
              onBlur={() => { if (comment.text.trim()) { setEditingDraft(false); onCommit?.(); } }}
              placeholder="Add a comment…"
              // data-edit-menu (was the artifact-edit-textarea class, which design lint rejects on <Textarea>): reuses the artifact editor's right-click
              // routing (build-menu.ts) — Electron ships no default context menu,
              // so without this marker cut/copy/paste here would do nothing.
              className="mt-1 w-full"
              data-edit-menu
            />
          ) : (
            <p className="mt-0.5 text-fg-2 whitespace-pre-wrap">{comment.text}</p>
          )}
          {!isDraft && <StatusNote comment={comment} />}
        </div>
        {resolveToggle}
      </div>

      {comment.replies.map((r) => (
        <div key={r.id} className="flex items-start gap-2 mt-2 pl-1">
          <Avatar author={r.author} />
          <div className="flex-1 min-w-0">
            {header(r)}
            <p className="mt-0.5 text-fg-2 whitespace-pre-wrap">{r.text}</p>
          </div>
        </div>
      ))}

      {/* F7 fix (T5 review): a failed add (still a draft, `isDraft`) or a
          failed reply/resolve (rolled back to `resolved: false`, landing
          here) both show their own error inline — one per comment, no
          clobbering, since it lives ON the comment object itself. */}
      {comment.error && (
        <ErrorState className="mt-2" message={comment.error.message} onRetry={comment.error.onRetry} />
      )}

      {/* The reply box is shared with the Reading-mode hover card (ReplyField.tsx). */}
      {!isDraft && <ReplyField onSend={onReply} />}
      {isDraft && (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={onDelete}>Delete</Button>
        </div>
      )}
    </div>
  );
}
