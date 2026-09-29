import { type ChildProcess, execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

// x2t format codes (OnlyOffice AVS_OFFICESTUDIO_FILE_*). Only the three kinds Office opens
// and saves in this plan, plus the editor's own internal form (bin).
export const FORMAT = { bin: 8192, docx: 65, xlsx: 257, pptx: 129 } as const;

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
      `<m_sAllFontsPath>${xmlEscape(path.join(bin, 'AllFonts.js'))}</m_sAllFontsPath>` +
      '</TaskQueueDataConvert>';
    await fsp.writeFile(params, xml, 'utf8');
    // WHY the library path: x2t loads its shared libraries from its own folder. On macOS the
    // DYLD_ variable is the equivalent — unverified there, noted for design task 9.
    // Each variable is set only on the platform that reads it (fix round 1).
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (process.platform === 'linux') env.LD_LIBRARY_PATH = bin;
    if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = bin;
    await new Promise<void>((resolve, reject) => {
      // WHY SIGKILL on timeout: a wedged converter may ignore SIGTERM and linger holding the
      // file. WHY a large maxBuffer: x2t can be chatty on stdout for a big document, and hitting
      // the default 1 MB limit would kill a translation that was working.
      // WHY `signal` (Task 5 fix round 2): execFile kills the child with killSignal when it
      // aborts, so one document's translation can be stopped without touching the others'.
      const opts = { cwd: bin, env, timeout: X2T_TIMEOUT_MS, killSignal: 'SIGKILL' as const, maxBuffer: 64 * 1024 * 1024, signal };
      const child = execFile(path.join(bin, 'x2t'), [params], opts, (err, _stdout, stderr) => {
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
    // WHY check the output: a translator that exits "successfully" without writing anything
    // must never be treated as a finished save — the caller would then replace the user's file
    // with nothing.
    const out = await fsp.stat(to).catch(() => null);
    if (!out || out.size === 0) throw new X2tError('x2t produced no output', 'no-output', '');
  } finally {
    await fsp.rm(job, { recursive: true, force: true }).catch(() => {});
  }
}
