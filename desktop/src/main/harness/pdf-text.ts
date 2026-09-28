// PDF text extraction for the native Read tool (ledger G-6, 2026-08-27).
//
// WHY a separate module instead of more branches in read.ts: read.ts is edited
// by several concurrent efforts; everything PDF-shaped lives here so Read only
// gains ONE call site. Runs in the Electron MAIN process, so the memory rules
// below are load-bearing — see the 2026-08-27 sidecar OOM investigation
// (docs/active/investigations/2026-08-27-artifacts-sidecar-oom-crash.md): N
// simultaneous parses of one file killed the app. Here every extraction is
// serialized through one module-level promise chain, pages are cleaned up as
// they are read, and the document is destroyed in `finally`.
import * as fs from 'fs';
import * as path from 'path';
import type { ToolResultPayload } from './tools/types';

// pdfjs-dist is already a dependency (the renderer's PdfView uses it). The
// LEGACY build is the one that runs in plain Node without a DOM. It is ESM-only;
// the main process is CommonJS, so we load it lazily with a dynamic import on
// the first PDF read (tsc rewrites this to a require(), which Electron 41's
// Node 24 accepts for ESM — verified 2026-08-27 with ELECTRON_RUN_AS_NODE).
// Typed against the package's public types; the legacy build exports the same
// API surface.
type PdfJs = typeof import('pdfjs-dist');
let pdfjsLoad: Promise<PdfJs> | undefined;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsLoad ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJs>;
  return pdfjsLoad;
}

/** Where pdf.js finds its bundled standard fonts + CMaps. Without these it
 *  still extracts text but logs a warning per missing font. Resolved at call
 *  time from the package location so it works from a dev checkout AND from a
 *  packaged app (the dirs are `asarUnpack`ed in electron-builder.yml).
 *
 *  THE TRAILING SLASH MUST BE A FORWARD SLASH, on every platform. pdf.js calls
 *  these "factory urls" and validates them inside getDocument():
 *  `if (val.endsWith("/")) return val;` — otherwise it throws
 *  `Invalid factory url: "…" must include trailing slash.` This used to append
 *  `path.sep`, which is `\` on Windows, so the check failed and EVERY PDF read
 *  on Windows threw before a single byte was parsed. It was visible the whole
 *  time as ten red tests in read-pdf.test.ts on the Windows CI leg, filed as
 *  part of a "pre-existing Windows redness" note and never traced (fixed
 *  2026-08-28).
 *
 *  A forward slash is correct on Windows too: in Node, pdf.js resolves the
 *  concatenated string with `fs.readFile` (node_utils_fetchData), not with a
 *  URL parser, and Windows accepts mixed separators — so
 *  `C:\...\standard_fonts/FoxitSans.pfb` opens exactly like the backslash
 *  form. Only the trailing character is contractual. */
export function pdfjsAssetDirs(): { standardFontDataUrl?: string; cMapUrl?: string } {
  try {
    const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
    // pdf.js concatenates these with a file name, so the trailing slash matters.
    return {
      standardFontDataUrl: path.join(root, 'standard_fonts') + '/',
      cMapUrl: path.join(root, 'cmaps') + '/',
    };
  } catch {
    return {};
  }
}

/** Pages returned when the caller gives no `pages` argument. */
export const DEFAULT_PDF_PAGES = 10;
/** Widest range one call may ask for. */
export const MAX_PDF_PAGES_PER_CALL = 20;
/** A page with fewer non-whitespace characters than this is "no text layer" —
 *  a scanned image, or a blank page. A stray page number alone stays under it. */
const MIN_TEXT_CHARS = 20;

// ---------------------------------------------------------------------------
// Serialization: never two extractions at once.
// ---------------------------------------------------------------------------
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  // Each call waits for the previous one to settle (success OR failure), then
  // runs. The chain itself swallows rejections so one bad PDF never wedges
  // every later read; the caller still gets its own rejection through `p`.
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

// ---------------------------------------------------------------------------
// `pages` argument
// ---------------------------------------------------------------------------
export type PageRange = { from: number; to: number };

/** Parse `"3"` or `"1-5"`. Returns a range or a specific error sentence. Does
 *  NOT know the document length — the past-the-end check happens after open. */
export function parsePagesArg(pages: string): PageRange | { error: string } {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(pages);
  if (!m) return { error: `pages must be a page number or a range like "3" or "1-5" (got "${pages}").` };
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from < 1) return { error: `pages="${pages}": pages are numbered from 1.` };
  if (to < from) return { error: `pages="${pages}": the range end is before its start.` };
  if (to - from + 1 > MAX_PDF_PAGES_PER_CALL) {
    return { error: `pages="${pages}" spans ${to - from + 1} pages; max ${MAX_PDF_PAGES_PER_CALL} per call.` };
  }
  return { from, to };
}

/** "3", "3–5", "3–5 and 9", "2, 4 and 6" — human page lists for the note. */
function describePageRuns(pages: number[]): string {
  const runs: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    runs.push(j === i ? String(pages[i]) : `${pages[i]}–${pages[j]}`);
    i = j + 1;
  }
  if (runs.length <= 1) return runs[0] ?? '';
  return `${runs.slice(0, -1).join(', ')} and ${runs[runs.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
interface Extracted {
  totalPages: number;
  range: PageRange;
  pages: Array<{ page: number; text: string }>;
}

async function extract(absPath: string, requested: PageRange | undefined): Promise<Extracted> {
  const pdfjs = await loadPdfJs();
  // pdf.js takes ownership of (detaches) the buffer it is handed, so give it
  // its own copy rather than a view that anything else might still hold.
  // WHY async (2026-09-24 blocking-calls B8): a whole PDF read synchronously
  // froze every window for the length of the read on each Read of a .pdf.
  // Still inside serialized(), so at most one PDF's bytes are in flight.
  const data = new Uint8Array(await fs.promises.readFile(absPath));
  const task = pdfjs.getDocument({
    data,
    // No probing the OS for fonts, no console chatter — we only want the text
    // layer. (pdf.js 6 dropped `isEvalSupported`; it never evals any more.)
    useSystemFonts: false,
    verbosity: 0,
    cMapPacked: true,
    ...pdfjsAssetDirs(),
  });
  try {
    const doc = await task.promise;
    const totalPages = doc.numPages;
    const range: PageRange = requested
      ? { from: requested.from, to: Math.min(requested.to, totalPages) }
      : { from: 1, to: Math.min(DEFAULT_PDF_PAGES, totalPages) };
    if (range.from > totalPages) {
      throw new Error(`pages="${requested!.from}${requested!.to !== requested!.from ? `-${requested!.to}` : ''}" starts past the end of the document (${totalPages} page${totalPages === 1 ? '' : 's'}).`);
    }
    const pages: Extracted['pages'] = [];
    for (let n = range.from; n <= range.to; n++) {
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        // pdf.js already inserts explicit " " items where a word gap has no
        // glyph, and flags line ends with `hasEOL`; joining on those (rather
        // than adding our own spaces) is what Firefox's copy-text does too, so
        // split words are not glued and kerned fragments are not spaced apart.
        let text = '';
        for (const item of content.items) {
          if (!('str' in item)) continue;
          text += item.str;
          if (item.hasEOL) text += '\n';
        }
        pages.push({ page: n, text: text.replace(/\n{3,}/g, '\n\n').trim() });
      } finally {
        page.cleanup();
      }
    }
    return { totalPages, range, pages };
  } finally {
    // Frees the document's worker-side state even when a page threw.
    await task.destroy().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// The tool-facing entry point
// ---------------------------------------------------------------------------
export interface ReadPdfOptions {
  /** The path as the model wrote it — echoed in messages. */
  displayPath: string;
  /** The raw `pages` argument, if given. */
  pages?: string;
  /** Whether the current model can look at images. Decides whether the
   *  scanned-page note may suggest rendering pages to PNG — a text-only model
   *  must never be handed advice that dead-ends (same lesson as read.ts's
   *  image branch). */
  supportsVision: boolean;
}

/** Read a PDF's text layer as a Read-tool result. Never throws for a bad PDF —
 *  every failure is an `isError` result naming the real reason. */
export async function readPdfAsToolResult(absPath: string, opts: ReadPdfOptions): Promise<ToolResultPayload> {
  let requested: PageRange | undefined;
  if (opts.pages !== undefined) {
    const parsed = parsePagesArg(opts.pages);
    if ('error' in parsed) return { text: `Read failed: ${parsed.error}`, isError: true };
    requested = parsed;
  }

  let ex: Extracted;
  try {
    ex = await serialized(() => extract(absPath, requested));
  } catch (err: any) {
    // Surface pdf.js's own message ("Invalid PDF structure.", "No password
    // given.") — it is specific and accurate, which "binary file" would not be.
    const msg = err?.message ?? String(err);
    const detail = err?.name === 'PasswordException'
      ? `${opts.displayPath} is password-protected (${msg})`
      : `${opts.displayPath}: ${msg}`;
    return { text: `Read failed: ${detail}`, isError: true };
  }

  const empty = ex.pages.filter((p) => p.text.replace(/\s/g, '').length < MIN_TEXT_CHARS).map((p) => p.page);
  const coversWholeDoc = ex.range.from === 1 && ex.range.to === ex.totalPages;
  const pageWord = (n: number) => `${n} page${n === 1 ? '' : 's'}`;

  if (empty.length === ex.pages.length) {
    // Nothing usable came back. Say so as an error — a successful-looking empty
    // result would read as "the document is blank".
    const where = coversWholeDoc
      ? `has no text layer (${pageWord(ex.totalPages)}; likely scanned images)`
      : `has no text layer in pages ${ex.range.from}–${ex.range.to} (of ${pageWord(ex.totalPages)}; likely scanned images)`;
    return { text: `Read failed: ${opts.displayPath} ${where}.${visionAdvice(opts, empty)}`, isError: true };
  }

  const body = ex.pages
    .filter((p) => !empty.includes(p.page))
    .map((p) => `--- page ${p.page} ---\n${p.text}`)
    .join('\n\n');

  // The scanned-page note goes FIRST: a paged read may be cut by the char cap
  // and an appended note is the part most likely to be lost.
  let note = '';
  if (empty.length > 0) {
    const list = describePageRuns(empty);
    note = `${empty.length === 1 ? `Page ${list} contains` : `Pages ${list} contain`} no text layer (likely scanned images); their content is not included.${visionAdvice(opts, empty)}\n\n`;
  }

  const more = ex.range.to < ex.totalPages;
  const nextFrom = ex.range.to + 1;
  // The suggested next range is the default window (10), not the 20-page
  // ceiling: it is the size the model just received, so following the hint
  // costs the same as the call it just made.
  const nextTo = Math.min(nextFrom + DEFAULT_PDF_PAGES - 1, ex.totalPages);
  return {
    text: note + body,
    bounds: more
      ? {
        shown: ex.pages.length,
        total: ex.totalPages,
        unit: 'pages',
        moreHint: `pass pages="${nextFrom}-${nextTo}" for the next range`,
      }
      : undefined,
  };
}

/** Only a model that can SEE images is told how to render the scanned pages;
 *  for everyone else the honest answer is just that the text is missing. */
function visionAdvice(opts: ReadPdfOptions, emptyPages: number[]): string {
  if (!opts.supportsVision || emptyPages.length === 0) return '';
  const first = emptyPages[0];
  const last = emptyPages[emptyPages.length - 1];
  const file = path.basename(opts.displayPath);
  return ` To see them, convert those pages to images (e.g. Bash: \`pdftoppm -png -f ${first} -l ${last} ${file} out\`) and Read the PNGs.`;
}
