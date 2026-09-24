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
 * FALLBACKS — the exact whole-message render when splitting could change the output:
 *   - any link/footnote DEFINITION (`[x]: url`, `[^1]: …`): it changes how text in
 *     OTHER blocks renders (a `[x]` elsewhere becomes a link). Sticky for the rest of
 *     the stream, because the text that caused it is still there.
 *   - top-level raw HTML: rehypeSafeDisclosures pairs `<details>` with a later
 *     `</details>` ACROSS sibling blocks. Pieces before the first HTML block stay
 *     frozen; everything from it to the end is one live piece, drawn together exactly
 *     as the whole message would be.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

// The same parser react-markdown builds internally (remark-parse + our only remark
// plugin, remark-gfm), so block boundaries here are the boundaries it will see.
const parser = unified().use(remarkParse).use(remarkGfm).freeze();

interface MdNode {
  type: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

export interface MarkdownBlocks {
  /** The content these pieces were computed for. */
  source: string;
  /** Render `source` as ONE markdown document (fallback — see header). */
  whole: boolean;
  /** Source text of each finished piece, in order. Never re-parsed. */
  frozen: string[];
  /** Offset in `source` where the live (re-parsed) region begins. */
  frozenEnd: number;
  /** Source text of each live piece, in order, after the frozen ones. */
  live: string[];
}

/** The pieces to render, in order. Joining them gives back `source`. */
export function blockChunks(blocks: MarkdownBlocks): string[] {
  return blocks.whole ? [blocks.source] : [...blocks.frozen, ...blocks.live];
}

function containsDefinition(node: MdNode): boolean {
  if (node.type === 'definition' || node.type === 'footnoteDefinition') return true;
  return !!node.children?.some(containsDefinition);
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

const wholeOf = (content: string): MarkdownBlocks =>
  ({ source: content, whole: true, frozen: [], frozenEnd: 0, live: [] });

/**
 * Pieces for `content`, reusing `prev` when `content` only APPENDS to it (the
 * streaming case) — then only the text after `prev.frozenEnd` is parsed. Any
 * other change starts over from the top.
 */
export function splitMarkdownBlocks(content: string, prev?: MarkdownBlocks | null): MarkdownBlocks {
  const appended = !!prev && content.startsWith(prev.source);
  if (appended && content === prev!.source) return prev!;
  // Sticky: the definition / text that forced whole mode is still in the message.
  if (appended && prev!.whole) return wholeOf(content);

  const start = appended ? prev!.frozenEnd : 0;
  const frozen = appended ? prev!.frozen.slice() : [];
  const tail = content.slice(start);
  const root = parser.parse(tail) as MdNode;
  if (containsDefinition(root)) return wholeOf(content);

  // Group the tail's top-level blocks into pieces. A piece starts at offset 0 (so
  // leading blank lines ride with it) or at the line start of a block that has a
  // blank line above it; its text runs to the next piece's start, so trailing
  // blank lines ride with it and the pieces join back into exactly `tail`.
  const blocks = root.children ?? [];
  const pieceStarts: number[] = [];
  let htmlPiece = -1;
  blocks.forEach((block, i) => {
    if (i === 0) {
      pieceStarts.push(0);
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
      }
    }
    if (block.type === 'html' && htmlPiece === -1) htmlPiece = pieceStarts.length - 1;
  });
  const n = pieceStarts.length;
  const piece = (i: number) => tail.slice(pieceStarts[i], i + 1 < n ? pieceStarts[i + 1] : undefined);
  const liveFrom = Math.max(0, Math.min(n - 2, htmlPiece === -1 ? n : htmlPiece));

  for (let i = 0; i < liveFrom; i++) frozen.push(piece(i));
  const live: string[] = [];
  for (let i = liveFrom; i < n; i++) {
    if (htmlPiece !== -1 && i >= htmlPiece) {
      live.push(tail.slice(pieceStarts[i]));
      break;
    }
    live.push(piece(i));
  }
  return {
    source: content,
    whole: false,
    frozen,
    // n === 0 (an empty or blank tail): nothing is frozen, so the blank text is
    // re-read next time — four leading spaces can still become a code block.
    frozenEnd: start + (n > 0 ? pieceStarts[liveFrom] : 0),
    live,
  };
}
