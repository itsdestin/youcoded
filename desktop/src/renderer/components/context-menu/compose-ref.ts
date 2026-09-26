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
  /** Ask Your Assistant's ONE summary chip for every open comment on a file
   *  (review deck R-5: one chip per comment was too much) — hovering it
   *  lights up all of their highlights. */
  commentIds?: string[];
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

function baseName(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || p;
}

// ── Wire format (build design §6.2, review 1 F11/F12, review 2 F2/F7, T7 review F1/F2) ─
//
// WHY this replaced `${OPEN}${encodeURIComponent(JSON.stringify(ref))}${CLOSE}`:
// that produced unreadable percent-encoded JSON in the model's own turn (the
// literal text a "Ask about this" chip sends is exactly what Claude Code
// reads as the user's prompt) — the bug the design doc's §6.1 opens with.
// The delimiters stay; the payload is now a small fixed grammar built from
// the fields a ComposeRef already carries, so the model sees a normal quoted
// excerpt plus a path/id instead of a JSON blob.
//
// PTY-safety (F12): every structural separator this grammar invents is `_`,
// NEVER a literal space. YouCoded types this text into Claude Code's PTY in
// chunks (`pty-worker.js`), and a chunk boundary landing on a literal space
// byte is exactly the kind of thing that can go missing in transit — the old
// JSON scheme was accidentally safe here only because `encodeURIComponent`
// never emits a literal space. The quote/path VALUES keep their own real
// characters (including any spaces of their own — ordinary prose already
// flows through chat messages today); only the syntax this file invents is
// underscore-joined.
//
// Escaping (F7, tightened by T7 review's F1/F2): a literal `\`, `"` is
// backslash-escaped inside a QUOTE (`escapeQuote`); a PATH additionally
// escapes its own literal `_` the same way (`escapePath`), because a path is
// the one value this grammar also splits on `_` for an optional line/cell
// suffix. `escapeText`'s single-pass `unescapeText` reverses either: every
// backslash in an escaped string is there ONLY because it introduces the next
// character literally, so replaying that rule left-to-right recovers the
// original text exactly regardless of how many backslashes the original text
// itself contained (T7 review, F1 test: a path containing `\`).
//
// F1 (high, T7 review): the old `findClosingQuote` took the LAST unescaped `"`
// followed by `_`/end, so a `"` legally present in a path (Linux/macOS allow
// it) could sit right before a `_` and get picked as the closing quote
// instead of the real one — decoding the wrong quote AND the wrong file. Two
// independent fixes, both applied: (1) `findClosingQuote` now takes the FIRST
// such `"`, matching where the true closing quote always is once the quote's
// own contents are correctly escaped; (2) a path's own `"` (and `\`, and `_`)
// are now escaped too, so a path can no longer contribute an unescaped `"` to
// the payload at all — belt and suspenders, since either fix alone would have
// closed the specific bug this review found, but only both together make every
// path character structurally inert.
//
// F2 (medium, T7 review): `splitPathSuffix` used to run an END-anchored regex
// over the raw (unescaped) remainder, so an extension-less path that itself
// ends in something shaped like `_L2-3` or `_cell_A1` (e.g. `notes/draft_L2-3`)
// was misread as a real line-range/cell suffix, truncating the path. Escaping
// a path's own `_` (above) removes the ambiguity at the source:
// `splitEscapedPathAndSuffix` scans the escaped remainder LEFT-TO-RIGHT for
// the first UNESCAPED `_` — the path's own underscores are never unescaped,
// so the only unescaped `_` that can exist is the real structural separator
// `pathSuffix()` inserts (or none, meaning no suffix at all).
//
// Four forms (F2/review-2 added the 4th — the original 3-form draft broke
// every shipped chat-message/code-block "Ask about this", a live, R15-covered
// feature):
//   1. doc quote (ephemeral, no comment):      "<quote>"_<path>[_L<a>-<b>|_cell_<C>[_<sheet>]]
//   2. an existing comment thread:              comment_<commentId>_"<quote>"_<path>
//   3. a chat message / code block (pathless):  chat_<entryKey>_"<quote>"
//   4. Ask Your Assistant's summary chip:        <N>_open_comments_<path>_use_ReadFileComments_to_read_them
//      (deliberately a POINTER, not the comments themselves — see
//      CommentsFloatingActions.tsx's own comment. A decoded summary chip
//      therefore cannot recover which N comments it covered, only the count:
//      `use-ref-source-highlight.ts`'s `rangeFor` and `ReadingHighlights.tsx`'s
//      jump listener recover "every currently open comment on `ref.path`"
//      from the LIVE STORE instead — see those files, F3 — rather than from
//      the wire text; `jumpToRef` still opens the file itself via `ref.path`
//      when nothing local answers the hover/click.)
//
// `<path>` in forms 1/2/4 is always `escapePath(ref.path)` on the wire and
// `unescapePath(...)` on the way back out.
function escapeText(s: string, extra: RegExp): string {
  // Order matters: escaping `\` FIRST means the later `extra` pass only ever
  // matches characters that were literally in the original text (it can't
  // accidentally re-touch a backslash this pass just inserted), which is what
  // makes `unescapeText`'s single left-to-right pass an exact inverse.
  return s.replace(/\\/g, '\\\\').replace(extra, (c) => `\\${c}`);
}

function unescapeText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

function escapeQuote(q: string): string {
  return escapeText(q, /"/g);
}

function unescapeQuote(q: string): string {
  return unescapeText(q);
}

// A path escapes its own `"` (F1 — never let a path's quote mark be read as
// this payload's closing quote) AND its own `_` (F2 — never let a path's
// underscore be read as this grammar's separator or an `_L…`/`_cell_…` suffix).
function escapePath(p: string): string {
  return escapeText(p, /[_"]/g);
}

function unescapePath(p: string): string {
  return unescapeText(p);
}

/** True when the `"` at index `i` is escaped — preceded by an ODD run of
 *  literal backslashes (an even run, including zero, means those backslashes
 *  are themselves escaped/absent and this `"` is a real, structural mark). */
function isEscapedAt(s: string, i: number): boolean {
  let count = 0;
  let j = i - 1;
  while (j >= 0 && s[j] === '\\') { count++; j--; }
  return count % 2 === 1;
}

/** `_cell_<C>[_<sheet>]` or `_L<start>-<end>`, whichever `ref` carries — the
 *  optional suffix after a doc quote's path (form 1). Inserted UNESCAPED
 *  (real literal `_`s) — it always comes after an escaped path, whose own
 *  `_`s can never be mistaken for it (F2, see `splitEscapedPathAndSuffix`). */
function pathSuffix(ref: ComposeRef): string {
  if (ref.cell) return `_cell_${ref.cell}${ref.sheet ? `_${ref.sheet}` : ''}`;
  if (ref.lineRange) return `_L${ref.lineRange[0]}-${ref.lineRange[1]}`;
  return '';
}

function encodeRefPayload(ref: ComposeRef): string {
  // Checked first: CommentsFloatingActions sets BOTH commentId and
  // commentIds on its one summary ref, and the summary form must win.
  if (ref.commentIds && ref.commentIds.length > 0 && ref.path) {
    return `${ref.commentIds.length}_open_comments_${escapePath(ref.path)}_use_ReadFileComments_to_read_them`;
  }
  if (ref.commentId && ref.path) {
    return `comment_${ref.commentId}_"${escapeQuote(ref.quote ?? '')}"_${escapePath(ref.path)}`;
  }
  if (ref.kind === 'chat') {
    return `chat_${ref.entryKey ?? ''}_"${escapeQuote(ref.quote ?? '')}"`;
  }
  return `"${escapeQuote(ref.quote ?? '')}"_${escapePath(ref.path ?? '')}${pathSuffix(ref)}`;
}

/** Encodes a ComposeRef as an inert plain-text marker (see the wire-format
 *  block above for the grammar and why it replaced percent-encoded JSON). */
function encodeRefMarker(ref: ComposeRef): string {
  return `${OPEN}${encodeRefPayload(ref)}${CLOSE}`;
}

const MARKER_RE = /⦃([^⦃⦄]*)⦄/g;

/** Locates a payload's closing quote mark: the FIRST `"` (index > 0, i.e. not
 *  the opening mark itself) that is NOT itself escaped and is immediately
 *  followed by a recognized trailing token (`_`, or the end of the payload).
 *
 *  WHY first, not last (F1, T7 review — was LAST until this fix): a path may
 *  legally contain its own `"` (Linux/macOS allow it), and with `escapePath`
 *  now escaping a path's own `"` too, no unescaped `"` can survive inside the
 *  path region at all — but taking the FIRST match is kept anyway as the
 *  structural guarantee: the real closing quote is always the first
 *  unescaped one once the quote's own contents are correctly escaped, so this
 *  no longer depends on every caller having escaped its path correctly.
 *  Returns -1 for a malformed/hand-edited payload. */
function findClosingQuote(payload: string): number {
  for (let i = 1; i < payload.length; i++) {
    if (payload[i] !== '"' || isEscapedAt(payload, i)) continue;
    const next = payload[i + 1];
    if (next === undefined || next === '_') return i;
  }
  return -1;
}

/** Reads a leading `"…"` off `payload` (which must start with `"`),
 *  unescaping `\"`. `rest` is whatever follows the closing mark, for the
 *  caller to keep parsing (a path, or nothing for the chat form). */
function extractQuote(payload: string): { quote: string; rest: string } | null {
  if (!payload.startsWith('"')) return null;
  const end = findClosingQuote(payload);
  if (end < 0) return null;
  return { quote: unescapeQuote(payload.slice(1, end)), rest: payload.slice(end + 1) };
}

/** Finds the boundary between an escaped path and this form's optional
 *  structural suffix (`_L<a>-<b>` / `_cell_<C>[_<sheet>]`) — F2, T7 review.
 *  `escapePath` escapes every literal `_` a real path contains, so scanning
 *  left-to-right for the first UNESCAPED `_` finds the true separator (the
 *  ONLY one `pathSuffix()` ever inserts unescaped) and never a literal
 *  underscore — or an `_L…`/`_cell_…`-shaped run of one — sitting inside a
 *  real filename (`notes/draft_L2-3`, `x_cell_A1`). No unescaped `_` at all
 *  means the whole remainder is the path and there is no suffix. */
function splitEscapedPathAndSuffix(rem: string): { escapedPath: string; suffix: string | null } {
  for (let i = 0; i < rem.length; i++) {
    if (rem[i] === '_' && !isEscapedAt(rem, i)) {
      return { escapedPath: rem.slice(0, i), suffix: rem.slice(i + 1) };
    }
  }
  return { escapedPath: rem, suffix: null };
}

/** Splits `<escaped-path>[_L<start>-<end>|_cell_<C>[_<sheet>]]` — form 1's
 *  optional suffix — and unescapes the path back to its real characters. */
function splitPathSuffix(rem: string): { path: string; lineRange?: [number, number]; cell?: string; sheet?: string } {
  const { escapedPath, suffix } = splitEscapedPathAndSuffix(rem);
  const path = unescapePath(escapedPath);
  if (suffix == null) return { path };
  const cellMatch = /^cell_([A-Za-z]+[0-9]+)(?:_(.*))?$/.exec(suffix);
  if (cellMatch) return { path, cell: cellMatch[1], sheet: cellMatch[2] || undefined };
  const lineMatch = /^L(\d+)-(\d+)$/.exec(suffix);
  if (lineMatch) return { path, lineRange: [Number(lineMatch[1]), Number(lineMatch[2])] };
  // The unescaped `_` we split on wasn't actually followed by a recognized
  // suffix shape — not something `encodeRefPayload` ever produces, but a
  // hand-edited/malformed marker degrades to "the rest is all path" rather
  // than losing text.
  return { path: unescapePath(rem) };
}

/** Reverses `encodeRefPayload`. Returns null for anything that doesn't match
 *  one of the grammar's four forms — the caller treats that as plain text
 *  rather than throwing (same "never crash a render over a mangled marker"
 *  policy the old JSON parser's `catch` had). Reconstructs everything the
 *  pill/hover/click machinery reads (quote, path, cell/sheet, lineRange,
 *  commentId, entryKey) and a human-readable `label` matching the same
 *  formulas `build-menu.ts`/`CommentsFloatingActions.tsx` use when they first
 *  build a ref, so a reference reads the same before and after sending in
 *  every case the wire format can actually carry (see the summary-chip note
 *  above for the one case it can't). */
function decodeRefPayload(payload: string): ComposeRef | null {
  const summary = /^(\d+)_open_comments_(.+)_use_ReadFileComments_to_read_them$/.exec(payload);
  if (summary) {
    const count = Number(summary[1]);
    const path = unescapePath(summary[2]);
    if (path && count > 0) {
      const fileName = baseName(path);
      return {
        id: genRefId(),
        kind: 'doc',
        path,
        fileName,
        label: `${count} ${count === 1 ? 'comment' : 'comments'} · ${fileName}`,
      };
    }
    return null;
  }

  if (payload.startsWith('comment_')) {
    const afterKind = payload.slice('comment_'.length);
    // A comment id (`c-${randomUUID()}`, T1's schema) has no `_` or `"` of
    // its own, so the first `_"` run unambiguously starts the quote.
    const qStart = afterKind.indexOf('_"');
    if (qStart < 0) return null;
    const commentId = afterKind.slice(0, qStart);
    const parsed = extractQuote(afterKind.slice(qStart + 1));
    if (!commentId || !parsed || !parsed.rest.startsWith('_')) return null;
    const path = unescapePath(parsed.rest.slice(1));
    if (!path) return null;
    const fileName = baseName(path);
    return {
      id: genRefId(),
      kind: 'doc',
      commentId,
      path,
      fileName,
      quote: parsed.quote,
      label: `“${truncateQuote(parsed.quote)}” · ${fileName}`,
    };
  }

  if (payload.startsWith('chat_')) {
    const afterKind = payload.slice('chat_'.length);
    const qStart = afterKind.indexOf('_"');
    if (qStart < 0) return null;
    const entryKey = afterKind.slice(0, qStart);
    const parsed = extractQuote(afterKind.slice(qStart + 1));
    if (!parsed || parsed.rest.length > 0) return null; // the quote is the LAST element in this form
    return {
      id: genRefId(),
      kind: 'chat',
      entryKey: entryKey || undefined,
      quote: parsed.quote,
      label: `“${truncateQuote(parsed.quote)}”`,
    };
  }

  if (payload.startsWith('"')) {
    const parsed = extractQuote(payload);
    if (!parsed || !parsed.rest.startsWith('_')) return null;
    const { path, lineRange, cell, sheet } = splitPathSuffix(parsed.rest.slice(1));
    if (!path) return null;
    const fileName = baseName(path);
    const label = cell
      ? `${sheet ? `${sheet} · ` : ''}${cell} · ${fileName}`
      : lineRange
        ? `${lineRange[0] === lineRange[1] ? `line ${lineRange[0]}` : `lines ${lineRange[0]}-${lineRange[1]}`} · ${fileName}`
        : `“${truncateQuote(parsed.quote)}”`;
    return { id: genRefId(), kind: 'doc', path, fileName, quote: parsed.quote, lineRange, cell, sheet, label };
  }

  return null;
}

export type ComposeSegment =
  | { type: 'text'; value: string }
  | { type: 'ref'; ref: ComposeRef; raw: string };

/** Splits composer/bubble text into plain-text runs and decoded ref tokens.
 *  A marker that fails to parse (hand-edited, truncated by a paste, or one
 *  whose quoted text happens to contain a raw ⦃/⦄) degrades to plain text
 *  rather than throwing — never crash a render over a mangled marker. */
export function splitComposeRefs(text: string): ComposeSegment[] {
  const parts: ComposeSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(MARKER_RE)) {
    const start = m.index ?? 0;
    if (start > last) parts.push({ type: 'text', value: text.slice(last, start) });
    const ref = decodeRefPayload(m[1]);
    if (ref) parts.push({ type: 'ref', ref, raw: m[0] });
    else parts.push({ type: 'text', value: m[0] });
    last = start + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

/** True for a decoded Ask Your Assistant summary chip (form 4) — F3, review
 *  3. The wire format deliberately never carries `commentIds` (§6.2 — "the
 *  comments themselves reach the assistant through its comment tools, not the
 *  chip"), so a decode of it is the ONLY `kind: 'doc'` ref with a `path` and
 *  no `quote`/`commentId`/`cell`/`lineRange` at all — every other decoded doc
 *  form always sets `quote`. `use-ref-source-highlight.ts` and
 *  `ReadingHighlights.tsx` use this to recover "every open comment on this
 *  path" from the live store instead of from the (deliberately id-less) wire
 *  text. */
export function isSummaryChipRef(ref: ComposeRef): boolean {
  return ref.kind === 'doc' && !!ref.path && !ref.quote && !ref.commentId && !ref.cell && !ref.lineRange;
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
