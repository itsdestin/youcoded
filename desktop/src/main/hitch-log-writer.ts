// Rotating, batched, async JSONL writer for the hitch recorder (hitch-recorder.ts).
// Same private-file pattern as providers/chatgpt-request-diagnostics.ts (dir 0700, file 0600,
// rotate by rename at a size cap), with three differences that matter here:
//  - lines are BUFFERED in memory and flushed at most every `flushMs` (2 s), so a burst of
//    hitches is one write, not one per line;
//  - the file is opened, appended and CLOSED on every flush — it is never held open, so a
//    reader (scripts/perf-lab/hitch-report.mjs) can read it from outside while the app runs;
//  - nothing here is synchronous: the main process must never block on this (performance rule 1).
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

export interface WriterOptions {
  dir: string;
  file?: string;
  rotatedFile?: string;
  /** Rotate when the live file would pass this many bytes (default 5 MiB; two files => ~10 MiB). */
  maxBytes?: number;
  flushMs?: number;
  /** Queued-but-unwritten bytes beyond which new lines are dropped (counted), so a stuck disk cannot grow memory. */
  maxQueueBytes?: number;
  fs?: Pick<typeof fsp, 'mkdir' | 'stat' | 'rename' | 'open'>;
}

export class RotatingJsonlWriter {
  private queue: string[] = [];
  private queued = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private dirReady = false;
  /** Lines lost to a full queue or a failed write — surfaced by the recorder so loss is visible, never silent. */
  lost = 0;
  rotations = 0;
  private readonly o: Required<Omit<WriterOptions, 'dir'>> & { dir: string };

  constructor(options: WriterOptions) {
    this.o = {
      file: 'hitches.jsonl', rotatedFile: 'hitches.1.jsonl', maxBytes: 5 * 1024 * 1024, flushMs: 2000,
      maxQueueBytes: 1024 * 1024, fs: fsp, ...options,
    };
  }

  /** Queue one JSON line. Never throws, never touches the disk (the flush timer does). */
  append(row: object): void {
    let line: string;
    try { line = JSON.stringify(row) + '\n'; } catch { this.lost++; return; }
    if (this.queued + line.length > this.o.maxQueueBytes) { this.lost++; return; }
    this.queue.push(line);
    this.queued += line.length;
    // WHY one-shot, armed on the first line: nothing wakes up while there is nothing to write.
    if (!this.timer && !this.flushing) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.o.flushMs);
      this.timer.unref();
    }
  }

  /** Write everything queued now. Safe to call at any time; concurrent calls share one write. */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.flushing) return this.flushing;
    if (!this.queue.length) return Promise.resolve();
    this.flushing = this.drain().finally(() => {
      this.flushing = undefined;
      // Lines queued while the write was in flight get their own timer.
      if (this.queue.length && !this.timer) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.o.flushMs);
        this.timer.unref();
      }
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    const lines = this.queue;
    this.queue = [];
    this.queued = 0;
    const text = lines.join('');
    const bytes = Buffer.byteLength(text);
    const { fs, dir } = this.o;
    const live = join(dir, this.o.file);
    try {
      if (!this.dirReady) { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); this.dirReady = true; }
      // stat every flush (at most one per 2 s): robust if someone deletes or trims the file by hand.
      const st = await fs.stat(live).catch(() => null);
      if (st && st.size > 0 && st.size + bytes > this.o.maxBytes) {
        // rename replaces an existing hitches.1.jsonl atomically: two files max, never a gap.
        await fs.rename(live, join(dir, this.o.rotatedFile));
        this.rotations++;
      }
      const handle = await fs.open(live, 'a', 0o600);
      try { await handle.writeFile(text); } finally { await handle.close(); }
    } catch {
      // A failed write drops this batch rather than retrying forever; the count shows up in the next minute line.
      this.lost += lines.length;
    }
  }
}
