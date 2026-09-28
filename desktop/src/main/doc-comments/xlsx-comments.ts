// Excel (.xlsx) comment reading + writing — T12 (read) and T13 (write) of the
// doc-comments build (docs/active/specs/2026-09-26-doc-comments-build-
// design.md §4.1-§4.3, §8). REWRITTEN 2026-09-27 (session `comments-mock-a`)
// for Destin's threaded-comments-only decision (chat, 2026-09-27: "Excel
// comments use ONLY modern threaded comments... never old-style notes as the
// product format") — this supersedes the ENTIRE prior legacy-Notes design
// (the exceljs-based reader/writer, the "Priya Shah: ..." formatted-
// transcript note body, the `​✓ Resolved`/`​[[yc:resolved]]` marker hack, the
// `APP_AUTHOR_PREFIX_RE`/`NON_NAME_HEADINGS` author-guessing heuristic) — not
// layered under it. See the design doc's own 2026-09-27 changelog entries for
// the full research citation.
//
// exceljs is REMOVED from this module entirely (§4.1): its `cell.note` getter
// cannot tell a genuine Note apart from a threaded comment's own legacy-
// compatibility placeholder — it reads the placeholder's text as if it were
// an ordinary Note, an independently-confirmed defect in the code this
// rewrite replaces. exceljs remains a direct dependency of the app as a
// whole (`XlsxView.tsx`'s own read-only cell-VALUE display still uses it),
// just never imported by THIS module again. Reading/writing here moves
// entirely to the same hand-rolled JSZip + `linkedom` DOM approach
// docx-comments.ts already uses — surgical edits touching only the parts a
// mutation needs, never a whole-workbook rebuild (the same "never re-
// serialize an untouched part" discipline that already protects a real
// LibreOffice-authored workbook's docProps/custom.xml, external links, and
// everything else this module never opens).
//
// Old-style Notes already in a file are never read, created, or edited by
// this module (§4.1) — a genuine Note round-trips byte-for-byte, untouched,
// no matter how many threaded-comment writes happen around it, and is never
// surfaced in the comments pane (the product has no write path for one any
// more, and showing it risks the exact garbled-placeholder confusion this
// rewrite retires).
//
// Exact OOXML shapes below are researched from Microsoft's [MS-XLSX] open
// spec plus two real, redistributable sample files captured under
// `shared-fixtures/doc-comments/xlsx-threaded-reference/` (`manifest.json`/
// `README.md` there hold the same facts machine-checkably) — see design §4.2
// for the full citation and the gaps that research could not close (Strict
// OOXML; same-cell Note+thread coexistence).
import { randomUUID } from 'crypto';
import JSZip from 'jszip';
import { DOMParser } from 'linkedom';
import type { CellSelector, CommentAuthor, CommentReply, CommentSelector, PersistedComment } from '../../shared/doc-comments-types';
import { checkNamedEntriesWithinCeiling, decompressBounded } from './zip-size-guard';
import { writeFileMutation } from './write-pipeline';

// Not exported (same convention as docx-comments.ts's DocxReadError): nothing
// outside this module needs the error union by name — knip flags an exported
// type nothing ever imports as dead code. Callers only need `XlsxReadResult`.
//
// 'archive-too-large': a NAMED part (never the whole archive — §4.3's own
//   "the guard narrows to match" finding, since exceljs's black-box
//   decompression is gone from this module entirely) declares (or, per
//   zip-size-guard.ts's own decompression-time backstop, actually contains)
//   an implausible uncompressed size.
// 'too-many-comments' (design review 1, F3): a record-count ceiling,
//   independent of the byte ceiling above — a crafted (or just very large)
//   threadedComment{N}.xml of many thousands of minimal elements could stay
//   comfortably under the byte ceiling while still handing the renderer many
//   thousands of PersistedComment records in one `list()` response.
type XlsxReadError = 'invalid-xlsx' | 'archive-too-large' | 'too-many-comments';
export type XlsxReadResult = { ok: true; comments: PersistedComment[] } | { ok: false; error: XlsxReadError };

// Task-time starting point, not a benchmarked constant (matching zip-size-
// guard.ts's own MAX_DECLARED_UNCOMPRESSED_BYTES precedent) — real workbooks
// this feature will see (the `elden` reference fixture's own ~150 threads is
// the largest real sample this research found) sit orders of magnitude below
// this; lower it if a real-world report calls for it.
const MAX_COMMENT_RECORDS = 20000;

const SML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XR_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2014/revision';
const THREADED_COMMENTS_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments';

const COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml';
// §4.2: NO `+xml` suffix, unlike every other XML part's content type in the
// same file — an easy mismatch to introduce by analogy with the Overrides
// around it, so this is a named constant, never re-typed at each call site.
const VML_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.vmlDrawing';
const THREADED_COMMENT_CONTENT_TYPE = 'application/vnd.ms-excel.threadedcomments+xml';
const PERSON_CONTENT_TYPE = 'application/vnd.ms-excel.person+xml';

const COMMENTS_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const VML_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing';
const THREADED_COMMENT_REL_TYPE = 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment';
const PERSON_REL_TYPE = 'http://schemas.microsoft.com/office/2017/10/relationships/person';

// The legacy compatibility placeholder's own text — §4.2, confirmed byte-for-
// byte (header sentence + URL) across three independent sources: both real
// reference fixtures, and a third real-Excel-365 sample quoted in a public
// bug report (github.com/PHPOffice/PhpSpreadsheet issue #2184). This app's
// writer matches the real-EXCEL layout verbatim (blank line after the
// header, blank line before "Comment:", 4-space indents, one "Reply:" block
// per reply) — the more common of the two observed shapes (Google Sheets'
// own export uses a different, tab-indented layout) and the one
// independently corroborated a third time.
const PLACEHOLDER_HEADER =
  '[Threaded comment]\n\n' +
  'Your version of Excel allows you to read this threaded comment; however, any edits to it will get removed if the file is opened in a newer version of Excel. Learn more: https://go.microsoft.com/fwlink/?linkid=870924\n\n' +
  'Comment:\n    ';

/** §4.2: builds the WHOLE placeholder body fresh from the thread's current
 *  full transcript (root text + every reply, in `dT`/creation order) rather
 *  than incrementally appending — simpler and just as correct, since a
 *  reply/move needs to know the full history to rebuild this anyway, and the
 *  placeholder is write-only output this app never re-parses (§4.1: a
 *  `tc={GUID}`-linked legacy `<comment>` is always skipped by the reader in
 *  favor of the real thread). A multi-line reply's OWN embedded newlines are
 *  never re-indented — only the block's own leading `Reply:\n    ` marks
 *  where the block starts, matching every real sample inspected. */
function buildPlaceholderBody(commentText: string, replyTexts: readonly string[]): string {
  let body = PLACEHOLDER_HEADER + commentText;
  for (const reply of replyTexts) body += `\nReply:\n    ${reply}`;
  return body;
}

/** §4.2's own "the ONLY link between a legacy placeholder and its real
 *  thread" rule: the legacy `<comment>`'s own `authorId` resolves (through
 *  this file's own `<authors>` list) to a `tc={GUID}` string, `{GUID}`
 *  byte-identical (this function compares case-insensitively — §4.2's own
 *  GUID-case finding) to the corresponding `threadedComment` ROOT's `id`.
 *  Anything else is a genuine Note (§4.1: never shown, never touched). */
const TC_AUTHOR_RE = /^tc=\{[0-9A-Fa-f-]{36}\}$/;

function isTcAuthorText(text: string): boolean {
  return TC_AUTHOR_RE.test(text);
}

/** §4.2: strips braces and lowercases, so a Windows/Mac-Excel-written
 *  UPPERCASE GUID and a Google-Sheets-written lowercase one compare equal —
 *  "reads case-insensitively (matches either vendor)". This app's OWN writer
 *  always MINTS uppercase (matches the spec and the majority real-world
 *  writer, §4.2), but every COMPARISON in this module goes through this
 *  function so a foreign file's own case convention never matters. */
function normalizeGuid(raw: string): string {
  return raw.replace(/[{}]/g, '').toLowerCase();
}

/** A brand-new root/reply/person GUID, in this app's own written shape:
 *  braces included, uppercase hex (§4.2). */
function mintGuid(): string {
  return `{${randomUUID().toUpperCase()}}`;
}

/** §4.2's own confirmed real-world format: `YYYY-MM-DDTHH:MM:SS.ff` — exactly
 *  two fractional-second digits, no timezone offset, never a trailing `Z`.
 *  Written in LOCAL time (matching "locally-naive" — no real writer sampled
 *  emits a UTC-suffixed value even though the XSD's plain `xsd:dateTime`
 *  would permit one). */
function formatThreadedDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  const cs = pad(Math.floor(d.getMilliseconds() / 10));
  return `${y}-${mo}-${day}T${h}:${mi}:${s}.${cs}`;
}

/** `Date.parse` already treats an offset-less ISO-shaped string as LOCAL time
 *  per the ES2016+ Date Time String Format grammar (confirmed empirically
 *  against real `dT` values from both reference fixtures before writing
 *  this) — no bespoke parsing needed, same `Date.parse`-with-`NaN`-fallback
 *  shape docx-comments.ts's own `parseDate` already uses. */
function parseThreadedDate(dT: string): number {
  const t = Date.parse(dT);
  return Number.isNaN(t) ? Date.now() : t;
}

/** linkedom's `Element.getAttribute()` does NOT decode XML entities for
 *  `text/xml` parsing — confirmed empirically before writing this fix
 *  (`.textContent` decodes correctly; `.getAttribute()` returns `&amp;`
 *  literally). A real workbook can legitimately have an `&` in a sheet name
 *  (the `elden` reference fixture's own "Sorceries & Incantations List" is
 *  exactly this case) or a person's `displayName` — every attribute value
 *  this module treats as free-text DATA (never an id/ref/GUID, which never
 *  contains XML-special characters in practice) is decoded through this
 *  function before use, both for comparison (matching a caller's own
 *  `CellSelector.sheet`) and for the value this module hands back to a
 *  caller. `setAttribute` + serialization already encodes correctly on the
 *  way OUT (confirmed empirically), so this fix is read-side only. */
function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (whole, ent: string) => {
    switch (ent) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code = ent[1] === 'x' || ent[1] === 'X' ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
        return Number.isNaN(code) ? whole : String.fromCodePoint(code);
      }
    }
  });
}

function toCommentAuthor(name: string): CommentAuthor {
  return `person:${name || 'Unknown'}`;
}

/** §3.4/§4.1's own rule, mirrored from docx-comments.ts's
 *  `commentAuthorToDisplayName` (duplicated here rather than imported — the
 *  two write modules are deliberately independent, same reasoning as
 *  write-pipeline.ts's own header): a reply/add made from this app must
 *  round-trip into a real `personId`->`displayName` mapping naming "the
 *  account's display name or 'You'", never overwriting a colleague's own
 *  `<person>` entry. No accounts exist yet (§1.2), so 'user' is literally
 *  "You"; 'assistant' is a plain, honest label. */
function commentAuthorToDisplayName(author: CommentAuthor): string {
  if (author === 'user') return 'You';
  if (author === 'assistant') return 'Assistant';
  if (author.startsWith('person:')) return author.slice('person:'.length) || 'Unknown';
  return 'Unknown';
}

// A1-style reference, 1-3 letters then 1-7 digits — generous enough for any
// real worksheet (Excel's own max column is XFD, max row 1,048,576) while
// still rejecting a malformed or empty string outright.
const CELL_ADDRESS_RE = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;

function isValidCellAddress(addr: string): boolean {
  return CELL_ADDRESS_RE.test(addr);
}

/** `"B5"` -> `{col: 2, row: 5}`, BOTH 1-based (Excel-native) — the shape the
 *  VML shape's `<x:Anchor>` default-rect math and `<x:Row>`/`<x:Column>`
 *  (which subtract 1 themselves) both need. Caller must already have
 *  validated the address with `isValidCellAddress`. */
function colLettersToNumber(letters: string): number {
  let col = 0;
  for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
  return col;
}

function parseCellRef(addr: string): { col: number; row: number } {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(addr)!;
  return { col: colLettersToNumber(m[1]), row: Number.parseInt(m[2], 10) };
}

// -----------------------------------------------------------------------
// The app-level thread id — §4.2's corrected, GUID-embedding scheme (design
// review 1, F1; parse regex pre-written by design review round 2, F2).
// -----------------------------------------------------------------------

/** Pre-written regex (design review round 2, F2) — parse from the LEFT,
 *  splitting on exactly the first TWO hyphens; the remainder (group 3),
 *  regardless of how many hyphens it itself contains, is the GUID verbatim,
 *  NEVER itself split further. A naive `id.split('-')` would destructure only
 *  the GUID's own first hyphen-delimited segment, silently truncating it.
 *  `shared-fixtures/doc-comments/id-parse-test-vectors.json` is the shared
 *  contract both this module and a future Kotlin port (T18/T19) read
 *  directly in their own pinning tests. */
const XLSX_THREAD_ID_RE = /^xt-(\d+)-([^-]+)-(.+)$/;

function parseXlsxThreadId(id: string): { sheetId: number; cell: string; guid: string } | null {
  const m = XLSX_THREAD_ID_RE.exec(id);
  if (!m) return null;
  const sheetId = Number.parseInt(m[1], 10);
  if (Number.isNaN(sheetId) || !isValidCellAddress(m[2])) return null;
  return { sheetId, cell: m[2], guid: m[3] };
}

function buildXlsxThreadId(sheetId: number, cell: string, guidBraced: string): string {
  return `xt-${sheetId}-${cell}-${guidBraced.replace(/[{}]/g, '')}`;
}

// -----------------------------------------------------------------------
// Small, format-agnostic path helpers — OOXML relationship `Target`s are
// always relative to the REFERRING part's own directory, never absolute.
// -----------------------------------------------------------------------

function dirnameOfPart(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function basenameOfPart(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/** Resolves a relationship `Target` (e.g. `"../comments1.xml"`,
 *  `"worksheets/sheet2.xml"`) against the directory the REFERRING part
 *  lives in, normalizing `..`/`.` segments — the general form of what OOXML
 *  relationship resolution always does, used for both workbook.xml.rels
 *  (base `xl`) and a worksheet's own rels (base `xl/worksheets`). */
function resolveRelTarget(baseDir: string, target: string): string {
  const segments = [...baseDir.split('/'), ...target.split('/')].filter((s) => s.length > 0);
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** The inverse of `resolveRelTarget`: expresses `toPath` as a path relative
 *  to `fromDir`, the shape a NEW `Relationship`'s own `Target` attribute
 *  needs. */
function relativizeTarget(fromDir: string, toPath: string): string {
  const fromParts = fromDir.split('/').filter(Boolean);
  const toParts = toPath.split('/').filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length - 1 && fromParts[i] === toParts[i]) i++;
  const ups = fromParts.length - i;
  const downs = toParts.slice(i);
  return [...Array(ups).fill('..'), ...downs].join('/');
}

function worksheetRelsPathFor(partPath: string): string {
  return `${dirnameOfPart(partPath)}/_rels/${basenameOfPart(partPath)}.rels`;
}

// -----------------------------------------------------------------------
// Minimal XML plumbing — mirrors docx-comments.ts's own linkedom-based
// parse/serialize helpers (duplicated rather than imported: the two write
// modules are deliberately independent, same reasoning as write-pipeline.ts's
// own header).
// -----------------------------------------------------------------------

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
}

function elementsByTag(node: Document | Element, tag: string): Element[] {
  return Array.from((node as unknown as { getElementsByTagName(t: string): ArrayLike<Element> }).getElementsByTagName(tag));
}

/** §4.2's own load-bearing gotcha, confirmed by the second real sample:
 *  namespace prefixes vary by writer (real Excel declares the threaded-
 *  comments namespace as the DEFAULT, unprefixed namespace; real Google
 *  Sheets prefixes every element `x18tc:`). `linkedom`'s own `.localName`
 *  getter is NOT namespace-aware for `text/xml` parsing (confirmed
 *  empirically before writing this module: it returns the full PREFIXED tag
 *  string, identical to `.tagName`) — so this module computes a real local
 *  name itself (the substring after the last `:`) rather than trusting
 *  either. `elementsByTagName(tag)` matching a literal (possibly-prefixed)
 *  string would silently read ZERO threaded comments from a Google-Sheets-
 *  authored file; this is the fix, used everywhere this module needs to find
 *  a `threadedComment`/`text`/`person` element regardless of which vendor's
 *  prefix convention wrote it. `querySelectorAll('*')` is used for the
 *  wildcard scan rather than `getElementsByTagName('*')` — confirmed
 *  empirically that linkedom's own wildcard `getElementsByTagName` returns
 *  an always-empty collection, while `querySelectorAll('*')` works. */
function localNameOf(el: Element): string {
  const tag = el.tagName;
  const i = tag.lastIndexOf(':');
  return i === -1 ? tag : tag.slice(i + 1);
}

function elementsByLocalName(root: Document | Element, name: string): Element[] {
  const all = Array.from((root as unknown as { querySelectorAll(sel: string): ArrayLike<Element> }).querySelectorAll('*'));
  return all.filter((el) => localNameOf(el) === name);
}

/** Sets every `[name, value]` pair in `attrs` so the element SERIALIZES in
 *  exactly that order — confirmed empirically that linkedom's own
 *  `Element.toString()` emits attributes in the REVERSE of their
 *  `setAttribute()` call order. Calling `setAttribute` in reverse of `attrs`'
 *  own order is what makes the OUTPUT come out in `attrs`' order. */
function setOrderedAttributes(el: Element, attrs: ReadonlyArray<readonly [string, string]>): void {
  for (let i = attrs.length - 1; i >= 0; i--) el.setAttribute(attrs[i][0], attrs[i][1]);
}

const XML_DECL_RE = /^<\?xml[^>]*\?>/;
// Matches a self-closing tag's OPENING `<tag ...` up to the space linkedom
// inserts before `/>` — requiring the leading `<` is what keeps this from
// ever touching plain text content (a literal `<` in XML text is always
// escaped as `&lt;`). Identical to docx-comments.ts's own regex of the same
// name/purpose.
const SELF_CLOSING_SPACE_RE = /(<[\w:.-]+(?:\s+[^<>]*)?) \/>/g;

/** Re-serializes `doc` through linkedom, then restores the ORIGINAL XML
 *  declaration verbatim (linkedom's own `toString()` lowercases `encoding`
 *  and drops `standalone="yes"`) and undoes the space linkedom adds before a
 *  self-closing tag's `/>`. `originalXml` is the part's real prior bytes for
 *  an EXISTING part, or `null` for a brand-new one this operation minted
 *  (only the self-closing-tag normalization applies then). */
function serializeXlsxPart(doc: Document, originalXml: string | null): string {
  let out = doc.toString();
  if (originalXml !== null) {
    const originalDecl = originalXml.match(XML_DECL_RE);
    out = originalDecl ? out.replace(XML_DECL_RE, originalDecl[0]) : out.replace(XML_DECL_RE, '');
  }
  return out.replace(SELF_CLOSING_SPACE_RE, '$1/>');
}

function writeXlsxPart(zip: JSZip, name: string, changed: boolean, doc: Document, originalXml: string | null): void {
  if (!changed && originalXml !== null) {
    zip.file(name, originalXml);
    return;
  }
  zip.file(name, serializeXlsxPart(doc, originalXml));
}

// -----------------------------------------------------------------------
// Exact OOXML shapes for brand-new parts — §4.2/§4.3.
// -----------------------------------------------------------------------

// A LEADING NEWLINE after the XML declaration is deliberate, not incidental
// formatting: linkedom PRESERVES whatever followed the declaration in the
// STRING it originally parsed, and every real reference sample captured here
// has this exact newline.
const EMPTY_VML_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype></xml>`;
const EMPTY_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}"></Relationships>`;
// §4.3 step 1 (design review 1, F6): a comments{N}.xml part THIS APP mints
// itself gets `xmlns:xr`/`mc:Ignorable="xr"` — the Mac-Excel convention, the
// more spec-literal of the two observed real conventions (Google Sheets
// omits it and Excel still opens the file either way). `<authors>` starts
// EMPTY — unlike the retired legacy-Notes writer's own "Author" placeholder
// convention, every author entry this module ever writes is a unique
// `tc={GUID}` string, one per thread, never reused across threads.
const EMPTY_COMMENTS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments xmlns="${SML_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="xr" xmlns:xr="${XR_NS}"><authors></authors><commentList></commentList></comments>`;
// §4.2: real Excel declares the threaded-comments namespace as the DEFAULT
// (unprefixed) namespace — this app's writer follows that convention for
// every part it mints itself (an existing Google-Sheets-authored, `x18tc:`-
// prefixed part is edited in its OWN convention instead — see
// `detectThreadedPrefix` below).
const EMPTY_THREADED_COMMENTS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<ThreadedComments xmlns="${THREADED_COMMENTS_NS}" xmlns:x="${SML_NS}"></ThreadedComments>`;
const EMPTY_PERSON_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<personList xmlns="${THREADED_COMMENTS_NS}" xmlns:x="${SML_NS}"></personList>`;

/** Detects whether an EXISTING `ThreadedComments`/`personList` document uses
 *  the default-namespace (Excel) convention or a prefixed (`x18tc:`, Google
 *  Sheets) one, by reading the root element's own tag name — so a NEW
 *  element appended into an existing part matches whatever convention that
 *  part already uses, rather than mixing two styles under one root. `''`
 *  (no prefix) for a brand-new part this app mints itself. */
function detectPrefix(doc: Document): string {
  const rootTag = doc.documentElement.tagName;
  const i = rootTag.indexOf(':');
  return i === -1 ? '' : rootTag.slice(0, i);
}

function tcTag(prefix: string, local: string): string {
  return prefix ? `${prefix}:${local}` : local;
}

/** Builds one `<v:shape>` element for a brand-new threaded-comment
 *  placeholder at 1-based `(col, row)`. §4.2's own confirmed difference from
 *  a genuine legacy Note's VML: every one of three independently-sourced
 *  real threaded-placeholder samples (Mac Excel, Google Sheets, plus one
 *  cross-checked-but-not-redistributed Windows Excel sample) OMITS
 *  `<x:Locked>`/`<x:LockText>` — present on a genuine Note's own VML, never
 *  on a threaded placeholder's. Anchor/position math is otherwise identical
 *  to the (now-retired) legacy-Notes VML builder's own formula (a format
 *  detail unrelated to note-vs-threaded, carried forward unchanged). */
function buildThreadedVmlShape(doc: Document, idNumber: number, col: number, row: number): Element {
  const shape = doc.createElement('v:shape');
  setOrderedAttributes(shape, [
    ['id', `_x0000_s${idNumber}`],
    ['type', '#_x0000_t202'],
    ['style', 'position:absolute; margin-left:105.3pt;margin-top:10.5pt;width:97.8pt;height:59.1pt;z-index:1;visibility:hidden'],
    ['fillcolor', 'infoBackground [80]'],
    ['strokecolor', 'none [81]'],
    ['o:insetmode', 'auto'],
  ]);

  const fill = doc.createElement('v:fill');
  fill.setAttribute('color2', 'infoBackground [80]');
  shape.appendChild(fill);
  const shadow = doc.createElement('v:shadow');
  setOrderedAttributes(shadow, [
    ['color', 'none [81]'],
    ['obscured', 't'],
  ]);
  shape.appendChild(shadow);
  const vpath = doc.createElement('v:path');
  vpath.setAttribute('o:connecttype', 'none');
  shape.appendChild(vpath);

  const textbox = doc.createElement('v:textbox');
  setOrderedAttributes(textbox, [
    ['style', 'mso-direction-alt:auto'],
    ['inset', '1.3mm,1.3mm,2.5mm,2.5mm'],
  ]);
  const div = doc.createElement('div');
  div.setAttribute('style', 'text-align:left');
  textbox.appendChild(div);
  shape.appendChild(textbox);

  const clientData = doc.createElement('x:ClientData');
  clientData.setAttribute('ObjectType', 'Note');
  clientData.appendChild(doc.createElement('x:MoveWithCells'));
  clientData.appendChild(doc.createElement('x:SizeWithCells'));
  // Default anchor rect (exceljs's own `vml-anchor-xform.js` `getDefaultRect`,
  // `ref.col`/`ref.row` 1-based): l=col, t=max(row-2,0), r=col+2, b=t+4, with
  // fixed sub-cell fractions 6/14/2/16 — carried forward unchanged from the
  // retired legacy-Notes builder (a positioning formula unrelated to the
  // note-vs-threaded distinction).
  const l = col;
  const t = Math.max(row - 2, 0);
  const r = col + 2;
  const b = t + 4;
  const anchor = doc.createElement('x:Anchor');
  anchor.textContent = [l, 6, t, 14, r, 2, b, 16].join(', ');
  clientData.appendChild(anchor);
  const autoFill = doc.createElement('x:AutoFill');
  autoFill.textContent = 'False';
  clientData.appendChild(autoFill);
  const rowEl = doc.createElement('x:Row');
  rowEl.textContent = String(row - 1);
  clientData.appendChild(rowEl);
  const colEl = doc.createElement('x:Column');
  colEl.textContent = String(col - 1);
  clientData.appendChild(colEl);
  shape.appendChild(clientData);

  return shape;
}

/** Scans the CURRENT `<v:shape id="_x0000_sNNNN">` ids already in `vmlDoc`
 *  and returns the next number to use — 1025 if none exist yet. Reused
 *  verbatim from the retired legacy-Notes writer (format-agnostic: it never
 *  cared whether a shape was a Note's or a threaded placeholder's). */
function nextVmlShapeId(vmlDoc: Document): number {
  let max = 1024;
  for (const el of elementsByTag(vmlDoc, 'v:shape')) {
    const m = /^_x0000_s(\d+)$/.exec(el.getAttribute('id') ?? '');
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

/** Ensures `doc`'s root declares the `xr` namespace prefix — needed before
 *  setting an `xr:uid` attribute on an EXISTING comments part that never had
 *  one before (a brand-new part already bakes this into its own template,
 *  §4.3 step 1/F6; this only matters when this module is APPENDING its
 *  first-ever `tc=`-linked placeholder into a foreign, pre-existing
 *  comments part). A no-op if already declared. */
function ensureXrNamespaceDeclared(doc: Document): void {
  if (!doc.documentElement.getAttribute('xmlns:xr')) {
    doc.documentElement.setAttribute('xmlns:xr', XR_NS);
  }
}

function appendTcAuthor(commentsDoc: Document, guidBraced: string): number {
  let authorsEl = elementsByTag(commentsDoc, 'authors')[0];
  if (!authorsEl) {
    authorsEl = commentsDoc.createElement('authors');
    commentsDoc.documentElement.insertBefore(authorsEl, commentsDoc.documentElement.firstChild);
  }
  const authorEls = elementsByTag(authorsEl, 'author');
  const newAuthor = commentsDoc.createElement('author');
  newAuthor.textContent = `tc=${guidBraced}`;
  authorsEl.appendChild(newAuthor);
  return authorEls.length;
}

/** §4.1's own rule: does the target cell already carry a GENUINE (non-`tc=`)
 *  Note in `commentsDoc`? Used to refuse `'cell-has-note'`. */
function findGenuineNoteAtCell(commentsDoc: Document, cell: string): boolean {
  const authorsEl = elementsByTag(commentsDoc, 'authors')[0];
  const authorEls = authorsEl ? elementsByTag(authorsEl, 'author') : [];
  for (const commentEl of elementsByTag(commentsDoc, 'comment')) {
    if (commentEl.getAttribute('ref') !== cell) continue;
    const idx = Number.parseInt(commentEl.getAttribute('authorId') ?? '', 10);
    const authorText = authorEls[idx]?.textContent ?? '';
    if (!isTcAuthorText(authorText)) return true;
  }
  return false;
}

/** Finds the ONE legacy `<comment>` fronting for the thread whose root GUID
 *  is `guidBraced`, by resolving each `<comment>`'s own `authorId` through
 *  `<authors>` and matching the `tc={GUID}` string case-insensitively
 *  (§4.2's own GUID-case finding). */
function findTcComment(commentsDoc: Document, guidBraced: string): Element | null {
  const authorsEl = elementsByTag(commentsDoc, 'authors')[0];
  const authorEls = authorsEl ? elementsByTag(authorsEl, 'author') : [];
  const target = `tc=${normalizeGuid(guidBraced)}`;
  for (const commentEl of elementsByTag(commentsDoc, 'comment')) {
    const idx = Number.parseInt(commentEl.getAttribute('authorId') ?? '', 10);
    const authorText = authorEls[idx]?.textContent ?? '';
    if (isTcAuthorText(authorText) && `tc=${normalizeGuid(authorText.slice(3))}` === target) return commentEl;
  }
  return null;
}

/** Replaces (or, for a brand-new `<comment>`, sets for the first time)
 *  `commentEl`'s own `<text>` child with a SINGLE `<r><t>` run holding the
 *  full placeholder body — this module's own convention is one placeholder
 *  body per thread, rebuilt WHOLE on every write (never per-turn rich runs).
 *  `xml:space="preserve"` is added under the same condition exceljs's own
 *  `text-xform.js` uses (leading/trailing whitespace or an embedded newline)
 *  — a placeholder body always has both, so this is effectively always set,
 *  but the check is kept general rather than hardcoded. */
function setXlsxCommentBody(doc: Document, commentEl: Element, bodyText: string): void {
  for (const existing of elementsByTag(commentEl, 'text')) {
    existing.parentNode?.removeChild(existing as unknown as Node);
  }
  const textEl = doc.createElement('text');
  const rEl = doc.createElement('r');
  const tEl = doc.createElement('t');
  if (/^\s|\n|\s$/.test(bodyText)) tEl.setAttribute('xml:space', 'preserve');
  tEl.textContent = bodyText;
  rEl.appendChild(tEl);
  textEl.appendChild(rEl);
  commentEl.appendChild(textEl);
}

function appendPlaceholderComment(commentsDoc: Document, cellAddr: string, authorIdx: number, guidBraced: string, bodyText: string): void {
  ensureXrNamespaceDeclared(commentsDoc);
  const commentList = elementsByTag(commentsDoc, 'commentList')[0];
  const commentEl = commentsDoc.createElement('comment');
  setOrderedAttributes(commentEl, [
    ['ref', cellAddr],
    ['authorId', String(authorIdx)],
    ['xr:uid', guidBraced],
  ]);
  setXlsxCommentBody(commentsDoc, commentEl, bodyText);
  commentList.appendChild(commentEl);
}

// -----------------------------------------------------------------------
// Per-worksheet / per-workbook wiring — resolving where a thread's parts
// live (or would need to be created).
// -----------------------------------------------------------------------

interface SheetMeta {
  name: string;
  sheetId: number;
  rId: string;
  partPath: string;
  isChartsheet: boolean;
}

/** Parses `xl/workbook.xml`'s `<sheets>` against `xl/_rels/workbook.xml.rels`
 *  to resolve each `<sheet>`'s real worksheet PART path and whether it's a
 *  chartsheet — chartsheets are excluded from every cell-comment operation
 *  (a chartsheet has no cells at all) and from "single sheet" counting. */
function parseSheetsFromWorkbook(workbookXml: string, workbookRelsXml: string): SheetMeta[] {
  const workbookDoc = parseXml(workbookXml);
  const relsDoc = parseXml(workbookRelsXml);
  const relMap = new Map<string, { target: string; type: string }>();
  for (const el of elementsByTag(relsDoc, 'Relationship')) {
    const id = el.getAttribute('Id');
    if (id) relMap.set(id, { target: el.getAttribute('Target') ?? '', type: el.getAttribute('Type') ?? '' });
  }
  const sheets: SheetMeta[] = [];
  for (const el of elementsByTag(workbookDoc, 'sheet')) {
    const name = decodeXmlEntities(el.getAttribute('name') ?? '');
    const sheetId = Number.parseInt(el.getAttribute('sheetId') ?? '', 10);
    const rId = el.getAttribute('r:id') ?? '';
    const rel = relMap.get(rId);
    if (!rel || Number.isNaN(sheetId)) continue; // malformed wiring — this sheet is simply not addressable
    sheets.push({
      name,
      sheetId,
      rId,
      partPath: resolveRelTarget('xl', rel.target),
      isChartsheet: rel.type.endsWith('/chartsheet'),
    });
  }
  return sheets;
}

interface WorksheetContext {
  partPath: string;
  sheetId: number;
  sheetName: string;
  worksheetDoc: Document;
  worksheetXmlOriginal: string;
  worksheetChanged: boolean;
  relsPartPath: string;
  relsDoc: Document;
  relsXmlOriginal: string;
  relsChanged: boolean;

  ambiguous: boolean;

  commentsPartPath: string | null;
  commentsDoc: Document | null;
  commentsXmlOriginal: string | null;
  commentsChanged: boolean;
  vmlPartPath: string | null;
  vmlDoc: Document | null;
  vmlXmlOriginal: string | null;
  vmlChanged: boolean;

  threadedPartPath: string | null;
  threadedDoc: Document | null;
  threadedXmlOriginal: string | null;
  threadedChanged: boolean;
}

interface XlsxArchive {
  zip: JSZip;
  sheets: SheetMeta[];
  contentTypesDoc: Document;
  contentTypesXmlOriginal: string;
  contentTypesChanged: boolean;
  workbookRelsDoc: Document;
  workbookRelsXmlOriginal: string;
  workbookRelsChanged: boolean;
  personsPartPath: string;
  personsDoc: Document | null;
  personsXmlOriginal: string | null;
  personsChanged: boolean;
  worksheetContexts: Map<string, WorksheetContext>;
}

type PartReadResult = { ok: true; text: string | null } | { ok: false; error: 'archive-too-large' };

/** Reads a NAMED zip entry (or `{ok:true, text:null}` if it doesn't exist),
 *  checked against the size guard BEFORE decompression and decompressed via
 *  the streaming, self-aborting `decompressBounded` — never `.async('string')`
 *  — matching docx-comments.ts's own "named parts only" discipline (§4.3's
 *  own "the guard narrows to match" finding: this module never hands a
 *  black-box decompressor a whole archive the way the retired exceljs-based
 *  reader did). */
async function readOptionalPart(zip: JSZip, name: string): Promise<PartReadResult> {
  const file = zip.file(name);
  if (!file) return { ok: true, text: null };
  const sizeCheck = checkNamedEntriesWithinCeiling(zip, [name]);
  if (!sizeCheck.ok) return { ok: false, error: sizeCheck.error };
  const bounded = await decompressBounded(file);
  if (!bounded.ok) return { ok: false, error: bounded.error };
  return { ok: true, text: bounded.text };
}

async function loadXlsxArchiveForWrite(bytes: Buffer): Promise<{ ok: true; archive: XlsxArchive } | { ok: false; error: XlsxWriteError }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { ok: false, error: 'invalid-xlsx' };
  }

  const workbookFile = zip.file('xl/workbook.xml');
  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!workbookFile || !contentTypesFile) return { ok: false, error: 'invalid-xlsx' };

  const sizeCheck = checkNamedEntriesWithinCeiling(zip, ['xl/workbook.xml', '[Content_Types].xml', 'xl/_rels/workbook.xml.rels']);
  if (!sizeCheck.ok) return { ok: false, error: sizeCheck.error };

  let workbookXml: string;
  let contentTypesXml: string;
  let workbookRelsXml: string;
  try {
    const workbookRelsFile = zip.file('xl/_rels/workbook.xml.rels');
    [workbookXml, contentTypesXml, workbookRelsXml] = await Promise.all([
      workbookFile.async('string'),
      contentTypesFile.async('string'),
      workbookRelsFile ? workbookRelsFile.async('string') : Promise.resolve(EMPTY_RELS_XML),
    ]);
  } catch {
    return { ok: false, error: 'invalid-xlsx' };
  }

  const sheets = parseSheetsFromWorkbook(workbookXml, workbookRelsXml);
  const workbookRelsDoc = parseXml(workbookRelsXml);

  // §4.2: the persons relationship is WORKBOOK-level, not per-worksheet, and
  // exactly one part per workbook — resolved once here, shared by every
  // worksheet context below.
  let personsPartPath = 'xl/persons/person.xml';
  let personsDoc: Document | null = null;
  let personsXmlOriginal: string | null = null;
  const personRel = elementsByTag(workbookRelsDoc, 'Relationship').find((el) => el.getAttribute('Type') === PERSON_REL_TYPE);
  if (personRel) {
    personsPartPath = resolveRelTarget('xl', personRel.getAttribute('Target') ?? '');
    const personRead = await readOptionalPart(zip, personsPartPath);
    if (!personRead.ok) return personRead;
    if (personRead.text !== null) {
      personsXmlOriginal = personRead.text;
      personsDoc = parseXml(personRead.text);
    }
  }

  return {
    ok: true,
    archive: {
      zip,
      sheets,
      contentTypesDoc: parseXml(contentTypesXml),
      contentTypesXmlOriginal: contentTypesXml,
      contentTypesChanged: false,
      workbookRelsDoc,
      workbookRelsXmlOriginal: workbookRelsXml,
      workbookRelsChanged: false,
      personsPartPath,
      personsDoc,
      personsXmlOriginal,
      personsChanged: false,
      worksheetContexts: new Map(),
    },
  };
}

/** Loads (or returns the already-loaded, cached-by-partPath) context for one
 *  worksheet: its own XML, its own rels, and — if wiring is unambiguous —
 *  the comments/VML/threadedComment parts it already points at.
 *  `ctx.ambiguous` is set when the legacy comments/vml/legacyDrawing trio is
 *  a partial or inconsistent combination, OR a threadedComment relationship
 *  exists with no matching part, OR a threadedComment part exists without
 *  its accompanying legacy pair (a shape no real Excel/Google-Sheets writer
 *  produces) — refused by every write op with `'ambiguous-comment-wiring'`
 *  rather than guessed at. */
async function getWorksheetContext(
  archive: XlsxArchive,
  sheetMeta: SheetMeta
): Promise<{ ok: true; ctx: WorksheetContext } | { ok: false; error: 'invalid-selector' | 'archive-too-large' }> {
  const cached = archive.worksheetContexts.get(sheetMeta.partPath);
  if (cached) return { ok: true, ctx: cached };

  const worksheetRead = await readOptionalPart(archive.zip, sheetMeta.partPath);
  if (!worksheetRead.ok) return worksheetRead;
  if (worksheetRead.text === null) return { ok: false, error: 'invalid-selector' };
  const worksheetXmlOriginal = worksheetRead.text;
  const worksheetDoc = parseXml(worksheetXmlOriginal);

  const relsPartPath = worksheetRelsPathFor(sheetMeta.partPath);
  const relsRead = await readOptionalPart(archive.zip, relsPartPath);
  if (!relsRead.ok) return relsRead;
  const relsXmlOriginal = relsRead.text ?? EMPTY_RELS_XML;
  const relsDoc = parseXml(relsXmlOriginal);

  const legacyDrawingEl = elementsByTag(worksheetDoc, 'legacyDrawing')[0] ?? null;
  const relationshipEls = elementsByTag(relsDoc, 'Relationship');
  const commentsRel = relationshipEls.find((el) => el.getAttribute('Type') === COMMENTS_REL_TYPE) ?? null;
  const vmlRel = relationshipEls.find((el) => el.getAttribute('Type') === VML_REL_TYPE) ?? null;
  const threadedRel = relationshipEls.find((el) => el.getAttribute('Type') === THREADED_COMMENT_REL_TYPE) ?? null;

  let ambiguous = false;
  let commentsPartPath: string | null = null;
  let vmlPartPath: string | null = null;
  let commentsDoc: Document | null = null;
  let vmlDoc: Document | null = null;
  let commentsXmlOriginal: string | null = null;
  let vmlXmlOriginal: string | null = null;
  let legacyExisting = false;

  if (legacyDrawingEl || commentsRel || vmlRel) {
    if (legacyDrawingEl && commentsRel && vmlRel && legacyDrawingEl.getAttribute('r:id') === vmlRel.getAttribute('Id')) {
      const worksheetDir = dirnameOfPart(sheetMeta.partPath);
      commentsPartPath = resolveRelTarget(worksheetDir, commentsRel.getAttribute('Target') ?? '');
      vmlPartPath = resolveRelTarget(worksheetDir, vmlRel.getAttribute('Target') ?? '');
      const commentsRead = await readOptionalPart(archive.zip, commentsPartPath);
      if (!commentsRead.ok) return commentsRead;
      const vmlRead = await readOptionalPart(archive.zip, vmlPartPath);
      if (!vmlRead.ok) return vmlRead;
      if (commentsRead.text === null || vmlRead.text === null) {
        ambiguous = true;
        commentsPartPath = null;
        vmlPartPath = null;
      } else {
        commentsXmlOriginal = commentsRead.text;
        vmlXmlOriginal = vmlRead.text;
        commentsDoc = parseXml(commentsXmlOriginal);
        vmlDoc = parseXml(vmlXmlOriginal);
        legacyExisting = true;
      }
    } else {
      ambiguous = true;
    }
  }

  let threadedPartPath: string | null = null;
  let threadedDoc: Document | null = null;
  let threadedXmlOriginal: string | null = null;
  let threadedExisting = false;
  if (threadedRel) {
    threadedPartPath = resolveRelTarget(dirnameOfPart(sheetMeta.partPath), threadedRel.getAttribute('Target') ?? '');
    const threadedRead = await readOptionalPart(archive.zip, threadedPartPath);
    if (!threadedRead.ok) return threadedRead;
    if (threadedRead.text === null) {
      ambiguous = true;
      threadedPartPath = null;
    } else {
      threadedXmlOriginal = threadedRead.text;
      threadedDoc = parseXml(threadedXmlOriginal);
      threadedExisting = true;
    }
  }
  // §4.2: a threaded part is never observed without its accompanying legacy
  // pair in any real sample — treat that combination as ambiguous rather
  // than silently reconstructing a legacy pair that never existed.
  if (threadedExisting && !legacyExisting) ambiguous = true;

  const ctx: WorksheetContext = {
    partPath: sheetMeta.partPath,
    sheetId: sheetMeta.sheetId,
    sheetName: sheetMeta.name,
    worksheetDoc,
    worksheetXmlOriginal,
    worksheetChanged: false,
    relsPartPath,
    relsDoc,
    relsXmlOriginal,
    relsChanged: false,
    ambiguous,
    commentsPartPath,
    commentsDoc,
    commentsXmlOriginal,
    commentsChanged: false,
    vmlPartPath,
    vmlDoc,
    vmlXmlOriginal,
    vmlChanged: false,
    threadedPartPath,
    threadedDoc,
    threadedXmlOriginal,
    threadedChanged: false,
  };
  archive.worksheetContexts.set(sheetMeta.partPath, ctx);
  return { ok: true, ctx };
}

function nextRelId(relsDoc: Document): string {
  let max = 0;
  for (const el of elementsByTag(relsDoc, 'Relationship')) {
    const m = /^rId(\d+)$/.exec(el.getAttribute('Id') ?? '');
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `rId${max + 1}`;
}

function addXlsxRelationship(relsDoc: Document, id: string, type: string, target: string): void {
  const el = relsDoc.createElement('Relationship');
  setOrderedAttributes(el, [
    ['Id', id],
    ['Type', type],
    ['Target', target],
  ]);
  relsDoc.documentElement.appendChild(el);
}

function addContentTypeOverride(contentTypesDoc: Document, partName: string, contentType: string): void {
  const exists = elementsByTag(contentTypesDoc, 'Override').some((el) => el.getAttribute('PartName') === partName);
  if (exists) return;
  const el = contentTypesDoc.createElement('Override');
  setOrderedAttributes(el, [
    ['PartName', partName],
    ['ContentType', contentType],
  ]);
  contentTypesDoc.documentElement.appendChild(el);
}

/** Picks the smallest positive integer not already used by an
 *  `xl/comments<N>.xml`, `xl/drawings/vmlDrawing<N>.vml`, OR
 *  `xl/threadedComments/threadedComment<N>.xml` part ANYWHERE in the archive
 *  — extended (§4.2) from the retired legacy-Notes writer's own
 *  `mintPartNumber`, which already produces the correct "skip the gap, don't
 *  reserve it" numbering once the new part type is included in the scan. */
function mintPartNumber(archive: XlsxArchive): number {
  let max = 0;
  archive.zip.forEach((relPath) => {
    let m = /^xl\/comments(\d+)\.xml$/.exec(relPath);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
    m = /^xl\/drawings\/vmlDrawing(\d+)\.vml$/.exec(relPath);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
    m = /^xl\/threadedComments\/threadedComment(\d+)\.xml$/.exec(relPath);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  });
  return max + 1;
}

function extractPartNumber(partPath: string): number {
  const m = /(\d+)\.[a-z]+$/i.exec(partPath);
  return m ? Number.parseInt(m[1], 10) : 1;
}

/** Creates a brand-new comments{N}.xml/vmlDrawing{N}.vml pair, wires the
 *  worksheet's own rels (comments relationship THEN vmlDrawing relationship)
 *  and `[Content_Types].xml`, and inserts `<legacyDrawing r:id="...">` as the
 *  worksheet's OWN LAST child element — restated explicitly (design review
 *  round 2, F4 — High): this exact rule was found and fixed once already for
 *  the retired legacy-Notes design and neither real reference fixture has a
 *  worksheet-level `<extLst>` to force a regression here to surface during
 *  ordinary testing (`synthetic-worksheet-with-extlst.xlsx` is the required
 *  fixture that does). `appendChild` satisfies this unconditionally
 *  regardless of whether an `<extLst>` is already the current last child. */
function createLegacyPair(archive: XlsxArchive, ctx: WorksheetContext, n: number): void {
  ctx.commentsPartPath = `xl/comments${n}.xml`;
  ctx.vmlPartPath = `xl/drawings/vmlDrawing${n}.vml`;
  ctx.commentsXmlOriginal = null;
  ctx.vmlXmlOriginal = null;
  ctx.commentsDoc = parseXml(EMPTY_COMMENTS_XML);
  ctx.vmlDoc = parseXml(EMPTY_VML_XML);

  let vmlDefaultEl = elementsByTag(archive.contentTypesDoc, 'Default').find(
    (el) => (el.getAttribute('Extension') ?? '').toLowerCase() === 'vml'
  );
  if (!vmlDefaultEl) {
    vmlDefaultEl = archive.contentTypesDoc.createElement('Default');
    setOrderedAttributes(vmlDefaultEl, [
      ['Extension', 'vml'],
      ['ContentType', VML_CONTENT_TYPE],
    ]);
    archive.contentTypesDoc.documentElement.appendChild(vmlDefaultEl);
  }
  const override = archive.contentTypesDoc.createElement('Override');
  setOrderedAttributes(override, [
    ['PartName', `/${ctx.commentsPartPath}`],
    ['ContentType', COMMENTS_CONTENT_TYPE],
  ]);
  vmlDefaultEl.parentNode?.insertBefore(override as unknown as Node, vmlDefaultEl.nextSibling);
  archive.contentTypesChanged = true;

  const worksheetDir = dirnameOfPart(ctx.partPath);
  const commentsRelId = nextRelId(ctx.relsDoc);
  addXlsxRelationship(ctx.relsDoc, commentsRelId, COMMENTS_REL_TYPE, relativizeTarget(worksheetDir, ctx.commentsPartPath));
  const vmlRelId = nextRelId(ctx.relsDoc);
  addXlsxRelationship(ctx.relsDoc, vmlRelId, VML_REL_TYPE, relativizeTarget(worksheetDir, ctx.vmlPartPath));
  ctx.relsChanged = true;

  const legacyDrawing = ctx.worksheetDoc.createElement('legacyDrawing');
  legacyDrawing.setAttribute('r:id', vmlRelId);
  ctx.worksheetDoc.documentElement.appendChild(legacyDrawing);
  ctx.worksheetChanged = true;
}

/** §4.2: the threadedComment/person relationships are BOTH "implicit" — no
 *  `r:id` anywhere in worksheet/workbook CONTENT ever points at either, so
 *  creating the threaded part needs only a rels entry + content-types
 *  Override, never any worksheet-content wiring beyond that (unlike
 *  vmlDrawing's explicit `<legacyDrawing r:id>`). */
function createThreadedPart(archive: XlsxArchive, ctx: WorksheetContext, n: number): void {
  ctx.threadedPartPath = `xl/threadedComments/threadedComment${n}.xml`;
  ctx.threadedXmlOriginal = null;
  ctx.threadedDoc = parseXml(EMPTY_THREADED_COMMENTS_XML);

  const worksheetDir = dirnameOfPart(ctx.partPath);
  const relId = nextRelId(ctx.relsDoc);
  addXlsxRelationship(ctx.relsDoc, relId, THREADED_COMMENT_REL_TYPE, relativizeTarget(worksheetDir, ctx.threadedPartPath));
  ctx.relsChanged = true;

  addContentTypeOverride(archive.contentTypesDoc, `/${ctx.threadedPartPath}`, THREADED_COMMENT_CONTENT_TYPE);
  archive.contentTypesChanged = true;
}

/** Ensures BOTH the legacy pair and the threaded part exist for `ctx`,
 *  minting a fresh shared `N` when neither exists yet, or reusing the
 *  EXISTING legacy pair's own `N` when only the threaded part is missing
 *  (§4.2: "`N`... is shared between `comments{N}.xml` and
 *  `threadedComment{N}.xml` for a given worksheet"). Called only
 *  immediately before the first thread is actually added to a worksheet —
 *  never speculatively. */
function ensureThreadedWiring(archive: XlsxArchive, ctx: WorksheetContext): void {
  if (!ctx.commentsDoc) {
    const n = mintPartNumber(archive);
    createLegacyPair(archive, ctx, n);
    createThreadedPart(archive, ctx, n);
  } else if (!ctx.threadedDoc) {
    const n = extractPartNumber(ctx.commentsPartPath!);
    createThreadedPart(archive, ctx, n);
  }
}

function ensurePersonsPart(archive: XlsxArchive): void {
  if (archive.personsDoc) return;
  archive.personsDoc = parseXml(EMPTY_PERSON_XML);
  archive.personsXmlOriginal = null;
  archive.personsChanged = true;

  const alreadyWired = elementsByTag(archive.workbookRelsDoc, 'Relationship').some((el) => el.getAttribute('Type') === PERSON_REL_TYPE);
  if (!alreadyWired) {
    const relId = nextRelId(archive.workbookRelsDoc);
    addXlsxRelationship(archive.workbookRelsDoc, relId, PERSON_REL_TYPE, relativizeTarget('xl', archive.personsPartPath));
    archive.workbookRelsChanged = true;
  }
  addContentTypeOverride(archive.contentTypesDoc, `/${archive.personsPartPath}`, PERSON_CONTENT_TYPE);
  archive.contentTypesChanged = true;
}

/** §4.2's own reuse-not-duplicate rule: before minting a new `<person>`, look
 *  for an existing entry with `providerId="YouCoded"` AND a matching
 *  `displayName` — only a genuine miss appends a new one with a freshly-
 *  minted GUID. `userId` is omitted (matching Google Sheets' own precedent —
 *  this app has no real account-linked identity to put there yet, §1.2). */
function resolveOrCreatePerson(archive: XlsxArchive, author: CommentAuthor): string {
  ensurePersonsPart(archive);
  const displayName = commentAuthorToDisplayName(author);
  const existing = elementsByLocalName(archive.personsDoc!, 'person').find(
    (el) => el.getAttribute('providerId') === 'YouCoded' && decodeXmlEntities(el.getAttribute('displayName') ?? '') === displayName
  );
  if (existing) {
    const id = existing.getAttribute('id');
    if (id) return id;
  }
  const id = mintGuid();
  const personEl = archive.personsDoc!.createElement('person');
  setOrderedAttributes(personEl, [
    ['displayName', displayName],
    ['id', id],
    ['providerId', 'YouCoded'],
  ]);
  archive.personsDoc!.documentElement.appendChild(personEl);
  archive.personsChanged = true;
  return id;
}

// -----------------------------------------------------------------------
// Thread lookup — root/reply element helpers, shared by read and write.
// -----------------------------------------------------------------------

function isRootThreadedComment(el: Element): boolean {
  return !el.getAttribute('parentId');
}

function repliesOfRoot(threadedDoc: Document, rootIdBraced: string): Element[] {
  const target = normalizeGuid(rootIdBraced);
  return elementsByLocalName(threadedDoc, 'threadedComment').filter(
    (el) => normalizeGuid(el.getAttribute('parentId') ?? '') === target
  );
}

function textOfThreadedComment(el: Element): string {
  const textEl = elementsByLocalName(el, 'text')[0];
  return textEl?.textContent ?? '';
}

function findRootByRefAndGuid(threadedDoc: Document, ref: string, guidNorm: string): Element | null {
  return (
    elementsByLocalName(threadedDoc, 'threadedComment').find(
      (el) => isRootThreadedComment(el) && el.getAttribute('ref') === ref && normalizeGuid(el.getAttribute('id') ?? '') === guidNorm
    ) ?? null
  );
}

function findAnyRootAtRef(threadedDoc: Document, ref: string): Element | null {
  return elementsByLocalName(threadedDoc, 'threadedComment').find((el) => isRootThreadedComment(el) && el.getAttribute('ref') === ref) ?? null;
}

function findRootsByGuid(threadedDoc: Document, guidNorm: string): Element[] {
  return elementsByLocalName(threadedDoc, 'threadedComment').filter(
    (el) => isRootThreadedComment(el) && normalizeGuid(el.getAttribute('id') ?? '') === guidNorm
  );
}

interface ThreadTarget {
  ctx: WorksheetContext;
  cell: string;
  rootEl: Element;
}

/** §4.2's corrected id-resolution algorithm (design review 1, F1; ambiguity
 *  refusal design review round 2, F3): (1) open the HINTED worksheet and
 *  match the embedded GUID against a root at the hinted `ref`; (2) on a
 *  miss, fall back to a full-workbook scan for a root whose `id` matches;
 *  (3) refuse `'comment-not-found'` only if NEITHER finds it, or
 *  `'ambiguous-comment-id'` if the FALLBACK scan finds more than one —
 *  never "the nth thread currently at this ref". */
async function resolveXlsxThreadTarget(
  archive: XlsxArchive,
  id: string
): Promise<{ ok: true; target: ThreadTarget } | { ok: false; error: 'comment-not-found' | 'ambiguous-comment-id' | 'ambiguous-comment-wiring' | 'archive-too-large' }> {
  const parsed = parseXlsxThreadId(id);
  if (!parsed) return { ok: false, error: 'comment-not-found' };
  const guidNorm = normalizeGuid(parsed.guid);

  const hintedSheet = archive.sheets.find((s) => s.sheetId === parsed.sheetId && !s.isChartsheet);
  if (hintedSheet) {
    const ctxResult = await getWorksheetContext(archive, hintedSheet);
    if (!ctxResult.ok) {
      if (ctxResult.error === 'archive-too-large') return { ok: false, error: 'archive-too-large' };
      // 'invalid-selector' here means the worksheet part itself is missing —
      // fall through to the workbook-wide scan below rather than failing
      // outright, since the hint is only ever a locate-first shortcut.
    } else {
      const ctx = ctxResult.ctx;
      if (ctx.ambiguous) return { ok: false, error: 'ambiguous-comment-wiring' };
      if (ctx.threadedDoc) {
        const hit = findRootByRefAndGuid(ctx.threadedDoc, parsed.cell, guidNorm);
        if (hit) return { ok: true, target: { ctx, cell: parsed.cell, rootEl: hit } };
      }
    }
  }

  const matches: ThreadTarget[] = [];
  for (const sheetMeta of archive.sheets) {
    if (sheetMeta.isChartsheet) continue;
    const ctxResult = await getWorksheetContext(archive, sheetMeta);
    if (!ctxResult.ok) {
      if (ctxResult.error === 'archive-too-large') return { ok: false, error: 'archive-too-large' };
      continue;
    }
    const ctx = ctxResult.ctx;
    if (ctx.ambiguous || !ctx.threadedDoc) continue;
    for (const rootEl of findRootsByGuid(ctx.threadedDoc, guidNorm)) {
      matches.push({ ctx, cell: rootEl.getAttribute('ref') ?? '', rootEl });
    }
  }
  if (matches.length === 0) return { ok: false, error: 'comment-not-found' };
  if (matches.length > 1) return { ok: false, error: 'ambiguous-comment-id' };
  return { ok: true, target: matches[0] };
}

/** §4.2's own rule: `sheet` is required only when the workbook has more than
 *  one (non-chartsheet) tab. Reused identically by add's `selector` and
 *  move's `newSelector`. */
async function resolveWorksheetForSelector(
  archive: XlsxArchive,
  sel: CellSelector
): Promise<{ ok: true; ctx: WorksheetContext } | { ok: false; error: 'sheet-not-found' | 'invalid-selector' | 'ambiguous-comment-wiring' | 'archive-too-large' }> {
  if (!isValidCellAddress(sel.cell)) return { ok: false, error: 'invalid-selector' };
  const realSheets = archive.sheets.filter((s) => !s.isChartsheet);
  let sheetMeta: SheetMeta;
  if (sel.sheet) {
    const match = realSheets.find((s) => s.name === sel.sheet);
    if (!match) return { ok: false, error: 'sheet-not-found' };
    sheetMeta = match;
  } else {
    if (realSheets.length !== 1) return { ok: false, error: 'invalid-selector' };
    sheetMeta = realSheets[0];
  }
  const ctxResult = await getWorksheetContext(archive, sheetMeta);
  if (!ctxResult.ok) {
    if (ctxResult.error === 'archive-too-large') return ctxResult;
    return { ok: false, error: 'invalid-selector' };
  }
  if (ctxResult.ctx.ambiguous) return { ok: false, error: 'ambiguous-comment-wiring' };
  return { ok: true, ctx: ctxResult.ctx };
}

/** Removes a thread's root+replies from `ctx.threadedDoc`, its ONE legacy
 *  `<comment>` from `ctx.commentsDoc`, and its `<v:shape>` from `ctx.vmlDoc`
 *  (matched by `<x:Row>`/`<x:Column>`, the same 0-based pair every legacy-
 *  note-writing tool writes into `<x:ClientData>`) — used only by Move, to
 *  vacate the OLD `[sheet, cell]` pair. */
function removeThreadFromWorksheet(ctx: WorksheetContext, cell: string, rootEl: Element): void {
  const rootId = rootEl.getAttribute('id') ?? '';
  for (const reply of repliesOfRoot(ctx.threadedDoc!, rootId)) {
    reply.parentNode?.removeChild(reply as unknown as Node);
  }
  rootEl.parentNode?.removeChild(rootEl as unknown as Node);
  ctx.threadedChanged = true;

  const commentEl = ctx.commentsDoc ? findTcComment(ctx.commentsDoc, rootId) : null;
  if (commentEl) {
    commentEl.parentNode?.removeChild(commentEl as unknown as Node);
    ctx.commentsChanged = true;
  }
  const { col, row } = parseCellRef(cell);
  const zeroRow = String(row - 1);
  const zeroCol = String(col - 1);
  if (ctx.vmlDoc) {
    for (const shape of elementsByTag(ctx.vmlDoc, 'v:shape')) {
      const clientData = elementsByTag(shape, 'x:ClientData')[0];
      if (!clientData) continue;
      const rowEl = elementsByTag(clientData, 'x:Row')[0];
      const colEl = elementsByTag(clientData, 'x:Column')[0];
      if (rowEl?.textContent === zeroRow && colEl?.textContent === zeroCol) {
        shape.parentNode?.removeChild(shape as unknown as Node);
        ctx.vmlChanged = true;
        break;
      }
    }
  }
}

interface ThreadSnapshotReply {
  id: string;
  personId: string;
  dT: string;
  text: string;
}

interface ThreadSnapshot {
  id: string;
  personId: string;
  dT: string;
  done: boolean;
  text: string;
  replies: ThreadSnapshotReply[];
}

function snapshotThread(ctx: WorksheetContext, rootEl: Element): ThreadSnapshot {
  const rootId = rootEl.getAttribute('id') ?? '';
  const replies = repliesOfRoot(ctx.threadedDoc!, rootId)
    .slice()
    .sort((a, b) => parseThreadedDate(a.getAttribute('dT') ?? '') - parseThreadedDate(b.getAttribute('dT') ?? ''))
    .map((r) => ({
      id: r.getAttribute('id') ?? '',
      personId: r.getAttribute('personId') ?? '',
      dT: r.getAttribute('dT') ?? '',
      text: textOfThreadedComment(r),
    }));
  return {
    id: rootId,
    personId: rootEl.getAttribute('personId') ?? '',
    dT: rootEl.getAttribute('dT') ?? '',
    done: rootEl.getAttribute('done') === '1',
    text: textOfThreadedComment(rootEl),
    replies,
  };
}

/** Appends a `<threadedComment>` element (root or reply) matching the target
 *  document's own namespace-prefix convention (§4.2's own load-bearing
 *  finding — a brand-new part always uses the default-namespace convention,
 *  since `ensureThreadedWiring` always mints one from `EMPTY_THREADED_COMMENTS_XML`). */
function appendThreadedElement(
  threadedDoc: Document,
  attrs: { ref: string; dT: string; personId: string; id: string; parentId?: string; done?: boolean },
  text: string
): void {
  const prefix = detectPrefix(threadedDoc);
  const el = threadedDoc.createElement(tcTag(prefix, 'threadedComment'));
  const orderedAttrs: Array<[string, string]> = [
    ['ref', attrs.ref],
    ['dT', attrs.dT],
    ['personId', attrs.personId],
    ['id', attrs.id],
  ];
  if (attrs.parentId) orderedAttrs.push(['parentId', attrs.parentId]);
  if (attrs.done) orderedAttrs.push(['done', '1']);
  setOrderedAttributes(el, orderedAttrs);
  const textEl = threadedDoc.createElement(tcTag(prefix, 'text'));
  textEl.textContent = text;
  el.appendChild(textEl);
  threadedDoc.documentElement.appendChild(el);
}

/** Re-runs `ensureThreadedWiring`, appends `snapshot`'s root+replies verbatim
 *  (SAME ids/personIds/timestamps/text/done state — §3.3/§4.3a's own "never
 *  minting fresh GUIDs on a move" rule), the matching legacy placeholder
 *  (a FRESH `authorId` in the destination file's own `<authors>` list, since
 *  author indices are per-file, but the SAME `tc={root id}` string), and a
 *  fresh `<v:shape>` at the new cell. Used by both Add (a `snapshot` with no
 *  replies) and Move. */
function insertThreadIntoWorksheet(archive: XlsxArchive, ctx: WorksheetContext, cell: string, snapshot: ThreadSnapshot): void {
  ensureThreadedWiring(archive, ctx);

  appendThreadedElement(
    ctx.threadedDoc!,
    { ref: cell, dT: snapshot.dT, personId: snapshot.personId, id: snapshot.id, done: snapshot.done },
    snapshot.text
  );
  ctx.threadedChanged = true;
  for (const reply of snapshot.replies) {
    appendThreadedElement(ctx.threadedDoc!, { ref: cell, dT: reply.dT, personId: reply.personId, id: reply.id, parentId: snapshot.id }, reply.text);
  }

  const authorIdx = appendTcAuthor(ctx.commentsDoc!, snapshot.id);
  const body = buildPlaceholderBody(
    snapshot.text,
    snapshot.replies.map((r) => r.text)
  );
  appendPlaceholderComment(ctx.commentsDoc!, cell, authorIdx, snapshot.id, body);
  ctx.commentsChanged = true;

  const { col, row } = parseCellRef(cell);
  const shape = buildThreadedVmlShape(ctx.vmlDoc!, nextVmlShapeId(ctx.vmlDoc!), col, row);
  ctx.vmlDoc!.documentElement.appendChild(shape);
  ctx.vmlChanged = true;
}

function serializeXlsxArchive(archive: XlsxArchive): Promise<Buffer> {
  if (archive.contentTypesChanged) {
    writeXlsxPart(archive.zip, '[Content_Types].xml', true, archive.contentTypesDoc, archive.contentTypesXmlOriginal);
  }
  if (archive.workbookRelsChanged) {
    writeXlsxPart(archive.zip, 'xl/_rels/workbook.xml.rels', true, archive.workbookRelsDoc, archive.workbookRelsXmlOriginal);
  }
  if (archive.personsChanged && archive.personsDoc) {
    writeXlsxPart(archive.zip, archive.personsPartPath, true, archive.personsDoc, archive.personsXmlOriginal);
  }
  for (const ctx of archive.worksheetContexts.values()) {
    if (ctx.worksheetChanged) writeXlsxPart(archive.zip, ctx.partPath, true, ctx.worksheetDoc, ctx.worksheetXmlOriginal);
    if (ctx.relsChanged) writeXlsxPart(archive.zip, ctx.relsPartPath, true, ctx.relsDoc, ctx.relsXmlOriginal);
    if (ctx.commentsChanged && ctx.commentsDoc && ctx.commentsPartPath) {
      writeXlsxPart(archive.zip, ctx.commentsPartPath, true, ctx.commentsDoc, ctx.commentsXmlOriginal);
    }
    if (ctx.vmlChanged && ctx.vmlDoc && ctx.vmlPartPath) {
      writeXlsxPart(archive.zip, ctx.vmlPartPath, true, ctx.vmlDoc, ctx.vmlXmlOriginal);
    }
    if (ctx.threadedChanged && ctx.threadedDoc && ctx.threadedPartPath) {
      writeXlsxPart(archive.zip, ctx.threadedPartPath, true, ctx.threadedDoc, ctx.threadedXmlOriginal);
    }
  }
  // Every OTHER part in the archive — styles, shared strings, other
  // worksheets, docProps/*, xl/externalLinks/*, images, a genuine Note
  // elsewhere in the same file, everything — was never read into a Document
  // at all and is never `zip.file()`d again here, so JSZip's own
  // generateAsync passthrough emits its ORIGINAL bytes unchanged.
  return archive.zip.generateAsync({ type: 'nodebuffer' });
}

// -----------------------------------------------------------------------
// Read (T12) — hand-rolled JSZip + linkedom parse of
// xl/threadedComments/threadedComment{N}.xml + xl/persons/person.xml.
// -----------------------------------------------------------------------

/**
 * Reads every Excel THREADED comment out of a `.xlsx`'s raw bytes into
 * `PersistedComment`-shaped thread records — never exceljs, never a legacy
 * Note (§4.1). `path` is the file's own (project-relative) path, stamped
 * onto each returned record the same way docx-comments.ts's own
 * `readDocxComments` does.
 *
 * A workbook with ONLY genuine Notes (no threaded comments at all) returns
 * an EMPTY list, not the garbled pseudo-comment the retired exceljs-based
 * reader produced for this exact shape (§4.1) — this module never opens a
 * legacy `commentsN.xml` at all during a read, since nothing in it
 * contributes information not already in the real threadedComment part; a
 * worksheet with no `threadedComment` relationship simply contributes no
 * records.
 */
export async function readXlsxComments(bytes: Uint8Array | Buffer, path: string): Promise<XlsxReadResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { ok: false, error: 'invalid-xlsx' };
  }

  const workbookFile = zip.file('xl/workbook.xml');
  if (!workbookFile) return { ok: false, error: 'invalid-xlsx' };
  const sizeCheck0 = checkNamedEntriesWithinCeiling(zip, ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels']);
  if (!sizeCheck0.ok) return { ok: false, error: sizeCheck0.error };

  let workbookXml: string;
  let workbookRelsXml: string;
  try {
    const workbookRelsFile = zip.file('xl/_rels/workbook.xml.rels');
    [workbookXml, workbookRelsXml] = await Promise.all([
      workbookFile.async('string'),
      workbookRelsFile ? workbookRelsFile.async('string') : Promise.resolve(EMPTY_RELS_XML),
    ]);
  } catch {
    return { ok: false, error: 'invalid-xlsx' };
  }

  const sheets = parseSheetsFromWorkbook(workbookXml, workbookRelsXml);
  const realSheets = sheets.filter((s) => !s.isChartsheet);
  const singleSheet = realSheets.length <= 1;
  const workbookRelsDoc = parseXml(workbookRelsXml);

  // Person map, resolved once at workbook level (§4.2).
  const personMap = new Map<string, string>();
  const personRel = elementsByTag(workbookRelsDoc, 'Relationship').find((el) => el.getAttribute('Type') === PERSON_REL_TYPE);
  if (personRel) {
    const personPath = resolveRelTarget('xl', personRel.getAttribute('Target') ?? '');
    const personRead = await readOptionalPart(zip, personPath);
    if (!personRead.ok) return personRead;
    if (personRead.text !== null) {
      const personDoc = parseXml(personRead.text);
      for (const el of elementsByLocalName(personDoc, 'person')) {
        const id = el.getAttribute('id');
        if (id) personMap.set(normalizeGuid(id), decodeXmlEntities(el.getAttribute('displayName') ?? ''));
      }
    }
  }

  let totalRecords = 0;
  const comments: PersistedComment[] = [];

  for (const sheetMeta of realSheets) {
    const relsPath = worksheetRelsPathFor(sheetMeta.partPath);
    const relsRead = await readOptionalPart(zip, relsPath);
    if (!relsRead.ok) return relsRead;
    if (relsRead.text === null) continue;
    const relsDoc = parseXml(relsRead.text);
    const threadedRel = elementsByTag(relsDoc, 'Relationship').find((el) => el.getAttribute('Type') === THREADED_COMMENT_REL_TYPE);
    if (!threadedRel) continue;
    const threadedPath = resolveRelTarget(dirnameOfPart(sheetMeta.partPath), threadedRel.getAttribute('Target') ?? '');
    const threadedRead = await readOptionalPart(zip, threadedPath);
    if (!threadedRead.ok) return threadedRead;
    if (threadedRead.text === null) continue; // dangling relationship — skip this sheet rather than fail the whole read

    const threadedDoc = parseXml(threadedRead.text);
    const all = elementsByLocalName(threadedDoc, 'threadedComment');
    totalRecords += all.length;
    if (totalRecords > MAX_COMMENT_RECORDS) return { ok: false, error: 'too-many-comments' };

    const repliesByRoot = new Map<string, Element[]>();
    const roots: Element[] = [];
    for (const el of all) {
      const parentId = el.getAttribute('parentId');
      if (parentId) {
        const key = normalizeGuid(parentId);
        const list = repliesByRoot.get(key) ?? [];
        list.push(el);
        repliesByRoot.set(key, list);
      } else {
        roots.push(el);
      }
    }

    for (const rootEl of roots) {
      const rootId = rootEl.getAttribute('id') ?? '';
      const ref = rootEl.getAttribute('ref') ?? '';
      const personId = rootEl.getAttribute('personId') ?? '';
      const dT = rootEl.getAttribute('dT') ?? '';
      const resolved = rootEl.getAttribute('done') === '1';
      const text = textOfThreadedComment(rootEl);
      const replyEls = (repliesByRoot.get(normalizeGuid(rootId)) ?? [])
        .slice()
        .sort((a, b) => parseThreadedDate(a.getAttribute('dT') ?? '') - parseThreadedDate(b.getAttribute('dT') ?? ''));

      const appId = buildXlsxThreadId(sheetMeta.sheetId, ref, rootId);
      const replies: CommentReply[] = replyEls.map((r, i) => ({
        id: `${appId}-r${i + 1}`,
        author: toCommentAuthor(personMap.get(normalizeGuid(r.getAttribute('personId') ?? '')) ?? 'Unknown'),
        text: textOfThreadedComment(r),
        createdAt: parseThreadedDate(r.getAttribute('dT') ?? ''),
      }));

      const cellSelector: CellSelector = {
        type: 'CellSelector',
        cell: ref,
        ...(singleSheet ? {} : { sheet: sheetMeta.name }),
      };

      comments.push({
        id: appId,
        path,
        selector: { kind: 'cell', selector: cellSelector },
        text,
        author: toCommentAuthor(personMap.get(normalizeGuid(personId)) ?? 'Unknown'),
        createdAt: parseThreadedDate(dT),
        replies,
        resolved,
        // A threaded comment's OOXML has no separate resolve/reopen AUDIT
        // TRAIL — only the current `done` bit. Same reasoning as
        // docx-comments.ts's own read path: `history` starts empty on a
        // freshly-read native comment.
        history: [],
      });
    }
  }

  return { ok: true, comments };
}

// =============================================================================
// Write (T13) — surgical add/reply/resolve/reopen/move, mirroring docx's §3.3.
// =============================================================================

// Not exported: same knip convention as `XlsxReadError` above.
//
// 'comment-not-found': a reply/resolve/reopen/move `id` that can't be
//   resolved to a real thread root (hinted lookup AND full-workbook fallback
//   both miss).
// 'ambiguous-comment-id' (design review round 2, F3): the fallback scan found
//   MORE than one root sharing the embedded GUID — never silently acted on
//   scan order.
// 'invalid-selector': add's `selector` (or move's `newSelector`) isn't a
//   `kind: 'cell'` selector, names a malformed cell reference, or omits
//   `sheet` on a workbook with more than one tab.
// 'sheet-not-found': a named `sheet` doesn't exist in the workbook (or names
//   a chartsheet, which never carries cell comments).
// 'cell-has-note' (§4.1): the target cell already carries a GENUINE
//   (non-`tc=`) Note — this app's own policy, refused rather than layered on
//   top of it (Excel's own engine behavior here is unverified either way).
// 'cell-already-has-comment' (§4.2's own one-thread-per-cell WRITE policy):
//   `add` targeted a cell that already carries ANY thread (resolved or not)
//   — a real file's cell can carry several independent threads, but THIS
//   app's own "Add comment" always offers reply-to-the-existing-thread
//   instead, mirroring Excel's everyday UI.
// 'destination-cell-occupied': `move`'s `newSelector` names a DIFFERENT cell
//   that already carries its OWN thread.
// 'ambiguous-comment-wiring': the target worksheet's own legacy comments/vml/
//   legacyDrawing/threadedComment wiring is a partial or inconsistent
//   combination no real Excel/Google-Sheets writer produces.
// 'file-open-elsewhere' (design review round 3, F4 — §3.3 step 0, shared by
//   write-pipeline.ts): a real Word/Excel/LibreOffice owner/lock file sits
//   beside the target — inherited for free via the shared pipeline entry
//   point, no separate implementation needed here.
type XlsxWriteError =
  | XlsxReadError
  | 'comment-not-found'
  | 'ambiguous-comment-id'
  | 'invalid-selector'
  | 'sheet-not-found'
  | 'cell-has-note'
  | 'cell-already-has-comment'
  | 'destination-cell-occupied'
  | 'ambiguous-comment-wiring'
  | 'read-failed'
  | 'backup-failed'
  | 'write-failed'
  | 'verify-failed'
  | 'file-open-elsewhere';

export type XlsxWriteResult<Extra extends Record<string, unknown> = {}> = ({ ok: true } & Extra) | { ok: false; error: XlsxWriteError };

type XlsxErrorResult = { ok: false; error: XlsxWriteError };
type XlsxMutateResult<Extra extends Record<string, unknown>> = ({ ok: true } & Extra) | XlsxErrorResult;

const XLSX_BACKUP_SUFFIX = '.xlsx.bak';

async function mutateAddXlsxComment(
  currentBytes: Buffer,
  args: { selector: CommentSelector; text: string; author: CommentAuthor }
): Promise<XlsxMutateResult<{ bytes: Buffer; id: string }>> {
  if (args.selector.kind !== 'cell') return { ok: false, error: 'invalid-selector' };
  const loaded = await loadXlsxArchiveForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { archive } = loaded;

  const wsResult = await resolveWorksheetForSelector(archive, args.selector.selector);
  if (!wsResult.ok) return wsResult;
  const ctx = wsResult.ctx;
  const cellAddr = args.selector.selector.cell;

  if (ctx.threadedDoc && findAnyRootAtRef(ctx.threadedDoc, cellAddr)) {
    return { ok: false, error: 'cell-already-has-comment' };
  }
  if (ctx.commentsDoc && findGenuineNoteAtCell(ctx.commentsDoc, cellAddr)) {
    return { ok: false, error: 'cell-has-note' };
  }

  const personId = resolveOrCreatePerson(archive, args.author);
  const snapshot: ThreadSnapshot = {
    id: mintGuid(),
    personId,
    dT: formatThreadedDate(new Date()),
    done: false,
    text: args.text,
    replies: [],
  };
  insertThreadIntoWorksheet(archive, ctx, cellAddr, snapshot);

  const bytes = await serializeXlsxArchive(archive);
  return { ok: true, bytes, id: buildXlsxThreadId(ctx.sheetId, cellAddr, snapshot.id) };
}

async function mutateReplyToXlsxComment(
  currentBytes: Buffer,
  args: { id: string; text: string; author: CommentAuthor }
): Promise<XlsxMutateResult<{ bytes: Buffer }>> {
  const loaded = await loadXlsxArchiveForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { archive } = loaded;
  const found = await resolveXlsxThreadTarget(archive, args.id);
  if (!found.ok) return found;
  const { ctx, cell, rootEl } = found.target;

  const rootId = rootEl.getAttribute('id') ?? '';
  const ref = rootEl.getAttribute('ref') ?? cell;
  const personId = resolveOrCreatePerson(archive, args.author);
  const replyId = mintGuid();
  appendThreadedElement(
    ctx.threadedDoc!,
    { ref, dT: formatThreadedDate(new Date()), personId, id: replyId, parentId: rootId },
    args.text
  );
  ctx.threadedChanged = true;

  // §4.2: the placeholder is rebuilt WHOLE from the thread's current full
  // transcript — read the (now-updated) reply list straight back off
  // `threadedDoc` rather than tracking it separately, so this can never
  // disagree with what was just appended above.
  const replies = repliesOfRoot(ctx.threadedDoc!, rootId)
    .slice()
    .sort((a, b) => parseThreadedDate(a.getAttribute('dT') ?? '') - parseThreadedDate(b.getAttribute('dT') ?? ''))
    .map((r) => textOfThreadedComment(r));
  const commentEl = ctx.commentsDoc ? findTcComment(ctx.commentsDoc, rootId) : null;
  if (commentEl && ctx.commentsDoc) {
    setXlsxCommentBody(ctx.commentsDoc, commentEl, buildPlaceholderBody(textOfThreadedComment(rootEl), replies));
    ctx.commentsChanged = true;
  }

  const bytes = await serializeXlsxArchive(archive);
  return { ok: true, bytes };
}

async function mutateSetResolvedXlsx(
  currentBytes: Buffer,
  args: { id: string },
  done: boolean
): Promise<XlsxMutateResult<{ bytes: Buffer }>> {
  const loaded = await loadXlsxArchiveForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { archive } = loaded;
  const found = await resolveXlsxThreadTarget(archive, args.id);
  if (!found.ok) return found;
  const { ctx, rootEl } = found.target;

  // §4.2: `done` lives ONLY on the root element, and this app OMITS the
  // attribute entirely on reopen (never writes `done="0"`) — never touching
  // the legacy placeholder, which never reflects resolve state at all.
  if (done) rootEl.setAttribute('done', '1');
  else rootEl.removeAttribute('done');
  ctx.threadedChanged = true;

  const bytes = await serializeXlsxArchive(archive);
  return { ok: true, bytes };
}

async function mutateMoveXlsxComment(
  currentBytes: Buffer,
  args: { id: string; newSelector: CommentSelector }
): Promise<XlsxMutateResult<{ bytes: Buffer }>> {
  if (args.newSelector.kind !== 'cell') return { ok: false, error: 'invalid-selector' };
  const loaded = await loadXlsxArchiveForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { archive } = loaded;

  const found = await resolveXlsxThreadTarget(archive, args.id);
  if (!found.ok) return found;
  const { ctx: oldCtx, cell: oldCell, rootEl } = found.target;
  // §4.3a: read the OLD cell's thread data VERBATIM before touching
  // anything — reused, never re-minted, at the new location.
  const snapshot = snapshotThread(oldCtx, rootEl);

  const wsResult = await resolveWorksheetForSelector(archive, args.newSelector.selector);
  if (!wsResult.ok) return wsResult;
  const newCtx = wsResult.ctx;
  const newCell = args.newSelector.selector.cell;

  const isSameCell = newCtx.partPath === oldCtx.partPath && newCell === oldCell;
  if (!isSameCell && newCtx.threadedDoc) {
    const existingAtDest = findAnyRootAtRef(newCtx.threadedDoc, newCell);
    if (existingAtDest) return { ok: false, error: 'destination-cell-occupied' };
  }
  if (!isSameCell && newCtx.commentsDoc && findGenuineNoteAtCell(newCtx.commentsDoc, newCell)) {
    return { ok: false, error: 'cell-has-note' };
  }

  removeThreadFromWorksheet(oldCtx, oldCell, rootEl);
  insertThreadIntoWorksheet(archive, newCtx, newCell, snapshot);

  const bytes = await serializeXlsxArchive(archive);
  return { ok: true, bytes };
}

// -----------------------------------------------------------------------
// Public orchestration — one per operation, each wiring its own mutate +
// verify into `writeFileMutation`. `absolutePath` is the already-
// containment-verified real file path (doc-comments-dispatch.ts resolves
// it); `path` is the caller's project-relative (or fallback-absolute) path,
// stamped onto `PersistedComment.path` — needed here only to re-run this
// module's own reader during verification.
// -----------------------------------------------------------------------

export async function addXlsxComment(args: {
  absolutePath: string;
  path: string;
  selector: CommentSelector;
  text: string;
  author: CommentAuthor;
}): Promise<XlsxWriteResult<{ id: string }>> {
  return writeFileMutation<{ id: string }, XlsxErrorResult>(
    args.absolutePath,
    XLSX_BACKUP_SUFFIX,
    (bytes) => mutateAddXlsxComment(bytes, args),
    async (newBytes, extra) => {
      const result = await readXlsxComments(newBytes, args.path);
      if (!result.ok) return false;
      const added = result.comments.find((c) => c.id === extra.id);
      return !!added && added.text === args.text && added.replies.length === 0;
    }
  );
}

export async function replyToXlsxComment(args: {
  absolutePath: string;
  path: string;
  id: string;
  text: string;
  author: CommentAuthor;
}): Promise<XlsxWriteResult> {
  return writeFileMutation<{}, XlsxErrorResult>(
    args.absolutePath,
    XLSX_BACKUP_SUFFIX,
    (bytes) => mutateReplyToXlsxComment(bytes, args),
    async (newBytes) => {
      const result = await readXlsxComments(newBytes, args.path);
      if (!result.ok) return false;
      const target = findByThreadIdPrefix(result.comments, args.id);
      return !!target && target.replies.some((r) => r.text === args.text);
    }
  );
}

/** `by` (§1.6's generic `{path, id, by}` payload) is accepted for call-site
 *  symmetry with the sidecar store's own `resolveComment`/`reopenComment` and
 *  docx-comments.ts's own `resolveDocxComment`, but deliberately UNUSED here:
 *  a threaded comment's resolve/reopen has no separate audit trail — only the
 *  current `done` bit exists in the file itself. */
export async function resolveXlsxComment(args: { absolutePath: string; path: string; id: string }): Promise<XlsxWriteResult> {
  return writeFileMutation<{}, XlsxErrorResult>(
    args.absolutePath,
    XLSX_BACKUP_SUFFIX,
    (bytes) => mutateSetResolvedXlsx(bytes, args, true),
    async (newBytes) => {
      const result = await readXlsxComments(newBytes, args.path);
      if (!result.ok) return false;
      const target = findByThreadIdPrefix(result.comments, args.id);
      return !!target && target.resolved === true;
    }
  );
}

export async function reopenXlsxComment(args: { absolutePath: string; path: string; id: string }): Promise<XlsxWriteResult> {
  return writeFileMutation<{}, XlsxErrorResult>(
    args.absolutePath,
    XLSX_BACKUP_SUFFIX,
    (bytes) => mutateSetResolvedXlsx(bytes, args, false),
    async (newBytes) => {
      const result = await readXlsxComments(newBytes, args.path);
      if (!result.ok) return false;
      const target = findByThreadIdPrefix(result.comments, args.id);
      return !!target && target.resolved === false;
    }
  );
}

export async function moveXlsxComment(args: {
  absolutePath: string;
  path: string;
  id: string;
  newSelector: CommentSelector;
}): Promise<XlsxWriteResult> {
  return writeFileMutation<{}, XlsxErrorResult>(
    args.absolutePath,
    XLSX_BACKUP_SUFFIX,
    (bytes) => mutateMoveXlsxComment(bytes, args),
    async (newBytes) => {
      if (args.newSelector.kind !== 'cell') return false;
      const result = await readXlsxComments(newBytes, args.path);
      if (!result.ok) return false;
      const target = findByThreadIdPrefix(result.comments, args.id);
      if (!target || target.selector.kind !== 'cell') return false;
      const wantSheet = args.newSelector.selector.sheet;
      const gotSheet = target.selector.selector.sheet;
      return target.selector.selector.cell === args.newSelector.selector.cell && (wantSheet ?? '') === (gotSheet ?? '');
    }
  );
}

/** A move changes the id's own embedded CELL (the hint), so the id a caller
 *  passed to `moveXlsxComment` no longer matches any record after a
 *  successful move — verification instead matches by the id's own embedded
 *  GUID suffix, which a move never changes (§4.2: "never minting fresh
 *  GUIDs on a move"). Also used by reply/resolve/reopen's own verify step
 *  (there the id genuinely is unchanged, so this is equivalent to an exact
 *  match, just expressed once). */
function findByThreadIdPrefix(comments: readonly PersistedComment[], id: string): PersistedComment | undefined {
  const parsed = parseXlsxThreadId(id);
  if (!parsed) return undefined;
  const guidNorm = normalizeGuid(parsed.guid);
  return comments.find((c) => {
    const p = parseXlsxThreadId(c.id);
    return !!p && normalizeGuid(p.guid) === guidNorm;
  });
}
