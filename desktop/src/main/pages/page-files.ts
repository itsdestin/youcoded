// A page's file door (`youcoded.files`, pages-finish step 2; design §3 and review 1).
//
// The page never holds a path. It gets HANDLES — random names main keeps the real path
// behind — and file contents. Every call re-reads the page's approvals (the service hands
// in only lines whose fingerprint still matches) and re-checks the level and the access:
//   pick / remember  a file the person chose in an Open or Save window (a phone: YouCoded's
//                    own chooser, through an `ask`); remember keeps it for next time;
//   folder           paths inside the ONE folder chosen on the card;
//   all              paths under home (never outside it: review finding 3).
// The real-path rules (no links out, no secrets, no writes where code runs later) are
// page-file-guard.ts; this file is who may ask for what, and how much.
//
// Handles belong to ONE page in ONE window or phone (review finding 7). They go when that
// window navigates or closes, the phone drops, the host closes the page (`close`), or the
// page's approvals or code change (closePage) — so a handle never outlives the yes it
// stood on.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import {
  badSegment, cleanRelative, cleanUnderHome, folderChoiceProblem, guardContext, isReadDenied, isWriteDenied,
  listInside, openForRead, openForWrite, resolveInside, type GuardContext, type Opened, type Refused, type WriteLevel,
} from './page-file-guard';
import type { RememberedFile } from './connections-store';
import type {
  PageFileAccess, PageFileEncoding, PageFileEntry, PageFileHandle, PageFileLevel, PageFilesRefusal, PageFilesRequest, PageFilesResult,
} from '../../shared/pages-types';

const MB = 1024 * 1024;
/** One file on a computer window; through a phone, less, because it crosses the network
 *  as base64 inside one message (review finding 9). */
export const FILE_LIMITS = {
  fileBytes: 25 * MB,
  remoteFileBytes: 10 * MB,
  textBytes: 5 * MB,
  /** Across every page at once: what main holds in memory for page files. */
  inFlightBytes: 32 * MB,
  listEntries: 5000,
  handlesPerPage: 500,
  askMs: 10 * 60_000,
  folderTokenMs: 10 * 60_000,
};

/** One approved files line, as the service hands it in. */
export interface FileLine { id: string; level: PageFileLevel; access: PageFileAccess; types?: string[] }
export interface FilesAccess {
  pageKey: string;
  /** Approved lines only. */
  lines: FileLine[];
  folders: Record<string, string>;
  remembered: Record<string, RememberedFile[]>;
  /** The page's own folder: never written by it. */
  pageDir: string | null;
}

export interface PageFilesDeps {
  access: (pageId: string) => Promise<FilesAccess | null>;
  rememberFile: (pageKey: string, lineId: string, name: string, filePath: string) => Promise<string | null>;
  /** The computer's Open window for the asking window; chosen paths or null. Absent: no screen (Android, tests). */
  showOpen?: (sender: unknown, opts: { types?: string[]; multiple: boolean }) => Promise<string[] | null>;
  showSave?: (sender: unknown, opts: { suggestedName: string; types?: string[] }) => Promise<string | null>;
  showFolder?: (sender: unknown) => Promise<string | null>;
  /** Move to the system bin. Absent where there is none: remove is then refused, never permanent. */
  trash?: (filePath: string) => Promise<void>;
  /** YouCoded's own folders (userData, every Pages folder): never written, never a page's folder. */
  protectedRoots: () => string[];
  gate: { acquire(pageId: string): Promise<boolean>; release(pageId: string): void };
  /** Tests: a home other than the account's. */
  home?: string;
}

/** Who is calling, from the DOOR (never the request): its window or phone, and whether it is a phone. */
export interface FilesCaller { ownerKey: string; remote: boolean; sender?: unknown }

interface Held { pageId: string; ownerKey: string; lineId: string; path: string; name: string; rememberedId?: string }
interface Ask { pageId: string; ownerKey: string; kind: 'open' | 'save'; lineId: string; multiple: boolean; types?: string[]; expires: number }

const readable = (a: PageFileAccess) => a !== 'write';
const writable = (a: PageFileAccess) => a !== 'read';
const newId = () => randomBytes(12).toString('hex');

class Refusal extends Error { constructor(readonly code: PageFilesRefusal, message: string) { super(message); } }
const no = (code: PageFilesRefusal, message: string): never => { throw new Refusal(code, message); };

export class PageFiles {
  private readonly held = new Map<string, Held>();
  private readonly asks = new Map<string, Ask>();
  private readonly folderTokens = new Map<string, { path: string; ownerKey: string; expires: number }>();
  private inFlight = 0;

  constructor(private readonly deps: PageFilesDeps) {}

  // ── Lifetimes ──────────────────────────────────────────────────────────────────

  closeOwner(ownerKey: string): void {
    for (const [k, h] of this.held) if (h.ownerKey === ownerKey) this.held.delete(k);
    for (const [k, a] of this.asks) if (a.ownerKey === ownerKey) this.asks.delete(k);
    for (const [k, t] of this.folderTokens) if (t.ownerKey === ownerKey) this.folderTokens.delete(k);
  }

  /** The page's approvals or code changed: every handle it held stands on an old yes. */
  closePage(pageId: string): void {
    for (const [k, h] of this.held) if (h.pageId === pageId) this.held.delete(k);
    for (const [k, a] of this.asks) if (a.pageId === pageId) this.asks.delete(k);
  }

  // ── Choosing a folder for a folder line (the card, Page settings) ─────────────

  /** Show the computer's Choose folder window; keep the path behind a one-time token. */
  async chooseFolder(caller: FilesCaller): Promise<{ ok: true; token: string; display: string } | { ok: false; message?: string }> {
    if (caller.remote || !this.deps.showFolder) return { ok: false, message: 'Folders can be chosen on the computer running YouCoded.' };
    const picked = await this.deps.showFolder(caller.sender);
    if (!picked) return { ok: false };
    const ctx = await this.context(null);
    const real = canonicalize(await fs.promises.realpath(picked).catch(() => picked), null);
    const problem = folderChoiceProblem(real, ctx);
    if (problem) return { ok: false, message: problem };
    this.sweep();
    const token = newId();
    this.folderTokens.set(token, { path: real, ownerKey: caller.ownerKey, expires: Date.now() + FILE_LIMITS.folderTokenMs });
    const h = ctx.home.replace(/\/+$/, '');
    return { ok: true, token, display: real.startsWith(`${h}/`) ? `~/${real.slice(h.length + 1)}` : real };
  }

  /** The folder a token stands for, once, for the window that chose it; null when spent or expired. */
  takeFolderToken(token: string, ownerKey: string): string | null {
    const t = this.folderTokens.get(token);
    this.folderTokens.delete(token);
    return t && t.ownerKey === ownerKey && t.expires > Date.now() ? t.path : null;
  }

  // ── The phone's chooser listing ───────────────────────────────────────────────

  async listForAsk(caller: FilesCaller, pageId: string, askId: string, folder: string): Promise<{ ok: true; entries: PageFileEntry[] } | { ok: false; message: string }> {
    const ask = this.asks.get(askId);
    // Only while THIS page has a pick or save waiting for THIS screen (design §4): not a
    // general way to browse the computer.
    if (!ask || ask.pageId !== pageId || ask.ownerKey !== caller.ownerKey || ask.expires < Date.now()) {
      return { ok: false, message: 'This file window has closed. Ask the page to open it again.' };
    }
    const segs = cleanRelative(folder);
    // Hidden folders are settings, never shown in the chooser, so never browsed through it either.
    if (!segs || segs.some((x) => x.startsWith('.'))) return { ok: false, message: 'That folder name cannot be used.' };
    const ctx = await this.context(null);
    const r = await listInside(ctx.home, segs, ctx, FILE_LIMITS.listEntries);
    return 'refused' in r ? { ok: false, message: r.refused } : { ok: true, entries: r.entries };
  }

  // ── The door ──────────────────────────────────────────────────────────────────

  async call(caller: FilesCaller, pageId: string, req: PageFilesRequest): Promise<PageFilesResult> {
    const op = req.op;
    if (op === 'close') {
      for (const [k, h] of this.held) if (h.pageId === pageId && h.ownerKey === caller.ownerKey) this.held.delete(k);
      for (const [k, a] of this.asks) if (a.pageId === pageId && a.ownerKey === caller.ownerKey) this.asks.delete(k);
      return { ok: true, op };
    }
    if (op === 'cancel') { this.asks.delete(req.ask); return { ok: false, op, code: 'CANCELLED', message: 'Nothing was chosen.' }; }
    if (!(await this.deps.gate.acquire(pageId))) return { ok: false, op, code: 'TOO_MANY', message: 'This page is asking faster than the app will allow. Try again shortly.' };
    try {
      const access = await this.deps.access(pageId);
      if (!access || access.lines.length === 0) no('NOT_ALLOWED', 'This page has not been allowed to use your files.');
      return await this.run(caller, pageId, access!, req);
    } catch (e) {
      if (e instanceof Refusal) return { ok: false, op, code: e.code, message: e.message };
      return { ok: false, op, code: 'FAILED', message: 'The file could not be used.' };
    } finally {
      this.deps.gate.release(pageId);
    }
  }

  private async run(caller: FilesCaller, pageId: string, access: FilesAccess, req: PageFilesRequest): Promise<PageFilesResult> {
    const ctx = await this.context(access.pageDir);
    const cap = caller.remote ? FILE_LIMITS.remoteFileBytes : FILE_LIMITS.fileBytes;
    switch (req.op) {
      case 'pick': {
        const line = this.chooserLine(access, 'read');
        const types = cleanTypes(req.types ?? line.types);
        if (caller.remote || !this.deps.showOpen) return { ok: true, op: req.op, ask: this.newAsk(caller, pageId, line, 'open', !!req.multiple, types) };
        const paths = await this.deps.showOpen(caller.sender, { types, multiple: !!req.multiple });
        if (!paths?.length) no('CANCELLED', 'Nothing was chosen.');
        const files: PageFileHandle[] = [];
        for (const p of paths!) {
          const real = canonicalize(await fs.promises.realpath(p).catch(() => p), null);
          if (isReadDenied(real, ctx)) continue;
          files.push(await this.hold(caller, pageId, access, line, real));
        }
        if (!files.length) no('REFUSED', 'That file holds passwords or keys, so pages never see it.');
        return { ok: true, op: req.op, files };
      }
      case 'saveAs': {
        const line = this.chooserLine(access, 'write');
        const types = cleanTypes(req.types ?? line.types);
        const suggestedName = cleanSuggested(req.suggestedName);
        if (caller.remote || !this.deps.showSave) return { ok: true, op: req.op, ask: { ...this.newAsk(caller, pageId, line, 'save', false, types), suggestedName } };
        const data = decode(req.data ?? '', req.encoding, cap);
        const target = await this.deps.showSave(caller.sender, { suggestedName, types });
        if (!target) no('CANCELLED', 'Nothing was saved.');
        // The Save window already asked before replacing an existing file.
        const real = await this.writeChosen(target!, data, ctx, true);
        return { ok: true, op: req.op, files: [await this.hold(caller, pageId, access, line, real)] };
      }
      case 'choose': {
        const ask = this.asks.get(req.ask);
        this.asks.delete(req.ask);
        if (!ask || ask.pageId !== pageId || ask.ownerKey !== caller.ownerKey || ask.expires < Date.now()) no('CANCELLED', 'This file window has closed. Ask again.');
        const line = access.lines.find((l) => l.id === ask!.lineId) ?? no('NOT_ALLOWED', 'This page is no longer allowed to use your files.');
        const segs = cleanRelative(req.folder);
        if (!segs || segs.some((x) => x.startsWith('.')) || badSegment(req.file)) no('BAD_REQUEST', 'That name cannot be used.');
        const target = `${ctx.home.replace(/\/+$/, '')}/${[...segs!, req.file].join('/')}`;
        if (ask!.kind === 'open') {
          const real = canonicalize(await fs.promises.realpath(target).catch(() => no('REFUSED', 'That file is not there any more.')), null);
          if (isReadDenied(real, ctx)) no('REFUSED', 'That file holds passwords or keys, so pages never see it.');
          return { ok: true, op: req.op, files: [await this.hold(caller, pageId, access, line, real)] };
        }
        const data = decode(req.data ?? '', req.encoding, cap);
        // YouCoded's own chooser does not ask before replacing, so it never replaces.
        const real = await this.writeChosen(target, data, ctx, false);
        return { ok: true, op: req.op, files: [await this.hold(caller, pageId, access, line, real)] };
      }
      case 'read': {
        const h = this.handle(caller, pageId, access, req.handle, 'read');
        const opened = await this.openHeldForRead(h, ctx);
        return { ok: true, op: req.op, ...(await this.readOpened(opened, req.as, cap)) };
      }
      case 'save': {
        const h = this.handle(caller, pageId, access, req.handle, 'write');
        const data = decode(req.data, req.encoding, cap);
        await this.writeChosen(h.path, data, ctx, true);
        return { ok: true, op: req.op };
      }
      case 'recent': {
        const files: PageFileHandle[] = [];
        for (const line of access.lines.filter((l) => l.level === 'remember' && readable(l.access))) {
          for (const f of access.remembered[line.id] ?? []) {
            const st = await fs.promises.stat(f.path).catch(() => null);
            if (!st?.isFile()) continue;
            files.push(this.holdKnown(caller, pageId, line.id, f.path, f.name, st, f.id));
          }
        }
        return { ok: true, op: req.op, files };
      }
      case 'list': {
        const { root, segs } = this.pathTarget(caller, access, req.path, 'read');
        const r = await listInside(root, segs, ctx, FILE_LIMITS.listEntries);
        if ('refused' in r) no('REFUSED', r.refused);
        const ok = r as Exclude<typeof r, Refused>;
        return { ok: true, op: req.op, entries: ok.entries, more: ok.more };
      }
      case 'readPath': {
        const { root, segs, level } = this.pathTarget(caller, access, req.path, 'read');
        const opened = await openForRead(root, segs, ctx, level === 'folder');
        if ('refused' in opened) no('REFUSED', opened.refused);
        return { ok: true, op: req.op, ...(await this.readOpened(opened as Opened, req.as, cap)) };
      }
      case 'writePath': {
        const { root, segs, level } = this.pathTarget(caller, access, req.path, 'write');
        const data = decode(req.data, req.encoding, cap);
        const r = await resolveInside(root, segs);
        if ('refused' in r) no('REFUSED', r.refused);
        const mode = (r as Exclude<typeof r, Refused>).exists ? (req.replace ? 'replace' : no('REFUSED', 'A file with that name is already there.')) : 'new';
        await this.writeOpened(await openForWrite(root, segs, ctx, level, mode), data);
        return { ok: true, op: req.op };
      }
      case 'makeFolder': {
        const { root, segs, level } = this.pathTarget(caller, access, req.path, 'write');
        const r = await resolveInside(root, segs);
        if ('refused' in r) no('REFUSED', r.refused);
        const t = r as Exclude<typeof r, Refused>;
        if (t.exists) no('REFUSED', 'Something with that name is already there.');
        if (isWriteDenied(t.real, ctx, level)) no('REFUSED', 'Pages cannot change that folder.');
        await fs.promises.mkdir(t.real).catch(() => no('FAILED', 'The folder could not be made.'));
        return { ok: true, op: req.op };
      }
      case 'remove': {
        const { root, segs, level } = this.pathTarget(caller, access, req.path, 'write');
        if (segs.length === 0) no('REFUSED', 'A page cannot remove the folder it was given.');
        if (!this.deps.trash) no('UNSUPPORTED', 'Removing files is not available here, so nothing was removed.');
        const r = await resolveInside(root, segs);
        if ('refused' in r) no('REFUSED', r.refused);
        const t = r as Exclude<typeof r, Refused>;
        if (!t.exists) no('REFUSED', 'That file is not there any more.');
        if (isWriteDenied(t.real, ctx, level)) no('REFUSED', 'Pages cannot change that file or folder.');
        const st = await fs.promises.lstat(t.real);
        if (!st.isFile() && !st.isDirectory()) no('REFUSED', 'Only ordinary files and folders can be removed by a page.');
        // To the bin, never gone for good: the card's "cannot be undone" stays true for YouCoded,
        // and the person can still get it back.
        await this.deps.trash!(t.real).catch(() => no('FAILED', 'The file could not be moved to the bin.'));
        return { ok: true, op: req.op };
      }
      default:
        return no('BAD_REQUEST', 'The page asked for something the app does not do.');
    }
  }

  // ── Lines, handles, paths ─────────────────────────────────────────────────────

  /** The line an Open or Save window answers to: the narrowest that allows the access. */
  private chooserLine(access: FilesAccess, need: 'read' | 'write'): FileLine {
    const ok = access.lines.filter((l) => (need === 'read' ? readable(l.access) : writable(l.access)));
    const order: PageFileLevel[] = ['remember', 'pick', 'folder', 'all'];
    for (const level of order) { const l = ok.find((x) => x.level === level); if (l) return l; }
    return no('NOT_ALLOWED', need === 'read' ? 'This page has not been allowed to open your files.' : 'This page has not been allowed to save files.');
  }

  private newAsk(caller: FilesCaller, pageId: string, line: FileLine, kind: 'open' | 'save', multiple: boolean, types: string[] | undefined) {
    this.sweep();
    // One waiting window per page per screen: a new ask replaces the old.
    for (const [k, a] of this.asks) if (a.pageId === pageId && a.ownerKey === caller.ownerKey) this.asks.delete(k);
    const id = newId();
    this.asks.set(id, { pageId, ownerKey: caller.ownerKey, kind, lineId: line.id, multiple, types, expires: Date.now() + FILE_LIMITS.askMs });
    return { id, kind, ...(types ? { types } : {}), ...(multiple ? { multiple } : {}) };
  }

  private async hold(caller: FilesCaller, pageId: string, access: FilesAccess, line: FileLine, real: string): Promise<PageFileHandle> {
    const st = await fs.promises.stat(real).catch(() => no('REFUSED', 'That file is not there any more.'));
    if (!st.isFile()) no('REFUSED', 'Only ordinary files can be opened by a page.');
    const name = path.basename(real);
    const rememberedId = line.level === 'remember' ? (await this.deps.rememberFile(access.pageKey, line.id, name, real)) ?? undefined : undefined;
    return this.holdKnown(caller, pageId, line.id, real, name, st, rememberedId);
  }

  private holdKnown(caller: FilesCaller, pageId: string, lineId: string, real: string, name: string, st: fs.Stats, rememberedId?: string): PageFileHandle {
    let count = 0;
    for (const h of this.held.values()) if (h.pageId === pageId) count++;
    if (count >= FILE_LIMITS.handlesPerPage) no('TOO_MANY', 'This page has too many files open. Close the page and open it again.');
    const handle = newId();
    this.held.set(handle, { pageId, ownerKey: caller.ownerKey, lineId, path: real, name, ...(rememberedId ? { rememberedId } : {}) });
    return { handle, name, size: st.size, modified: st.mtime.toISOString() };
  }

  private handle(caller: FilesCaller, pageId: string, access: FilesAccess, handle: string, need: 'read' | 'write'): Held {
    const h = this.held.get(handle);
    if (!h || h.pageId !== pageId || h.ownerKey !== caller.ownerKey) return no('NOT_ALLOWED', 'That file is no longer open for this page. Choose it again.');
    const line = access.lines.find((l) => l.id === h.lineId);
    // The line was removed or changed since the file was chosen; or a remembered file was forgotten.
    if (!line || (h.rememberedId && !access.remembered[line.id]?.some((f) => f.id === h.rememberedId))) {
      this.held.delete(handle);
      return no('NOT_ALLOWED', 'That file is no longer open for this page. Choose it again.');
    }
    if (need === 'read' ? !readable(line.access) : !writable(line.access)) {
      return no('NOT_ALLOWED', need === 'read' ? 'This page was allowed to save files, not to read them.' : 'This page was allowed to read files, not to change them.');
    }
    return h;
  }

  /** A path a folder or all line reaches: relative to the folder, or `~/` under home. */
  private pathTarget(caller: FilesCaller, access: FilesAccess, raw: unknown, need: 'read' | 'write'): { root: string; segs: string[]; level: WriteLevel } {
    const home = typeof raw === 'string' && (raw === '~' || raw.startsWith('~/') || raw.startsWith('/') || /^[a-z]:/i.test(raw));
    const ok = (l: FileLine) => (need === 'read' ? readable(l.access) : writable(l.access));
    const line = access.lines.find((l) => l.level === (home ? 'all' : 'folder') && ok(l));
    if (!line) {
      return no('NOT_ALLOWED', home ? 'This page was not allowed to reach files outside its folder.' : need === 'read' ? 'This page has not been allowed to read a folder.' : 'This page has not been allowed to change files in a folder.');
    }
    // A phone may change files only inside an approved folder, never anywhere at `all` (review finding 12).
    if (need === 'write' && caller.remote && line.level === 'all') no('NOT_ALLOWED', 'From a phone, a page can change files only inside the folder it was given.');
    const homeDir = this.deps.home ?? os.homedir();
    if (line.level === 'all') {
      const segs = cleanUnderHome(raw, canonicalize(homeDir, null));
      if (!segs) no('BAD_REQUEST', 'That path is outside your home folder or cannot be used.');
      return { root: homeDir, segs: segs!, level: 'all' };
    }
    const folder = access.folders[line.id] ?? no('NOT_ALLOWED', 'Choose the folder for this page in its settings first.');
    const segs = cleanRelative(raw);
    if (!segs) no('BAD_REQUEST', 'That path cannot be used.');
    return { root: folder, segs: segs!, level: 'folder' };
  }

  // ── Bytes ─────────────────────────────────────────────────────────────────────

  private async openHeldForRead(h: Held, ctx: GuardContext): Promise<Opened> {
    const opened = await openForRead(path.dirname(h.path), [path.basename(h.path)], ctx, false);
    if ('refused' in opened) no('REFUSED', opened.refused);
    return opened as Opened;
  }

  private async readOpened(opened: Opened, as: PageFileEncoding | undefined, cap: number): Promise<{ data: string; encoding: PageFileEncoding }> {
    const encoding: PageFileEncoding = as === 'base64' ? 'base64' : 'text';
    const limit = encoding === 'text' ? Math.min(cap, FILE_LIMITS.textBytes) : cap;
    try {
      if (opened.size > limit) no('TOO_BIG', `That file is larger than ${Math.round(limit / MB)} MB, which is more than a page may open.`);
      const buf = await this.withBudget(opened.size, async () => {
        // Read at most limit + 1 bytes: a file that grew since it was measured is still caught.
        const b = Buffer.alloc(Math.min(opened.size, limit) + 1);
        const { bytesRead } = await opened.fh.read(b, 0, b.length, 0);
        return b.subarray(0, bytesRead);
      });
      if (buf.length > limit) no('TOO_BIG', `That file is larger than ${Math.round(limit / MB)} MB, which is more than a page may open.`);
      return { data: encoding === 'text' ? buf.toString('utf8') : buf.toString('base64'), encoding };
    } finally {
      await opened.fh.close().catch(() => {});
    }
  }

  /** Write a file the person chose: replace it when it exists (and `mayReplace`), else make it. */
  private async writeChosen(target: string, data: Buffer, ctx: GuardContext, mayReplace: boolean): Promise<string> {
    const dir = path.dirname(target);
    const base = path.basename(target);
    const r = await resolveInside(dir, [base]);
    if ('refused' in r) no('REFUSED', r.refused);
    const t = r as Exclude<typeof r, Refused>;
    if (t.exists && !mayReplace) no('REFUSED', 'A file with that name is already there. Choose another name.');
    await this.writeOpened(await openForWrite(dir, [base], ctx, 'chosen', t.exists ? 'replace' : 'new'), data);
    return t.real;
  }

  private async writeOpened(opened: Opened | Refused, data: Buffer): Promise<void> {
    if ('refused' in opened) no('REFUSED', opened.refused);
    const o = opened as Opened;
    try {
      await this.withBudget(data.length, async () => {
        await o.fh.truncate(0);
        await o.fh.write(data, 0, data.length, 0);
      });
    } finally {
      await o.fh.close().catch(() => {});
    }
  }

  private async withBudget<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
    if (this.inFlight + bytes > FILE_LIMITS.inFlightBytes) no('TOO_MANY', 'Pages are moving a lot of files right now. Try again in a moment.');
    this.inFlight += bytes;
    try { return await fn(); } finally { this.inFlight -= bytes; }
  }

  private async context(pageDir: string | null): Promise<GuardContext> {
    return guardContext([...this.deps.protectedRoots(), ...(pageDir ? [pageDir] : [])], this.deps.home);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, a] of this.asks) if (a.expires < now) this.asks.delete(k);
    for (const [k, t] of this.folderTokens) if (t.expires < now) this.folderTokens.delete(k);
  }
}

/** File endings a page names (`.csv`): at most 20, letters and digits only. */
function cleanTypes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((t): t is string => typeof t === 'string' && /^\.[a-z0-9]{1,10}$/i.test(t)).map((t) => t.toLowerCase()).slice(0, 20);
  return out.length ? out : undefined;
}

function cleanSuggested(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().slice(0, 200) : '';
  return s && !badSegment(s) ? s : 'Untitled';
}

function decode(data: unknown, encoding: PageFileEncoding | undefined, cap: number): Buffer {
  if (typeof data !== 'string') return no('BAD_REQUEST', 'The page sent no file contents.');
  // A base64 string is 4/3 of its bytes: refuse an oversized one before decoding it.
  if (data.length > (encoding === 'base64' ? Math.ceil(cap / 3) * 4 + 4 : cap)) no('TOO_BIG', `That file is larger than ${Math.round(cap / MB)} MB, which is more than a page may save.`);
  if (encoding === 'base64') {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) no('BAD_REQUEST', 'The page sent file contents the app could not read.');
    return Buffer.from(data, 'base64');
  }
  const buf = Buffer.from(data, 'utf8');
  if (buf.length > cap) no('TOO_BIG', `That file is larger than ${Math.round(cap / MB)} MB, which is more than a page may save.`);
  return buf;
}
