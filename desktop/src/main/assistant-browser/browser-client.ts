// The main process's handle on the Browser worker (browser-host.ts).
//
// A thin proxy: it forks the worker on first use, numbers each request, turns
// an abort into a `cancel` message, and re-emits the worker's state/frame
// events. It holds NO browser logic and no policy (one owner: the worker).
//
// Crash handling (design review 2 #7): if the worker dies, every pending
// request resolves with a plain error and the next request forks a new one.
// Respawns are capped (3 per 5 minutes) so a worker that dies on start can't
// loop; the voice worker's respawn bug (voice-handlers.ts) leaked 1.14 GB per
// loop, so the old process is always killed before a new one starts.
import { EventEmitter } from 'events';
import type { BrowserSessionState, FrameEvent } from './browser-service';
import type { BrowserCommand, MainToWorker, WorkerToMain } from './browser-protocol';
import type { RunResult } from './browser-tool-runners';

/** The bits of Electron's UtilityProcess this uses — injectable for tests. */
export interface WorkerHandle {
  postMessage(m: MainToWorker): void;
  on(event: 'message', cb: (m: WorkerToMain) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
  kill(): void;
}

export interface BrowserClientOptions {
  /** The conversation's permission mode as the app last read it (native 'ask' | 'auto-edit' | 'full-auto'; Claude Code 'normal' | 'bypass' | …).
   *  WHY here: the worker has no session records; the form-submit ask must know whether the person chose Full Auto. */
  modeOf?: (sessionId: string) => string | null | undefined;
  fork: () => WorkerHandle;
  log?: (level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>) => void;
}

// WHY a late-bound lookup (kept here, not in browser-electron.ts, so tests and headless code never import electron):
// the client is created on first use, but the session records the mode is read from are built by create-runtime.ts.
// Same pattern as setOutsideCommentsModeLookup.
let modeLookup: (sessionId: string) => string | null | undefined = () => null;
export function setBrowserModeLookup(lookup: (sessionId: string) => string | null | undefined): void { modeLookup = lookup; }
export function browserModeOf(sessionId: string): string | null | undefined { return modeLookup(sessionId); }

const RESPAWN_WINDOW_MS = 5 * 60_000;
const MAX_RESPAWNS = 3;

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class BrowserClient extends EventEmitter {
  private worker: WorkerHandle | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly spawns: number[] = [];
  private readonly lastState = new Map<string, BrowserSessionState>();
  private disposed = false;

  constructor(private readonly opts: BrowserClientOptions) { super(); }

  /** Whether the worker is up (the browser itself may still be stopped). */
  get alive(): boolean { return this.worker !== null; }

  private ensure(): WorkerHandle {
    if (this.worker) return this.worker;
    if (this.disposed) throw new Error('The browser is shutting down.');
    const now = Date.now();
    while (this.spawns.length && now - this.spawns[0] > RESPAWN_WINDOW_MS) this.spawns.shift();
    if (this.spawns.length >= MAX_RESPAWNS) throw new Error('The browser stopped working several times in a row, so it is paused for a few minutes.');
    this.spawns.push(now);
    const w = this.opts.fork();
    this.worker = w;
    w.on('message', (m) => this.onMessage(m));
    w.on('exit', (code) => {
      if (this.worker !== w) return;
      this.worker = null;
      if (!this.disposed) this.opts.log?.('WARN', 'Browser worker exited', { code });
      const err = new Error('The browser stopped unexpectedly during this step. Try again.');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      // Every conversation's panel learns the browser is gone.
      for (const [sid, st] of this.lastState) {
        const next: BrowserSessionState = { ...st, run: 'stopped', tabs: [], prompt: null, busy: false };
        this.lastState.set(sid, next);
        this.emit('state', next);
      }
    });
    return w;
  }

  private onMessage(m: WorkerToMain): void {
    switch (m.t) {
      case 'reply': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
        return;
      }
      case 'state':
        this.lastState.set(m.state.sessionId, m.state);
        this.emit('state', m.state);
        return;
      case 'frame': this.emit('frame', m.frame as FrameEvent); return;
      case 'info-changed': this.emit('info-changed'); return;
      case 'log': this.opts.log?.(m.level, m.msg, m.data); return;
    }
  }

  private request<T>(build: (id: number) => MainToWorker, signal?: AbortSignal): Promise<T> {
    // WHY: a cancel sent before its call is lost by the worker, and must not
    // start a worker merely to cancel work that was never dispatched.
    if (signal?.aborted) return Promise.reject(new Error('Browser call cancelled; not started.'));
    let w: WorkerHandle;
    try { w = this.ensure(); } catch (e) { return Promise.reject(e); }
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => w.postMessage({ t: 'cancel', id });
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      this.pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value as T); },
        reject: (error) => { cleanup(); reject(error); },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try { w.postMessage(build(id)); }
      catch (error) { cleanup(); reject(error); }
    });
  }

  /** Run one Browser tool. Never rejects: a worker failure becomes an error result. */
  async callTool(sessionId: string, tool: string, args: unknown, opts: { signal?: AbortSignal; vision: boolean }): Promise<RunResult> {
    try {
      return await this.request<RunResult>((id) => ({ t: 'call', id, sessionId, tool, args, vision: opts.vision, mode: this.opts.modeOf?.(sessionId) ?? null }), opts.signal);
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
  }

  command<T = unknown>(command: BrowserCommand): Promise<T> {
    return this.request<T>((id) => ({ t: 'cmd', id, command }));
  }

  /** A command that only makes sense if the worker already exists (unwatch,
   *  ack, closing a conversation's tabs): never forks a worker just to say no. */
  commandIfAlive(command: BrowserCommand): void {
    if (!this.worker) return;
    void this.command(command).catch(() => undefined);
  }

  /** The last state the worker reported for a conversation, without starting it. */
  cachedState(sessionId: string): BrowserSessionState | null { return this.lastState.get(sessionId) ?? null; }

  /** App quit: ask the worker to close the browser, then make sure it's gone. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const w = this.worker;
    if (!w) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { w.kill(); resolve(); }, 3000);
      t.unref?.();
      w.on('exit', () => { clearTimeout(t); resolve(); });
      try { w.postMessage({ t: 'shutdown' }); } catch { w.kill(); resolve(); }
    });
    this.worker = null;
  }
}
