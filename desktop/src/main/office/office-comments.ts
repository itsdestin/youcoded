// Comments on a document open in Office go through its editor — finish plan Task 6.
//
// WHY: the editor saves what it holds. A comment the assistant (or the reading view) writes into
// the FILE while Office has it open is erased by the editor's next autosave. So while a document
// is open, doc-comments' requests are sent to the editor that holds it (live-comments.ts says
// what to send; this module gets it there and back):
//   main → its window   office:comments-request {token, id, op}   (the window that opened it)
//   window → main       office:comments-answer  id, result, token (that window, for that document)
//   window → main       office:comments-changed token             (a comment changed in the editor)
// The window relays to its editor frame (EditorFrame → the add-on's yc-comments.js).
//
// When the editor cannot answer — still opening, a cell being typed in, no answer in 3 s — the
// change is kept, per file and in order, and tried again every 1.5 s; if the editor closes first,
// it is written to the file as before. A read is never kept: it reads the file instead.
// Desktop only, like the quit prompt (main/unsaved-quit.ts): the phone and the remote client
// have no Office editors, so they carry none of these channels.
import { randomBytes } from 'node:crypto';
import { webContents } from 'electron';
import { log } from '../logger';
import { getOfficeSessions } from './office-session-registry';
import { EditorNotReady, setLiveCommentsRouter, type Ask, type LiveAnswer, type LiveCommentsRouter, type LiveOp } from '../doc-comments/live-comments';
import { nudgeDocumentComments } from '../doc-comments/doc-comments-watcher';

export const OFFICE_COMMENTS_REQUEST = 'office:comments-request';
export const OFFICE_COMMENTS_ANSWER = 'office:comments-answer';
export const OFFICE_COMMENTS_CHANGED = 'office:comments-changed';

/** WHY 3 s: an editor answers in milliseconds (measured); one that has not answered in 3 s is
 *  busy or gone, and the assistant's own wait for the whole request is 8 s. */
const ANSWER_CAP_MS = 3_000;
const RETRY_MS = 1_500;
/** A kept change older than this is dropped (logged): the editor never became ready. */
const KEEP_MS = 10 * 60_000;
const KEEP_MAX = 50; // per file

interface Session { token: string; path: string; senderId: number }
interface Registry { latestByPath(p: string): Session | undefined; inUse(p: string): boolean; get(token: string): Session | undefined }
interface Target { send(channel: string, ...args: unknown[]): void; isDestroyed(): boolean }
interface Ipc {
  on(channel: string, l: (e: unknown, ...args: unknown[]) => void): unknown;
}
export interface OfficeCommentsDeps {
  sessions(): Registry | null;
  windowFor(senderId: number): Target | null;
  ipc: Ipc;
  /** A comment changed in the editor of this (real) path: tell the reading views. */
  onChanged(realPath: string): void;
  capMs?: number;
  retryMs?: number;
}

interface Kept { work: (ask: Ask) => Promise<unknown>; fallback: () => Promise<unknown>; key: string; at: number }

let seq = 0;

export function createOfficeComments(deps: OfficeCommentsDeps): LiveCommentsRouter & { pending(path: string): number } {
  const capMs = deps.capMs ?? ANSWER_CAP_MS;
  const retryMs = deps.retryMs ?? RETRY_MS;
  const waiting = new Map<string, { senderId: number; token: string; done: (r: unknown) => void }>();
  const kept = new Map<string, Kept[]>();
  const draining = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  deps.ipc.on(OFFICE_COMMENTS_ANSWER, (e, id, result, token) => {
    const w = typeof id === 'string' ? waiting.get(id) : undefined;
    // Only the window that was asked answers, and only for the document it was asked about: a
    // window can hold several documents, and a request id alone is no proof of which one answered.
    if (!w || (e as { sender?: { id?: unknown } } | null)?.sender?.id !== w.senderId || token !== w.token) return;
    waiting.delete(id as string);
    w.done(result);
  });
  deps.ipc.on(OFFICE_COMMENTS_CHANGED, (e, token) => {
    const s = typeof token === 'string' ? deps.sessions()?.get(token) : undefined;
    if (!s || (e as { sender?: { id?: unknown } } | null)?.sender?.id !== s.senderId) return;
    deps.onChanged(s.path);
  });

  /** One op to the editor of `s`. Throws EditorNotReady when it cannot answer now. */
  function ask(s: Session, op: LiveOp & { key: string }): Promise<LiveAnswer> {
    const win = deps.windowFor(s.senderId);
    if (!win || win.isDestroyed()) return Promise.reject(new EditorNotReady());
    // Unguessable, so no editor can answer for another request it was never sent.
    const id = randomBytes(12).toString('hex');
    return new Promise<LiveAnswer>((resolve, reject) => {
      const t = setTimeout(() => { waiting.delete(id); reject(new EditorNotReady()); }, capMs);
      waiting.set(id, {
        senderId: s.senderId,
        token: s.token,
        done: (raw) => {
          clearTimeout(t);
          const r = raw as { ok?: unknown; error?: unknown } | null;
          if (!r || typeof r !== 'object' || typeof r.ok !== 'boolean') { resolve({ ok: false, error: 'apply-failed' }); return; }
          if (r.ok === false && (r.error === 'editor-not-ready' || r.error === 'editor-busy')) { reject(new EditorNotReady()); return; }
          resolve(r as LiveAnswer);
        },
      });
      try { win.send(OFFICE_COMMENTS_REQUEST, { token: s.token, id, op }); } catch { waiting.delete(id); clearTimeout(t); reject(new EditorNotReady()); }
    });
  }

  /** Runs `work` against the editor; each op it sends carries `<key>:<n>`, the same on a retry,
   *  so an op the editor did but whose answer was late is not done twice (yc-comments.js). */
  function attempt<T>(s: Session, work: (a: Ask) => Promise<T>, key: string): Promise<T> {
    let n = 0;
    return work((op) => ask(s, { ...op, key: `${key}:${n++}` }));
  }

  function keep(path: string, item: Kept): void {
    const list = kept.get(path) ?? [];
    if (list.length >= KEEP_MAX) { log('WARN', 'OfficeComments', 'too many comment changes waiting for one document; the oldest was dropped', { count: list.length }); list.shift(); }
    list.push(item);
    kept.set(path, list);
    arm();
  }
  function arm(): void {
    if (timer || kept.size === 0) return;
    timer = setTimeout(() => { timer = null; void drainAll().finally(arm); }, retryMs);
    timer.unref?.();
  }
  async function drainAll(): Promise<void> {
    await Promise.all([...kept.keys()].map((p) => drain(p)));
  }
  async function drain(path: string): Promise<void> {
    if (draining.has(path)) return;
    draining.add(path);
    try {
      const list = kept.get(path) ?? [];
      while (list.length > 0) {
        const item = list[0];
        if (Date.now() - item.at > KEEP_MS) {
          list.shift();
          log('WARN', 'OfficeComments', 'a comment change waited too long for its document\'s editor and was dropped', {});
          continue;
        }
        const reg = deps.sessions();
        const s = reg?.latestByPath(path);
        if (s) {
          try { await attempt(s, item.work, item.key); } catch (e) {
            if (e instanceof EditorNotReady) break; // still not ready: next round
            log('WARN', 'OfficeComments', 'a kept comment change failed in the editor', { kind: e instanceof Error ? e.name : typeof e });
          }
        } else if (!reg || !reg.inUse(path)) {
          // Closed (or Office stopped): the file is the editor's no more — write it as before.
          await item.fallback().catch((e: unknown) => log('WARN', 'OfficeComments', 'a kept comment change could not be written to the file', { kind: e instanceof Error ? e.name : typeof e }));
        } else {
          break; // opening or closing: wait for it to settle
        }
        list.shift();
      }
      if (list.length === 0) kept.delete(path);
    } finally {
      draining.delete(path);
    }
  }

  return {
    async run<T>(realPath: string, work: (ask: Ask) => Promise<T>, fallback: () => Promise<unknown>, opts: { queueable: boolean }) {
      const reg = deps.sessions();
      if (!reg) return null;
      const key = `k${++seq}-${Date.now().toString(36)}`;
      const item: Kept = { work: work as (a: Ask) => Promise<unknown>, fallback, key, at: Date.now() };
      // Changes already waiting for this file go first: a new one waits behind them, in order.
      if (kept.has(realPath)) {
        if (!opts.queueable) return null;
        keep(realPath, item);
        return { how: 'queued' as const };
      }
      const s = reg.latestByPath(realPath);
      if (!s) {
        // Not open: the file as before. Opening or closing: a write now could be lost (the
        // opening editor may have read the file already; a closing one's last save may follow).
        if (!reg.inUse(realPath) || !opts.queueable) return null;
        keep(realPath, item);
        return { how: 'queued' as const };
      }
      try {
        return { how: 'live' as const, value: await attempt(s, work, key) };
      } catch (e) {
        if (!(e instanceof EditorNotReady)) throw e;
        if (!opts.queueable) return null;
        keep(realPath, item);
        return { how: 'queued' as const };
      }
    },
    pending: (path: string) => kept.get(path)?.length ?? 0,
  };
}

/** Desktop startup (main.ts), after registerOfficeIpc. */
export function registerOfficeComments(ipc: Ipc): void {
  setLiveCommentsRouter(createOfficeComments({
    sessions: () => getOfficeSessions(),
    windowFor: (id) => webContents.fromId(id) ?? null,
    ipc,
    onChanged: (realPath) => nudgeDocumentComments(realPath),
  }));
}
