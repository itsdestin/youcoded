import { execFile } from 'node:child_process';
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
export async function convert(root: string, from: string, to: string, formatTo: number, tempBase: string): Promise<void> {
  const bin = path.join(root, 'converter');
  // Every x2t job gets a FRESH temp dir. Measured 2026-09-28: saving with the temp dir the open
  // step had used (it leaves xlsx_unpacked/ behind) made x2t merge the old drawing parts in, and
  // a workbook's 5 charts came back on two sheets. A clean dir gives the right file.
  await fsp.mkdir(tempBase, { recursive: true });
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
    const env: NodeJS.ProcessEnv = { ...process.env, LD_LIBRARY_PATH: bin };
    if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = bin;
    await new Promise<void>((resolve, reject) => {
      execFile(path.join(bin, 'x2t'), [params], { cwd: bin, env, timeout: 60_000 }, (err, _stdout, stderr) => {
        if (!err) return resolve();
        const e = err as NodeJS.ErrnoException & { signal?: string | null };
        const code = e.code ?? e.signal ?? 'unknown';
        reject(new X2tError(`x2t failed (${code})`, code, String(stderr ?? '')));
      });
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
