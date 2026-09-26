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
  /** Pill text, e.g. '“the sync step…”' or 'line 2 · notes.txt'. */
  label: string;
  kind: 'doc' | 'chat';
  /** doc kind only — project-relative path, for jump-to-span; never shown. */
  path?: string;
  /** doc kind only — the file's display name (not the full path). */
  fileName?: string;
  /** doc kind — the selected text itself (capped), so hovering or clicking
   *  the chip can find and light up where it came from. */
  quote?: string;
  /** chat kind — the timeline entry (ChatView data-entry-key) it came from. */
  entryKey?: string;
  /** doc kind, spreadsheets — the cell ("C4") the reference points at. */
  cell?: string;
  /** doc kind, multi-sheet workbooks — the tab that cell is on. */
  sheet?: string;
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
function encodeRefMarker(ref: ComposeRef): string {
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

// ── Chip ↔ source text (Destin, 2026-09-24: "i should be able to click the
// chip and have it focus/highlight the originating text… should be hover
// sensitive as well") ──────────────────────────────────────────────────────
// Hover: 'youcoded:ref-hover' with the ref (or null on leave) — an open viewer
// of that file tints the source text while the pointer is on the chip.
// Click: 'youcoded:jump-to-ref' — an open viewer of that file scrolls to the
// text and flashes it, and marks the event handled. When no viewer answered,
// the caller's `openFile` opens the file and the jump waits as `pendingJump`
// until that viewer mounts and its content has loaded (useRefSourceHighlight).

/** Hovering a chip (null when the pointer leaves it). */
export function dispatchRefHover(ref: ComposeRef | null): void {
  window.dispatchEvent(new CustomEvent('youcoded:ref-hover', { detail: { ref } }));
}

let pendingJump: { ref: ComposeRef; until: number } | null = null;
const PENDING_JUMP_MS = 6000;

/** Clicking a chip: jump to its source text, opening the file if needed. */
export function jumpToRef(ref: ComposeRef, openFile?: (path: string) => Promise<void> | void): void {
  const detail = { ref, handled: false };
  window.dispatchEvent(new CustomEvent('youcoded:jump-to-ref', { detail }));
  if (!detail.handled && ref.kind === 'doc' && openFile && ref.path) {
    pendingJump = { ref, until: Date.now() + PENDING_JUMP_MS };
    void openFile(ref.path);
  }
}

/** The jump a just-opened viewer of `path` should perform, if any. */
export function takePendingJump(path: string): ComposeRef | null {
  if (!pendingJump || pendingJump.ref.path !== path) return null;
  if (Date.now() > pendingJump.until) { pendingJump = null; return null; }
  const ref = pendingJump.ref;
  pendingJump = null;
  return ref;
}

/** Truncates a quoted snippet for a pill label — single line, short. */
export function truncateQuote(quote: string, max = 28): string {
  const oneLine = quote.replace(/\s+/g, ' ').trim();
  // trimEnd: a cut that lands after a space would otherwise read "of …".
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

// ── Draft tokens: what the COMPOSER holds while you type ─────────────────
//
// WHY a second, display-sized form (Destin, 2026-09-24: "if I ask about text
// my cursor ends up in the completely wrong position. I can't really tell
// where I'm typing in relation to the chip"): the textarea used to hold the
// full encoded marker (the URL-encoded JSON above, often 150+ invisible
// characters) while the mirror layer drew a short pill in its place — so the
// textarea's caret was measured against text the user could not see, and
// drifted far to the right of the pill. A draft token holds EXACTLY the
// characters the mirror draws: "⦃" + a zero-width key + the label + "⦄". The
// mirror renders the same string (brackets and key transparent, the label on
// a chip fill), so both layers lay out identically and the caret always sits
// where it looks like it does. The full marker is only produced on send
// (expandDraftTokens), which is what the sent bubble and transcript keep.
//
// The key is the ref's slot in a module-level registry, written in binary
// with two zero-width characters and ended by a word joiner. Module-level so a
// draft that survives a session switch or remount still resolves.
const ZW0 = '​';
const ZW1 = '‌';
const ZW_END = '⁠';
const draftRegistry = new Map<string, ComposeRef>();
let draftCounter = 0;

/** Registers `ref` and returns the display token to put in the composer. */
export function makeDraftToken(ref: ComposeRef): string {
  draftCounter += 1;
  const key = draftCounter.toString(2).replace(/0/g, ZW0).replace(/1/g, ZW1) + ZW_END;
  draftRegistry.set(key, ref);
  // Non-breaking spaces: a chip never wraps across two lines, in either layer.
  return `${OPEN}${key}${ref.label.replace(/ /g, ' ')}${CLOSE}`;
}

/** The ref behind a draft token's key (the mirror chip carries the key). */
export function draftRef(key: string): ComposeRef | null {
  return draftRegistry.get(key) ?? null;
}

const DRAFT_RE = /⦃([​‌]+⁠)([^⦃⦄]*)⦄/g;

export type DraftSegment =
  | { type: 'text'; value: string }
  | { type: 'token'; key: string; label: string; ref: ComposeRef | null };

/** Splits composer text into plain runs and draft tokens, for the mirror. */
export function splitDraftTokens(text: string): DraftSegment[] {
  const out: DraftSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(DRAFT_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ type: 'text', value: text.slice(last, start) });
    out.push({ type: 'token', key: m[1], label: m[2], ref: draftRegistry.get(m[1]) ?? null });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

/** Every token's [start, end) range in `text` — for keeping the caret out of
 *  tokens and deleting them whole. */
export function draftTokenRanges(text: string): Array<{ start: number; end: number }> {
  return [...text.matchAll(DRAFT_RE)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

/** Turns draft tokens into the full markers the sent bubble decodes. A token
 *  whose ref is unknown (e.g. pasted from another app run) degrades to its
 *  label as plain text rather than sending invisible characters. */
export function expandDraftTokens(text: string): string {
  return text.replace(DRAFT_RE, (_m, key: string, label: string) => {
    const ref = draftRegistry.get(key);
    return ref ? encodeRefMarker(ref) : label.replace(/ /g, ' ');
  });
}
