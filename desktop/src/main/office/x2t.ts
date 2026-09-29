import { type ChildProcess, execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

// x2t format codes (OnlyOffice AVS_OFFICESTUDIO_FILE_*). The three kinds Office opens and saves,
// the editor's own internal form (bin), and what Save As / Export writes (finish plan Task 2).
export const FORMAT = {
  bin: 8192, docx: 65, xlsx: 257, pptx: 129,
  odt: 67, rtf: 68, txt: 69, odp: 131, ods: 259, csv: 260, pdf: 513,
} as const;

// What each kind of document may be written as by Save As / Export. WHY exactly these: they are
// the formats the editor's own Download-as panel is trimmed to (editor-patches.js keeps 65, 67,
// 68, 69, 257, 259, 260, 129, 131, 513), and each was measured 2026-09-29 to come out of x2t
// from the editor form as a real file. Legacy doc/xls/ppt are not offered there.
const EXPORTS: Record<'docx' | 'xlsx' | 'pptx', readonly (keyof typeof FORMAT)[]> = {
  docx: ['docx', 'odt', 'rtf', 'txt', 'pdf'],
  xlsx: ['xlsx', 'ods', 'csv', 'pdf'],
  pptx: ['pptx', 'odp', 'pdf'],
};
const extOf = (p: string) => path.extname(p).slice(1).toLowerCase();

/** The x2t code for writing a document of `source`'s kind to `target`, or null when that kind
 *  can't be written in `target`'s format. */
export function exportFormatFor(source: string, target: string): number | null {
  const kind = extOf(source);
  if (kind !== 'docx' && kind !== 'xlsx' && kind !== 'pptx') return null;
  const ext = extOf(target);
  return (EXPORTS[kind] as readonly string[]).includes(ext) ? FORMAT[ext as keyof typeof FORMAT] : null;
}

export function formatFor(filePath: string): number | null {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  // WHY an explicit list and not `ext in FORMAT`: 'bin' is a key too, but a user's `.bin` file
  // is not a document Office can save back to — only the three document kinds count here.
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') return FORMAT[ext];
  return null;
}

// Every converter process still running, so quit can stop them (fix round 2). WHY: when quit
// stops waiting for a save, an x2t left running would keep writing into a folder that is being
// removed, and outlive the app.
const running = new Set<ChildProcess>();
/** The longest one translation may run before x2t is killed and the save fails ("took too long").
 *  Exported so a document's close can wait exactly this long for its last save (office-commands). */
export const X2T_TIMEOUT_MS = 60_000;
const stoppedAtQuit = new WeakSet<ChildProcess>();

/** Kill every running converter (quit only). Returns how many were running. */
export function killRunningConverters(): number {
  const n = running.size;
  for (const child of running) {
    stoppedAtQuit.add(child);
    child.kill('SIGKILL');
  }
  return n;
}

export class X2tError extends Error {
  code: string | number;
  stderr: string;
  constructor(message: string, code: string | number, stderr: string) {
    super(message);
    this.name = 'X2tError';
    this.code = code;
    this.stderr = stderr;
  }
}

// WHY escape: these are real folder and file names, and a folder called "Tom & Jerry" or
// "<drafts>" would otherwise break the task file's XML and make x2t fail (or read the wrong
// path). Only the characters XML text needs escaped: & < > and ".
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Run the bundled x2t once with `args`, rejecting with an X2tError whose code says why.
 *  WHY one helper (Task 2 fix round 1): the translation and the PDF font list are both x2t runs,
 *  and both must report a timeout as 'timeout' (the only code callers call "took too long"), be
 *  stoppable, and be killed at quit. */
function runX2t(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  // WHY the library path: x2t loads its shared libraries from its own folder. On macOS the
  // DYLD_ variable is the equivalent — unverified there, noted for design task 9.
  // Each variable is set only on the platform that reads it (fix round 1).
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.platform === 'linux') env.LD_LIBRARY_PATH = bin;
  if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = bin;
  return new Promise<void>((resolve, reject) => {
    // WHY SIGKILL on timeout: a wedged converter may ignore SIGTERM and linger holding the
    // file. WHY a large maxBuffer: x2t can be chatty on stdout for a big document, and hitting
    // the default 1 MB limit would kill a translation that was working.
    // WHY `signal` (Task 5 fix round 2): execFile kills the child with killSignal when it
    // aborts, so one document's translation can be stopped without touching the others'.
    const opts = { cwd: bin, env, timeout: X2T_TIMEOUT_MS, killSignal: 'SIGKILL' as const, maxBuffer: 64 * 1024 * 1024, signal };
    const child = execFile(path.join(bin, 'x2t'), args, opts, (err, _stdout, stderr) => {
      running.delete(child);
      if (!err) return resolve();
      const e = err as NodeJS.ErrnoException & { signal?: string | null; killed?: boolean };
      // WHY three distinct codes (fix round 2): callers tell the user "took too long" ONLY for
      // a real timeout. Node reports an output overflow with its own code, and our own kill
      // at quit also arrives as killed+SIGKILL, so each is told apart before the timeout test.
      let code: string | number;
      if (stoppedAtQuit.has(child) || signal?.aborted) code = 'stopped';
      else if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') code = e.code;
      else if (e.killed && e.signal === 'SIGKILL') code = 'timeout';
      else code = e.code ?? e.signal ?? 'unknown';
      reject(new X2tError(`x2t failed (${code})`, code, String(stderr ?? '')));
    });
    running.add(child);
  });
}

/**
 * Translate `from` into `to` with the bundled native x2t. Rejects with X2tError when x2t
 * fails, times out, or finishes without writing a non-empty `to`.
 *
 * Media: x2t writes a document's pictures to `<dirname(to)>/media/` when translating INTO the
 * editor's form, and reads them back from `<dirname(from)>/media/` when translating OUT of it
 * (verified 2026-09-28 by running x2t on a docx with a picture — see the task-4 report).
 */
export async function convert(
  root: string, from: string, to: string, formatTo: number, tempBase: string,
  /** Aborting it kills this translation (a closed document whose close stopped waiting). */
  signal?: AbortSignal,
  /** What Save As / Export adds (finish plan Task 2): the font list a PDF needs (pdfFontData),
   *  and the editor's export choices, already checked by exportParams(). */
  extra: { allFontsPath?: string; params?: ExportParams } = {},
): Promise<void> {
  if (signal?.aborted) throw new X2tError('x2t failed (stopped)', 'stopped', '');
  const bin = path.join(root, 'converter');
  // Every x2t job gets a FRESH temp dir. Measured 2026-09-28: saving with the temp dir the open
  // step had used (it leaves xlsx_unpacked/ behind) made x2t merge the old drawing parts in, and
  // a workbook's 5 charts came back on two sheets. A clean dir gives the right file.
  //
  // WHY no mkdir of tempBase (fix round 1): at quit, cleanup removes the instance temp base;
  // recreating it here would leave a folder behind after quit. A missing base makes mkdtemp
  // reject, which is the right answer for a translation asked for that late.
  const job = await fsp.mkdtemp(path.join(tempBase, 'job-'));
  try {
    const params = path.join(job, 'params.xml');
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><TaskQueueDataConvert>' +
      `<m_sFileFrom>${xmlEscape(from)}</m_sFileFrom>` +
      `<m_sFileTo>${xmlEscape(to)}</m_sFileTo>` +
      `<m_nFormatTo>${formatTo}</m_nFormatTo>` +
      `<m_sTempDir>${xmlEscape(job)}</m_sTempDir>` +
      `<m_sFontDir>${xmlEscape(path.join(bin, 'fonts'))}</m_sFontDir>` +
      `<m_sAllFontsPath>${xmlEscape(extra.allFontsPath ?? path.join(bin, 'AllFonts.js'))}</m_sAllFontsPath>` +
      paramsXml(extra.params) +
      '</TaskQueueDataConvert>';
    await fsp.writeFile(params, xml, 'utf8');
    await runX2t(bin, [params], signal);
    // WHY check the output: a translator that exits "successfully" without writing anything
    // must never be treated as a finished save — the caller would then replace the user's file
    // with nothing.
    const out = await fsp.stat(to).catch(() => null);
    if (!out || out.size === 0) throw new X2tError('x2t produced no output', 'no-output', '');
  } finally {
    await fsp.rm(job, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Font data for PDF (finish plan Task 2) ──
// WHY: a PDF is drawn by x2t's renderer, which reads each font file named in its font list. The
// bundled list (converter/AllFonts.js) names bare file names, fine for docx/xlsx/pptx but not for
// drawing: measured 2026-09-29, a PDF made with it had every character as glyph 0 — blank pages.
// x2t makes a list of real font files itself (`-create-allfonts`, what Euro-Office's own app runs
// at first start); it takes about half a second, so it is made once per run, on the first PDF,
// in the instance temp base (removed at quit like every other Office temp file).
const fontData = new Map<string, Promise<string>>();

/** The AllFonts.js a PDF translation needs (pass it to convert's allFontsPath). */
export function pdfFontData(root: string, tempBase: string): Promise<string> {
  let p = fontData.get(tempBase);
  if (!p) {
    p = makeFontData(root, tempBase);
    fontData.set(tempBase, p);
    // A failure is not remembered: the next PDF tries again.
    p.catch(() => { if (fontData.get(tempBase) === p) fontData.delete(tempBase); });
  }
  return p;
}

async function makeFontData(root: string, tempBase: string): Promise<string> {
  const bin = path.join(root, 'converter');
  const out = path.join(tempBase, 'fontdata');
  // WHY not recursive: as convert's job folders — a temp base removed at quit is not recreated.
  await fsp.mkdir(out).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
  await runX2t(bin, ['-create-allfonts', out, path.join(bin, 'fonts')]);
  const list = path.join(out, 'AllFonts.js');
  const st = await fsp.stat(list).catch(() => null);
  if (!st || st.size === 0) throw new X2tError('x2t made no font list', 'no-output', '');
  return list;
}

// ── The editor's export choices (Task 2 fix round 1) ──
// WHY here, checked: they come from the editor frame (bridge.js's save options), so only
// well-formed values of the kinds x2t was measured to honour (2026-09-29) reach its task file.
export interface ExportParams {
  /** CSV encoding: an index into sdkjs's encoding table (c_oAscEncodings), which is what both the
   *  editor sends and x2t reads (measured: 44 wrote windows-1252, 46 UTF-8, 48 UTF-16LE). */
  csvEncoding?: number;
  /** CSV delimiter: 1 tab, 2 semicolon, 3 colon, 4 comma, 5 space (x2t's numbering, measured). */
  csvDelimiter?: number;
  /** CSV "Other" delimiter: one character, written as is (measured: '|' honoured). */
  csvDelimiterChar?: string;
  /** Spreadsheet PDF: the print range the editor's PDF dialog chose, as sdkjs's own native print
   *  reads it (m_sJsonParams → asc_nativePrint; measured: page range and orientation honoured). */
  json?: string;
}
const MAX_ENCODING_INDEX = 52; // c_oAscEncodings runs 0..52 (52: EUC-JP)
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** The checked x2t additions for writing `formatTo` from the editor's options, or {} when there
 *  is nothing (or nothing valid) to add. `text`: the TXT/CSV dialog's choice; `json`: bridge.js's
 *  jsonOptions string. Anything malformed is dropped, never passed on. */
export function exportParams(formatTo: number, sourceExt: string, text: unknown, json: unknown): ExportParams {
  const out: ExportParams = {};
  if (formatTo === FORMAT.csv && text && typeof text === 'object') {
    const t = text as { codePage?: unknown; delimiter?: unknown; delimiterChar?: unknown };
    if (isInt(t.codePage, 0, MAX_ENCODING_INDEX)) out.csvEncoding = t.codePage;
    // The editor sends the delimiter as a list ([2]) or, for "Other", an empty list and a character.
    const d = Array.isArray(t.delimiter) ? t.delimiter[0] : t.delimiter;
    if (isInt(d, 1, 5)) out.csvDelimiter = d;
    else if (typeof t.delimiterChar === 'string' && t.delimiterChar.length === 1 && !/["\r\n\0-\x1f]/.test(t.delimiterChar)) {
      out.csvDelimiterChar = t.delimiterChar;
    }
  }
  if (formatTo === FORMAT.pdf && sourceExt === 'xlsx' && typeof json === 'string' && json.length <= 4 * 1024 * 1024) {
    let raw: unknown;
    try { raw = JSON.parse(json); } catch { raw = null; }
    const j = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const adj = j.adjustOptions && typeof j.adjustOptions === 'object' ? (j.adjustOptions as Record<string, unknown>) : null;
    const layout = j.spreadsheetLayout && typeof j.spreadsheetLayout === 'object' ? (j.spreadsheetLayout as Record<string, unknown>) : null;
    const clean: { spreadsheetLayout?: { ignorePrintArea: boolean }; adjustOptions?: Record<string, unknown> } = {};
    if (layout && typeof layout.ignorePrintArea === 'boolean') clean.spreadsheetLayout = { ignorePrintArea: layout.ignorePrintArea };
    if (adj) {
      const a: Record<string, unknown> = {};
      // printType: 0 active sheets, 1 whole workbook, 2 selection (Asc.c_oAscPrintType).
      if (isInt(adj.printType, 0, 2)) a.printType = adj.printType;
      if (isInt(adj.startPageIndex, 0, 100_000)) a.startPageIndex = adj.startPageIndex;
      if (isInt(adj.endPageIndex, 0, 100_000)) a.endPageIndex = adj.endPageIndex;
      if (Array.isArray(adj.activeSheetsArray) && adj.activeSheetsArray.length <= 1000 && adj.activeSheetsArray.every((n) => isInt(n, 0, 10_000))) {
        a.activeSheetsArray = adj.activeSheetsArray;
      }
      if (Object.keys(a).length) clean.adjustOptions = a;
    }
    // WHY only when the editor sent its print type: sdkjs's native print prints the WHOLE
    // workbook whenever options are passed without one — more than the person asked for.
    if (clean.adjustOptions && 'printType' in clean.adjustOptions) out.json = JSON.stringify(clean);
  }
  return out;
}

function paramsXml(p: ExportParams | undefined): string {
  if (!p) return '';
  let x = '';
  if (p.csvEncoding !== undefined) x += `<m_nCsvTxtEncoding>${p.csvEncoding}</m_nCsvTxtEncoding>`;
  if (p.csvDelimiter !== undefined) x += `<m_nCsvDelimiter>${p.csvDelimiter}</m_nCsvDelimiter>`;
  if (p.csvDelimiterChar !== undefined) x += `<m_nCsvDelimiterChar>${xmlEscape(p.csvDelimiterChar)}</m_nCsvDelimiterChar>`;
  if (p.json !== undefined) x += `<m_sJsonParams>${xmlEscape(p.json)}</m_sJsonParams>`;
  return x;
}
