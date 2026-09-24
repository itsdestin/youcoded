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
 * THE "FINISHED" RULE — every piece except the LAST TWO is frozen (never
 * re-parsed, never re-drawn). Markdown is parsed line by line and only the newest
 * block can still be open, and a blank line closes everything a later line could
 * reach into, so the last piece alone would do; two is margin. Both live pieces are
 * still drawn separately, so the second-to-last one (usually a just-finished code
 * block) re-parses but does not re-draw or re-highlight.
 *
 * CROSS-BLOCK EFFECTS — two things make one block's drawing depend on another:
 *   - link DEFINITIONS (`[x]: url`) turn a `[x]` in any other block into a link.
 *     Top-level definitions are collected and handed to every piece that holds a
 *     `[`, placed in front of it (they draw nothing). Footnotes (numbered across
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
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * What a top-level block means for the parts of drawing that look ACROSS blocks.
 * Only definitions and raw-HTML blocks can affect another block; everything else
 * is 'other'.
 */
type BlockInfo =
  | { kind: 'def'; text: string }
  | { kind: 'html'; opener: 'with-summary' | 'bare' | null; summary: boolean; close: boolean; nested: boolean }
  | { kind: 'other' };

/** A run of top-level blocks with no blank line between them (see header). */
interface Piece {
  /** Offset in the message where this piece starts. */
  start: number;
  text: string;
  blocks: BlockInfo[];
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
  /** Source text of every link definition in `frozen`, in order. */
  frozenDefs: string[];
  /** Pieces still being typed, in order, after the frozen ones. */
  live: Piece[];
}

/** The pieces' text, in order. Joining them gives back `source` (bar trailing blank text). */
export function blockChunks(blocks: MarkdownBlocks): string[] {
  return blocks.whole ? [blocks.source] : [...blocks.frozen, ...blocks.live].map((p) => p.text);
}

/** Every top-level link definition in the message, in order. */
export function definitionsOf(blocks: MarkdownBlocks): string[] {
  const live = blocks.live.flatMap((p) => p.blocks.flatMap((b) => (b.kind === 'def' ? [b.text] : [])));
  return live.length ? [...blocks.frozenDefs, ...live] : blocks.frozenDefs;
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

function blockInfo(text: string, block: MdNode): BlockInfo {
  if (block.type === 'definition') {
    return { kind: 'def', text: text.slice(block.position?.start.offset ?? 0, block.position?.end.offset ?? text.length) };
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

  const start = appended ? prev!.frozenEnd : 0;
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
    pieceBlocks[pieceBlocks.length - 1].push(blockInfo(tail, block));
  });
  const n = pieceStarts.length;
  const piece = (i: number): Piece => ({
    start: start + pieceStarts[i],
    text: tail.slice(pieceStarts[i], i + 1 < n ? pieceStarts[i + 1] : undefined),
    blocks: pieceBlocks[i],
  });
  // WHY HTML no longer holds anything live here (review F2): which blocks a
  // <details> pairs with is a DRAWING question, answered by planStream over the
  // pieces' BlockInfo. Parsing a piece never depends on HTML elsewhere, so the
  // splitter freezes by the plain two-live-pieces rule and each update parses
  // only the tail — a comment or <br> near the top used to make every update
  // parse (and draw) everything below it twice.
  const liveFrom = Math.max(0, n - 2);

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
      for (const b of p.blocks) if (b.kind === 'def') frozenDefs.push(b.text);
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
    frozenEnd: start + (n > 0 ? pieceStarts[liveFrom] : 0),
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
  /** Draws at least one element (a group of only link definitions draws nothing). */
  paints: boolean;
  /** Holds a `[`, so link definitions elsewhere can change how it draws. */
  refs: boolean;
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
  /** The message's link definitions, ready to put in front of a group (see withDefinitions). */
  defs: string;
  groups: DrawnGroup[];
}

const oneDocument = (content: string): StreamView => ({
  drawn: content,
  blocks: null,
  floor: 0,
  settled: [],
  settledPieces: 0,
  defs: '',
  groups: [{ key: 0, source: content, paints: true, refs: false }],
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
  const floor = view.blocks ? view.floor : view.drawn.length;
  const blocks = splitMarkdownBlocks(content, view.blocks);
  if (blocks.whole) {
    return { ...oneDocument(content), blocks, floor };
  }
  const defList = definitionsOf(blocks);
  const joined = defList.join('\n\n');
  // Same string object when unchanged, so the memoised groups compare in O(1).
  const defs = joined === view.defs ? view.defs : joined;
  const settledIn = view.blocks ? view : { settled: [], settledPieces: 0 };
  const { settled, settledPieces, pending } = planStream(blocks, floor, settledIn.settled, settledIn.settledPieces);
  return {
    drawn: content,
    blocks,
    floor,
    settled,
    settledPieces,
    defs,
    groups: settled.length ? settled.concat(pending) : pending,
  };
}

const groupOf = (pieces: Piece[]): DrawnGroup => {
  const source = pieces.length === 1 ? pieces[0].text : pieces.map((p) => p.text).join('');
  return {
    key: pieces[0].start,
    source,
    paints: pieces.some((p) => p.blocks.some((b) => b.kind !== 'def')),
    refs: source.includes('['),
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
function planStream(blocks: MarkdownBlocks, floor: number, settledIn: DrawnGroup[], settledPiecesIn: number) {
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
      groups.push(groupOf(run));
      groupPieces.push(pi - 1);
      run = [];
    }
    run.push(p);
  });
  if (run.length) { groups.push(groupOf(run)); groupPieces.push(pieces.length - 1); }

  // Settle leading groups whose pieces are all frozen and whose closing cut is final.
  let s = 0;
  while (s < groups.length - 1 && groupPieces[s] < frozenCount && groupPieces[s] < unsettledFrom) s++;
  if (s === 0) return { settled: settledIn, settledPieces: settledPiecesIn, pending: groups };
  return {
    settled: settledIn.concat(groups.slice(0, s)),
    settledPieces: settledPiecesIn + groupPieces[s - 1] + 1,
    pending: groups.slice(s),
  };
}
