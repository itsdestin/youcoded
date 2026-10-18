// Session setup reads user-controlled skill/plugin trees. Keep their synchronous
// scanner (and Claude's instruction inventory) off the thread serving every window.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { SessionContext, SkillEntry } from '../shared/types';

export type DiscoveryJob = { kind: 'skills'; cwd: string } | { kind: 'claude-context'; cwd: string; modelLabel: string | null };
export type DiscoveryReply = { ok: true; value: SkillEntry[] | SessionContext } | { ok: false; error: string };
interface DiscoveryWorker {
  on(event: 'message', cb: (reply: DiscoveryReply) => void): unknown;
  on(event: 'error' | 'exit', cb: (...args: any[]) => void): unknown;
  terminate(): Promise<unknown> | void;
  unref?(): void;
}

export function createSessionDiscovery(options: { spawn?: (job: DiscoveryJob) => DiscoveryWorker; timeoutMs?: number; stopTimeoutMs?: number } = {}) {
  const spawn = options.spawn ?? ((job: DiscoveryJob) => new Worker(path.join(__dirname, 'session-discovery-worker.js'), { workerData: job }));
  // Policy ceiling, not a claimed benchmark: a broken/network-mounted plugin
  // must fail setup rather than hold the discovery queue indefinitely.
  const timeoutMs = options.timeoutMs ?? 30_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 1000;
  let stopping: DiscoveryWorker | null = null;
  const pending = new Map<string, Promise<SkillEntry[] | SessionContext>>();
  let tail: Promise<unknown> = Promise.resolve();

  function run(job: DiscoveryJob): Promise<SkillEntry[] | SessionContext> {
    const key = JSON.stringify(job);
    const existing = pending.get(key);
    if (existing) return existing;
    // WHY serialize and coalesce: restoring many chats must not create a worker
    // per tab or multiply filesystem pressure. Only simultaneous identical jobs
    // share a result; a later session must see newly installed/edited skills.
    const task = tail.then(() => new Promise<SkillEntry[] | SessionContext>((resolve, reject) => {
      if (stopping) { reject(new Error('Session discovery is still stopping a previous worker. Try again in a moment.')); return; }
      let worker: DiscoveryWorker;
      try { worker = spawn(job); } catch (error) { reject(error); return; }
      let settled = false;
      let exited = false;
      const finish = (reply: DiscoveryReply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // WHY: terminate() may itself wait on blocked filesystem I/O. Bound
        // the caller's wait, but keep the slot occupied until the thread exits:
        // subsequent jobs fail explicitly instead of leaking more stuck workers.
        stopping = worker;
        worker.unref?.();
        let returned = false;
        const complete = () => {
          if (returned) return;
          returned = true;
          if (reply.ok) resolve(reply.value);
          else reject(new Error(reply.error));
        };
        const stopTimer = setTimeout(complete, stopTimeoutMs);
        void Promise.resolve().then(() => worker.terminate()).then(() => {
          if (stopping === worker) stopping = null;
          clearTimeout(stopTimer);
          complete();
        }, () => {
          if (exited && stopping === worker) stopping = null;
          clearTimeout(stopTimer);
          complete();
        });
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'Session discovery timed out.' }), timeoutMs);
      worker.on('message', finish);
      worker.on('error', (error: Error) => finish({ ok: false, error: error.message }));
      worker.on('exit', () => {
        exited = true;
        if (stopping === worker) stopping = null;
        finish({ ok: false, error: 'Session discovery worker exited before returning a result.' });
      });
    }));
    pending.set(key, task);
    tail = task.catch(() => {});
    void task.finally(() => { if (pending.get(key) === task) pending.delete(key); }).catch(() => {});
    return task;
  }

  return {
    skills: (cwd: string) => run({ kind: 'skills', cwd }) as Promise<SkillEntry[]>,
    claudeContext: (cwd: string, modelLabel: string | null) => run({ kind: 'claude-context', cwd, modelLabel }) as Promise<SessionContext>,
  };
}

export const sessionDiscovery = createSessionDiscovery();
