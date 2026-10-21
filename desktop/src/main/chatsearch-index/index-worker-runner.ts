import { Worker } from 'node:worker_threads';
import path from 'node:path';

export interface IndexJob {
  homeRoot: string;
  storeRoot: string;
  tagsRoot: string | null;
}
export type IndexReply = { ok: true; value: boolean } | { ok: false; error: string };
interface IndexWorker {
  on(event: 'message', cb: (reply: IndexReply) => void): unknown;
  on(event: 'error', cb: (error: Error) => void): unknown;
  on(event: 'exit', cb: (code: number) => void): unknown;
  terminate(): Promise<unknown>;
  unref(): void;
}

export function createIndexWorkerRunner(options: {
  spawn?: (job: IndexJob) => IndexWorker;
  timeoutMs?: number;
  onIdle?: () => void;
} = {}) {
  const spawn = options.spawn ?? ((job: IndexJob) => new Worker(path.join(__dirname, 'index-worker.js'), { workerData: job }));
  // WHY below the existing five-minute stale-lock horizon: stop a runaway build
  // before another process would normally assume its lock is abandoned. A stuck
  // filesystem can delay thread exit; never delete its lock from this runner.
  const timeoutMs = options.timeoutMs ?? 120_000;
  let active: { worker: IndexWorker; cancel: () => void } | null = null;

  return {
    busy: () => active !== null,
    stop: () => { active?.cancel(); },
    run(job: IndexJob): Promise<boolean> {
      if (active) return Promise.reject(new Error('Chatsearch index worker is still running or stopping.'));
      return new Promise((resolve, reject) => {
        let worker: IndexWorker;
        try { worker = spawn(job); } catch (error) { reject(error); return; }
        let settled = false;
        let cancelled = false;
        let reply: IndexReply | null = null;
        const finish = (result: IndexReply) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (result.ok) resolve(result.value);
          else reject(new Error(result.error));
        };
        const cancel = (error = 'Chatsearch index refresh stopped.') => {
          if (cancelled) return;
          cancelled = true;
          // WHY settle immediately but retain active: terminate can wait on IO.
          // Caller wait is bounded; no replacement writer until the EXIT event.
          finish({ ok: false, error });
          worker.unref();
          void worker.terminate().catch(() => {});
        };
        const timer = setTimeout(() => cancel('Chatsearch index refresh timed out.'), timeoutMs);
        timer.unref?.();
        active = { worker, cancel };
        worker.on('message', (result) => { if (!cancelled && !reply) reply = result; });
        worker.on('error', (error) => cancel(error.message));
        worker.on('exit', (code) => {
          // WHY do not terminate on a success message: the worker releases the
          // shared build lock in finally, then exits naturally. No cleanup here
          // can accidentally remove a different process's replacement lock.
          if (active?.worker === worker) active = null;
          finish(code === 0 && reply ? reply : { ok: false, error: 'Chatsearch index worker exited without a result.' });
          options.onIdle?.();
        });
      });
    },
  };
}
