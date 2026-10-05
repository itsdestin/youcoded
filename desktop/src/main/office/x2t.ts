import { type ChildProcess, execFile } from 'node:child_process';
import { createReadStream, promises as fsp } from 'node:fs';
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

// ── Folder containment (defensive hardening, 2026-10-01) ──
// WHY: a media/picture name in the save data may carry a "../" chain. x2t reads a document's
// pictures from <dirname(m_sFileFrom)>/media/<name> and theme pictures from <m_sThemeDir>/<name>,
// so a chain there would read a file from OUTSIDE the job and embed it in the saved document
// (confirmed 2026-10-01). Every x2t job is therefore run inside a deep private nest, with every
// path parameter inside it: a chain up to CONTAIN_DEPTH lands on an empty private folder and reads
// nothing of the person's; a deeper chain is refused by maxTraversalDepth before x2t runs.
const CONTAIN_DEPTH = 40;
// Two extra levels under the counted depth so an ALLOWED chain (<= CONTAIN_DEPTH) from in/media/
// (which sits two levels below the nest's bottom) still lands inside the private nest.
const NEST = Array(CONTAIN_DEPTH + 2).fill('d').join(path.sep);

/** Copy a directory tree if it exists; returns false when the source is absent. */
async function copyDirIfPresent(src: string, dst: string): Promise<boolean> {
  try {
    await fsp.cp(src, dst, { recursive: true });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/** Recreate `src` under `dst` with hardlinks (cheap — the files are the add-on's read-only
 *  themes), falling back to a copy where a hardlink cannot be made (across filesystems, or a
 *  read-only source). WHY hardlink: the per-instance theme copy and each job's theme folder are
 *  on the same filesystem (the instance temp base), so this costs inodes, not bytes. */
async function linkTree(src: string, dst: string): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  for (const ent of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) await linkTree(s, d);
    else
      await fsp.link(s, d).catch(async (e: NodeJS.ErrnoException) => {
        if (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EMLINK' || e.code === 'EEXIST') await fsp.copyFile(s, d);
        else throw e;
      });
  }
}

// The add-on's slide themes, copied once per instance onto the instance temp base (same filesystem
// as every job), so each job can hardlink them into its own contained nest cheaply. WHY cached:
// the copy is ~5 MB; doing it per save would be waste, and the files never change at runtime.
const themeSource = new Map<string, Promise<string>>();
function instanceThemes(root: string, tempBase: string): Promise<string> {
  let p = themeSource.get(tempBase);
  if (!p) {
    p = (async () => {
      const dst = path.join(tempBase, '.themes');
      // copyDirIfPresent so a build without bundled slide themes (or a test root) still yields a
      // real, empty, contained theme folder rather than throwing.
      await copyDirIfPresent(path.join(root, 'editors', 'sdkjs', 'slide', 'themes'), dst);
      await fsp.mkdir(dst, { recursive: true });
      return dst;
    })();
    themeSource.set(tempBase, p);
    // A failure is not remembered (as fontData): the next job tries again.
    p.catch(() => { if (themeSource.get(tempBase) === p) themeSource.delete(tempBase); });
  }
  return p;
}

/** The longest run of consecutive "../" (or "..\") sequences anywhere in `file`, scanned in both
 *  ASCII and UTF-16LE (the editor form stores picture names as UTF-16LE). WHY streamed and never a
 *  whole-file read: the editor form can be hundreds of MB and the main process must never block. */
async function maxTraversalDepth(file: string): Promise<number> {
  const units = [
    Buffer.from('../', 'latin1'),
    Buffer.from('..\\', 'latin1'),
    Buffer.from('../', 'utf16le'),
    Buffer.from('..\\', 'utf16le'),
  ];
  const st = units.map(() => ({ run: 0, nextAt: -1, lastAt: -1 }));
  const maxUnit = Math.max(...units.map((u) => u.length));
  let max = 0;
  let base = 0; // absolute offset of the current chunk's first byte (chunk only, not carry)
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) {
    const c = chunk as Buffer;
    const buf = carry.length ? Buffer.concat([carry, c]) : c;
    const bufBase = base - carry.length; // absolute offset of buf[0]
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const s = st[i];
      for (let from = 0; ; ) {
        const at = buf.indexOf(u, from);
        if (at < 0) break;
        from = at + u.length;
        const abs = bufBase + at;
        // Skip a match already counted last round (it fell in the carry overlap), without
        // disturbing the run state that may continue into the new bytes.
        if (abs <= s.lastAt) continue;
        s.run = abs === s.nextAt ? s.run + 1 : 1;
        s.nextAt = abs + u.length;
        s.lastAt = abs;
        if (s.run > max) max = s.run;
      }
    }
    // Keep the last (maxUnit-1) bytes so a unit split across the chunk boundary is still found.
    const keep = Math.min(maxUnit - 1, buf.length);
    carry = keep ? Buffer.from(buf.subarray(buf.length - keep)) : Buffer.alloc(0);
    base += c.length;
  }
  return max;
}

// ── Network containment (defensive hardening, 2026-10-01) ──
// WHY: a picture name that is a web address makes x2t download it during a save, bypassing the
// app's own picture-download checks (office-pictures.ts / public-address.ts). x2t ignores the
// proxy environment variables on Linux (measured 2026-10-01), so the real block is an unprivileged
// network namespace with no network at all; the proxy vars are a cross-platform backstop for any
// build or platform that does honour them.
let netnsProbe: Promise<boolean> | undefined;
function netnsSupported(): Promise<boolean> {
  if (!netnsProbe) {
    netnsProbe = new Promise<boolean>((resolve) => {
      if (process.platform !== 'linux') return resolve(false);
      // `unshare -rn true`: map ourselves to root in a new user namespace and a fresh, empty
      // network namespace, then exit. It succeeds only where unprivileged user+net namespaces are
      // allowed; where the kernel forbids them it fails and we fall back to the proxy vars alone.
      execFile('unshare', ['-rn', '--', 'true'], { timeout: 5_000 }, (err) => resolve(!err));
    });
  }
  return netnsProbe;
}

/** Whether this platform can fully contain x2t's network (an unprivileged empty network
 *  namespace). WHY exported: the regression tests only assert "web-address picture not fetched"
 *  where containment actually holds; where it does not (no user namespaces, macOS, Windows) the
 *  proxy vars are x2t's only — and, for the bundled build, ineffective — network guard. */
export function networkContainmentAvailable(): Promise<boolean> {
  return netnsSupported();
}

/** Point every proxy variable at a closed local port and clear the no-proxy list, so an x2t build
 *  that honours them cannot reach the network (the port is never listening). Harmless where x2t
 *  ignores them. */
function applyNetworkEnv(env: NodeJS.ProcessEnv): void {
  const closed = 'http://127.0.0.1:9';
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) env[k] = closed;
  env.NO_PROXY = '';
  env.no_proxy = '';
}

/** Run the bundled x2t once with `args`, rejecting with an X2tError whose code says why.
 *  WHY one helper (Task 2 fix round 1): the translation and the PDF font list are both x2t runs,
 *  and both must report a timeout as 'timeout' (the only code callers call "took too long"), be
 *  stoppable, and be killed at quit. */
async function runX2t(bin: string, args: string[], signal?: AbortSignal, cwd?: string): Promise<void> {
  // WHY the library path: x2t loads its shared libraries from its own folder. On macOS the
  // libraries are found through x2t's own @executable_path rpath (Task 9), and DYLD_ is a
  // harmless backup (a signed app's hardened runtime ignores it). Windows needs neither: it
  // looks for a program's DLLs in the program's own folder first.
  // Each variable is set only on the platform that reads it (fix round 1).
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.platform === 'linux') env.LD_LIBRARY_PATH = bin;
  if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = bin;
  // Network containment: proxy vars always (backstop), plus a real network namespace on Linux.
  applyNetworkEnv(env);
  const useNetns = await netnsSupported();
  return new Promise<void>((resolve, reject) => {
    // WHY SIGKILL on timeout: a wedged converter may ignore SIGTERM and linger holding the
    // file. WHY a large maxBuffer: x2t can be chatty on stdout for a big document, and hitting
    // the default 1 MB limit would kill a translation that was working.
    // WHY `signal` (Task 5 fix round 2): execFile kills the child with killSignal when it
    // aborts, so one document's translation can be stopped without touching the others'.
    // WHY cwd defaults to bin but a job may pass its own: running x2t with its working directory
    // inside the contained job folder keeps even a relative path x2t resolves against cwd inside.
    const opts = { cwd: cwd ?? bin, env, timeout: X2T_TIMEOUT_MS, killSignal: 'SIGKILL' as const, maxBuffer: 64 * 1024 * 1024, signal };
    // WHY the .exe spelled out (Task 9): the Windows bundle's converter is x2t.exe; naming it
    // exactly does not lean on Windows guessing the extension.
    const exe = path.join(bin, process.platform === 'win32' ? 'x2t.exe' : 'x2t');
    // WHY `unshare -rn` when supported: it runs x2t in an empty network namespace, so a web-address
    // picture name cannot be fetched during a save. No `-f`, so x2t replaces unshare in place and
    // the pid we hold (and kill at quit / on timeout) is x2t's own.
    const cmd = useNetns ? 'unshare' : exe;
    const cmdArgs = useNetns ? ['-rn', '--', exe, ...args] : args;
    const child = execFile(cmd, cmdArgs, opts, (err, _stdout, stderr) => {
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
    // Build the deep private nest (folder containment, 2026-10-01). Every path x2t sees — input,
    // its media, output, temp and theme folders — lives under `work`, which sits CONTAIN_DEPTH+2
    // levels inside the job's own 0700 folder. A "../" chain in a picture name climbs through empty
    // private directories and reaches nothing of the person's.
    const work = path.join(job, NEST, 'w');
    const inDir = path.join(work, 'in');
    const outDir = path.join(work, 'out');
    const tmpDir = path.join(work, 'tmp');
    await fsp.mkdir(inDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.mkdir(tmpDir, { recursive: true });

    // Copy the input into the nest. A missing input is x2t's "input not found", reported as an
    // X2tError (the caller turns it into a user message) rather than a raw fs throw.
    const inFile = path.join(inDir, path.basename(from));
    try {
      await fsp.copyFile(from, inFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new X2tError('x2t input not found', 'no-input', '');
      throw e;
    }
    // Copy the session's OWN media beside the input (save direction): x2t embeds pictures by reading
    // them from media/ next to m_sFileFrom. Only the session's pictures come in; nothing outside.
    await copyDirIfPresent(path.join(path.dirname(from), 'media'), path.join(inDir, 'media'));

    // Depth guard: refuse save data whose "../" depth exceeds what the nest absorbs. WHY on top of
    // the nest: the nest is a fixed depth, so a long enough chain could still climb out of it; this
    // catches that before x2t runs. A legitimate document has no "../" at all, so there is no false
    // positive. The bundled x2t ignores proxy vars for downloads, but path traversal is pure fs.
    const depth = await maxTraversalDepth(inFile);
    if (depth > CONTAIN_DEPTH) throw new X2tError('x2t input would reach outside its folder', 'escape', '');

    // Theme pictures of PowerPoint's standard themes are named "theme<N>/media/…" relative to
    // m_sThemeDir. Point it at a hardlinked copy INSIDE the nest (not the add-on in place): a
    // crafted theme-relative "../" name is then contained exactly like a media name.
    const themeDir = path.join(work, 'themes');
    await linkTree(await instanceThemes(root, tempBase), themeDir);

    const outFile = path.join(outDir, path.basename(to));
    const params = path.join(work, 'params.xml');
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><TaskQueueDataConvert>' +
      `<m_sFileFrom>${xmlEscape(inFile)}</m_sFileFrom>` +
      `<m_sFileTo>${xmlEscape(outFile)}</m_sFileTo>` +
      `<m_nFormatTo>${formatTo}</m_nFormatTo>` +
      `<m_sTempDir>${xmlEscape(tmpDir)}</m_sTempDir>` +
      `<m_sFontDir>${xmlEscape(path.join(bin, 'fonts'))}</m_sFontDir>` +
      `<m_sAllFontsPath>${xmlEscape(extra.allFontsPath ?? path.join(bin, 'AllFonts.js'))}</m_sAllFontsPath>` +
      // WHY m_sThemeDir (add-on v0.1.37): a slide that took a standard theme points at its pictures
      // as "theme<N>/media/…" and x2t finds them only under this folder. It is now a contained copy
      // inside the job, so neither the add-on's own files nor anything above them can be escaped to.
      `<m_sThemeDir>${xmlEscape(themeDir)}</m_sThemeDir>` +
      paramsXml(extra.params) +
      '</TaskQueueDataConvert>';
    await fsp.writeFile(params, xml, 'utf8');
    // cwd = work, so even a path x2t resolves against its working directory stays contained.
    await runX2t(bin, [params], signal, work);
    // WHY check the output: a translator that exits "successfully" without writing anything
    // must never be treated as a finished save — the caller would then replace the user's file
    // with nothing.
    const out = await fsp.stat(outFile).catch(() => null);
    if (!out || out.size === 0) throw new X2tError('x2t produced no output', 'no-output', '');
    // Move the output media out to where the caller serves it (open direction): x2t writes a
    // document's pictures to media/ beside its output, which the editor serves from <dirname(to)>.
    await copyDirIfPresent(path.join(outDir, 'media'), path.join(path.dirname(to), 'media'));
    // Deliver the finished file to the caller's path (outside the nest). Rename when it is on the
    // same filesystem (the open direction, both under the instance temp base); copy across devices.
    await fsp.rename(outFile, to).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EXDEV') throw e;
      await fsp.copyFile(outFile, to);
    });
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
   *  reads it (m_sJsonParams → asc_nativePrint; measured: page range and orientation honoured).
   *  Print (Task 3): also a document's or presentation's page list (printParams). */
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

// ── What to print (finish plan Task 3) ──
// A page list as the editor's print panel writes it ("2-3", "1,4,6-8"). WHY capped: it comes from
// the editor frame, and only this shape reaches x2t.
const PAGE_LIST = /^[1-9][0-9]{0,5}(-[1-9][0-9]{0,5})?(,[1-9][0-9]{0,5}(-[1-9][0-9]{0,5})?){0,99}$/;

/** The checked x2t additions for printing a document of `sourceExt`'s kind: the editor's print
 *  options (bridge.js's Print), or {} for the whole document. 'selection' when the editor asked
 *  for only the selected part — x2t works from the saved document, which has no selection, so the
 *  caller refuses that rather than print more than was asked. */
export function printParams(sourceExt: string, json: unknown): ExportParams | 'selection' {
  if (sourceExt === 'xlsx') {
    // A workbook's print panel gives the same range the PDF export does (sheets, pages, print area).
    const p = exportParams(FORMAT.pdf, 'xlsx', undefined, json);
    if (p.json && (JSON.parse(p.json) as { adjustOptions?: { printType?: number } }).adjustOptions?.printType === 2) return 'selection';
    return p;
  }
  if (typeof json !== 'string' || json.length > 64 * 1024) return {};
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return {}; }
  const j = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const printOptions = j.printOptions && typeof j.printOptions === 'object' ? (j.printOptions as Record<string, unknown>) : null;
  if (printOptions?.selection) return 'selection';
  const native = j.nativeOptions && typeof j.nativeOptions === 'object' ? (j.nativeOptions as Record<string, unknown>) : null;
  const pages = typeof native?.pages === 'string' ? native.pages.replace(/\s+/g, '') : '';
  // Measured 2026-09-29: x2t's PDF writer prints only these pages (docx "2-3" → 2 pages, pptx "2"
  // → slide 2). "all" or nothing is the whole document, which needs no parameter.
  if (PAGE_LIST.test(pages)) return { json: JSON.stringify({ nativeOptions: { pages } }) };
  return {};
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
