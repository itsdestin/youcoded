// Shared comment-thread avatar — CommentCard and HighlightHoverCard each had
// their own byte-identical copy, which had drifted (round 3 finding: the
// user's initial was 'D' — Destin's own initial — while the name it sits next
// to reads "You", a mismatch nobody would type on purpose twice). One
// component now owns the mapping so the two can't disagree again.
//
// WHY a letter/glyph, not an accent fill: G-8 reserves the accent colour for
// STATE (selection, focus, primary actions) — a resting avatar is decoration,
// so it stays neutral like every other tag/badge in the app.
import type { CommentAuthor } from '../../state/doc-comments-store';

export function authorName(author: CommentAuthor): string {
  if (author === 'assistant') return 'Claude';
  if (author === 'user') return 'You';
  // A colleague's comment from a Word/Excel file: their own name, as Word
  // shows it (doc-comments-store.ts CommentAuthor's WHY).
  return author.slice('person:'.length);
}

/** Lower-case form for the middle of a sentence ("Resolved by you"). */
export function authorNameInline(author: CommentAuthor): string {
  return author === 'user' ? 'you' : authorName(author);
}

function initialOf(author: CommentAuthor): string {
  if (author === 'assistant') return '✳';
  if (author === 'user') return 'Y';
  return authorName(author).trim().charAt(0).toUpperCase() || '?';
}

export function Avatar({ author }: { author: CommentAuthor }) {
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center shrink-0 w-5 h-5 rounded-full border border-edge-dim bg-inset text-3xs font-medium text-fg-2"
    >
      {initialOf(author)}
    </span>
  );
}
