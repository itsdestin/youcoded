// Word (.docx) comment READING — T10 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §3.2, §8 T10).
// Parses word/comments.xml + word/commentsExtended.xml (Word 2013+'s
// resolve/reply-thread part) into PersistedComment-shaped records, run in
// the Electron MAIN process — not the renderer, and not through mammoth.
//
// WHY main, not the renderer (§3.2, review 1 F1 — blocker): T8's native
// harness tools and T9's MCP pending-mutation queue must be able to read (and
// later mutate) a Word comment even when no renderer window has that file
// open at all — an assistant tool call is not scoped to an open tab. Electron's
// main process is a plain Node context with no DOM
// (`node -e "console.log(typeof DOMParser)"` prints `undefined` — verified
// against this repo's own Node at the time this was written), which is why
// this can't just reuse a browser `DOMParser` the way an earlier design draft
// assumed.
//
// XML LIBRARY CHOICE (T10's own "spike to confirm which" — §3.2 offered
// `@xmldom/xmldom` or `fast-xml-parser` as candidates): neither is used.
// `linkedom` is already a DIRECT dependency of desktop/package.json
// (src/main/harness/tools/web-fetch.ts already imports its `DOMParser`+
// `parseHTML` for Readability), and its `DOMParser().parseFromString(xml,
// 'text/xml')` handles namespaced OOXML tags/attributes (`w:comment`,
// `w:id`, `w15:paraIdParent`, …) correctly — confirmed empirically before
// writing this module. Using it means promoting only `jszip` to a direct
// dependency for this task, not two new packages.
//
// jszip promotion (review 2, F10): jszip was present only TRANSITIVELY
// (hoisted via mammoth's/exceljs's own dependency trees, `desktop/CLAUDE.md`
// `allowScripts`' own warning that "a dependency's own dependency tree is not
// a contract"). It is now a direct dependency of desktop/package.json,
// pinned to the exact version (3.10.1) already resolved in this worktree's
// node_modules — added by hand-editing package.json/package-lock.json rather
// than running `npm install` (which, tested against this exact package,
// silently re-resolved to a newer 3.10.2 from the registry — precisely the
// "resolved version changes underfoot" risk §8's own task notes for T10
// warn about — and per docs/PITFALLS.md's Worktrees section, `npm install`
// also writes `node_modules/.package-lock.json` IN PLACE through a shared
// hardlink). No node_modules write of any kind was needed since jszip@3.10.1
// was already present on disk; this is a metadata-only declaration.
import JSZip from 'jszip';
import { DOMParser } from 'linkedom';
import type {
  CommentAuthor,
  CommentReply,
  CommentSelector,
  PersistedComment,
} from '../../shared/doc-comments-types';
import { checkNamedEntriesWithinCeiling } from './zip-size-guard';

// Not exported: nothing outside this module needs the error union by name
// (knip flags an exported type nothing ever imports as dead code — same
// convention doc-comments-store.ts's own `DocCommentsError` already uses).
// Callers only need the shape of `DocxReadResult`, which IS exported.
//
// 'archive-too-large' (implementation-review F2 — major): refused BEFORE any
// entry is decompressed, when word/document.xml, word/comments.xml, or
// word/commentsExtended.xml declares an implausibly large uncompressed size —
// see zip-size-guard.ts for why this check is possible cheaply and what it
// actually guards against.
type DocxReadError = 'invalid-docx' | 'missing-document-part' | 'archive-too-large';
export type DocxReadResult = { ok: true; comments: PersistedComment[] } | { ok: false; error: DocxReadError };

// ~32 chars, per §1.1's TextQuoteSelector doc comment ("~32 chars before,
// whitespace-collapsed"). A generous raw window is sliced first so
// `collapseWhitespace` never has to scan more than a few hundred characters
// even on a large document.
const CONTEXT_CHARS = 32;
const RAW_WINDOW_MULTIPLIER = 4;

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ');
}

function buildPrefix(fullText: string, start: number): string {
  const raw = fullText.slice(Math.max(0, start - CONTEXT_CHARS * RAW_WINDOW_MULTIPLIER), start);
  const collapsed = collapseWhitespace(raw);
  return collapsed.slice(Math.max(0, collapsed.length - CONTEXT_CHARS));
}

function buildSuffix(fullText: string, end: number): string {
  const raw = fullText.slice(end, Math.min(fullText.length, end + CONTEXT_CHARS * RAW_WINDOW_MULTIPLIER));
  const collapsed = collapseWhitespace(raw);
  return collapsed.slice(0, CONTEXT_CHARS);
}

/** How many times `exact` (verbatim) appears in `fullText` strictly before
 *  `start` — §1.1's `occurrence`, "which match of exact this was, at
 *  creation time". T2's `resolveSelector` (src/shared/doc-comments-anchor.ts)
 *  does not actually consult this field when re-anchoring (it scores every
 *  remaining occurrence instead — see its own doc comment), so this value is
 *  informational/for-display, not load-bearing for anchoring correctness;
 *  it's still computed honestly rather than hardcoded to 0. */
function countOccurrencesBefore(fullText: string, exact: string, start: number): number {
  if (!exact) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = fullText.indexOf(exact, from);
    if (idx === -1 || idx >= start) break;
    count++;
    from = idx + 1;
  }
  return count;
}

interface RangeInfo {
  start: number;
  end: number;
}

/** One stack frame in `walkDocument`'s iterative walk: an element whose
 *  element-children we're partway through visiting. */
interface WalkFrame {
  el: Element;
  children: Element[];
  idx: number;
}

function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 1 /* ELEMENT_NODE */) out.push(child as unknown as Element);
  }
  return out;
}

/**
 * Walks `<w:body>` in document order, building the same kind of flat text a
 * text-only viewer would render (§3.2: "Word's own range becomes the anchor
 * text, matched against mammoth's rendered HTML the same way findQuote/
 * resolveSelector matches anything else") — but read straight from
 * document.xml's own markup, never mammoth. Mammoth needs a browser
 * `DOMParser` (`mammoth/mammoth.browser`, used only for the reading VIEW in
 * `DocxView.tsx`) and only runs in the renderer; this main-process module
 * has no access to its rendered HTML and doesn't need it — `w:commentRangeStart`
 * /`End` already mark exactly which run text a comment covers, straight off
 * the same document.xml this walk reads.
 *
 * `w:commentRangeStart`/`End` are recorded by their `w:id` (never
 * `w15:paraId` — that identifier only exists on `<w:p>` elements inside
 * comments.xml, and only commentsExtended.xml's `w15:commentEx` entries key
 * off it).
 *
 * F3 (implementation review, major): this walk is ITERATIVE, with an
 * explicit stack, rather than a recursive `visit()` call per element (the
 * original shape). A recursive walk's call-stack depth grows with the DOM's
 * NESTING depth, not its byte size — a document.xml that nests an element
 * (e.g. `w:sdt`/`w:sdtContent`) thousands of levels deep costs only ~20
 * bytes per level, so it can sit comfortably under zip-size-guard.ts's F2
 * byte-size ceiling while still being deep enough to overflow a recursive
 * call stack. F2's ceiling therefore does NOT bound recursion depth — it
 * bounds total bytes read, and by extension the total amount of synchronous
 * WORK this walk does (each element is visited once, so total work is
 * linear in element count, which the byte ceiling does cap). Depth itself
 * needed a structural fix, not a bigger or smarter limit: an explicit stack
 * lives on the heap, so it has no call-stack ceiling to hit regardless of
 * how deep the document nests — F2's size ceiling remains what bounds how
 * much synchronous work one call to this function can demand.
 */
function walkDocument(doc: Document): { fullText: string; ranges: Map<string, RangeInfo> } {
  const ranges = new Map<string, RangeInfo>();
  let fullText = '';
  const body = doc.getElementsByTagName('w:body')[0] as unknown as Element | undefined;
  if (!body) return { fullText, ranges };

  const stack: WalkFrame[] = [{ el: body, children: elementChildren(body), idx: 0 }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.idx >= frame.children.length) {
      // Every child of this element has been visited — the post-order step,
      // mirroring the old recursive code's "append \n after the recursive
      // call returns" for a paragraph.
      if (frame.el.tagName === 'w:p') fullText += '\n';
      stack.pop();
      continue;
    }
    const el = frame.children[frame.idx++];
    const tag = el.tagName;
    if (tag === 'w:t') {
      fullText += el.textContent ?? '';
    } else if (tag === 'w:tab') {
      fullText += '\t';
    } else if (tag === 'w:br' || tag === 'w:cr') {
      fullText += '\n';
    } else if (tag === 'w:commentRangeStart') {
      const id = el.getAttribute('w:id');
      if (id !== null) ranges.set(id, { start: fullText.length, end: fullText.length });
    } else if (tag === 'w:commentRangeEnd') {
      const id = el.getAttribute('w:id');
      if (id !== null) {
        const existing = ranges.get(id);
        if (existing) existing.end = fullText.length;
      }
    }
    // Descend into this element's own children next (pre-order for this
    // element's own tag handling above, matching the old `visit(el)` call).
    stack.push({ el, children: elementChildren(el), idx: 0 });
  }
  return { fullText, ranges };
}

interface RawComment {
  id: string;
  author: string;
  date: string;
  text: string;
  paraId: string | null;
}

function parseCommentsXml(xml: string): RawComment[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  const nodes = Array.from(doc.getElementsByTagName('w:comment'));
  return nodes.map((node) => {
    const el = node as unknown as Element;
    const id = el.getAttribute('w:id') ?? '';
    const author = el.getAttribute('w:author') ?? '';
    const date = el.getAttribute('w:date') ?? '';
    const texts = Array.from(el.getElementsByTagName('w:t'));
    const text = texts.map((t) => (t as unknown as Element).textContent ?? '').join('');
    const paras = Array.from(el.getElementsByTagName('w:p'));
    // Real Word writes this as `w14:paraId` on the comment's own first
    // paragraph — the same identifier commentsExtended.xml's `w15:paraId`
    // refers back to.
    const paraId = paras.length > 0 ? (paras[0] as unknown as Element).getAttribute('w14:paraId') : null;
    return { id, author, date, text, paraId };
  });
}

interface ExtendedInfo {
  done: boolean;
  paraIdParent: string | null;
}

function parseCommentsExtendedXml(xml: string): Map<string, ExtendedInfo> {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  const nodes = Array.from(doc.getElementsByTagName('w15:commentEx'));
  const map = new Map<string, ExtendedInfo>();
  for (const node of nodes) {
    const el = node as unknown as Element;
    const paraId = el.getAttribute('w15:paraId');
    if (!paraId) continue;
    map.set(paraId, {
      done: el.getAttribute('w15:done') === '1',
      paraIdParent: el.getAttribute('w15:paraIdParent'),
    });
  }
  return map;
}

function toCommentAuthor(name: string): CommentAuthor {
  // Every Word comment author is a real, named colleague from this reader's
  // point of view (§3.4: "a colleague's Word comment reads as an ordinary
  // thread... person:Priya Shah") — reading never has grounds to claim an
  // author is 'user' or 'assistant' (those only apply to comments THIS app
  // itself created, a write-path concern, not this read path's).
  return `person:${name || 'Unknown'}`;
}

function parseDate(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Date.now() : t;
}

/**
 * Follows a `w15:paraIdParent` chain up to its root — a reply-to-a-reply
 * collapses into the SAME flat `replies[]` array as a direct reply, since
 * `PersistedComment` has no nested-thread shape (§1.1). A cycle (malformed
 * input) stops the walk rather than looping forever; the paraId where it
 * stopped is treated as the root.
 */
function resolveRootParaId(paraId: string, extended: Map<string, ExtendedInfo>): string {
  let current = paraId;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const parent = extended.get(current)?.paraIdParent;
    if (!parent) return current;
    current = parent;
  }
}

/**
 * Reads every Word comment out of a `.docx`'s raw bytes. `path` is the
 * file's own (project-relative) path, stamped onto each returned record —
 * these are never stored in a JSON sidecar (§1.1: Word/Excel comments live
 * inside the file itself), but the field still lets a caller identify which
 * file a record came from, the same as any other `PersistedComment`.
 *
 * Never throws on ordinary "nothing to read" shapes: a docx with no
 * `word/comments.xml` part at all (§3.2: "a .docx may simply not have this
 * part") returns an EMPTY list, not an error.
 */
export async function readDocxComments(bytes: Uint8Array | Buffer, path: string): Promise<DocxReadResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { ok: false, error: 'invalid-docx' };
  }

  const commentsFile = zip.file('word/comments.xml');
  if (!commentsFile) {
    return { ok: true, comments: [] };
  }
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) {
    // A comments.xml part with no document.xml at all is not a real Word
    // file (every .docx has one) — refuse rather than silently reporting no
    // comments for what is actually a corrupt archive.
    return { ok: false, error: 'missing-document-part' };
  }
  const extendedFile = zip.file('word/commentsExtended.xml');

  // F2 (major): refuse a decompression-bomb-shaped archive BEFORE spending
  // any CPU/memory decompressing it — checked against the central-directory
  // metadata `loadAsync` already parsed, never against actually-decompressed
  // bytes (zip-size-guard.ts).
  const sizeCheck = checkNamedEntriesWithinCeiling(zip, [
    'word/comments.xml',
    'word/document.xml',
    'word/commentsExtended.xml',
  ]);
  if (!sizeCheck.ok) return { ok: false, error: sizeCheck.error };

  const [commentsXml, documentXml, extendedXml] = await Promise.all([
    commentsFile.async('string'),
    documentFile.async('string'),
    extendedFile ? extendedFile.async('string') : Promise.resolve(null),
  ]);

  const rawComments = parseCommentsXml(commentsXml);
  const extended = extendedXml ? parseCommentsExtendedXml(extendedXml) : new Map<string, ExtendedInfo>();
  const { fullText, ranges } = walkDocument(new DOMParser().parseFromString(documentXml, 'text/xml') as unknown as Document);

  const byParaId = new Map<string, RawComment>();
  for (const c of rawComments) if (c.paraId) byParaId.set(c.paraId, c);

  // Group every raw comment.xml entry into its root's replies[] (if it's a
  // reply, however deeply nested) or the top-level list (if it's a root).
  const repliesByRootParaId = new Map<string, CommentReply[]>();
  const topLevel: RawComment[] = [];
  for (const c of rawComments) {
    const rootParaId = c.paraId ? resolveRootParaId(c.paraId, extended) : null;
    const isReply = rootParaId !== null && rootParaId !== c.paraId && byParaId.has(rootParaId);
    if (isReply) {
      const root = byParaId.get(rootParaId!)!;
      const list = repliesByRootParaId.get(rootParaId!) ?? [];
      list.push({
        id: `w-${root.id}-r${list.length + 1}`,
        author: toCommentAuthor(c.author),
        text: c.text,
        createdAt: parseDate(c.date),
      });
      repliesByRootParaId.set(rootParaId!, list);
    } else {
      topLevel.push(c);
    }
  }

  const comments: PersistedComment[] = topLevel.map((c) => {
    const range = ranges.get(c.id);
    const ext = c.paraId ? extended.get(c.paraId) : undefined;
    const exact = range ? fullText.slice(range.start, range.end) : '';
    const selector: CommentSelector = {
      kind: 'text',
      selector: {
        type: 'TextQuoteSelector',
        exact,
        prefix: range ? buildPrefix(fullText, range.start) : '',
        suffix: range ? buildSuffix(fullText, range.end) : '',
        occurrence: range ? countOccurrencesBefore(fullText, exact, range.start) : 0,
      },
    };
    return {
      id: `w-${c.id}`,
      path,
      selector,
      text: c.text,
      author: toCommentAuthor(c.author),
      createdAt: parseDate(c.date),
      replies: (c.paraId && repliesByRootParaId.get(c.paraId)) || [],
      resolved: ext?.done ?? false,
      // Word's own OOXML has no separate resolve/reopen AUDIT TRAIL — only
      // the CURRENT `w15:done` bit. Never invent a by/at this file doesn't
      // record; `history` starts empty for a freshly-read native comment and
      // only grows once this app's own resolve/reopen calls append to it
      // (a write-path task, not this one).
      history: [],
    };
  });

  return { ok: true, comments };
}
