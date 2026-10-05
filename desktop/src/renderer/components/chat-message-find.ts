import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { AssistantTurn, TimelineEntry } from '../state/chat-types';
import { detectLinkTokens } from './markdown-linkify';
import { detectFilepaths } from '../hooks/useInlineFilepathDetector';
import { splitComposeRefs } from './context-menu/compose-ref';

// mdast is transitive; keep the shape needed by the direct remark dependencies.
type MarkdownNode = { type: string; value?: string; lang?: string; children?: MarkdownNode[] };
export interface MessageFindRow { id: string; bodies: readonly string[]; markdown: boolean; attachments?: readonly string[] }
export interface MessageFindHit { id: string; body: number; ordinal: number }
const parser = unified().use(remarkParse).use(remarkGfm);
const DOM_BLOCK = 'p,pre,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,hr';

export function extractMessageFindRows(timeline: readonly TimelineEntry[], turns: ReadonlyMap<string, AssistantTurn>): MessageFindRow[] {
  const rows: MessageFindRow[] = [];
  for (const entry of timeline) {
    // WHY: injected user-role entries are host/tool events, never authored messages.
    if (entry.kind === 'user' && !entry.injected) rows.push({ id: entry.message.id, bodies: [entry.message.content], markdown: false, attachments: entry.message.attachments });
    if (entry.kind === 'assistant-turn') {
      const turn = turns.get(entry.turnId);
      if (turn) rows.push({ id: entry.turnId, bodies: turn.segments.filter((seg) => seg.type === 'text').map((seg) => seg.content), markdown: true });
    }
  }
  return rows;
}

function fileBasename(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;
}

function visiblePaths(text: string): string {
  const matches = detectLinkTokens(text, { filepaths: true });
  let result = '';
  let cursor = 0;
  for (const match of matches) {
    result += text.slice(cursor, match.start) + (match.kind === 'path' ? fileBasename(match.value) : match.text);
    cursor = match.end;
  }
  return result + text.slice(cursor);
}

function plainUserText(content: string, attachments: readonly string[] = []): string {
  // WHY: the picker preserves exact paths containing spaces. Mirror UserMessage's
  // prefix consumption before regex detection of the remaining typed text.
  let text = content;
  let prefix = '';
  for (let i = 0; i < attachments.length; i++) {
    const path = attachments[i];
    if (!text.startsWith(path)) break;
    text = text.slice(path.length).replace(/^ /, '');
    prefix += fileBasename(path);
    if (i < attachments.length - 1 || text.length > 0) prefix += ' ';
  }
  // WHY: sent reference markers become labelled pills before path detection.
  // Index only their visible label, not hidden quotes/paths or marker syntax.
  return prefix + splitComposeRefs(text).map((segment) => {
    if (segment.type === 'ref') return segment.ref.label;
    const prose = segment.value;
    let result = '', cursor = 0;
    for (const match of detectFilepaths(prose)) {
      result += prose.slice(cursor, match.start) + fileBasename(match.path);
      cursor = match.end;
    }
    return result + prose.slice(cursor);
  }).join('');
}

function markdownBlocks(source: string): string[] {
  const root = parser.parse(source) as MarkdownNode;
  const blocks: string[] = [];
  const inline = (node: MarkdownNode, inLink = false): string => {
    if (node.type === 'text') return inLink ? node.value ?? '' : visiblePaths(node.value ?? '');
    if (node.type === 'inlineCode') return visiblePaths(node.value ?? '');
    if (node.type === 'break') return '\n';
    if (node.type === 'image' || node.type === 'html') return '';
    return node.children?.map((child) => inline(child, inLink || node.type === 'link' || node.type === 'linkReference')).join('') ?? '';
  };
  let closedDisclosure = false;
  const visit = (node: MarkdownNode) => {
    if (node.type === 'html') {
      const html = node.value ?? '';
      // A raw node that contains both tags cannot be paired by
      // rehypeSafeDisclosures; its fallback strips tags and shows the words.
      if (/<details\b/i.test(html) && /<\/details>/i.test(html)) {
        const readable = html.replace(/<(?:(?:"[^"]*"|'[^']*'|[^'">])*)>/g, '').trim();
        if (readable) blocks.push(readable);
        return;
      }
      const summary = html.match(/<summary[^>]*>([^<]*)<\/summary>/i);
      if (summary) blocks.push(summary[1]);
      if (/<details\b/i.test(html)) closedDisclosure = !/<details\b[^>]*\bopen\b/i.test(html);
      if (/<\/details>/i.test(html)) closedDisclosure = false;
      return;
    }
    if (closedDisclosure) return;
    if (node.type === 'code') {
      // A conversations fence is replaced by interactive reference cards, not code text.
      if (node.lang !== 'conversations') blocks.push(node.value ?? '');
    } else if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') {
      blocks.push(inline(node));
    } else if (node.children) {
      for (const child of node.children) visit(child);
    }
  };
  for (const child of root.children ?? []) visit(child);
  return blocks;
}

function* matchingOffsets(source: string, query: string): Generator<{ start: number; end: number }> {
  if (!query) return;
  const lower = source.toLowerCase();
  // WHY: Unicode case folding can expand a code point (İ → i + combining dot).
  // Folded offsets are not DOM UTF-16 offsets. Map whole-character boundaries,
  // and reject partial expansions consistently in both the count and DOM paths.
  let boundaries: Map<number, number> | undefined;
  if (lower.length !== source.length) {
    boundaries = new Map([[0, 0]]);
    let original = 0, folded = 0;
    for (const char of source) {
      original += char.length; folded += char.toLowerCase().length;
      boundaries.set(folded, original);
    }
  }
  for (let pos = lower.indexOf(query); pos !== -1; pos = lower.indexOf(query, pos + query.length)) {
    const end = pos + query.length;
    if (boundaries && (!boundaries.has(pos) || !boundaries.has(end))) continue;
    yield { start: boundaries?.get(pos) ?? pos, end: boundaries?.get(end) ?? end };
  }
}
function occurrences(blocks: readonly string[], query: string): number {
  let count = 0;
  for (const block of blocks) for (const _match of matchingOffsets(block, query)) count++;
  return count;
}

function sameAttachments(a?: readonly string[], b?: readonly string[]): boolean {
  return (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((path, i) => path === b?.[i]);
}

type CachedRow = { bodies: readonly string[]; markdown: boolean; attachments?: readonly string[]; blocks: readonly (readonly string[])[] };
export interface FindSliceScheduler {
  schedule: () => Promise<void>;
  now: () => number;
  maxRows?: number;
}
const defaultScheduler: FindSliceScheduler = {
  // A timer (not a microtask) gives the browser a chance to paint between slices.
  schedule: () => new Promise((done) => setTimeout(done, 0)),
  now: () => performance.now(),
};

export class ChatMessageFindIndex {
  private rows: readonly MessageFindRow[] = [];
  private cache = new Map<string, CachedRow>();
  private epoch = 0;
  // WHY: the measured first query synchronously parsed 1020 loaded rows into a
  // 900ms long task. Work per slice is bounded by time AND row count; no count
  // escapes until the complete corpus is prepared. A single giant Markdown body
  // is still one indivisible parse and is explicitly not covered by this budget.
  async prepareSearch(rows: readonly MessageFindRow[], query: string, signal: AbortSignal,
    scheduler: FindSliceScheduler = defaultScheduler): Promise<MessageFindHit[] | null> {
    const epoch = ++this.epoch;
    const next = new Map<string, CachedRow>();
    const hits: MessageFindHit[] = [];
    const q = query.toLowerCase();
    let start = scheduler.now();
    let handled = 0;
    for (const row of rows) {
      if (signal.aborted || epoch !== this.epoch) return null;
      const previous = this.cache.get(row.id);
      next.set(row.id, this.buildRow(row, previous));
      next.get(row.id)!.blocks.forEach((blocks, body) => {
        const count = occurrences(blocks, q);
        for (let ordinal = 0; ordinal < count; ordinal++) hits.push({ id: row.id, body, ordinal });
      });
      if (++handled >= (scheduler.maxRows ?? 12) || scheduler.now() - start >= 6) {
        handled = 0;
        await scheduler.schedule();
        start = scheduler.now();
      }
    }
    if (signal.aborted || epoch !== this.epoch) return null;
    this.rows = rows;
    this.cache = next;
    return hits;
  }

  private buildRow(row: MessageFindRow, previous?: CachedRow): CachedRow {
    if (previous && previous.markdown === row.markdown && sameAttachments(previous.attachments, row.attachments) && previous.bodies.length === row.bodies.length
        && previous.bodies.every((body, i) => body === row.bodies[i])) return previous;
    return {
      bodies: [...row.bodies], markdown: row.markdown, attachments: row.attachments ? [...row.attachments] : undefined,
      blocks: row.bodies.map((body, i) => previous?.markdown === row.markdown && previous.bodies[i] === body
        && sameAttachments(previous.attachments, row.attachments)
        ? previous.blocks[i]
        : row.markdown ? markdownBlocks(body) : [plainUserText(body, row.attachments)]),
    };
  }

  setRows(rows: readonly MessageFindRow[]) {
    this.epoch++;
    this.rows = rows;
    const ids = new Set(rows.map((row) => row.id));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
    for (const row of rows) {
      this.cache.set(row.id, this.buildRow(row, this.cache.get(row.id)));
    }
  }
  blocksOf(id: string, body: number): readonly string[] | undefined {
    return this.cache.get(id)?.blocks[body];
  }
  search(query: string): MessageFindHit[] {
    if (!query) return [];
    const q = query.toLowerCase();
    const hits: MessageFindHit[] = [];
    for (const row of this.rows) {
      this.cache.get(row.id)?.blocks.forEach((blocks, body) => {
        const count = occurrences(blocks, q);
        for (let ordinal = 0; ordinal < count; ordinal++) hits.push({ id: row.id, body, ordinal });
      });
    }
    return hits;
  }
  clear() { this.epoch++; this.rows = []; this.cache.clear(); }
}

/** Build real ranges across inline spans without joining separate block/message bodies.
 * Accepted text nodes have UTF-16 offsets; CSS Highlights support multi-node Ranges. */
function domBlocks(root: HTMLElement): { nodes: Text[]; text: string }[] {
  const blocks: { nodes: Text[]; text: string }[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('[data-message-find-ignore]')) return NodeFilter.FILTER_REJECT;
      // Closed details keep their descendants in the DOM but do not show them.
      if (parent.closest('details:not([open])') && !parent.closest('summary')) return NodeFilter.FILTER_REJECT;
      // ReactMarkdown emits separators between top-level blocks; they aren't visible words.
      if (!node.nodeValue?.trim() && !root.hasAttribute('data-message-find-plain') && !parent.closest(DOM_BLOCK)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  let lastBlock: Element | null = null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    const block = parent?.closest(DOM_BLOCK) ?? root;
    if (block !== lastBlock) { blocks.push({ nodes: [], text: '' }); lastBlock = block; }
    const current = blocks[blocks.length - 1];
    current.nodes.push(node as Text);
    current.text += node.nodeValue ?? '';
  }
  return blocks;
}

export function messageBodyBlocks(root: HTMLElement): string[] {
  return domBlocks(root).map(({ text, nodes }) => nodes[0]?.parentElement?.closest('pre') ? text.replace(/\n$/, '') : text);
}

export function resolveBodyRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const blocks = domBlocks(root);
  const ranges: Range[] = [];
  const q = query.toLowerCase();
  for (const block of blocks) {
    for (const match of matchingOffsets(block.text, q)) {
      const locate = (position: number) => {
        let remaining = position;
        for (const text of block.nodes) {
          if (remaining <= text.length) return { text, offset: remaining };
          remaining -= text.length;
        }
        return { text: block.nodes[block.nodes.length - 1], offset: block.nodes.at(-1)!.length };
      };
      const start = locate(match.start);
      const end = locate(match.end);
      const range = root.ownerDocument.createRange();
      range.setStart(start.text, start.offset);
      range.setEnd(end.text, end.offset);
      ranges.push(range);
    }
  }
  return ranges;
}
