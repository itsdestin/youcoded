// Shared edit/delete affordances for a comment or reply — CommentCard (both
// its open and resolved branches, plus each reply row) and HighlightHoverCard
// (Reading mode's hover preview, plus its reply rows) all need the identical
// icon pair, inline editor and delete confirm. One file so the two surfaces
// can't drift the way Avatar.tsx's own WHY describes two earlier byte-
// identical copies doing.
//
// Design (Destin's decisions, docs/active/design/2026-09-24-doc-comments/
// doc-comments.edit-delete.questions.answers.json):
// E-1: small Edit/Delete ICONS next to the Resolve toggle, not a ⋯ menu —
//      "this is how most other editors do it". Hover-revealed on desktop
//      (matches the app's other row-level icon affordances — ProjectSwitcher's
//      remove-project ×), always visible+tappable on touch via the app's own
//      `.touch-reveal`/`.coarse-hit` conventions (narrow-viewport.md: "hover-
//      only affordances have no touch path").
// E-2: anyone's comment/reply can be edited or deleted — no author check.
// E-3: deleting a thread's first comment deletes the whole thread. True for
//      free in this data model (a thread IS one DocComment plus its nested
//      `replies`), so the delete-confirm copy just SAYS so.
// E-4: delete asks first, inline — "Delete this comment and its 3 replies?"
//      with Delete/Cancel. No dedicated confirm-popover primitive exists in
//      `components/ui/` today, and this is small enough not to need one: it
//      reuses the same `<Button>` primitive every other confirmation in the
//      app already uses (ProjectView's Remove-project confirm, TagManagerPopup's
//      two-step delete), inline in the card rather than a new Scrim/OverlayPanel
//      — never a hand-rolled dialog, but not a floating popover either.
// E-5: no "edited" marker — editing a comment/reply just replaces its text.
import React, { useEffect, useRef, useState } from 'react';
import { Button, FOCUS_RING } from '../ui/Button';
import { FIELD_SIZE, FIELD_TEXT } from '../ui/field';

/** 24×24 viewBox, stroke currentColor, the app's shared inline-icon
 *  convention (menu-icons.tsx, detail-tool-icons.tsx). */
function IconSvg({ children, className = 'w-3.5 h-3.5' }: { children: React.ReactNode; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

// className is threaded through (default undefined, so IconSvg's own
// 'w-3.5 h-3.5' still applies) so EditingPill below can shrink the glyph to
// fit its pill without a second near-identical icon component.
function EditGlyph({ className }: { className?: string } = {}) {
  return (
    <IconSvg className={className}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </IconSvg>
  );
}

function DeleteGlyph() {
  return (
    <IconSvg>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </IconSvg>
  );
}

/** narrow-viewport.md: "hover-only affordances have no touch path" —
 *  `.touch-reveal` keeps these visible under `pointer: coarse`; `.coarse-hit`
 *  gives them a real touch target despite the small glyph. The resolve toggle
 *  next to these (E-1: "next to the Resolve toggle") stays unconditionally
 *  visible — only edit/delete are hover-gated, so the row isn't three icons
 *  deep at rest. A bare `<button>`, like `CompleteToggle` right beside it
 *  (SessionCardDetails.tsx) — not the `<Button>` primitive: lint's
 *  `no-restyle` rule refuses overriding `<Button>`'s own opacity/transition
 *  from a caller's className (it "owns its effects"), which is exactly what
 *  a hover-reveal needs to do here.
 *
 *  WHY `cursor-pointer` is explicit here (Destin, dev instance: "cursor
 *  seems to flicker/stutter when hovering between/across the different
 *  buttons"): browsers' own UA stylesheet sets a bare `<button>` to
 *  `cursor: default`, which BREAKS inheritance — it doesn't fall back to
 *  whatever an ancestor's `cursor-pointer` resolves to, it overrides it.
 *  The card background these buttons sit on (CommentsMargin.tsx's per-card
 *  wrapper, `.state-layer` rows, etc.) already says `cursor-pointer`, so the
 *  ~2px `gap-0.5` between these tightly-packed icons showed POINTER
 *  (inherited from that background) while the icons themselves showed
 *  DEFAULT (the UA override) — the cursor glyph flipped every time the
 *  pointer crossed a button edge while sweeping Resolve → Edit → Delete.
 *  Same fix on the wrapping `<div>` below and on `CompleteToggle` closes
 *  every gap in the row, so nothing in it can disagree with anything else. */
const ICON_BUTTON =
  'rounded-sm p-0.5 text-fg-faint hover:text-fg-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse-hit cursor-pointer ' +
  'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 touch-reveal transition-opacity';

// WHY not exported (knip): only CommentRowActions below calls this now — the
// restyle moved every external call site (CommentCard, HighlightHoverCard)
// onto CommentRowActions, which owns the editing/not-editing swap.
function EditDeleteButtons({ onEdit, onDelete, editLabel, deleteLabel, className = '' }: {
  onEdit: () => void;
  onDelete: () => void;
  editLabel: string;
  deleteLabel: string;
  className?: string;
}) {
  return (
    // cursor-pointer on the row itself too — the gap-0.5 slivers between (and
    // around) the two buttons are this <div>, not the buttons, so without it
    // the same flicker this file's WHY describes reopens between Edit and
    // Delete specifically.
    <div className={`flex items-center gap-0.5 shrink-0 cursor-pointer ${className}`.trim()}>
      <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(); }} aria-label={editLabel} title={editLabel} className={ICON_BUTTON}>
        <EditGlyph />
      </button>
      <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(); }} aria-label={deleteLabel} title={deleteLabel} className={ICON_BUTTON}>
        <DeleteGlyph />
      </button>
    </div>
  );
}

/** Same fill as `<Button variant="primary" size="sm">` (`bg-accent
 *  text-on-accent`, `text-2xs px-2.5 py-1`, the one shared `FOCUS_RING`) —
 *  the exact classes BUTTON_VARIANT.primary/BUTTON_SIZE.sm emit, copied
 *  rather than reached through `<Button className="rounded-full gap-1">`:
 *  `lint:design`'s `shadcn/no-restyle` refuses a caller overriding
 *  `<Button>`'s own shape/spacing groups even under this file's allowed
 *  "layout" contract (Button.tsx's own `rounded-full` className precedent
 *  is size-driven, not a caller override) — the SAME reason `ICON_BUTTON`
 *  above is a raw `<button>` rather than `<Button>` for its hover-reveal.
 *  A pill is a shape Button's `sm` size doesn't have. */
const EDITING_PILL =
  'inline-flex items-center gap-1 shrink-0 rounded-full px-2.5 py-1 text-2xs font-medium ' +
  'bg-accent text-on-accent hover:bg-accent/90 active:bg-accent/80 cursor-pointer coarse-hit transition-colors ' +
  FOCUS_RING;

/** Ask 3 (Destin, 2026-09-28, restyle round): while a row is being edited,
 *  its Edit pencil (and, for CommentRowActions below, Delete/Resolve too)
 *  sit exactly where they'd otherwise be, replaced by this one dark pill —
 *  same filled look as InlineEditField's own Save. Clicking it cancels the
 *  edit — same effect as InlineEditField's Cancel button, just reachable
 *  from the exact spot the eye is already on.
 *
 *  Not exported (knip): only CommentRowActions below renders it. */
function EditingPill({ onCancel }: { onCancel: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onCancel(); }}
      aria-label="Cancel editing"
      title="Cancel editing"
      className={EDITING_PILL}
    >
      Editing
      <EditGlyph className="w-2.5 h-2.5" />
    </button>
  );
}

/** Ask 2+3, shared by CommentCard and HighlightHoverCard so the swap between
 *  "Edit/Delete icons (+ an optional trailing node, e.g. Resolve)" and "the
 *  Editing pill alone" is written once. While `editing` is true this row's
 *  own Delete AND `trailing` (a top-level comment's Resolve toggle) are both
 *  gone, not just Edit — ask 2's "hide that comment's delete + resolve
 *  buttons" / "hide that reply's own delete button" falls out of returning
 *  ONLY the pill, with nothing else in this row to hide separately. */
export function CommentRowActions({ editing, onEdit, onDelete, onCancelEdit, editLabel, deleteLabel, trailing }: {
  editing: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onCancelEdit: () => void;
  editLabel: string;
  deleteLabel: string;
  trailing?: React.ReactNode;
}) {
  if (editing) return <EditingPill onCancel={onCancelEdit} />;
  return (
    <div className="flex items-center gap-0.5 shrink-0 cursor-pointer">
      <EditDeleteButtons onEdit={onEdit} onDelete={onDelete} editLabel={editLabel} deleteLabel={deleteLabel} />
      {trailing}
    </div>
  );
}

/** WHY (Destin, 2026-09-28: the edit box cut text off after two lines): the
 *  comment boxes grow with what's typed, up to a cap, then scroll. CSS
 *  `field-sizing: content` does it with no script measuring the box on every
 *  keystroke (performance.md rule 6 — the InputBar's scrollHeight approach
 *  reads layout per key); Electron's Chromium supports it. */
const GROWING_FIELD_STYLE = { fieldSizing: 'content', minHeight: '3.2em', maxHeight: '14em', overflowY: 'auto' } as React.CSSProperties;

/** Inline replacement for a comment/reply's text while editing it. Mounted
 *  only while the caller's own edit-mode flag is true, and that flag NEVER
 *  flips from something typed inside this field — only from the Edit button
 *  that opened it and Save/Cancel/Escape here — so it can never unmount
 *  mid-keystroke the way the recent draft-focus bug did (doc-comments-
 *  store.ts's `commitDraft`/CommentCard's `editingDraft`, both keyed off a
 *  flag a keystroke could flip). A local `value` buffer, not the live store
 *  text: nothing is saved until Save/Enter.
 *
 *  Restyle (Destin, 2026-09-28, re-reviewing the dev instance):
 *  - The surface/padding/text-size/focus-border here already match
 *    CommentComposer's (both go through FIELD_TEXT + FIELD_SIZE.sm on an
 *    FIELD_SURFACE-equivalent wrapper) — what didn't match was Save reading
 *    as a light secondary button next to the composer's dark filled send
 *    arrow. Save is now `variant="primary"`, the SAME filled look as that
 *    arrow, through the Button primitive rather than a hand-rolled class.
 *    Cancel stays `ghost` — quiet, as asked.
 *  - Clearing the box to nothing swaps Save for a `danger` Delete button
 *    (E-4's existing inline confirm is what it opens — `onRequestDelete`,
 *    not a second delete path) — Enter while empty does the same. Typing
 *    text back swaps it right back to Save; both branches read off the same
 *    `isEmpty`, so there's no separate state to fall out of sync. */
export function InlineEditField({ text, onSave, onCancel, onRequestDelete, className = 'mt-1' }: {
  text: string;
  onSave: (text: string) => void;
  onCancel: () => void;
  /** Empty-box Delete (via the button or Enter) — same delete confirm the
   *  standalone Delete icon opens, never a second/silent deletion path. */
  onRequestDelete: () => void;
  className?: string;
}) {
  const [value, setValue] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const isEmpty = value.trim().length === 0;
  const save = () => { if (!isEmpty) onSave(value.trim()); };
  const submit = () => { if (isEmpty) onRequestDelete(); else save(); };
  return (
    // Destin, 2026-09-28: Cancel/Save move INSIDE the field's own border,
    // bottom-right — one bordered box (textarea on top, buttons at the
    // bottom) instead of a border on the textarea and a separate row below
    // it. Same structure InputGroup.tsx's own WHY describes ("the border
    // moves to a wrapper and the field goes bare"), just stacked instead of
    // inline — this row is TWO buttons (Cancel + Save), which is why it's
    // built here rather than through InputGroup itself: that primitive's
    // own §11.9 sub-rule limits it to a single submit action inside, and
    // this box deliberately carries both, on Destin's explicit ask.
    <div className={`${className} rounded-lg border border-edge-dim bg-inset focus-within:border-accent`}>
      <textarea
        ref={ref}
        rows={2}
        style={GROWING_FIELD_STYLE}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        placeholder="Edit…"
        // Bare, like InputGroup.Field — FIELD_SURFACE's border/background
        // live on the wrapper div above; the Textarea primitive would put a
        // second border on this element instead.
        className={`w-full resize-none bg-transparent border-0 outline-none leading-snug ${FIELD_TEXT} ${FIELD_SIZE.sm}`}
        data-edit-menu
      />
      <div className="flex items-center justify-end gap-1.5 px-1.5 pb-1.5 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        {isEmpty ? (
          <Button variant="danger" size="sm" onClick={onRequestDelete}>Delete</Button>
        ) : (
          <Button variant="primary" size="sm" onClick={save}>Save</Button>
        )}
      </div>
    </div>
  );
}

/** E-4's inline confirm — no Scrim/OverlayPanel, just the same danger/ghost
 *  button pair every other confirmation in the app uses, placed where the
 *  content it's about to remove was. */
export function DeleteConfirmRow({ label, onConfirm, onCancel, className = 'mt-2' }: {
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
}) {
  return (
    <div className={`rounded-md border border-destructive/40 bg-destructive/10 p-2 ${className}`.trim()}>
      <p className="text-2xs text-fg-2">{label}</p>
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="danger" size="sm" onClick={onConfirm}>Delete</Button>
      </div>
    </div>
  );
}

/** "Delete this comment?" / "Delete this comment and its 3 replies?" — E-3's
 *  own wording: the count is what tells the reader a whole thread is going,
 *  not just its top note. */
export function deleteCommentLabel(replyCount: number): string {
  if (replyCount === 0) return 'Delete this comment?';
  return `Delete this comment and its ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}?`;
}
