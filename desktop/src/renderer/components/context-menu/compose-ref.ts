// Reference tokens — the inline-pill mechanism for "Ask about this" and
// "Send to assistant", ported from the "inline & conversational" mockup
// (Style C, session/comments-mock-c) at Destin's explicit direction (round 2):
// he wants a reference to read as a pill INSIDE the sentence, not as a
// separate chip row above the composer (round 1's QuoteReferenceChip, now
// deleted).
//
// WHY a textarea, not contentEditable: "Ask about this" used to build a
// scaffold STRING (quoted text + a lead sentence) and drop it straight into
// the composer's plain text — editable, and indistinguishable from anything
// the user typed. The brief wants the reference to feel ATTACHED, like an
// @mention pill, never quoted prose you could accidentally mangle. Rewriting
// InputBar as contentEditable would touch IME/voice/slash-command/paste
// plumbing far outside this mockup's scope — so a ComposeRef rides INSIDE the
// textarea's plain-text value as a short delimited marker, and a
// transparent-text overlay (the mirror layer InputBar already has for voice/
// keyword highlighting) renders a real pill in its place. See InputBar.tsx's
// mirror layer and UserMessage.tsx (sent bubbles decode the same marker so a
// reference reads identically before and after sending).
export interface ComposeRef {
  id: string;
  /** Pill text, e.g. '¶ "the sync step…"' or 'line 2 · notes.txt'. */
  label: string;
  kind: 'doc' | 'chat';
  /** doc kind only — project-relative path, for jump-to-span; never shown. */
  path?: string;
  /** doc kind only — the file's display name (not the full path). */
  fileName?: string;
  /** doc kind, code/raw text — 1-indexed inclusive line range. */
  lineRange?: [number, number];
  /** Present when this ref represents an EXISTING comment thread (batched via
   *  Comments mode's "Send to assistant") rather than a fresh selection —
   *  lets a click jump straight to that thread's highlight. */
  commentId?: string;
}

// U+2983 / U+2984 LEFT/RIGHT WHITE CURLY BRACKET — chosen because neither
// appears in ordinary typed text or Markdown/code, so the marker can never be
// confused with real content when it rides through as plain text.
const OPEN = '⦃';
const CLOSE = '⦄';

let counter = 0;
export function genRefId(): string {
  counter += 1;
  return `ref-${Date.now().toString(36)}-${counter}`;
}

/** Encodes a ComposeRef as an inert plain-text marker. Kept short-ish (no full
 *  quote, no full path) — a longer marker widens the gap between the
 *  invisible textarea text and the pill the mirror draws over it. */
export function encodeRefMarker(ref: ComposeRef): string {
  return `${OPEN}${encodeURIComponent(JSON.stringify(ref))}${CLOSE}`;
}

const MARKER_RE = /⦃([^⦃⦄]*)⦄/g;

export type ComposeSegment =
  | { type: 'text'; value: string }
  | { type: 'ref'; ref: ComposeRef; raw: string };

/** Splits composer/bubble text into plain-text runs and decoded ref tokens.
 *  A marker that fails to parse (hand-edited, truncated by a paste) degrades
 *  to plain text rather than throwing — never crash a render over a mangled
 *  marker. */
export function splitComposeRefs(text: string): ComposeSegment[] {
  const parts: ComposeSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(MARKER_RE)) {
    const start = m.index ?? 0;
    if (start > last) parts.push({ type: 'text', value: text.slice(last, start) });
    try {
      const ref = JSON.parse(decodeURIComponent(m[1])) as ComposeRef;
      parts.push({ type: 'ref', ref, raw: m[0] });
    } catch {
      parts.push({ type: 'text', value: m[0] });
    }
    last = start + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

/** True when `text[pos]` sits exactly at the end of one complete marker — used
 *  by InputBar's Backspace handler so deleting a pill removes it whole rather
 *  than nibbling one invisible character at a time. */
export function markerEndingAt(text: string, pos: number): { start: number; end: number } | null {
  for (const m of text.matchAll(MARKER_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    if (end === pos) return { start: m.index ?? 0, end };
  }
  return null;
}

/** True when `text[pos]` sits exactly at the start of one complete marker —
 *  the forward-Delete mirror of markerEndingAt. */
export function markerStartingAt(text: string, pos: number): { start: number; end: number } | null {
  for (const m of text.matchAll(MARKER_RE)) {
    const start = m.index ?? 0;
    if (start === pos) return { start, end: start + m[0].length };
  }
  return null;
}

/** Click-a-pill "jump to the span" — a no-op unless the SAME document happens
 *  to be open right now; there is no cross-file navigation here, only a
 *  scroll+flash of an already-open match (DocHighlights/CommentsMargin listen
 *  for this). */
export function dispatchJumpToRef(ref: ComposeRef): void {
  if (ref.kind !== 'doc') return;
  window.dispatchEvent(new CustomEvent('youcoded:jump-to-ref', {
    detail: { path: ref.path, commentId: ref.commentId },
  }));
}

/** Truncates a quoted snippet for a pill label — single line, short. */
export function truncateQuote(quote: string, max = 28): string {
  const oneLine = quote.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
