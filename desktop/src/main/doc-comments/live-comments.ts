// Comments on a Word/Excel file that Office has open — finish plan Task 6.
//
// WHY: a comment written into the FILE while Office has it open is erased by the editor's next
// autosave (the editor saves what it holds, and it never saw the comment). So while an editor
// holds the file, every comment read and change goes to that editor instead: the comment shows in
// the editor at once, and the editor's own autosave writes it to the file. When no editor holds
// the file, nothing here applies and the file is read and written exactly as before.
//
// This module is the format side: it turns the dispatch's requests (doc-comments-dispatch.ts)
// into editor operations and the editor's comments back into `PersistedComment`s with the same
// ids the file gives them. The window side — finding the editor, sending, waiting, queueing —
// is a `LiveCommentsRouter` that the desktop's Office module registers (main/office/
// office-comments.ts). Android has no Office editor and never registers one.
//
// IDs. Excel comments keep their GUID through the editor and its save (measured: the editor's
// sGuid becomes the file's threadedComment id), so a live comment gets the file's own id,
// `xt-<sheetId>-<cell>-<guid>`. Word renumbers comments on every save (`w-<n>` is the comment's
// w:id), so while the document is open a Word comment is named by the editor's own id,
// `oo-<editor id>`, which holds until it closes; a `w-<n>` id read from the file earlier still
// finds its comment (matched on author, text and quoted text).
import { promises as fs } from 'fs';
import JSZip from 'jszip';
import { readDocxComments } from './docx-comments';
import { buildXlsxThreadId, parseXlsxThreadId, readXlsxComments } from './xlsx-comments';
import type { NativeFormat } from './native-format';
import type { CommentAuthor, CommentReply, CommentSelector, PersistedComment } from '../../shared/doc-comments-types';

/** One operation for the editor (the add-on's yc-comments.js). */
export type LiveOp =
  | { kind: 'list' }
  | { kind: 'add'; text: string; author: string; quote?: string; occurrence?: number; sheet?: string; cell?: string }
  | { kind: 'reply'; id: string; text: string; author: string }
  | { kind: 'resolve' | 'reopen' | 'delete'; id: string }
  | { kind: 'edit'; id: string; text: string }
  | { kind: 'edit-reply'; id: string; index: number; text: string }
  | { kind: 'delete-reply'; id: string; index: number }
  | { kind: 'move'; id: string; quote?: string; occurrence?: number; sheet?: string; cell?: string };

/** A comment as the editor reports it. `time` is milliseconds (0: unknown). */
export interface LiveComment {
  id: string;
  text: string;
  author: string;
  time: number;
  solved: boolean;
  quote?: string;
  sheet?: string;
  cell?: string;
  guid?: string;
  replies: Array<{ text: string; author: string; time: number }>;
}

export type LiveAnswer =
  | { ok: true; comments?: LiveComment[]; id?: string; guid?: string; index?: number }
  | { ok: false; error: string };

/** Sends one op to the editor that holds the file; throws `EditorNotReady` when it cannot answer now. */
export type Ask = (op: LiveOp) => Promise<LiveAnswer>;

export class EditorNotReady extends Error {
  constructor() { super('editor-not-ready'); this.name = 'EditorNotReady'; }
}

/**
 * The window side (main/office/office-comments.ts).
 * `run` returns null when no editor holds `realPath` — the caller then uses the file as before.
 * Otherwise it runs `work` against the editor. When the editor cannot answer (still opening, a
 * cell being typed in, no answer in time), a `queueable` request is kept and `work` runs again
 * once it can — or, if the editor closes first, `fallback` writes the file — and `run` says
 * `queued`. A request that is not queueable (a read) returns null instead: the file is read.
 */
export interface LiveCommentsRouter {
  run<T>(realPath: string, work: (ask: Ask) => Promise<T>, fallback: () => Promise<unknown>, opts: { queueable: boolean }): Promise<{ how: 'live'; value: T } | { how: 'queued' } | null>;
}

let router: LiveCommentsRouter | null = null;
/** Desktop's Office module registers itself once at startup; tests set and clear it. */
export function setLiveCommentsRouter(r: LiveCommentsRouter | null): void {
  router = r;
}

// ── Names ──
/** The name a new comment carries — the same names docx-comments.ts / xlsx-comments.ts write. */
function displayNameFor(author: CommentAuthor): string {
  if (author === 'user') return 'You';
  if (author === 'assistant') return 'Assistant';
  if (author.startsWith('person:')) return author.slice('person:'.length) || 'Unknown';
  return 'Unknown';
}
// Read back the way the file readers do: every name is a person (the reading view shows it).
const authorOf = (name: string): CommentAuthor => `person:${name || 'Unknown'}`;

// ── The file's own view, for matching ids ──
interface FileView { comments: PersistedComment[]; sheetIds: Map<string, number>; singleSheet: boolean }

async function fileView(format: NativeFormat, absolutePath: string, path: string): Promise<FileView> {
  const empty: FileView = { comments: [], sheetIds: new Map(), singleSheet: true };
  let bytes: Buffer;
  try { bytes = await fs.readFile(absolutePath); } catch { return empty; }
  const read = format === 'docx' ? await readDocxComments(bytes, path) : await readXlsxComments(bytes, path);
  const comments = read.ok ? read.comments : [];
  if (format === 'docx') return { ...empty, comments };
  const sheetIds = await xlsxSheetIds(bytes);
  return { comments, sheetIds, singleSheet: sheetIds.size <= 1 };
}

/** name -> sheetId, from xl/workbook.xml (the number in an `xt-` id). */
async function xlsxSheetIds(bytes: Buffer): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const xml = await (await JSZip.loadAsync(bytes)).file('xl/workbook.xml')?.async('string');
    for (const m of (xml ?? '').matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)) {
      const name = /\bname="([^"]*)"/.exec(m[1])?.[1];
      const id = /\bsheetId="(\d+)"/.exec(m[1])?.[1];
      if (name !== undefined && id) out.set(decodeXml(name), Number(id));
    }
  } catch { /* not readable: every sheet gets the unknown id below */ }
  return out;
}
function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e] ?? _);
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const normGuid = (g: string) => g.replace(/[{}]/g, '').toLowerCase();

/** editor id -> the app id the reading view and the assistant use (see the header). */
function appIds(format: NativeFormat, live: LiveComment[], file: FileView): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of live) {
    // Excel: the file's own id (its GUID survives the save). A sheet the file does not have yet
    // (added in the editor, not saved) is 0 until the save.
    if (format === 'xlsx' && c.guid && c.cell) out.set(c.id, buildXlsxThreadId(file.sheetIds.get(c.sheet ?? '') ?? 0, c.cell, c.guid));
    // Word: the editor's own id. WHY not the file's w-<n>: Office renumbers every comment on every
    // save (measured: one autosave turned w-5 into w-7), so an id handed out while the document
    // is open would name a different comment, or none, seconds later. The editor's id holds for as
    // long as the document stays open.
    else out.set(c.id, `oo-${c.id}`);
  }
  return out;
}

/** Word: editor id -> the file comment with the same author, text and quote, matched in order;
 *  each file comment is used once. Lets a `w-<n>` id the assistant read from the file before the
 *  document opened still name its comment, and keeps the saved comment's quote context. */
function matchWordFile(live: LiveComment[], file: FileView): Map<string, PersistedComment> {
  const out = new Map<string, PersistedComment>();
  const unused = file.comments.slice();
  for (const c of live) {
    const i = unused.findIndex((f) => displayNameOf(f.author) === c.author && norm(f.text) === norm(c.text)
      && (f.selector.kind !== 'text' || norm(f.selector.selector.exact) === norm(c.quote ?? '')));
    if (i >= 0) { out.set(c.id, unused[i]); unused.splice(i, 1); }
  }
  return out;
}
const displayNameOf = (a: CommentAuthor) => (a.startsWith('person:') ? a.slice('person:'.length) : displayNameFor(a));

function toPersisted(format: NativeFormat, path: string, live: LiveComment[], file: FileView): PersistedComment[] {
  const ids = appIds(format, live, file);
  const byId = new Map(file.comments.map((c) => [c.id, c]));
  const word = format === 'docx' ? matchWordFile(live, file) : null;
  return live.map((c) => {
    const id = ids.get(c.id)!;
    const saved = word ? word.get(c.id) : byId.get(id);
    const selector: CommentSelector = format === 'xlsx'
      ? { kind: 'cell', selector: { type: 'CellSelector', cell: c.cell ?? 'A1', ...(file.singleSheet ? {} : { sheet: c.sheet }) } }
      // The saved comment's selector carries the context around the quote; a new one has only the quote.
      : saved?.selector ?? { kind: 'text', selector: { type: 'TextQuoteSelector', exact: c.quote ?? '', prefix: '', suffix: '', occurrence: 0 } };
    const replies: CommentReply[] = c.replies.map((r, i) => ({ id: `${id}-r${i + 1}`, author: authorOf(r.author), text: r.text, createdAt: r.time || saved?.replies[i]?.createdAt || Date.now() }));
    return {
      id, path, selector, text: c.text, author: authorOf(c.author),
      createdAt: c.time || saved?.createdAt || Date.now(),
      replies, resolved: c.solved, history: saved?.history ?? [],
      // The editor holds every comment it lists on its own text: anchored by definition.
      status: 'anchored' as const,
    };
  });
}

/** Splits `<thread>-r<n>` into the thread id and the reply's 0-based index. */
function splitReply(replyId: string): { thread: string; index: number } | null {
  const m = /^(.*)-r(\d+)$/.exec(replyId);
  return m && Number(m[2]) >= 1 ? { thread: m[1], index: Number(m[2]) - 1 } : null;
}

/** The editor's id for an app id, using a fresh list (null: no such comment in the editor). */
function editorIdFor(format: NativeFormat, appId: string, live: LiveComment[], file: FileView): string | null {
  if (appId.startsWith('oo-')) return live.some((c) => c.id === appId.slice(3)) ? appId.slice(3) : null;
  if (format === 'xlsx') {
    const parsed = parseXlsxThreadId(appId);
    if (parsed) return live.find((c) => c.guid && normGuid(c.guid) === normGuid(parsed.guid))?.id ?? null;
  }
  if (format === 'docx') {
    for (const [editorId, saved] of matchWordFile(live, file)) if (saved.id === appId) return editorId;
    return null;
  }
  for (const [editorId, id] of appIds(format, live, file)) if (id === appId) return editorId;
  return null;
}

// ── The dispatch's entry points ──
// Each returns null when no editor holds the file (the caller goes on to the file), the
// request's own result shape when the editor did it, or `{ok:true, queued:true}` when it is kept
// for later (see LiveCommentsRouter.run).
type Queued = { ok: true; queued: true };
type NotFound = { ok: false; error: string };
type Live<T> = Promise<T | Queued | null>;

interface Target { format: NativeFormat; absolutePath: string; path: string }

async function route<T>(t: Target, work: (ask: Ask, file: () => Promise<FileView>) => Promise<T>, fallback: () => Promise<unknown>, queueable = true): Live<T> {
  if (!router) return null;
  const file = () => fileView(t.format, t.absolutePath, t.path);
  const r = await router.run(t.absolutePath, (ask) => work(ask, file), fallback, { queueable });
  if (!r) return null;
  return r.how === 'queued' ? { ok: true, queued: true } : r.value;
}

/** A failed editor answer as the request's error. 'editor-not-ready' / 'editor-busy' never get
 *  here: the router keeps those requests (EditorNotReady). */
async function must(ask: Ask, op: LiveOp): Promise<LiveAnswer & { ok: true }> {
  const a = await ask(op);
  if (!a.ok) throw new LiveRefusal(a.error);
  return a;
}
class LiveRefusal extends Error { constructor(readonly code: string) { super(code); } }
const refusal = (e: unknown): NotFound => {
  if (e instanceof LiveRefusal) return { ok: false, error: e.code };
  throw e;
};

/** The app id of a comment the editor just made: an Excel one is read back for its sheet, cell
 *  and GUID, so its id is the one every later read (live or from the saved file) gives it. */
async function idOf(t: Target, ask: Ask, file: () => Promise<FileView>, editorId: string): Promise<string> {
  if (t.format === 'docx') return `oo-${editorId}`;
  const [live, view] = await Promise.all([liveComments(ask), file()]);
  return appIds(t.format, live, view).get(editorId) ?? `oo-${editorId}`;
}

async function liveComments(ask: Ask): Promise<LiveComment[]> {
  return (await must(ask, { kind: 'list' })).comments ?? [];
}

export function liveList(t: Target, fallback: () => Promise<unknown>): Live<{ ok: true; comments: PersistedComment[] }> {
  return route(t, async (ask, file) => {
    const [live, view] = await Promise.all([liveComments(ask), file()]);
    return { ok: true as const, comments: toPersisted(t.format, t.path, live, view) };
  }, fallback, false);
}

function anchorOp(selector: CommentSelector): { quote?: string; occurrence?: number; sheet?: string; cell?: string } {
  return selector.kind === 'cell'
    ? { cell: selector.selector.cell, sheet: selector.selector.sheet }
    : { quote: selector.selector.exact, occurrence: selector.selector.occurrence };
}

export function liveAdd(t: Target, a: { selector: CommentSelector; text: string; author: CommentAuthor }, fallback: () => Promise<unknown>): Live<{ ok: true; id: string; text: string } | NotFound> {
  return route(t, async (ask, file) => {
    try {
      const r = await must(ask, { kind: 'add', text: a.text, author: displayNameFor(a.author), ...anchorOp(a.selector) });
      return { ok: true as const, id: await idOf(t, ask, file, r.id ?? ''), text: a.text };
    } catch (e) { return refusal(e); }
  }, fallback);
}

/** Runs `op(editorId)` on the comment named `appId`. */
function onComment<T>(t: Target, appId: string, fallback: () => Promise<unknown>, op: (ask: Ask, editorId: string, live: LiveComment[], file: FileView) => Promise<T>): Live<T | NotFound> {
  return route(t, async (ask, file) => {
    try {
      const [live, view] = await Promise.all([liveComments(ask), file()]);
      const editorId = editorIdFor(t.format, appId, live, view);
      if (!editorId) return { ok: false as const, error: 'comment-not-found' };
      return await op(ask, editorId, live, view);
    } catch (e) { return refusal(e); }
  }, fallback);
}

export function liveReply(t: Target, a: { id: string; text: string; author: CommentAuthor }, fallback: () => Promise<unknown>): Live<{ ok: true; reply: CommentReply } | NotFound> {
  return onComment(t, a.id, fallback, async (ask, editorId) => {
    const r = await must(ask, { kind: 'reply', id: editorId, text: a.text, author: displayNameFor(a.author) });
    return { ok: true as const, reply: { id: `${a.id}-r${(r.index ?? 0) + 1}`, author: a.author, text: a.text, createdAt: Date.now() } };
  });
}

export function liveSimple(t: Target, kind: 'resolve' | 'reopen' | 'delete', id: string, fallback: () => Promise<unknown>): Live<{ ok: true } | NotFound> {
  return onComment(t, id, fallback, async (ask, editorId) => { await must(ask, { kind, id: editorId }); return { ok: true as const }; });
}

export function liveEdit(t: Target, a: { id: string; text: string }, fallback: () => Promise<unknown>): Live<{ ok: true; text: string } | NotFound> {
  return onComment(t, a.id, fallback, async (ask, editorId) => { await must(ask, { kind: 'edit', id: editorId, text: a.text }); return { ok: true as const, text: a.text }; });
}

function replyOp<T>(t: Target, a: { id: string; replyId: string }, fallback: () => Promise<unknown>, op: (ask: Ask, editorId: string, index: number, reply: LiveComment['replies'][number]) => Promise<T>): Live<T | NotFound> {
  const split = splitReply(a.replyId);
  // A reply id that is no reply id at all names nothing, in the editor or in the file.
  if (!split || split.thread !== a.id) return Promise.resolve(router ? { ok: false as const, error: 'reply-not-found' } : null);
  return onComment(t, a.id, fallback, async (ask, editorId, live) => {
    const reply = live.find((c) => c.id === editorId)!.replies[split.index];
    if (!reply) return { ok: false as const, error: 'reply-not-found' };
    return op(ask, editorId, split.index, reply);
  });
}

export function liveEditReply(t: Target, a: { id: string; replyId: string; text: string }, fallback: () => Promise<unknown>): Live<{ ok: true; reply: CommentReply } | NotFound> {
  return replyOp(t, a, fallback, async (ask, editorId, index, reply) => {
    await must(ask, { kind: 'edit-reply', id: editorId, index, text: a.text });
    return { ok: true as const, reply: { id: a.replyId, author: authorOf(reply.author), text: a.text, createdAt: reply.time || Date.now() } };
  });
}

export function liveDeleteReply(t: Target, a: { id: string; replyId: string }, fallback: () => Promise<unknown>): Live<{ ok: true } | NotFound> {
  return replyOp(t, a, fallback, async (ask, editorId, index) => {
    await must(ask, { kind: 'delete-reply', id: editorId, index });
    return { ok: true as const };
  });
}

export function liveMove(t: Target, a: { id: string; newSelector: CommentSelector }, fallback: () => Promise<unknown>): Live<{ ok: true; id: string } | NotFound> {
  return onComment(t, a.id, fallback, async (ask, editorId) => {
    const r = await must(ask, { kind: 'move', id: editorId, ...anchorOp(a.newSelector) });
    return { ok: true as const, id: await idOf(t, ask, () => fileView(t.format, t.absolutePath, t.path), r.id ?? '') };
  });
}
