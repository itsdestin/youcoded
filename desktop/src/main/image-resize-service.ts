// Owns the resize worker threads: one Worker per job, terminated the moment it
// answers (or errors, or exceeds its time limit) so the decoded bitmap's
// memory goes back with the thread. image-prepare.ts already serialises jobs.
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { ResizeFn, ResizeResult } from './harness/image-prepare';
import type { ResizeJob, ResizeReply } from './image-resize-worker';

export interface WorkerLike {
  on(event: 'message', cb: (reply: ResizeReply) => void): void;
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

/** Per-job time limit: 3× the measured wall time at the incident size, floored at 15 s.
 *  WHY 15 s: the BUILT worker resizing a 2904×17528 PNG to 1221×7372 over a real
 *  worker_threads Worker (2026-10-07, Linux, 32 cores, idle) took 1.87 s for flat
 *  pixels and 3.11 s for incompressible noise — the worst case for inflate.
 *  Memory: the 951 MB (flat) and 1.56 GB (noise) figures are WHOLE-PROCESS RSS read
 *  at job end (process peak 1.37 GB / 1.96 GB), and they INCLUDE the smoke test's
 *  own synthetic 203 MB source bitmap; the worker's own share is roughly 0.6–1.2 GB.
 *  3 × 3.11 s = 9.3 s is under the floor, so the floor wins; it leaves room for a
 *  slower or busier machine without letting a stuck job hold the send for a minute.
 *  Not exported: nothing outside this file reads it (knip's ratchet). */
const RESIZE_JOB_TIMEOUT_MS = 15_000;

export function createResizeService(opts: { spawn?: (job: ResizeJob) => WorkerLike; jobTimeoutMs?: number } = {}): { resize: ResizeFn } {
  const spawn = opts.spawn ?? nodeSpawn;
  const jobTimeoutMs = opts.jobTimeoutMs ?? RESIZE_JOB_TIMEOUT_MS;
  const resize: ResizeFn = (req) => new Promise((resolve) => {
    let settled = false;
    const job: ResizeJob = { bytes: new Uint8Array(req.bytes.buffer, req.bytes.byteOffset, req.bytes.byteLength), width: req.width, height: req.height, format: req.format };
    const worker = spawn(job);
    const finish = (result: ResizeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    // WHY resolve a typed failure, not reject: the preparer turns each reason
    // into its OWN honest refusal — a slow job is "took longer than N s", a
    // crashed worker is "the shrinking step failed", and only the worker's own
    // `undecodable` verdict may blame the picture's format.
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', afterMs: jobTimeoutMs }), jobTimeoutMs);
    worker.on('message', (reply) => finish(reply?.ok ? { ok: true, bytes: Buffer.from(reply.bytes.buffer, reply.bytes.byteOffset, reply.bytes.byteLength) }
      : { ok: false, reason: reply?.reason === 'undecodable' ? 'undecodable' : 'failed' }));
    worker.on('error', () => finish({ ok: false, reason: 'failed' }));
    worker.on('exit', () => finish({ ok: false, reason: 'failed' }));
  });
  return { resize };
}
