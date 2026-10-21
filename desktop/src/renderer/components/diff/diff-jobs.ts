import DiffWorker from './diff.worker?worker';
import type { DiffRequest, DiffReply } from './diff.worker';
import type { DiffRow } from './diff-rows';

type DiffWorkerPort = Pick<Worker, 'onmessage' | 'onerror' | 'postMessage' | 'terminate'>;
interface Job {
  input: DiffRequest;
  done: boolean;
  worker?: DiffWorkerPort;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (rows: DiffRow[] | null) => void;
  reject: (error: Error) => void;
}

/** One active comparison per window, not one CPU-heavy worker per tool card.
 * Cancellation kills obsolete active work instead of making the next file wait.
 * The 60s ceiling is a resource policy, not a measured performance assertion. */
export function createDiffQueue(spawn: () => DiffWorkerPort = () => new DiffWorker(), timeoutMs = 60_000) {
  const queued: Job[] = [];
  let active: Job | null = null;
  const finish = (job: Job, result: DiffRow[] | null | Error) => {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    job.worker?.terminate();
    if (active === job) active = null;
    const index = queued.indexOf(job);
    if (index >= 0) queued.splice(index, 1);
    if (result instanceof Error) job.reject(result);
    else job.resolve(result);
    queueMicrotask(pump);
  };
  const pump = () => {
    if (active || queued.length === 0) return;
    const job = queued.shift()!;
    active = job;
    try {
      const worker = spawn();
      job.worker = worker;
      worker.onmessage = (event: MessageEvent<DiffReply>) => {
        const reply = event.data;
        finish(job, reply?.ok && Array.isArray(reply.rows) ? reply.rows : new Error('Couldn’t calculate this comparison.'));
      };
      worker.onerror = (event) => { event.preventDefault(); finish(job, new Error('Couldn’t calculate this comparison.')); };
      job.timer = setTimeout(() => finish(job, new Error('The comparison took too long.')), timeoutMs);
      worker.postMessage(job.input);
    } catch {
      // Never run the expensive computation on the page as a fallback: that
      // would reintroduce the freeze precisely when the worker is unavailable.
      finish(job, new Error('Couldn’t start this comparison.'));
    }
  };
  return {
    request(input: DiffRequest) {
      let job: Job;
      const promise = new Promise<DiffRow[] | null>((resolve, reject) => {
        job = { input, done: false, resolve, reject };
        queued.push(job);
      });
      queueMicrotask(pump);
      return { promise, cancel: () => finish(job!, null) };
    },
  };
}

export const diffQueue = createDiffQueue();
