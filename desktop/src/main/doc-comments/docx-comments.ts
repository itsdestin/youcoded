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
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import JSZip from 'jszip';
import { DOMParser } from 'linkedom';
import type {
  CommentAuthor,
  CommentReply,
  CommentSelector,
  PersistedComment,
} from '../../shared/doc-comments-types';
import { checkNamedEntriesWithinCeiling } from './zip-size-guard';
import { resolveSelector } from '../../shared/doc-comments-anchor';

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
 * T11's write-path addition to T10's `walkDocument`: a leaf is one
 * contiguous span of `fullText` that came from a single DOM unit — a `<w:t>`
 * run's text, a single-character `w:tab`/`w:br`/`w:cr`, or the synthetic
 * paragraph-break `\n` a `</w:p>` contributes. Contiguous and gap-free by
 * construction (every character in `fullText` comes from exactly one leaf),
 * which is what lets `resolveSelector`'s character OFFSETS be translated
 * back into an exact DOM insertion point for `AddComment`/`MoveComment`
 * (§3.3) — something T10's read-only `ranges` map never needed, since the
 * read path only ever looks up an id Word ALREADY marked, never inserts one.
 *
 * `textEl` (the `<w:t>` node itself, not just its ancestor `<w:r>`) is kept
 * alongside `run` so a mid-run split (`splitRunAtOffsets`) never has to
 * GUESS which of a run's children to split when a run unusually holds more
 * than one `<w:t>` — a shape no fixture here exercises, but one this design
 * can rule out cheaply just by keeping the exact reference instead of
 * re-deriving it later.
 */
type WriteLeaf =
  | { kind: 'text'; start: number; end: number; run: Element; textEl: Element }
  | { kind: 'atom'; start: number; end: number; run: Element }
  | { kind: 'parabreak'; start: number; end: number; paragraph: Element };

/** Walks up from `el` (inclusive) for the nearest ancestor with `tagName`,
 *  or `null` if none exists before the document root. Used to find a
 *  `<w:t>`'s owning `<w:r>` — comment range markers are always inserted as
 *  RUN siblings, never inside a run's own children. */
function nearestAncestor(el: Element, tagName: string): Element | null {
  let cur: Element | null = el;
  while (cur) {
    if (cur.tagName === tagName) return cur;
    cur = cur.parentNode as unknown as Element | null;
  }
  return null;
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
/**
 * `collectLeaves` (T11, write path only): also build the `WriteLeaf[]` array
 * above, in the SAME single pass that builds `fullText` — never a second,
 * separately-maintained walk that could disagree with this one about what
 * `fullText` actually contains. Left `undefined` by every T10 read-path call
 * (unchanged behaviour, unchanged return shape for existing callers/tests).
 */
function walkDocument(
  doc: Document,
  opts?: { collectLeaves?: boolean }
): { fullText: string; ranges: Map<string, RangeInfo>; leaves?: WriteLeaf[] } {
  const ranges = new Map<string, RangeInfo>();
  const leaves: WriteLeaf[] | undefined = opts?.collectLeaves ? [] : undefined;
  let fullText = '';
  const body = doc.getElementsByTagName('w:body')[0] as unknown as Element | undefined;
  if (!body) return { fullText, ranges, leaves };

  const stack: WalkFrame[] = [{ el: body, children: elementChildren(body), idx: 0 }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.idx >= frame.children.length) {
      // Every child of this element has been visited — the post-order step,
      // mirroring the old recursive code's "append \n after the recursive
      // call returns" for a paragraph.
      if (frame.el.tagName === 'w:p') {
        if (leaves) leaves.push({ kind: 'parabreak', start: fullText.length, end: fullText.length + 1, paragraph: frame.el });
        fullText += '\n';
      }
      stack.pop();
      continue;
    }
    const el = frame.children[frame.idx++];
    const tag = el.tagName;
    if (tag === 'w:t') {
      const text = el.textContent ?? '';
      // An empty <w:t> contributes zero characters — no leaf needed (and
      // none would be addressable by any offset anyway).
      if (leaves && text.length > 0) {
        const run = nearestAncestor(el, 'w:r') ?? el;
        leaves.push({ kind: 'text', start: fullText.length, end: fullText.length + text.length, run, textEl: el });
      }
      fullText += text;
    } else if (tag === 'w:tab') {
      if (leaves) leaves.push({ kind: 'atom', start: fullText.length, end: fullText.length + 1, run: nearestAncestor(el, 'w:r') ?? el });
      fullText += '\t';
    } else if (tag === 'w:br' || tag === 'w:cr') {
      if (leaves) leaves.push({ kind: 'atom', start: fullText.length, end: fullText.length + 1, run: nearestAncestor(el, 'w:r') ?? el });
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
  return { fullText, ranges, leaves };
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

// =============================================================================
// Word (.docx) comment WRITING — T11 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §3.3, §8 T11).
// add / reply / resolve / reopen / move, all in the SAME module as the reader
// above (§3.3: "Same module, mirrored write functions, applied to the loaded
// JSZip archive in memory") and run in the same Electron MAIN process for the
// identical reason T10 does (§3.2, F1): a native tool call or the MCP
// pending-mutation queue (T9b) must be able to mutate a Word comment with no
// renderer window open on that file at all.
//
// Every mutation goes through `writeDocxMutation` (bottom of this section):
// backup-before-write, atomic tmp-then-rename replace, and verify-after-write
// with AUTOMATIC ROLLBACK on failure (§3.3 steps 1 and 6) — the file the user
// has open is always either the successfully-mutated version or byte-
// identical to what it was before, never a half-written third state.
// =============================================================================

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';
const W15_NS = 'http://schemas.microsoft.com/office/word/2012/wordml';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const COMMENTS_EXT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml';
const COMMENTS_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const COMMENTS_EXT_REL_TYPE = 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended';

const EMPTY_COMMENTS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${W_NS}" xmlns:w14="${W14_NS}"></w:comments>`;
const EMPTY_EXTENDED_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="${W15_NS}"></w15:commentsEx>`;
const EMPTY_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS_NS}"></Relationships>`;

// Not exported: same knip convention as DocxReadError above — callers only
// need the exported *Result/*Error unions of the specific functions they call.
// 'comment-not-found': a reply/resolve/reopen/move `id` that isn't (or is no
//   longer) a real comment in this file's comments.xml.
// 'selector-not-found': add's `selector`, or move's `newSelector`, doesn't
//   resolve against the CURRENT document.xml text (§3.3 step 5's own "refused
//   ... rather than silently leaving the old range removed" rule).
// 'invalid-selector': a `kind: 'cell'` selector reached a Word target — Word
//   has no cells; this is a caller bug (dispatch should never construct one),
//   refused honestly rather than silently coerced.
// 'read-failed' / 'backup-failed' / 'write-failed' / 'verify-failed': the
//   write pipeline's own stages (§3.3 steps 1 and 6).
type DocxWriteError =
  | DocxReadError
  | 'comment-not-found'
  | 'selector-not-found'
  | 'invalid-selector'
  | 'read-failed'
  | 'backup-failed'
  | 'write-failed'
  | 'verify-failed';

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
}

function elementsByTag(doc: Document, tag: string): Element[] {
  return Array.from(doc.getElementsByTagName(tag)) as unknown as Element[];
}

function findByAttr(doc: Document, tag: string, attr: string, value: string): Element | null {
  for (const el of elementsByTag(doc, tag)) {
    if (el.getAttribute(attr) === value) return el;
  }
  return null;
}

/** `"w-3"` -> `"3"`; `null` for anything not shaped like a Word-native id
 *  T10's own reader mints (§1.1's `id: \`w-${c.id}\``). A reply id
 *  (`w-3-r1`) is never a valid target for reply/resolve/reopen/move — those
 *  four always act on a whole THREAD (the sidecar store's own `findComment`
 *  precedent), never a single reply within it. */
function stripWPrefix(id: string): string | null {
  const m = /^w-([^-]+)$/.exec(id);
  return m ? m[1] : null;
}

/** §3.4: a reply/add made from this app must round-trip back into
 *  `w:author` naming "the account's display name or 'You'" — NEVER
 *  overwriting a colleague's own original `w:author` (this function is only
 *  ever called to author a BRAND NEW `<w:comment>` this app is creating,
 *  never to rewrite an existing one). No accounts exist yet (§1.2), so
 *  `'user'` is literally "You"; `'assistant'` is a plain, honest label
 *  rather than inventing a persona name nobody configured. */
function commentAuthorToDisplayName(author: CommentAuthor): string {
  if (author === 'user') return 'You';
  if (author === 'assistant') return 'Assistant';
  if (author.startsWith('person:')) return author.slice('person:'.length) || 'Unknown';
  return 'Unknown';
}

function maxExistingCommentId(commentsDoc: Document): number {
  let max = -1;
  for (const el of elementsByTag(commentsDoc, 'w:comment')) {
    const n = Number.parseInt(el.getAttribute('w:id') ?? '', 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max;
}

function findCommentParaId(commentsDoc: Document, rawId: string): string | null {
  const el = findByAttr(commentsDoc, 'w:comment', 'w:id', rawId);
  if (!el) return null;
  const p = elementsByTag(el as unknown as Document, 'w:p')[0];
  return p ? p.getAttribute('w14:paraId') : null;
}

interface LoadedArchive {
  zip: JSZip;
  documentDoc: Document;
  commentsDoc: Document;
  commentsIsNew: boolean;
  /** Whether `commentsDoc` should actually be written back into the zip.
   *  Starts `true` when the part already existed (any mutation of it just
   *  keeps it), and is flipped to `true` by `ensureCommentsPart` when a
   *  brand-new part is genuinely being created. A part that started absent
   *  and stays untouched by THIS operation (e.g. an `add` that only touches
   *  comments.xml, never commentsExtended.xml) must stay absent from the
   *  output archive — writing an untouched empty shell back would create an
   *  orphan part with no `[Content_Types].xml` override, exactly the class
   *  of bug F17's own verify step exists to catch (confirmed by that check
   *  failing during this module's own implementation). */
  commentsTouched: boolean;
  extendedDoc: Document;
  extendedIsNew: boolean;
  extendedTouched: boolean;
  contentTypesDoc: Document;
  relsDoc: Document;
}

/** Union of every `w14:paraId`/`w15:paraId` already in use anywhere in the
 *  archive — document.xml's own paragraphs, comments.xml's comment
 *  paragraphs, AND commentsExtended.xml's own entries — so a freshly
 *  generated one (§3.3, F6) can never collide with ANY of them, not just
 *  with other comments. */
function collectAllParaIds(archive: LoadedArchive): Set<string> {
  const set = new Set<string>();
  for (const doc of [archive.documentDoc, archive.commentsDoc]) {
    for (const el of elementsByTag(doc, 'w:p')) {
      const id = el.getAttribute('w14:paraId');
      if (id) set.add(id);
    }
  }
  for (const el of elementsByTag(archive.extendedDoc, 'w15:commentEx')) {
    const id = el.getAttribute('w15:paraId');
    if (id) set.add(id);
  }
  return set;
}

/** An 8-hex-digit value "the way Word itself does" (§3.3, F6) — never
 *  sequential, and re-rolled on the rare collision against every paraId
 *  already in the archive. 100 attempts is generous: a 32-bit space colliding
 *  even once against a real document's (at most a few thousand) existing ids
 *  is already vanishingly unlikely. */
function generateParaId(existing: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = randomBytes(4).toString('hex').toUpperCase();
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('docx-comments: could not generate a unique paraId');
}

function nextRelId(relsDoc: Document): string {
  let max = 0;
  for (const el of elementsByTag(relsDoc, 'Relationship')) {
    const m = /^rId(\d+)$/.exec(el.getAttribute('Id') ?? '');
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `rId${max + 1}`;
}

function addContentTypeOverride(contentTypesDoc: Document, partName: string, contentType: string): void {
  const exists = elementsByTag(contentTypesDoc, 'Override').some((el) => el.getAttribute('PartName') === partName);
  if (exists) return;
  const el = contentTypesDoc.createElement('Override');
  el.setAttribute('PartName', partName);
  el.setAttribute('ContentType', contentType);
  contentTypesDoc.documentElement.appendChild(el);
}

function addRelationship(relsDoc: Document, type: string, target: string): void {
  const exists = elementsByTag(relsDoc, 'Relationship').some((el) => el.getAttribute('Target') === target);
  if (exists) return;
  const el = relsDoc.createElement('Relationship');
  el.setAttribute('Id', nextRelId(relsDoc));
  el.setAttribute('Type', type);
  el.setAttribute('Target', target);
  relsDoc.documentElement.appendChild(el);
}

/** §3.3 step 2: "creating the part + its [Content_Types].xml override + the
 *  word/_rels/document.xml.rels relationship if the file had no comments
 *  before" — called only when `archive.commentsIsNew`. Idempotent (checks
 *  before appending), though every real caller only invokes it once per
 *  archive. */
function ensureCommentsPart(archive: LoadedArchive): void {
  addContentTypeOverride(archive.contentTypesDoc, '/word/comments.xml', COMMENTS_CONTENT_TYPE);
  addRelationship(archive.relsDoc, COMMENTS_REL_TYPE, 'comments.xml');
  archive.commentsTouched = true;
}

/** §3.3 steps 3/4: "creating commentsExtended.xml if absent" (reply) / "if
 *  this is the file's first resolve" (resolve). */
function ensureExtendedPart(archive: LoadedArchive): void {
  addContentTypeOverride(archive.contentTypesDoc, '/word/commentsExtended.xml', COMMENTS_EXT_CONTENT_TYPE);
  addRelationship(archive.relsDoc, COMMENTS_EXT_REL_TYPE, 'commentsExtended.xml');
  archive.extendedTouched = true;
}

function appendCommentEntry(
  commentsDoc: Document,
  entry: { id: number; author: string; date: string; paraId: string; text: string }
): void {
  const commentEl = commentsDoc.createElement('w:comment');
  commentEl.setAttribute('w:id', String(entry.id));
  commentEl.setAttribute('w:author', entry.author);
  commentEl.setAttribute('w:date', entry.date);
  const pEl = commentsDoc.createElement('w:p');
  pEl.setAttribute('w14:paraId', entry.paraId);
  const rEl = commentsDoc.createElement('w:r');
  const tEl = commentsDoc.createElement('w:t');
  tEl.setAttribute('xml:space', 'preserve');
  tEl.textContent = entry.text;
  rEl.appendChild(tEl);
  pEl.appendChild(rEl);
  commentEl.appendChild(pEl);
  commentsDoc.documentElement.appendChild(commentEl);
}

/** §3.3 step 4 (and step 3's `w15:paraIdParent`): update an EXISTING
 *  `w15:commentEx` entry in place when one already exists for `paraId`
 *  (never duplicated), or create a fresh one when it doesn't — covers both
 *  "this file has never been resolved before" (no commentsExtended.xml part
 *  at all — `ensureExtendedPart` handles that half) and "this specific
 *  comment has never had an extended entry" (a comments.xml-only file that
 *  DOES already have commentsExtended.xml for some OTHER comment). */
function upsertExtendedEntry(extendedDoc: Document, paraId: string, fields: { done: boolean; paraIdParent?: string }): void {
  const existing = findByAttr(extendedDoc, 'w15:commentEx', 'w15:paraId', paraId);
  const el = existing ?? extendedDoc.createElement('w15:commentEx');
  el.setAttribute('w15:paraId', paraId);
  el.setAttribute('w15:done', fields.done ? '1' : '0');
  if (fields.paraIdParent) el.setAttribute('w15:paraIdParent', fields.paraIdParent);
  if (!existing) extendedDoc.documentElement.appendChild(el);
}

/**
 * Splits `run` (whose text lives in its child `textEl`) at every offset in
 * `offsetsInRun` (each strictly between 0 and the text's length; boundary
 * values are filtered out by the caller since they need no split at all),
 * replacing `run` in the tree with the resulting pieces — clones of `run`'s
 * own `w:rPr` (so formatting survives the split) each holding one slice of
 * the original text. Returns the pieces AND the full cut-point list
 * (`[0, ...offsetsInRun, len]`) so the caller can look up "the piece that
 * starts/ends at exactly offset X" without recomputing anything.
 *
 * A no-op (`offsetsInRun` empty) returns `[run]` unchanged — this is what
 * makes `insertMarkerRelativeToRun` below correct for BOTH a boundary
 * position (no split needed) and a strictly-interior one (split needed)
 * through the exact same code path.
 */
function splitRunAtOffsets(
  doc: Document,
  run: Element,
  textEl: Element,
  offsetsInRun: number[]
): { pieces: Element[]; cuts: number[] } {
  const text = textEl.textContent ?? '';
  const cuts = Array.from(new Set([0, ...offsetsInRun.filter((o) => o > 0 && o < text.length), text.length])).sort(
    (a, b) => a - b
  );
  if (cuts.length <= 2) return { pieces: [run], cuts: [0, text.length] };

  const rPr = elementsByTag(run as unknown as Document, 'w:rPr')[0] ?? null;
  const pieces: Element[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const newRun = doc.createElement('w:r');
    if (rPr) newRun.appendChild(rPr.cloneNode(true) as unknown as Element);
    const newT = doc.createElement('w:t');
    newT.setAttribute('xml:space', 'preserve');
    newT.textContent = text.slice(cuts[i], cuts[i + 1]);
    newRun.appendChild(newT);
    pieces.push(newRun);
  }
  const parent = run.parentNode as unknown as Element;
  for (const piece of pieces) parent.insertBefore(piece as unknown as Node, run as unknown as Node);
  parent.removeChild(run as unknown as Node);
  return { pieces, cuts };
}

interface InsertionAnchor {
  parent: Element;
  before: Element | null;
}

/** Resolves WHERE (as a DOM `parent`/`before` pair — `parent.insertBefore(
 *  newNode, before)`, `before === null` meaning "append") to place a marker
 *  for character offset `offset`, splitting a run when the offset falls
 *  strictly inside one. `edge` distinguishes "the marker goes right BEFORE
 *  whatever starts at this offset" (a range's own start, or the piece a
 *  split produces) from "right AFTER whatever ends at this offset" (a
 *  range's end) — for a boundary offset (no split needed) the two coincide
 *  at the same DOM position; they only diverge meaningfully once a split
 *  happens, which is exactly the case `splitRunAtOffsets`'s `cuts` array
 *  exists to look back up. */
function anchorForOffset(
  doc: Document,
  leaves: WriteLeaf[],
  fullText: string,
  offset: number,
  edge: 'start' | 'end'
): InsertionAnchor {
  const idx = leaves.findIndex((l) => offset >= l.start && offset < l.end);
  if (idx === -1) {
    // offset === fullText.length (or the document has no leaves at all,
    // which resolveSelector already ruled out by finding a match).
    const last = leaves[leaves.length - 1];
    if (!last) throw new Error('docx-comments: no leaves to anchor an insertion against');
    if (last.kind === 'parabreak') return { parent: last.paragraph, before: null };
    return { parent: last.run.parentNode as unknown as Element, before: (last.run.nextSibling as unknown as Element) ?? null };
  }
  const leaf = leaves[idx];
  if (leaf.kind === 'parabreak') {
    // The only reachable offset here is leaf.start (leaf.end = start + 1) —
    // "immediately after the last real content of the paragraph that just
    // closed, before the implicit paragraph break".
    return { parent: leaf.paragraph, before: null };
  }
  const offsetInRun = offset - leaf.start;
  const runLen = leaf.end - leaf.start;
  // A BOUNDARY position (offset 0 or runLen) never needs a split, regardless
  // of `edge` — "insert before this run" and "insert after the PREVIOUS
  // run" are the same DOM position when offsetInRun is 0, and likewise at
  // runLen. Checking this FIRST (before ever calling `splitRunAtOffsets`)
  // matters for `edge === 'end'` specifically: `end` landing exactly at
  // offsetInRun === 0 means the true "last included character" belongs to
  // the PREVIOUS leaf, not this one — treating it as "the piece ending at
  // cut 0" (via `cuts.indexOf(0) - 1`) would look up a piece at index -1,
  // which is undefined (confirmed by this exact crash during this module's
  // own implementation, on a MOVE whose new range's end fell precisely on a
  // run boundary already created by an earlier ADD's own split).
  if (leaf.kind === 'atom' || offsetInRun === 0) {
    return { parent: leaf.run.parentNode as unknown as Element, before: leaf.run };
  }
  if (offsetInRun === runLen) {
    return { parent: leaf.run.parentNode as unknown as Element, before: (leaf.run.nextSibling as unknown as Element) ?? null };
  }
  const { pieces, cuts } = splitRunAtOffsets(doc, leaf.run, leaf.textEl, [offsetInRun]);
  if (edge === 'start') {
    const piece = pieces[cuts.indexOf(offsetInRun)];
    return { parent: piece.parentNode as unknown as Element, before: piece };
  }
  const piece = pieces[cuts.indexOf(offsetInRun) - 1];
  return { parent: piece.parentNode as unknown as Element, before: (piece.nextSibling as unknown as Element) ?? null };
}

function buildCommentReferenceRun(doc: Document, id: string): Element {
  const refRun = doc.createElement('w:r');
  const rPr = doc.createElement('w:rPr');
  const rStyle = doc.createElement('w:rStyle');
  rStyle.setAttribute('w:val', 'CommentReference');
  rPr.appendChild(rStyle);
  refRun.appendChild(rPr);
  const ref = doc.createElement('w:commentReference');
  ref.setAttribute('w:id', id);
  refRun.appendChild(ref);
  return refRun;
}

/**
 * Inserts a `w:commentRangeStart`/`w:commentRangeEnd` pair for `id` at
 * `[start, end)`, plus the `w:commentReference` run immediately after the
 * end marker (§3.2's own read-path shape: "the reference run goes right
 * after commentRangeEnd" — every fixture confirms this ordering).
 *
 * When `start` and `end` fall in the SAME original text leaf, both cuts are
 * made in ONE `splitRunAtOffsets` call (up to three resulting pieces: before
 * the quote, the quote itself, after the quote) — never two independent
 * calls, which would each try to split what is, by the second call, already
 * a stale/removed node reference. When they fall in DIFFERENT leaves, the
 * two ends are resolved independently (safe: splitting the run at `start`
 * never touches the run at `end`, and vice versa).
 */
function insertCommentRangeMarkers(
  doc: Document,
  leaves: WriteLeaf[],
  fullText: string,
  start: number,
  end: number,
  id: string
): void {
  const startMarker = doc.createElement('w:commentRangeStart');
  startMarker.setAttribute('w:id', id);
  const endMarker = doc.createElement('w:commentRangeEnd');
  endMarker.setAttribute('w:id', id);
  const refRun = buildCommentReferenceRun(doc, id);

  const startIdx = leaves.findIndex((l) => start >= l.start && start < l.end);
  const endIdx = leaves.findIndex((l) => end >= l.start && end < l.end);

  if (startIdx !== -1 && startIdx === endIdx && leaves[startIdx].kind === 'text') {
    const leaf = leaves[startIdx] as Extract<WriteLeaf, { kind: 'text' }>;
    const so = start - leaf.start;
    const eo = end - leaf.start;
    const { pieces, cuts } = splitRunAtOffsets(doc, leaf.run, leaf.textEl, [so, eo]);
    const startPiece = pieces[cuts.indexOf(so)];
    const endPiece = pieces[cuts.indexOf(eo) - 1];
    (startPiece.parentNode as unknown as Element).insertBefore(startMarker as unknown as Node, startPiece as unknown as Node);
    (endPiece.parentNode as unknown as Element).insertBefore(
      endMarker as unknown as Node,
      (endPiece.nextSibling as unknown as Node) ?? null
    );
    (endMarker.parentNode as unknown as Element).insertBefore(
      refRun as unknown as Node,
      (endMarker.nextSibling as unknown as Node) ?? null
    );
    return;
  }

  const startAnchor = anchorForOffset(doc, leaves, fullText, start, 'start');
  startAnchor.parent.insertBefore(startMarker as unknown as Node, startAnchor.before as unknown as Node);
  const endAnchor = anchorForOffset(doc, leaves, fullText, end, 'end');
  endAnchor.parent.insertBefore(endMarker as unknown as Node, endAnchor.before as unknown as Node);
  (endMarker.parentNode as unknown as Element).insertBefore(
    refRun as unknown as Node,
    (endMarker.nextSibling as unknown as Node) ?? null
  );
}

/** §3.3 step 5 (Move, review 3 F2): removes the CURRENT
 *  `w:commentRangeStart`/`End` pair and its paired `w:commentReference` run,
 *  all matched by `id` (never `paraId` — ranges and references are keyed off
 *  the Word-native numeric id, same as T10's own read path). Returns `false`
 *  (removing nothing) when any of the three pieces can't be found — a
 *  malformed "comment with no range" state this refuses rather than guesses
 *  at, matching §2.3's "never guess" rule. */
function removeCommentRangeAndReference(doc: Document, id: string): boolean {
  const start = findByAttr(doc, 'w:commentRangeStart', 'w:id', id);
  const end = findByAttr(doc, 'w:commentRangeEnd', 'w:id', id);
  const ref = findByAttr(doc, 'w:commentReference', 'w:id', id);
  if (!start || !end || !ref) return false;
  (start.parentNode as unknown as Element)?.removeChild(start as unknown as Node);
  (end.parentNode as unknown as Element)?.removeChild(end as unknown as Node);
  const refRun = nearestAncestor(ref, 'w:r') ?? ref;
  (refRun.parentNode as unknown as Element)?.removeChild(refRun as unknown as Node);
  return true;
}

function countAttrOccurrences(xml: string, tag: string, attr: string, value: string): number {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}="${escaped}"`, 'g');
  return (xml.match(re) ?? []).length;
}

/**
 * Loads every part a write might touch and parses the ones this module
 * mutates, mirroring T10's own `readDocxComments` size-guard-before-decompress
 * discipline (F2) — a write is at least as dangerous as a read here, since it
 * decompresses the SAME parts before re-compressing the whole archive again.
 * `commentsIsNew`/`extendedIsNew` name which parts didn't exist at all before
 * this call (§3.3 step 2's "creating the part... if the file had no comments
 * before"), so a caller can decide whether `ensureCommentsPart`/
 * `ensureExtendedPart` need to run.
 */
async function loadArchiveForWrite(
  bytes: Buffer
): Promise<{ ok: true; archive: LoadedArchive } | { ok: false; error: DocxWriteError }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { ok: false, error: 'invalid-docx' };
  }
  const documentFile = zip.file('word/document.xml');
  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!documentFile || !contentTypesFile) return { ok: false, error: 'missing-document-part' };

  const sizeCheck = checkNamedEntriesWithinCeiling(zip, [
    'word/document.xml',
    'word/comments.xml',
    'word/commentsExtended.xml',
    '[Content_Types].xml',
    'word/_rels/document.xml.rels',
  ]);
  if (!sizeCheck.ok) return { ok: false, error: sizeCheck.error };

  const commentsFile = zip.file('word/comments.xml');
  const extendedFile = zip.file('word/commentsExtended.xml');
  const relsFile = zip.file('word/_rels/document.xml.rels');

  const [documentXml, contentTypesXml, commentsXml, extendedXml, relsXml] = await Promise.all([
    documentFile.async('string'),
    contentTypesFile.async('string'),
    commentsFile ? commentsFile.async('string') : Promise.resolve(null),
    extendedFile ? extendedFile.async('string') : Promise.resolve(null),
    relsFile ? relsFile.async('string') : Promise.resolve(null),
  ]);

  const archive: LoadedArchive = {
    zip,
    documentDoc: parseXml(documentXml),
    commentsDoc: parseXml(commentsXml ?? EMPTY_COMMENTS_XML),
    commentsIsNew: commentsXml === null,
    // Already-existing parts are always written back (any mutation of them
    // just keeps them); a brand-new one stays OUT of the output archive
    // until `ensureCommentsPart`/`ensureExtendedPart` actually decides to
    // create it for real (see `LoadedArchive.commentsTouched`'s own doc
    // comment for why — an unconditional write here previously created an
    // orphan commentsExtended.xml part on every `add`, caught by this
    // module's own F17 verify step during implementation).
    commentsTouched: commentsXml !== null,
    extendedDoc: parseXml(extendedXml ?? EMPTY_EXTENDED_XML),
    extendedIsNew: extendedXml === null,
    extendedTouched: extendedXml !== null,
    contentTypesDoc: parseXml(contentTypesXml),
    relsDoc: parseXml(relsXml ?? EMPTY_RELS_XML),
  };
  return { ok: true, archive };
}

async function serializeArchive(archive: LoadedArchive): Promise<Buffer> {
  archive.zip.file('word/document.xml', archive.documentDoc.toString());
  if (archive.commentsTouched) archive.zip.file('word/comments.xml', archive.commentsDoc.toString());
  if (archive.extendedTouched) archive.zip.file('word/commentsExtended.xml', archive.extendedDoc.toString());
  archive.zip.file('[Content_Types].xml', archive.contentTypesDoc.toString());
  archive.zip.file('word/_rels/document.xml.rels', archive.relsDoc.toString());
  return archive.zip.generateAsync({ type: 'nodebuffer' });
}

// -----------------------------------------------------------------------
// Pure, in-memory mutations — bytes in, bytes out. No disk I/O here at all;
// `writeDocxMutation` (below) owns backup/atomic-write/verify/rollback so
// EVERY operation gets that behaviour identically, in one place.
// -----------------------------------------------------------------------

async function mutateAddComment(
  currentBytes: Buffer,
  args: { selector: CommentSelector; text: string; author: CommentAuthor }
): Promise<{ ok: true; bytes: Buffer; id: string } | { ok: false; error: DocxWriteError }> {
  if (args.selector.kind !== 'text') return { ok: false, error: 'invalid-selector' };
  const loaded = await loadArchiveForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { archive } = loaded;

  const { fullText, leaves } = walkDocument(archive.documentDoc, { collectLeaves: true });
  const resolved = resolveSelector(fullText, args.selector.selector);
  if (resolved === 'detached') return { ok: false, error: 'selector-not-found' };

  const newId = maxExistingCommentId(archive.commentsDoc) + 1;
  const paraId = generateParaId(collectAllParaIds(archive));

  if (archive.commentsIsNew) ensureCommentsPart(archive);
  insertCommentRangeMarkers(archive.documentDoc, leaves!, fullText, resolved.start, resolved.end, String(newId));
  appendCommentEntry(archive.commentsDoc, {
    id: newId,
    author: commentAuthorToDisplayName(args.author),
    date: new Date().toISOString(),
    paraId,
    text: args.text,
  });

  const bytes = await serializeArchive(archive);
  return { ok: true, bytes, id: `w-${newId}` };
}

async function mutateReplyToComment(
  currentBytes: Buffer,
  args: { id: string; text: string; author: CommentAuthor }
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: DocxWriteError }> {
  const rawId = stripWPrefix(args.id);
  if (rawId === null) return { ok: false, error: 'comment-not-found' };
  const loaded = await loadArchiveForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { archive } = loaded;

  const targetParaId = findCommentParaId(archive.commentsDoc, rawId);
  if (targetParaId === null) return { ok: false, error: 'comment-not-found' };

  const newId = maxExistingCommentId(archive.commentsDoc) + 1;
  const paraId = generateParaId(collectAllParaIds(archive));
  appendCommentEntry(archive.commentsDoc, {
    id: newId,
    author: commentAuthorToDisplayName(args.author),
    date: new Date().toISOString(),
    paraId,
    text: args.text,
  });

  if (archive.extendedIsNew) ensureExtendedPart(archive);
  upsertExtendedEntry(archive.extendedDoc, paraId, { done: false, paraIdParent: targetParaId });

  const bytes = await serializeArchive(archive);
  return { ok: true, bytes };
}

async function mutateSetResolved(
  currentBytes: Buffer,
  args: { id: string },
  done: boolean
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: DocxWriteError }> {
  const rawId = stripWPrefix(args.id);
  if (rawId === null) return { ok: false, error: 'comment-not-found' };
  const loaded = await loadArchiveForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { archive } = loaded;

  const targetParaId = findCommentParaId(archive.commentsDoc, rawId);
  if (targetParaId === null) return { ok: false, error: 'comment-not-found' };

  if (archive.extendedIsNew) ensureExtendedPart(archive);
  upsertExtendedEntry(archive.extendedDoc, targetParaId, { done });

  const bytes = await serializeArchive(archive);
  return { ok: true, bytes };
}

async function mutateMoveComment(
  currentBytes: Buffer,
  args: { id: string; newSelector: CommentSelector }
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: DocxWriteError }> {
  if (args.newSelector.kind !== 'text') return { ok: false, error: 'invalid-selector' };
  const rawId = stripWPrefix(args.id);
  if (rawId === null) return { ok: false, error: 'comment-not-found' };
  const loaded = await loadArchiveForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { archive } = loaded;

  if (!findCommentParaId(archive.commentsDoc, rawId)) return { ok: false, error: 'comment-not-found' };
  if (!removeCommentRangeAndReference(archive.documentDoc, rawId)) return { ok: false, error: 'comment-not-found' };

  // Re-resolve against the CURRENT text (the old range is already gone from
  // this in-memory copy, but nothing has been written to disk yet — a
  // 'selector-not-found' return below discards this whole in-memory archive,
  // leaving the ON-DISK original completely untouched; see §3.3 step 5's own
  // "never silently leaving the old range removed with no new one inserted"
  // rule, which is about the WRITTEN file, not this in-memory intermediate).
  const { fullText, leaves } = walkDocument(archive.documentDoc, { collectLeaves: true });
  const resolved = resolveSelector(fullText, args.newSelector.selector);
  if (resolved === 'detached') return { ok: false, error: 'selector-not-found' };

  insertCommentRangeMarkers(archive.documentDoc, leaves!, fullText, resolved.start, resolved.end, rawId);

  const bytes = await serializeArchive(archive);
  return { ok: true, bytes };
}

// -----------------------------------------------------------------------
// The write pipeline: backup, atomic replace, verify, automatic rollback.
// -----------------------------------------------------------------------

/** Per-absolute-path in-process serialization (T11's own "two mutations on
 *  one file serialize, no lost update" pinning test): nothing else in this
 *  design puts a lock around a docx mutation the way T1's JSON sidecar has
 *  `mutateFileUnderLock` — without one, two IPC calls racing the SAME file
 *  would both read the same original bytes, mutate independently, and
 *  whichever writes last would silently discard the other's change. Every
 *  real caller (desktop IPC, remote, and T9b's future pending-mutation
 *  queue) reaches this SAME main process, so a plain per-path promise chain
 *  is enough — cross-PROCESS safety (a second `node` process) is a
 *  deliberately separate, not-yet-built concern (§9.2's pending-mutation
 *  queue exists precisely so the MCP script never mutates a docx directly). */
const writeLocks = new Map<string, Promise<unknown>>();

function withDocxWriteLock<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
  const prior = writeLocks.get(absolutePath) ?? Promise.resolve();
  const settled = prior.then(fn, fn);
  // Chain a NEVER-REJECTING tracker so one failed mutation doesn't poison the
  // lock for the next caller — `settled` itself (returned below) still
  // carries this call's own real outcome, including a rejection.
  writeLocks.set(
    absolutePath,
    settled.then(
      () => undefined,
      () => undefined
    )
  );
  return settled;
}

type MutateFn<Extra extends Record<string, unknown>> = (
  currentBytes: Buffer
) => Promise<({ ok: true; bytes: Buffer } & Extra) | { ok: false; error: DocxWriteError }>;

/**
 * §3.3's full write pipeline, shared by every mutation above. EXPORTED so a
 * test can pin the automatic-rollback path directly (T11's own "failed
 * verification restores the original — inject a fault" pinning test) by
 * supplying a `verify` that deliberately returns `false`, without needing to
 * corrupt real on-disk bytes to provoke a genuine failure.
 */
export async function writeDocxMutation<Extra extends Record<string, unknown>>(
  absolutePath: string,
  mutate: MutateFn<Extra>,
  verify: (newBytes: Buffer, extra: Extra) => Promise<boolean>
): Promise<({ ok: true } & Extra) | { ok: false; error: DocxWriteError }> {
  return withDocxWriteLock(absolutePath, async () => {
    let originalBytes: Buffer;
    try {
      originalBytes = await fs.readFile(absolutePath);
    } catch {
      return { ok: false, error: 'read-failed' };
    }

    const mutated = await mutate(originalBytes);
    if (!mutated.ok) return mutated;
    const { bytes: newBytes, ...extraRest } = mutated;
    const extra = extraRest as unknown as Extra;

    // Step 1 (§3.3): backup BEFORE touching the real target at all.
    const backupPath = `${absolutePath}.docx.bak-${Date.now()}`;
    try {
      await fs.writeFile(backupPath, originalBytes);
    } catch {
      return { ok: false, error: 'backup-failed' };
    }

    // Atomic replace: tmp-write then rename, never a direct overwrite —
    // matches artifacts/cas-write.ts's own atomicWrite shape.
    const tmpPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmpPath, newBytes);
      await fs.rename(tmpPath, absolutePath);
    } catch {
      try {
        await fs.unlink(tmpPath);
      } catch {
        /* already gone */
      }
      try {
        await fs.unlink(backupPath);
      } catch {
        /* best-effort — the real target was never touched either way */
      }
      return { ok: false, error: 'write-failed' };
    }

    // Step 6 (§3.3, F5/F17): verify, with AUTOMATIC ROLLBACK on failure.
    let verified: boolean;
    try {
      verified = await verify(newBytes, extra);
    } catch {
      verified = false;
    }
    if (!verified) {
      await fs.rename(backupPath, absolutePath);
      return { ok: false, error: 'verify-failed' };
    }
    await fs.unlink(backupPath);
    return { ok: true, ...extra };
  });
}

/**
 * F17 (minor): a minimal OOXML relationship/content-types sanity check —
 * every `r:id` attribute referenced anywhere in document.xml resolves in
 * word/_rels/document.xml.rels, and every comments/commentsExtended part
 * actually present in the archive has a matching `[Content_Types].xml`
 * `Override`. Catches "opens in Word, silently drops in Google Docs" ahead
 * of the manual R10 check, not instead of it.
 */
async function verifyOoxmlWiring(bytes: Buffer): Promise<boolean> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return false;
  }
  const documentFile = zip.file('word/document.xml');
  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!documentFile || !contentTypesFile) return false;
  const relsFile = zip.file('word/_rels/document.xml.rels');
  const [documentXml, contentTypesXml, relsXml] = await Promise.all([
    documentFile.async('string'),
    contentTypesFile.async('string'),
    relsFile ? relsFile.async('string') : Promise.resolve(null),
  ]);

  const relIds = new Set<string>();
  if (relsXml) {
    for (const el of elementsByTag(parseXml(relsXml), 'Relationship')) {
      const id = el.getAttribute('Id');
      if (id) relIds.add(id);
    }
  }
  const referenced = documentXml.match(/r:id="[^"]*"/g) ?? [];
  for (const ref of referenced) {
    const id = ref.slice('r:id="'.length, -1);
    if (!relIds.has(id)) return false;
  }

  const contentTypesDoc = parseXml(contentTypesXml);
  const overrides = new Set(elementsByTag(contentTypesDoc, 'Override').map((el) => el.getAttribute('PartName')));
  if (zip.file('word/comments.xml') && !overrides.has('/word/comments.xml')) return false;
  if (zip.file('word/commentsExtended.xml') && !overrides.has('/word/commentsExtended.xml')) return false;
  return true;
}

// -----------------------------------------------------------------------
// Public orchestration — one per operation, each wiring its own mutate +
// verify into `writeDocxMutation`. `absolutePath` is the already-
// containment-verified real file path (doc-comments-dispatch.ts resolves
// it, the same way it already does for `listNativeComments`); `path` is the
// caller's project-relative (or fallback-absolute) path, stamped onto
// `PersistedComment.path` exactly like the read path already does — needed
// here only to re-run T10's own reader during verification.
// -----------------------------------------------------------------------

export async function addDocxComment(args: {
  absolutePath: string;
  path: string;
  selector: CommentSelector;
  text: string;
  author: CommentAuthor;
}): Promise<{ ok: true; id: string } | { ok: false; error: DocxWriteError }> {
  return writeDocxMutation(
    args.absolutePath,
    (bytes) => mutateAddComment(bytes, args),
    async (newBytes, extra) => {
      if (!(await verifyOoxmlWiring(newBytes))) return false;
      const result = await readDocxComments(newBytes, args.path);
      if (!result.ok) return false;
      const added = result.comments.find((c) => c.id === extra.id);
      return !!added && added.text === args.text;
    }
  );
}

export async function replyToDocxComment(args: {
  absolutePath: string;
  path: string;
  id: string;
  text: string;
  author: CommentAuthor;
}): Promise<{ ok: true } | { ok: false; error: DocxWriteError }> {
  return writeDocxMutation(
    args.absolutePath,
    (bytes) => mutateReplyToComment(bytes, args),
    async (newBytes) => {
      if (!(await verifyOoxmlWiring(newBytes))) return false;
      const result = await readDocxComments(newBytes, args.path);
      if (!result.ok) return false;
      const target = result.comments.find((c) => c.id === args.id);
      return !!target && target.replies.some((r) => r.text === args.text);
    }
  );
}

/** `by` (§1.6's generic `{path, id, by}` payload) is accepted for call-site
 *  symmetry with the sidecar store's own `resolveComment`/`reopenComment` but
 *  deliberately UNUSED here: native Word comments have no separate
 *  resolve/reopen audit trail to record it into (§3.2's read comment: history
 *  starts empty for a freshly-read native comment) — only the CURRENT
 *  `w15:done` bit exists in the file itself. */
export async function resolveDocxComment(args: {
  absolutePath: string;
  path: string;
  id: string;
}): Promise<{ ok: true } | { ok: false; error: DocxWriteError }> {
  return writeDocxMutation(
    args.absolutePath,
    (bytes) => mutateSetResolved(bytes, args, true),
    async (newBytes) => {
      if (!(await verifyOoxmlWiring(newBytes))) return false;
      const result = await readDocxComments(newBytes, args.path);
      if (!result.ok) return false;
      const target = result.comments.find((c) => c.id === args.id);
      return !!target && target.resolved === true;
    }
  );
}

export async function reopenDocxComment(args: {
  absolutePath: string;
  path: string;
  id: string;
}): Promise<{ ok: true } | { ok: false; error: DocxWriteError }> {
  return writeDocxMutation(
    args.absolutePath,
    (bytes) => mutateSetResolved(bytes, args, false),
    async (newBytes) => {
      if (!(await verifyOoxmlWiring(newBytes))) return false;
      const result = await readDocxComments(newBytes, args.path);
      if (!result.ok) return false;
      const target = result.comments.find((c) => c.id === args.id);
      return !!target && target.resolved === false;
    }
  );
}

export async function moveDocxComment(args: {
  absolutePath: string;
  path: string;
  id: string;
  newSelector: CommentSelector;
}): Promise<{ ok: true } | { ok: false; error: DocxWriteError }> {
  return writeDocxMutation(
    args.absolutePath,
    (bytes) => mutateMoveComment(bytes, args),
    async (newBytes) => {
      if (!(await verifyOoxmlWiring(newBytes))) return false;
      const rawId = stripWPrefix(args.id);
      if (rawId === null || args.newSelector.kind !== 'text') return false;

      // "The OLD range is gone" (review 3, F2) — a low-level marker COUNT,
      // since readDocxComments' PersistedComment shape (one record per
      // comments.xml id) can't itself distinguish "exactly one range" from
      // "two ranges, `ranges.set()` silently kept only the last one".
      let zip: JSZip;
      try {
        zip = await JSZip.loadAsync(newBytes);
      } catch {
        return false;
      }
      const documentFile = zip.file('word/document.xml');
      if (!documentFile) return false;
      const documentXml = await documentFile.async('string');
      if (countAttrOccurrences(documentXml, 'w:commentRangeStart', 'w:id', rawId) !== 1) return false;
      if (countAttrOccurrences(documentXml, 'w:commentRangeEnd', 'w:id', rawId) !== 1) return false;
      if (countAttrOccurrences(documentXml, 'w:commentReference', 'w:id', rawId) !== 1) return false;

      const result = await readDocxComments(newBytes, args.path);
      if (!result.ok) return false;
      const target = result.comments.find((c) => c.id === args.id);
      if (!target || target.selector.kind !== 'text') return false;
      return target.selector.selector.exact === args.newSelector.selector.exact;
    }
  );
}
