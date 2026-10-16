// Computer programs a page may run (Pages scope §9, spec 2026-10-16).
//
// A page lists a program file kept in its OWN folder in page.json (`kind: "program"`). The person's
// approval card says it runs with this computer account's full access, and the approval is tied to the
// file's exact contents: edit the file and the page asks again (the listing in pages-store.ts compares
// `hashProgramFile` to the hash recorded at approval). This file is the half that RUNS it.
//
// WHY every step is asynchronous: one thread serves every window (performance rule 1,
// main-blocking-calls.test.ts). The program is spawned, fed on stdin, and read through events; nothing here
// waits on the file system or the child with a blocking call.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PageProgramResult } from '../../shared/pages-types';
import { MAX_PAGE_PROGRAM_INPUT } from '../../shared/pages-types';

/** How long a program may run before it is stopped. */
const PROGRAM_TIMEOUT_MS = 120_000;
/** The most it may print (stdout and stderr each). Past this it is stopped, not trimmed: a cut-off answer
 *  would read as a whole one. */
const PROGRAM_MAX_OUTPUT = 2 * 1024 * 1024;
/** How much of what it complained about travels back on a non-zero exit. */
const STDERR_TAIL = 4000;
/** A page may have this many programs running at once. */
const MAX_RUNNING_PER_PAGE = 4;

/** Which program starts a file, by its extension; null = refused. Node scripts run on the app's own bundled
 *  Node (`ELECTRON_RUN_AS_NODE`), so a computer without a system Node still runs them. */
function interpreterFor(file: string): { command: string; env: Record<string, string> } | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mjs' || ext === '.js' || ext === '.cjs') return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  if (ext === '.py') return { command: process.platform === 'win32' ? 'python' : 'python3', env: {} };
  if (ext === '.sh') return { command: 'bash', env: {} };
  return null;
}

/** The program file's path and SHA-256, or null when it is missing, not a plain file, or a link (a link
 *  could be re-pointed outside the page's folder after the person said yes). Reads the whole file, once. */
export async function hashProgramFile(dir: string, file: string): Promise<string | null> {
  try {
    const full = path.join(dir, file);
    const st = await fs.lstat(full);
    if (!st.isFile()) return null;
    return createHash('sha256').update(await fs.readFile(full)).digest('hex');
  } catch { return null; }
}

/** The same hash for the page LISTING, which runs on every change anywhere under Pages/. Reads the file again
 *  only when its size or modified time moved. The run itself never uses this: it hashes fresh. */
const listingHashes = new Map<string, { size: number; mtimeMs: number; hash: string | null }>();
export async function hashProgramFileCached(dir: string, file: string): Promise<string | null> {
  const full = path.join(dir, file);
  try {
    const st = await fs.lstat(full);
    if (!st.isFile()) return null;
    const hit = listingHashes.get(full);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.hash;
    const hash = await hashProgramFile(dir, file);
    listingHashes.set(full, { size: st.size, mtimeMs: st.mtimeMs, hash });
    return hash;
  } catch { listingHashes.delete(full); return null; }
}

interface Running {
  pageId: string;
  /** The window or phone that started it, so closing THAT window stops it. */
  owner: string;
  child: ChildProcessWithoutNullStreams;
  /** Why it was stopped from outside, if it was; read when it exits. */
  stopped?: string;
}

/** Ends a program and everything it started. On a POSIX computer the program is its own process group, so
 *  a shell script's children do not outlive it. */
function kill(child: ChildProcessWithoutNullStreams): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

export class PageProgramRunner {
  private readonly running = new Set<Running>();
  /** `timeoutMs` is injectable ONLY so a test can watch the time limit work without waiting two minutes. */
  constructor(private readonly timeoutMs: number = PROGRAM_TIMEOUT_MS) {}

  /** Run `file` (already approved and hash-checked by the caller) with `input` on stdin. Always resolves. */
  run(pageId: string, owner: string, dir: string, file: string, input: string): Promise<PageProgramResult> {
    const interp = interpreterFor(file);
    if (!interp) return Promise.resolve({ ok: false, reason: `A ${path.extname(file) || 'file without a type'} file cannot be run. Programs can be .mjs, .js, .cjs, .py or .sh files.` });
    if (Buffer.byteLength(input, 'utf8') > MAX_PAGE_PROGRAM_INPUT) return Promise.resolve({ ok: false, reason: 'The input is larger than 1 MB, which is more than a program may be given.' });
    let mine = 0;
    for (const r of this.running) if (r.pageId === pageId) mine++;
    if (mine >= MAX_RUNNING_PER_PAGE) return Promise.resolve({ ok: false, reason: `This page already has ${MAX_RUNNING_PER_PAGE} programs running. Wait for one to finish.` });

    return new Promise<PageProgramResult>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(interp.command, [file], {
          cwd: dir,
          env: { ...process.env, ...interp.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          // WHY detached on POSIX: its own process group, so kill() can end a script's children too.
          detached: process.platform !== 'win32',
        }) as ChildProcessWithoutNullStreams;
      } catch (e) {
        resolve({ ok: false, reason: `The program could not be started (${(e as Error)?.message ?? String(e)}).` });
        return;
      }
      const rec: Running = { pageId, owner, child };
      this.running.add(rec);
      const out: Buffer[] = []; let outBytes = 0;
      const err: Buffer[] = []; let errBytes = 0;
      let overflow = false;
      let timedOut = false;
      let settled = false;
      const finish = (r: PageProgramResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(rec);
        resolve(r);
      };
      const timer = setTimeout(() => { timedOut = true; kill(child); }, this.timeoutMs);
      // The program may exit without reading its input; the broken pipe is its choice, not our error.
      child.stdin.on('error', () => { /* ignored on purpose */ });
      child.stdout.on('data', (b: Buffer) => {
        outBytes += b.length;
        if (outBytes > PROGRAM_MAX_OUTPUT) { overflow = true; kill(child); return; }
        out.push(b);
      });
      child.stderr.on('data', (b: Buffer) => {
        // Only the end of stderr is ever returned, so older chunks are dropped as soon as the newer ones
        // alone cover the tail. A program that talks on stderr forever therefore costs no memory; the
        // time limit ends it.
        err.push(b); errBytes += b.length;
        while (err.length > 1 && errBytes - err[0].length >= STDERR_TAIL) errBytes -= err.shift()!.length;
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        finish({ ok: false, reason: `The program could not be started (${e.code === 'ENOENT' ? `${interp.command} was not found on this computer` : e.message}).` });
      });
      child.on('close', (code, signal) => {
        if (rec.stopped) { finish({ ok: false, reason: rec.stopped }); return; }
        if (timedOut) { finish({ ok: false, reason: `The program ran longer than ${this.timeoutMs / 1000} seconds, so it was stopped.` }); return; }
        if (overflow) { finish({ ok: false, reason: 'The program printed more than 2 MB, so it was stopped.' }); return; }
        const output = Buffer.concat(out).toString('utf8');
        // A program killed by something outside this app has no exit code.
        const exitCode = typeof code === 'number' ? code : 1;
        const stderr = exitCode !== 0 || signal ? Buffer.concat(err).toString('utf8').slice(-STDERR_TAIL) : '';
        finish({ ok: true, output, exitCode, ...(stderr ? { stderr } : {}) });
      });
      try { child.stdin.end(input); } catch { /* the 'error' handler above covers a closed pipe */ }
    });
  }

  private stopWhere(match: (r: Running) => boolean, why: string): void {
    for (const r of [...this.running]) if (match(r)) { r.stopped = why; kill(r.child); }
  }

  /** The page was closed, changed or lost an approval: everything it has running stops. */
  stopPage(pageId: string, why = 'The page was closed, so the program was stopped.'): void { this.stopWhere((r) => r.pageId === pageId, why); }
  /** One window's (or phone's) page was closed: only what that owner started. */
  stopPageOf(pageId: string, owner: string): void { this.stopWhere((r) => r.pageId === pageId && r.owner === owner, 'The page was closed, so the program was stopped.'); }
  /** The window went away or the phone dropped. */
  stopOwner(owner: string): void { this.stopWhere((r) => r.owner === owner, 'The window was closed, so the program was stopped.'); }
  stopAll(): void { this.stopWhere(() => true, 'YouCoded closed, so the program was stopped.'); }
}
