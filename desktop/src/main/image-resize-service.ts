// Owns the resize worker threads: one Worker per job, terminated the moment it
// answers (or errors, or exceeds its time limit) so the decoded bitmap's
// memory goes back with the thread. image-prepare.ts already serialises jobs.
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { ResizeFn } from './harness/image-prepare';
import type { ResizeJob } from './image-resize-worker';

export interface WorkerLike {
  on(event: 'message', cb: (bytes: Uint8Array | null) => void): void;
  on(event: 'error' | 'exit', cb: (...a: any[]) => void): void;
  terminate(): Promise<unknown> | void;
}

/** Where the compiled worker sits next to this file, in dev and packaged alike
 *  (`tsc` emits both into dist/main/) — the same way voice-service.ts's
 *  voiceWorkerPath() finds voice-worker.js. */
function workerPath(): string { return path.join(__dirname, 'image-resize-worker.js'); }

function nodeSpawn(job: ResizeJob): WorkerLike {
  return new Worker(workerPath(), { workerData: job });
}

/** Per-job time limit. EXECUTOR: set this to 3× the wall time measured for the
 *  real 2904×17528 incident size in Task 11 step 2b (never below 15 s) and
 *  record the measurement here; 60 s is a placeholder, not a measurement.
 *  Not exported: nothing outside this file reads it (knip's ratchet). */
const RESIZE_JOB_TIMEOUT_MS = 60_000;

export function createResizeService(opts: { spawn?: (job: ResizeJob) => WorkerLike; jobTimeoutMs?: number } = {}): { resize: ResizeFn } {
  const spawn = opts.spawn ?? nodeSpawn;
  const jobTimeoutMs = opts.jobTimeoutMs ?? RESIZE_JOB_TIMEOUT_MS;
  const resize: ResizeFn = (req) => new Promise((resolve) => {
    let settled = false;
    const job: ResizeJob = { bytes: new Uint8Array(req.bytes.buffer, req.bytes.byteOffset, req.bytes.byteLength), width: req.width, height: req.height, format: req.format };
    const worker = spawn(job);
    const finish = (bytes: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(bytes);
    };
    // WHY resolve null, not reject: a dead or slow worker is "could not
    // downscale", which the preparer already turns into an honest refusal.
    const timer = setTimeout(() => finish(null), jobTimeoutMs);
    worker.on('message', (bytes) => finish(bytes ? Buffer.from(bytes) : null));
    worker.on('error', () => finish(null));
    worker.on('exit', () => finish(null));
  });
  return { resize };
}
