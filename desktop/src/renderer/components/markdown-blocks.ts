/**
 * Split a STREAMING markdown message into pieces, so the chat bubble can draw
 * each finished piece once and re-draw only the piece still being typed.
 *
 * WHY (smoothness sweep A5, 2026-09-23): while a reply streamed, the bubble ran
 * the WHOLE message through react-markdown — parse, GFM, highlight.js on every
 * code block — on every frame. Cost grew with the reply, so a long answer with a
 * few code blocks got steadily jerkier as it typed. Parsing alone was ~70% of that
 * cost (47 of 65 ms for a 16 KB reply, measured), so this module also avoids
 * re-PARSING the finished part: each update parses only the live tail.
 *
 * A PIECE is a run of top-level blocks with no blank line between them, cut at a
 * blank line. WHY at blank lines and not at every block: a block that starts right
 * under a paragraph (no blank line) is read differently than the same text on its
 * own — micromark refuses an empty list item there ("para\n* *" makes a list whose
 * item is the text "*"; alone, "* *" is a list inside a list), and the block may
 * still be pulled into the paragraph ("#foo", "===", lazy continuation). After a
 * blank line nothing is open but a list, an indented code block or a fence — and
 * those are, by definition, the same block — so a piece that starts there reads
 * exactly as it does inside the whole message. A seeded fuzz in
 * markdown-blocks.test.ts found the per-block version of this wrong; per piece it
 * holds.
 *
 * THE "FINISHED" RULE — every piece except the LAST one is frozen (never
 * re-parsed, never re-drawn). Markdown is parsed line by line and only the newest
 * block can still be open, and a blank line closes everything a later line could
 * reach into. The one exception is the last piece's own FIRST line while it
 * could still become a list item marker ("2" → "2."): it may yet join the list
 * in the piece before, so that piece stays live too (`startIsFinal`).
 *
 * CROSS-BLOCK EFFECTS — two things make one block's drawing depend on another:
 *   - link DEFINITIONS (`[x]: url`) turn a `[x]` in any other block into a link.
 *     Top-level definitions are collected, and each group is handed, in front
 *     of it (they draw nothing), only the definitions whose labels it names
 *     (`labelsOf`), so a definition being typed re-draws only the blocks that
 *     use it. Footnotes (numbered across
 *     the whole message, listed at its end) and definitions nested in a quote or
 *     list still fall back to the exact whole-message render, sticky for the rest
 *     of the stream.
 *   - rehypeSafeDisclosures pairs a top-level `<details>` block with a later
 *     `</details>` block ACROSS sibling blocks. `planStream` mirrors its pairing
 *     and draws a paired run as one piece; any other raw HTML (a comment, `<br>`)
 *     only affects itself, so it no longer holds anything live.
 *
 * DRAWN CONTENT KEEPS ITS ELEMENTS (review F1) — see `advanceStream`: pieces are
 * keyed by where they start in the message, and whatever was already drawn as one
 * document stays in that document, so nothing on screen is replaced by a fresh
 * copy (a tapped picture, an opened disclosure, a selection all survive).
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

// The same parser react-markdown builds internally (remark-parse + our only remark
// plugin, remark-gfm), so block boundaries here are the boundaries it will see.
const parser = unified().use(remarkParse).use(remarkGfm).freeze();

// The raw-HTML shapes rehypeSafeDisclosures (MarkdownContent.tsx) pairs into a
// real <details>. WHY they live here and the plugin imports them: `planStream`
// must predict exactly which blocks the plugin will pair, so both read one copy.
export const DETAILS_OPEN_WITH_SUMMARY = /^\s*<details(\s+open)?\s*>\s*<summary>\s*([^<>]*?)\s*<\/summary>\s*$/i;
export const DETAILS_OPEN = /^\s*<details(\s+open)?\s*>\s*$/i;
export const DETAILS_SUMMARY = /^\s*<summary>\s*([^<>]*?)\s*<\/summary>\s*$/i;
export const DETAILS_CLOSE = /^\s*<\/details>\s*$/i;
export const DETAILS_OPEN_ANY = /^\s*<details(?:\s+open)?\s*>/i;

interface MdNode {
  type: string;
  value?: string;
  label?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * What a top-level block means for the parts of drawing that look ACROSS blocks.
 * Only definitions and raw-HTML blocks can affect another block; everything else
 * is 'other'.
 */
/** A top-level link definition. */
interface DefInfo {
  /** Its label as micromark matches it (`normalizeIdentifier`): first one wins. */
  id: string;
  /** `id` loosened for finding it in a group's text (see labelKey). */
  key: string;
  /** Its source text, to put in front of a group that names it. */
  text: string;
  /** Offset in the message. */
  at: number;
}

type BlockInfo =
  | ({ kind: 'def' } & DefInfo)
  | { kind: 'html'; opener: 'with-summary' | 'bare' | null; summary: boolean; close: boolean; nested: boolean }
  | { kind: 'other' };

/** A run of top-level blocks with no blank line between them (see header). */
interface Piece {
  /** Offset in the message where this piece starts. */
  start: number;
  text: string;
  blocks: BlockInfo[];
  /**
   * Set on the LAST piece when its last block is a top-level fenced code block
   * that is still open and whose opening line is finished: where (in `text`)
   * the code starts. See `extendLastPiece`.
   */
  fenceBody?: number;
}

export interface MarkdownBlocks {
  /** The content these pieces were computed for. */
  source: string;
  /** Render `source` as ONE markdown document (footnotes — see header). */
  whole: boolean;
  /** Finished pieces, in order. Never re-parsed. */
  frozen: Piece[];
  /** Offset in `source` where the live (re-parsed) region begins. */
  frozenEnd: number;
  /** Every link definition in `frozen`, in order. */
  frozenDefs: DefInfo[];
  /** Pieces still being typed, in order, after the frozen ones. */
  live: Piece[];
}

/** The pieces' text, in order. Joining them gives back `source` (bar trailing blank text). */
export function blockChunks(blocks: MarkdownBlocks): string[] {
  return blocks.whole ? [blocks.source] : [...blocks.frozen, ...blocks.live].map((p) => p.text);
}

/** Every top-level link definition in the message, in order. */
export function definitionsOf(blocks: MarkdownBlocks): string[] {
  return [...blocks.frozenDefs, ...liveDefs(blocks)].map((d) => d.text);
}

const liveDefs = (blocks: MarkdownBlocks): DefInfo[] =>
  blocks.live.flatMap((p) => p.blocks.flatMap((b) => (b.kind === 'def' ? [b] : [])));

// micromark-util-normalize-identifier, copied (it is not a direct dependency):
// how micromark decides two labels are the same definition.
const normalizeIdentifier = (value: string) =>
  value.replace(/[\t\n\r ]+/g, ' ').replace(/^ | $/g, '').toLowerCase().toUpperCase();

/**
 * A label with every space, tab, line ending and `>` removed. WHY looser than
 * the real match: a reference's label can span lines inside a quote or list
 * item, where the `> ` or indent at the start of the next line is not part of
 * it. Removing those characters from BOTH sides can only find more matches,
 * never miss one — and an extra definition in front of a group draws nothing.
 */
const labelKey = (folded: string) => folded.replace(/[\t\n\r >]+/g, '');

/**
 * Every label `text` could name as a reference: the text inside each innermost
 * `[...]` (labels never hold an unescaped bracket), case-folded as micromark
 * folds it, then loosened by labelKey. A superset of what it really references.
 */
function labelsOf(text: string): string[] {
  if (!text.includes('[')) return [];
  const found = new Set<string>();
  for (const m of text.toLowerCase().toUpperCase().matchAll(/\[((?:[^[\]\\]|\\[\s\S])*)\]/g)) found.add(labelKey(m[1]));
  return [...found];
}

/**
 * The text a piece is drawn from once the message has link definitions: the
 * definitions in front (they draw nothing), then a blank line, then the piece.
 * WHY in FRONT: at the end they could be swallowed by a code fence or HTML block
 * the piece leaves open; in front, the blank line after them closes everything,
 * and a piece already starts after a blank line in the whole message.
 */
export function withDefinitions(text: string, defs: string): string {
  return defs ? `${defs}\n\n${text}` : text;
}

// A definition nested in a quote or list, or any footnote, forces the whole-
// message render: footnotes are numbered across the message and listed at its
// end, and a nested definition's text cannot be lifted out cleanly.
function needsWhole(node: MdNode, topLevel: boolean): boolean {
  if (node.type === 'footnoteDefinition') return true;
  if (node.type === 'definition' && !topLevel) return true;
  return !!node.children?.some((c) => needsWhole(c, node.type === 'root'));
}

function lineStart(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && text[i - 1] !== '\n' && text[i - 1] !== '\r') i--;
  return i;
}

// A line ending, optional spaces/tabs, another line ending: one blank line.
// Line endings are normalised first — a regex alternation would happily read the
// two halves of one CRLF as two line endings (the fuzz found it).
const hasBlankLine = (gap: string) => /\n[ \t]*\n/.test(gap.replace(/\r\n?/g, '\n'));

function isIndentedCode(text: string, block: MdNode): boolean {
  if (block.type !== 'code') return false;
  const at = block.position?.start.offset ?? 0;
  return !/^ {0,3}(?:```|~~~)/.test(text.slice(lineStart(text, at)));
}

function blockInfo(text: string, block: MdNode, base: number): BlockInfo {
  if (block.type === 'definition') {
    const at = block.position?.start.offset ?? 0;
    const id = normalizeIdentifier(block.label ?? '');
    return { kind: 'def', id, key: labelKey(id), text: text.slice(at, block.position?.end.offset ?? text.length), at: base + at };
  }
  if (block.type !== 'html') return { kind: 'other' };
  const v = block.value ?? '';
  return {
    kind: 'html',
    opener: DETAILS_OPEN_WITH_SUMMARY.test(v) ? 'with-summary' : DETAILS_OPEN.test(v) ? 'bare' : null,
    summary: DETAILS_SUMMARY.test(v),
    close: DETAILS_CLOSE.test(v),
    nested: DETAILS_OPEN_ANY.test(v),
  };
}

// A line that could close a code fence: up to three spaces, then three or more
// backticks or tildes, then nothing but spaces. Checked loosely (any length, any
// fence character) so a line that might close the fence always counts.
const FENCE_CLOSE_LINE = /(?:^|[\r\n]) {0,3}(?:`{3,}|~{3,})[ \t]*(?=[\r\n]|$)/;

// The first line of a piece that could still turn into a list item marker
// ("-", "2", "2.", "  *"). Such a piece can still JOIN the list before it:
// "1. a\n\n2" is a list and a paragraph, "1. a\n\n2." is one list.
const MAYBE_LIST_MARKER = /^[ \t]*(?:[-+*]|\d{1,9}[.)]?)?[ \t]*$/;

/**
 * Whether the piece starting `text` can no longer join the piece before it.
 * WHY only the first line matters: a piece starts after a blank line, where
 * nothing is open but a list (and indented code, which is never cut). A later
 * line cannot pull it into that list; only its own first line, while it could
 * still become a list item marker, can.
 */
function startIsFinal(text: string): boolean {
  const end = text.search(/[\r\n]/);
  return end !== -1 || !MAYBE_LIST_MARKER.test(text);
}

// A line starting (after any quote or list markers) with `<` or with a `[`
// that may be a link definition's label ("[x]:", or no closing "]" yet).
// Anything that could make a top-level raw-HTML block, a definition or a
// footnote — the only blocks the splitter records — begins such a line.
function mayHoldDefinitionOrHtml(text: string): boolean {
  for (const m of text.matchAll(/(?:^|\r\n?|\n)[ \t>*+\-0-9.)]*([<[])/g)) {
    if (m[1] === '<') return true;
    const open = m.index! + m[0].length - 1;
    const close = text.indexOf(']', open + 1);
    if (close === -1 || close === text.length - 1 || text[close + 1] === ':') return true;
    // An escaped "\]" may hide the label's real end; do not guess.
    if (text.slice(open + 1, close).includes('\\')) return true;
  }
  return false;
}

/**
 * The previous pieces with only the LAST one grown by the appended text — or
 * null when that is not certain, and the tail must be parsed.
 *
 * WHY (review 2, F2): a reply that ends in one long block with no blank line in
 * it (a 300-item list, a long table or quote, a long code block) was parsed by
 * the splitter AND by react-markdown on every word — twice today's cost. The
 * pieces can only change where a blank line is, or where a block the splitter
 * records (definition, raw HTML, footnote) starts, so when neither can have
 * happened the previous split still holds and nothing is parsed:
 *   - an open top-level code fence swallows every line (blank or not) until a
 *     line that could close it;
 *   - otherwise, a last piece with no blank line and no line that could start
 *     a definition or HTML block stays one piece of plain blocks.
 * In both cases the piece's first line must be final (`startIsFinal`), or the
 * piece could still merge into the list before it.
 */
function extendLastPiece(prev: MarkdownBlocks, content: string): MarkdownBlocks | null {
  const last = prev.live[prev.live.length - 1];
  if (!last) return null;
  const text = content.slice(last.start);
  // WHY the OLD text too (review 3, F1): when the last piece's first line was
  // still unfinished ("2"), the split kept the piece before it live because it
  // could still join that list; the appended text (". x") may be exactly what
  // joins it. Only a piece whose first line was already final can be extended.
  if (!startIsFinal(last.text) || !startIsFinal(text)) return null;
  if (last.fenceBody !== undefined) {
    // Lines of the fence before the old text's last line were already checked.
    const from = Math.max(last.fenceBody, lineStart(text, Math.max(0, last.text.length - 1)));
    if (FENCE_CLOSE_LINE.test(text.slice(from))) return null;
  } else if (hasBlankLine(text) || mayHoldDefinitionOrHtml(text)) {
    return null;
  }
  const live = prev.live.slice();
  live[live.length - 1] = { ...last, text };
  return { ...prev, source: content, live };
}

/**
 * When the one live piece starts with link definitions that are FINISHED — each
 * ends a line and the next line starts with `[`, so no title can still follow —
 * where the parse can resume after them, and the definitions it skips.
 *
 * WHY (review 2, F1): a reply ending in a list of definitions keeps them all in
 * one piece (no blank lines between), so every word re-parsed the whole list.
 * Definitions are read one after another from the start of a paragraph-like
 * run, so once one is finished the text after it reads exactly as it would on
 * its own; only the definition still being typed needs parsing.
 */
function finishedDefinitions(prev: MarkdownBlocks, content: string) {
  if (prev.whole || prev.live.length !== 1) return null;
  const piece = prev.live[0];
  let k = 0;
  let at = -1;
  for (const b of piece.blocks) {
    if (b.kind !== 'def') break;
    const end = b.at + b.text.length;
    const eol = /^(?:\r\n|\r|\n)/.exec(content.slice(end, end + 2));
    if (!eol || content[end + eol[0].length] !== '[') break;
    k++;
    at = end + eol[0].length;
  }
  return k ? { at, piece, blocks: piece.blocks.slice(0, k) } : null;
}

/**
 * Where the code of an open top-level fence starts, if `block` (the tail's last
 * block) is one — see `Piece.fenceBody`. Offsets are in `tail`.
 */
function openFenceBody(tail: string, block: MdNode): number | undefined {
  if (block.type !== 'code' || isIndentedCode(tail, block)) return undefined;
  const at = lineStart(tail, block.position?.start.offset ?? 0);
  const eol = tail.slice(at).search(/\r\n?|\n/);
  if (eol === -1) return undefined; // the opening line is still being typed
  const body = at + eol + (tail.startsWith('\r\n', at + eol) ? 2 : 1);
  return FENCE_CLOSE_LINE.test(tail.slice(body - 1)) ? undefined : body;
}

const wholeOf = (content: string): MarkdownBlocks =>
  ({ source: content, whole: true, frozen: [], frozenEnd: 0, frozenDefs: [], live: [] });

/**
 * Pieces for `content`, reusing `prev` when `content` only APPENDS to it (the
 * streaming case) — then only the text after `prev.frozenEnd` is parsed. Any
 * other change starts over from the top.
 */
export function splitMarkdownBlocks(content: string, prev?: MarkdownBlocks | null): MarkdownBlocks {
  const appended = !!prev && content.startsWith(prev.source);
  if (appended && content === prev!.source) return prev!;
  // Sticky: the footnote / nested definition that forced whole mode is still there.
  if (appended && prev!.whole) return wholeOf(content);
  const extended = appended ? extendLastPiece(prev!, content) : null;
  if (extended) return extended;

  const resume = appended ? finishedDefinitions(prev!, content) : null;
  const start = resume ? resume.at : appended ? prev!.frozenEnd : 0;
  const tail = content.slice(start);
  const root = parser.parse(tail) as MdNode;
  if (needsWhole(root, false)) return wholeOf(content);

  // Group the tail's top-level blocks into pieces. A piece starts at offset 0 (so
  // leading blank lines ride with it) or at the line start of a block that has a
  // blank line above it; its text runs to the next piece's start, so trailing
  // blank lines ride with it and the pieces join back into exactly `tail`.
  const blocks = root.children ?? [];
  const pieceStarts: number[] = [];
  const pieceBlocks: BlockInfo[][] = [];
  blocks.forEach((block, i) => {
    if (i === 0) {
      pieceStarts.push(0);
      pieceBlocks.push([]);
    } else {
      const at = lineStart(tail, block.position?.start.offset ?? 0);
      const before = blocks[i - 1];
      const gap = tail.slice(before.position?.end.offset ?? at, at);
      // WHY indented code never sits at a piece edge: micromark reads the lines
      // around an indented code block differently depending on what came before
      // it — it keeps the block "possibly continuing" across blank lines
      // ("    code\n\n-" gives the paragraph "-", while "-" alone is a list), and
      // after a list the same code block lets an empty item start a list that it
      // would not allow on its own. Found by the fuzz; no other top-level block
      // does this, and models almost always fence code, so gluing costs little.
      if (hasBlankLine(gap) && !isIndentedCode(tail, before) && !isIndentedCode(tail, block)) {
        pieceStarts.push(at);
        pieceBlocks.push([]);
      }
    }
    pieceBlocks[pieceBlocks.length - 1].push(blockInfo(tail, block, start));
  });
  const n = pieceStarts.length;
  const fenceBody = n > 0 ? openFenceBody(tail, blocks[blocks.length - 1]) : undefined;
  const piece = (i: number): Piece => {
    const p: Piece = {
      start: start + pieceStarts[i],
      text: tail.slice(pieceStarts[i], i + 1 < n ? pieceStarts[i + 1] : undefined),
      blocks: pieceBlocks[i],
    };
    if (i === n - 1 && fenceBody !== undefined) p.fenceBody = fenceBody - pieceStarts[i];
    if (i === 0 && resume) {
      // The finished definitions the parse skipped are the front of this piece.
      const lead = content.slice(resume.piece.start, start);
      p.start = resume.piece.start;
      p.text = lead + p.text;
      p.blocks = resume.blocks.concat(p.blocks);
      if (p.fenceBody !== undefined) p.fenceBody += lead.length;
    }
    return p;
  };
  // WHY HTML no longer holds anything live here (review F2): which blocks a
  // <details> pairs with is a DRAWING question, answered by planStream over the
  // pieces' BlockInfo. Parsing a piece never depends on HTML elsewhere, so the
  // splitter freezes by the plain two-live-pieces rule and each update parses
  // only the tail — a comment or <br> near the top used to make every update
  // parse (and draw) everything below it twice.
  // WHY one live piece, not two (review 2, F3): the second-to-last piece was
  // kept live as margin, so a long block followed by a new paragraph (typically
  // the text already on screen when a bubble opens mid-reply) was re-parsed on
  // every word. The only way the last piece can still reach back is its first
  // line joining a list, which startIsFinal rules out.
  const liveFrom = n >= 2 && startIsFinal(tail.slice(pieceStarts[n - 1])) ? n - 1 : Math.max(0, n - 2);

  // Copy the frozen list only when something new freezes, so an update that
  // freezes nothing does no work proportional to the reply (performance rule 4).
  let frozen = appended ? prev!.frozen : [];
  let frozenDefs = appended ? prev!.frozenDefs : [];
  if (liveFrom > 0) {
    frozen = frozen.slice();
    frozenDefs = frozenDefs.slice();
    for (let i = 0; i < liveFrom; i++) {
      const p = piece(i);
      frozen.push(p);
      for (const b of p.blocks) if (b.kind === 'def') frozenDefs.push(b);
    }
  }
  const live: Piece[] = [];
  for (let i = liveFrom; i < n; i++) live.push(piece(i));
  return {
    source: content,
    whole: false,
    frozen,
    frozenDefs,
    // n === 0 (an empty or blank tail): nothing is frozen, so the blank text is
    // re-read next time — four leading spaces can still become a code block.
    // A resumed parse's first piece starts at the skipped definitions, not at `start`.
    frozenEnd: resume && liveFrom === 0 ? resume.piece.start : start + (n > 0 ? pieceStarts[liveFrom] : 0),
    live,
  };
}

// ---------------------------------------------------------------------------
// From pieces to what the bubble draws.

/** One markdown document the bubble draws, as a sibling of the others. */
interface DrawnGroup {
  /** Where it starts in the message — its React key (see advanceStream). */
  key: number;
  source: string;
  /**
   * What is handed to react-markdown: `source`, minus trailing blank lines when
   * another group follows (see trimTrailingBlank).
   */
  draw: string;
  /** Draws at least one element (a group of only link definitions draws nothing). */
  paints: boolean;
  /** The labels it may reference (labelsOf `draw`). */
  labels: string[];
  /** The winning definitions of those labels that live OUTSIDE it, to put in front (withDefinitions). */
  defs: string;
}

/** Link definitions that won (first of each label), indexed by labelKey. */
interface DefIndex {
  /** The frozen definition list this index was built from. */
  from: DefInfo[];
  winners: Map<string, DefInfo>;
  byKey: Map<string, DefInfo[]>;
}

export interface StreamView {
  /** The content this view draws. */
  drawn: string;
  /** Pieces, once the content has grown while mounted; null = drawn as ONE document. */
  blocks: MarkdownBlocks | null;
  /** Everything before this offset was drawn as one document and stays in group 0. */
  floor: number;
  /** Leading groups that can never change again, and how many frozen pieces they hold. */
  settled: DrawnGroup[];
  settledPieces: number;
  /** Winning definitions among the frozen pieces, and among the live ones (those not already won). */
  frozenIndex: DefIndex | null;
  liveWinners: Map<string, DefInfo>;
  groups: DrawnGroup[];
}

const oneDocument = (content: string): StreamView => ({
  drawn: content,
  blocks: null,
  floor: 0,
  settled: [],
  settledPieces: 0,
  frozenIndex: null,
  liveWinners: new Map(),
  groups: [{ key: 0, source: content, draw: content, paints: true, labels: [], defs: '' }],
});

/** A message as first drawn: one document, no parsing (history messages never grow). */
export function startStream(content: string): StreamView {
  return oneDocument(content);
}

/**
 * The next view for `content`.
 *
 * WHY the grouping is shaped around what is ALREADY ON SCREEN (review F1): React
 * keeps an element only while it stays in the same document at the same place.
 * Content that moves from one group to another is torn down and rebuilt — a
 * tapped-to-load picture goes back to its placeholder, an opened disclosure snaps
 * shut, a selection vanishes. So:
 *   - groups are keyed by where they START in the message, never by position in
 *     the list, so a group keeps its identity however many groups precede it;
 *   - when a message drawn as one document (a bubble that mounted mid-reply —
 *     switching back to a session — or a history message) starts to grow, all
 *     of that drawn text stays in group 0 (`floor`) and only NEW text is split
 *     off. Group 0 is redrawn in full until its last block is finished — exactly
 *     today's cost — and is then frozen like any other group;
 *   - link definitions are handed to each group rather than collapsing the pieces.
 * The remaining remount is a footnote arriving mid-reply (whole-message fallback,
 * once), and a content REPLACEMENT (not an append; the app only appends).
 */
export function advanceStream(view: StreamView, content: string): StreamView {
  if (content === view.drawn) return view;
  if (!content.startsWith(view.drawn)) return oneDocument(content);
  // WHY (review 2, F3): a message drawn as one document (a bubble opened
  // mid-reply, or any reply before its first blank line) stays ONE document —
  // exactly today's render, no parse — until new text could start a piece of
  // its own. Splitting earlier parsed the whole message and then redrew all of
  // it anyway as group 0, on top of today's cost, every word.
  if (!view.blocks && !mayStartPiece(content, view.drawn.length)) return oneDocument(content);
  const floor = view.blocks ? view.floor : view.drawn.length;
  const blocks = splitMarkdownBlocks(content, view.blocks);
  if (blocks.whole) {
    return { ...oneDocument(content), blocks, floor };
  }
  // Only a view that was already split can be built on; one drawn as a single
  // document computed no labels or definitions for its group.
  const split = view.blocks && !view.blocks.whole ? view : null;

  // WHY per-group definitions (review 2, F1): handing EVERY definition to EVERY
  // group holding a `[` meant each word of a trailing definition list changed
  // the shared list and re-drew (re-parsed, re-highlighted) every such group
  // with the whole list in front — pieces × definitions per word. Now a group
  // gets only the winning definitions of the labels it names, and a group
  // already drawn is recomputed only when one of THOSE labels changed winner.
  // Frozen definitions are final and come first, so their winners never change.
  const frozenIndex = indexDefs(split?.frozenIndex ?? null, blocks.frozenDefs);
  const liveWinners = new Map<string, DefInfo>();
  for (const d of liveDefs(blocks)) if (!frozenIndex.winners.has(d.id) && !liveWinners.has(d.id)) liveWinners.set(d.id, d);
  const liveByKey = new Map<string, DefInfo[]>();
  for (const d of liveWinners.values()) liveByKey.set(d.key, [...(liveByKey.get(d.key) ?? []), d]);
  const lookup = (key: string) => {
    const f = frozenIndex.byKey.get(key);
    const l = liveByKey.get(key);
    return f && l ? f.concat(l) : f ?? l ?? [];
  };
  // Labels whose winner changed since the last view: only live winners and
  // newly frozen ones can differ.
  const changed = new Set<string>();
  if (split) {
    const winnerIn = (v: StreamView, id: string) => v.frozenIndex?.winners.get(id) ?? v.liveWinners.get(id);
    const now = (id: string) => frozenIndex.winners.get(id) ?? liveWinners.get(id);
    const ids = new Set([...split.liveWinners.keys(), ...liveWinners.keys()]);
    for (let i = split.frozenIndex?.from.length ?? 0; i < blocks.frozenDefs.length; i++) ids.add(blocks.frozenDefs[i].id);
    for (const id of ids) {
      const a = winnerIn(split, id);
      const b = now(id);
      if (a?.text !== b?.text || a?.at !== b?.at) changed.add((a ?? b)!.key);
    }
  }
  const finish = (g: DrawnGroup, prev: DrawnGroup | undefined): DrawnGroup => {
    const same = !!prev && prev.source === g.source && prev.draw === g.draw;
    const labels = same ? prev!.labels : labelsOf(g.draw);
    const defs = same && !labels.some((k) => changed.has(k)) ? prev!.defs : defsFor(g, labels, lookup);
    if (same && defs === prev!.defs && g.paints === prev!.paints) return prev!;
    // Same string object when unchanged, so the memoised drawing compares in O(1).
    return { ...g, labels, defs: prev && defs === prev.defs ? prev.defs : defs };
  };

  let settledIn = split ? split.settled : [];
  if (changed.size && settledIn.length) {
    const refreshed = settledIn.map((g) => {
      if (!g.labels.some((k) => changed.has(k))) return g;
      const defs = defsFor(g, g.labels, lookup);
      return defs === g.defs ? g : { ...g, defs };
    });
    if (refreshed.some((g, i) => g !== settledIn[i])) settledIn = refreshed;
  }
  const prevPending = new Map<number, DrawnGroup>();
  if (split) for (const g of split.groups.slice(split.settled.length)) prevPending.set(g.key, g);
  const { newlySettled, settledPieces, pending } = planStream(blocks, floor, split ? split.settledPieces : 0);
  const settled = newlySettled.length
    ? settledIn.concat(newlySettled.map((g) => finish(g, prevPending.get(g.key))))
    : settledIn;
  const pendingGroups = pending.map((g) => finish(g, prevPending.get(g.key)));
  return {
    drawn: content,
    blocks,
    floor,
    settled,
    settledPieces,
    frozenIndex,
    liveWinners,
    groups: settled.length ? settled.concat(pendingGroups) : pendingGroups,
  };
}

/**
 * The winners among `defs` (frozen, append-only), built on `prev` when `defs`
 * only extends the list it was built from. Copied only when something new
 * froze, never per word (performance rule 4).
 */
function indexDefs(prev: DefIndex | null, defs: DefInfo[]): DefIndex {
  if (prev && prev.from === defs) return prev;
  const extends_ = !!prev && prev.from.length <= defs.length
    && (prev.from.length === 0 || defs[prev.from.length - 1] === prev.from[prev.from.length - 1]);
  const winners = extends_ ? new Map(prev!.winners) : new Map<string, DefInfo>();
  const byKey = extends_ ? new Map(prev!.byKey) : new Map<string, DefInfo[]>();
  for (let i = extends_ ? prev!.from.length : 0; i < defs.length; i++) {
    const d = defs[i];
    if (winners.has(d.id)) continue;
    winners.set(d.id, d);
    byKey.set(d.key, [...(byKey.get(d.key) ?? []), d]);
  }
  return { from: defs, winners, byKey };
}

/**
 * The definitions to put in front of group `g`: the winner of each label it may
 * name, unless that winner is inside `g` itself (then `g` resolves it on its
 * own, and first-wins holds because the winner is the first in the message).
 */
function defsFor(g: DrawnGroup, labels: string[], lookup: (key: string) => DefInfo[]): string {
  if (!labels.length) return '';
  const end = g.key + g.source.length;
  const found: DefInfo[] = [];
  for (const k of labels) for (const d of lookup(k)) if ((d.at < g.key || d.at >= end) && !found.includes(d)) found.push(d);
  if (!found.length) return '';
  found.sort((a, b) => a.at - b.at);
  return found.map((d) => d.text).join('\n\n');
}

/**
 * Whether a piece could start at or after `floor` in `content`: pieces start
 * only on the line after a blank line, so with no blank line ending at or after
 * the drawn text, everything still belongs to what was drawn. Looks back over
 * whitespace so a blank line straddling `floor` (drawn "a\n", then "\nb") counts.
 */
function mayStartPiece(content: string, floor: number): boolean {
  let from = Math.max(0, floor - 2);
  while (from > 0 && /[ \t\r\n]/.test(content[from - 1])) from--;
  return hasBlankLine(content.slice(from));
}

/**
 * `text` without its trailing blank lines. WHY (review 2, F3): a group that is
 * followed by another ends at a blank line, and those blank lines draw nothing —
 * every block in it is closed by the piece after it. Drawing it without them
 * keeps its string the same as when it was still the last group ("para" then
 * "para\n\n" once the next paragraph starts), so the memoised drawing is
 * reused instead of being redone once per finished block. Never applied to the
 * LAST group: an open code fence keeps its trailing blank lines as code.
 */
function trimTrailingBlank(text: string): string {
  const m = /(?:\r\n|\r|\n)[ \t\r\n]*$/.exec(text);
  if (!m) return text;
  const trimmed = text.slice(0, m.index);
  // Raw HTML and a trailing definition line read differently at the very end of
  // a document ("1. one\n<br>" is a list and an HTML block; with a line ending
  // after it, one list item) — a render fuzz found it. Those groups keep their
  // blank lines; a fuzz of 12,000 other endings drew the same either way.
  if (/(?:^|[\r\n])[ \t>*+\-0-9.)]*</.test(trimmed)) return text;
  if (/^[ \t>*+\-0-9.)]*\[/.test(trimmed.slice(lineStart(trimmed, trimmed.length)))) return text;
  return trimmed;
}

const groupOf = (pieces: Piece[], last: boolean): DrawnGroup => {
  const source = pieces.length === 1 ? pieces[0].text : pieces.map((p) => p.text).join('');
  return {
    key: pieces[0].start,
    source,
    draw: last ? source : trimTrailingBlank(source),
    paints: pieces.some((p) => p.blocks.some((b) => b.kind !== 'def')),
    labels: [],
    defs: '',
  };
};

/**
 * Cut the not-yet-settled pieces into groups, mirroring rehypeSafeDisclosures:
 * a top-level `<details>` block (with its summary in the same block or the next)
 * becomes a real disclosure holding every block up to the FIRST `</details>`
 * block after it, unless another `<details>` opens in between — then it stays
 * text. A paired run is drawn as one group. Every other raw-HTML block only
 * affects itself. A group is SETTLED (never recomputed again) once it and the
 * cut after it can no longer change: all its pieces are frozen and every
 * disclosure opener before the cut was decided by frozen blocks.
 */
function planStream(blocks: MarkdownBlocks, floor: number, settledPiecesIn: number) {
  const frozenCount = blocks.frozen.length - settledPiecesIn;
  const pieces = frozenCount > 0 ? blocks.frozen.slice(settledPiecesIn).concat(blocks.live) : blocks.live;

  // The blocks that draw something, with the piece each is in. Definitions draw
  // nothing, so the plugin's "next sibling" skips them just as it skips the
  // newline text between blocks.
  const flat: { info: Extract<BlockInfo, { kind: 'html' }> | null; piece: number }[] = [];
  pieces.forEach((p, pi) => {
    for (const b of p.blocks) if (b.kind !== 'def') flat.push({ info: b.kind === 'html' ? b : null, piece: pi });
  });
  const joinBefore = new Array<boolean>(pieces.length).fill(false);
  let unsettledFrom = pieces.length; // first piece holding an opener not yet decided by frozen blocks
  for (let i = 0; i < flat.length; i++) {
    const h = flat[i].info;
    if (!h?.opener) continue;
    let contentStart = i + 1;
    let paired = h.opener === 'with-summary';
    if (h.opener === 'bare' && flat[i + 1]?.info?.summary) {
      paired = true;
      contentStart = i + 2;
    }
    // WHY (review 2, F4): a bare opener whose next drawn block is FROZEN and is
    // not a <summary> can never pair — it is text for good. Treating it as
    // undecided held every later group unsettled forever, re-walked per word.
    // Only an opener that could still pair waits for its closing block.
    const next = flat[i + 1];
    const mayPair = h.opener === 'with-summary' || !next || next.piece >= frozenCount || !!next.info?.summary;
    let closing = -1;
    for (let k = i + 1; k < flat.length; k++) if (flat[k].info?.close) { closing = k; break; }
    // Decided for good only when a FROZEN closing block follows (a live one can
    // still grow into something else — "</details>\nmore").
    if (mayPair && (closing === -1 || flat[closing].piece >= frozenCount)) unsettledFrom = Math.min(unsettledFrom, flat[i].piece);
    if (!paired || closing === -1 || closing < contentStart) continue;
    let nested = false;
    for (let k = contentStart; k < closing; k++) if (flat[k].info?.nested) { nested = true; break; }
    if (nested) continue;
    for (let pi = flat[i].piece + 1; pi <= flat[closing].piece; pi++) joinBefore[pi] = true;
    i = closing;
  }

  const groups: DrawnGroup[] = [];
  const groupPieces: number[] = []; // index of each group's last piece
  let run: Piece[] = [];
  pieces.forEach((p, pi) => {
    if (run.length && !joinBefore[pi] && p.start >= floor) {
      groups.push(groupOf(run, false));
      groupPieces.push(pi - 1);
      run = [];
    }
    run.push(p);
  });
  if (run.length) { groups.push(groupOf(run, true)); groupPieces.push(pieces.length - 1); }

  // Settle leading groups whose pieces are all frozen and whose closing cut is final.
  let s = 0;
  while (s < groups.length - 1 && groupPieces[s] < frozenCount && groupPieces[s] < unsettledFrom) s++;
  if (s === 0) return { newlySettled: [], settledPieces: settledPiecesIn, pending: groups };
  return {
    newlySettled: groups.slice(0, s),
    settledPieces: settledPiecesIn + groupPieces[s - 1] + 1,
    pending: groups.slice(s),
  };
}
