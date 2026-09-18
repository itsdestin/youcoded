// YouCoded Pages — the store behind `window.claude.pages` (Phase 1).
// Design: youcoded-dev/docs/active/specs/2026-09-17-youcoded-pages-phase1-technical-design.md
//
// A page is a folder: page.html (the document), page.json (name, description,
// icon) and an optional data.json ({ savedAt, data }) the app writes for the
// page. Two homes: the Personal sync space's Pages/ and a project's visible
// Pages/. Everything here is plain files so sync carries pages with nothing
// Pages-specific in sync; ids are `personal:<slug>` / `project:<name>:<slug>`
// so they match across devices and a synced pin file means the same thing
// everywhere (review F3).
//
// Conflict copies ("<base> (from <device>, <date>).<ext>") are OURS, written
// after THEIRS was checked out, so mtime says nothing about which save was
// later (review F2). data.json and page.json carry a stamp inside and fold by
// it; page.html has none, so the sync policy stands: the checked-out file wins
// and the copy is removed. All folding and writing goes through
// mutateFileUnderLock, like the naming store.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import type { PageDocument, PageHome, PageIcon, PageLoadFailure, PageSummary } from '../../shared/pages-types';
import { MAX_PAGE_DATA_BYTES, MAX_PINNED_PAGES } from '../../shared/pages-types';

export const PAGES_DIR = 'Pages';
const PINS_DIR = '.pins';
const ICONS: ReadonlySet<string> = new Set(['page', 'timer', 'notes', 'paint', 'chart', 'calendar', 'list', 'game']);
// "<base> (from <device>, <date>).<ext>" — the transport's conflict-copy shape
// (sync-spaces/guards.ts), matched for .json AND .html; store-core's matcher is
// .json-only.
const CONFLICT_RE = /^(.+?) \(from [^,()]+, [^()]+\)\.(json|html)$/;

export interface PagesStoreDeps {
  /** `~/YouCoded/Personal` (ManagedRoots.personalRoot); null when sync spaces are off. */
  personalRoot: () => string | null;
  /** The projects the app knows: name is what sync keys a project by (its folder name). */
  listProjects: () => Promise<Array<{ name: string; path: string }>>;
  /** getMachineIdentity()?.id — null when the built app never ran here. */
  deviceId: () => string | null;
  /** Where pins go when there is no Personal space or no device id (never synced). */
  localFallbackDir: () => string;
  /** project-watcher.noteOwnWrite, so our own data/pin writes are not echoed as external changes. */
  noteOwnWrite?: (absPath: string) => void;
}

interface Located { id: string; dir: string; slug: string; home: PageHome }

export function slugFromId(id: string): string {
  const i = id.lastIndexOf(':');
  return i < 0 ? id : id.slice(i + 1);
}

function safeSlug(name: string): boolean {
  // Letters, digits and hyphens only; no dots, so a slug can never be a path
  // component that escapes its home.
  return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(name);
}

export class PagesStore {
  private byId = new Map<string, Located>();
  constructor(private readonly deps: PagesStoreDeps) {}

  // ── Listing ──────────────────────────────────────────────────────────────

  async list(): Promise<PageSummary[]> {
    const homes: Array<{ root: string; home: PageHome; prefix: string }> = [];
    const personal = this.deps.personalRoot();
    if (personal) homes.push({ root: path.join(personal, PAGES_DIR), home: { kind: 'personal' }, prefix: 'personal' });
    for (const p of await this.deps.listProjects()) {
      homes.push({ root: path.join(p.path, PAGES_DIR), home: { kind: 'project', path: p.path, name: p.name }, prefix: `project:${p.name}` });
    }
    const pinned = new Set(await this.readPins());
    const out: PageSummary[] = [];
    const next = new Map<string, Located>();
    for (const h of homes) {
      let entries: import('node:fs').Dirent[] = [];
      try { entries = await fs.readdir(h.root, { withFileTypes: true }); } catch { continue; }
      // Case-insensitive uniqueness within a home (review F11): the first
      // wins in directory order; a colliding twin is skipped, not merged.
      const seen = new Set<string>();
      for (const e of entries) {
        if (!e.isDirectory() || !safeSlug(e.name) || e.name.startsWith('.')) continue;
        const key = e.name.toLowerCase();
        if (seen.has(key)) continue;
        const dir = path.join(h.root, e.name);
        const manifest = await this.readManifest(dir);
        if (!manifest) continue;
        seen.add(key);
        const id = `${h.prefix}:${e.name}`;
        const htmlStat = await fs.stat(path.join(dir, 'page.html')).catch(() => null);
        if (!htmlStat) continue; // a manifest without a document is not a page yet
        const jsonStat = await fs.stat(path.join(dir, 'page.json')).catch(() => null);
        const updated = Math.max(htmlStat.mtimeMs, jsonStat?.mtimeMs ?? 0);
        next.set(id, { id, dir, slug: e.name, home: h.home });
        out.push({
          id,
          name: manifest.name,
          description: manifest.description,
          icon: manifest.icon,
          home: h.home,
          pinned: pinned.has(id),
          updatedAt: new Date(updated).toISOString(),
          htmlStamp: Math.round(htmlStat.mtimeMs),
        });
      }
    }
    this.byId = next;
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** page.json, with conflict copies folded by their `updatedAt` stamp. Returns
   *  null when there is no readable manifest (then the folder is not a page). */
  private async readManifest(dir: string): Promise<{ name: string; description: string; icon: PageIcon } | null> {
    await this.foldJsonCopies(dir, 'page.json', 'updatedAt');
    let raw: string;
    try { raw = await fs.readFile(path.join(dir, 'page.json'), 'utf8'); } catch { return null; }
    let j: unknown;
    try { j = JSON.parse(raw); } catch { return null; }
    if (!j || typeof j !== 'object') return null;
    const o = j as Record<string, unknown>;
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : path.basename(dir);
    const description = typeof o.description === 'string' ? o.description.trim().slice(0, 200) : '';
    const icon = (typeof o.icon === 'string' && ICONS.has(o.icon) ? o.icon : 'page') as PageIcon;
    return { name, description, icon };
  }

  // ── One page ─────────────────────────────────────────────────────────────

  async get(id: string): Promise<{ ok: true; page: PageDocument } | { ok: false; failure: PageLoadFailure }> {
    const loc = await this.locate(id);
    if (!loc) return { ok: false, failure: { kind: 'missing', message: 'This page is no longer in your library.' } };
    await this.foldHtmlCopies(loc.dir);
    let html: string;
    try { html = await fs.readFile(path.join(loc.dir, 'page.html'), 'utf8'); }
    catch { return { ok: false, failure: { kind: 'unreadable', message: 'The page file could not be read.' } }; }
    const summaries = await this.list();
    const summary = summaries.find((s) => s.id === id);
    if (!summary) return { ok: false, failure: { kind: 'missing', message: 'This page is no longer in your library.' } };
    const data = await this.readData(loc.dir);
    return { ok: true, page: { ...summary, html, data } };
  }

  private async locate(id: string): Promise<Located | null> {
    if (!this.byId.has(id)) await this.list();
    return this.byId.get(id) ?? null;
  }

  // ── Page data ────────────────────────────────────────────────────────────

  private async readData(dir: string): Promise<unknown | null> {
    await this.foldJsonCopies(dir, 'data.json', 'savedAt');
    let raw: string;
    try { raw = await fs.readFile(path.join(dir, 'data.json'), 'utf8'); } catch { return null; }
    try {
      const env = JSON.parse(raw) as { savedAt?: unknown; data?: unknown };
      return env && typeof env === 'object' && 'data' in env ? env.data ?? null : null;
    } catch { return null; }
  }

  async setData(id: string, data: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
    const loc = await this.locate(id);
    if (!loc) return { ok: false, message: 'This page is no longer in your library.' };
    let body: string;
    try { body = JSON.stringify({ savedAt: new Date().toISOString(), data }); }
    catch { return { ok: false, message: 'The page tried to save something that is not plain data.' }; }
    if (Buffer.byteLength(body, 'utf8') > MAX_PAGE_DATA_BYTES) {
      return { ok: false, message: 'The page tried to save more than 1 MB; that is more than a page may keep.' };
    }
    const target = path.join(loc.dir, 'data.json');
    this.deps.noteOwnWrite?.(target);
    const ok = await mutateFileUnderLock(target, () => body);
    return ok ? { ok: true } : { ok: false, message: 'The page data file is busy; try again in a moment.' };
  }

  // ── Pins (per device) ────────────────────────────────────────────────────

  private pinsPath(): string {
    const personal = this.deps.personalRoot();
    const device = this.deps.deviceId();
    if (personal && device) return path.join(personal, PAGES_DIR, PINS_DIR, `${device}.json`);
    return path.join(this.deps.localFallbackDir(), 'pages-pins.json');
  }

  private async readPins(): Promise<string[]> {
    try {
      const j = JSON.parse(await fs.readFile(this.pinsPath(), 'utf8')) as { pinned?: unknown };
      return Array.isArray(j.pinned) ? j.pinned.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  }

  async setPinned(id: string, pinned: boolean): Promise<PageSummary[]> {
    const loc = await this.locate(id);
    if (loc) {
      const target = this.pinsPath();
      this.deps.noteOwnWrite?.(target);
      await mutateFileUnderLock(target, (onDisk) => {
        let cur: string[] = [];
        try { const j = onDisk ? JSON.parse(onDisk) as { pinned?: unknown } : {}; cur = Array.isArray(j.pinned) ? j.pinned.filter((x): x is string => typeof x === 'string') : []; } catch { cur = []; }
        const set = new Set(cur);
        if (pinned) {
          if (set.has(id)) return null;
          if (set.size >= MAX_PINNED_PAGES) return null; // the cap is enforced here too, not only in the UI
          set.add(id);
        } else {
          if (!set.has(id)) return null;
          set.delete(id);
        }
        return JSON.stringify({ pinned: [...set], updatedAt: new Date().toISOString() });
      });
    }
    return this.list();
  }

  // ── Conflict copies ──────────────────────────────────────────────────────

  /** For a JSON file with a stamp field: keep the copy with the latest stamp as
   *  the canonical file, delete the rest. Under the canonical file's lock. */
  private async foldJsonCopies(dir: string, base: string, stampField: 'savedAt' | 'updatedAt'): Promise<void> {
    const copies = await this.conflictCopies(dir, base);
    if (copies.length === 0) return;
    const canonical = path.join(dir, base);
    await mutateFileUnderLock(canonical, (onDisk) => {
      let best: { text: string; stamp: number; file: string | null } = { text: onDisk ?? '', stamp: stampOf(onDisk, stampField), file: null };
      for (const c of copies) {
        const text = c.text;
        const s = stampOf(text, stampField);
        if (s > best.stamp) best = { text, stamp: s, file: c.file };
      }
      // Return null when the canonical file already holds the winner.
      return best.file === null ? null : best.text;
    });
    for (const c of copies) await fs.rm(c.file, { force: true }).catch(() => {});
  }

  /** page.html has no stamp: the sync policy stands (remote wins), so our
   *  copies are simply removed. */
  private async foldHtmlCopies(dir: string): Promise<void> {
    for (const c of await this.conflictCopies(dir, 'page.html')) await fs.rm(c.file, { force: true }).catch(() => {});
  }

  private async conflictCopies(dir: string, base: string): Promise<Array<{ file: string; text: string }>> {
    const stem = base.replace(/\.(json|html)$/, '');
    const ext = base.endsWith('.html') ? 'html' : 'json';
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { return []; }
    const out: Array<{ file: string; text: string }> = [];
    for (const n of names) {
      const m = CONFLICT_RE.exec(n);
      if (!m || m[1] !== stem || m[2] !== ext) continue;
      const file = path.join(dir, n);
      try { out.push({ file, text: await fs.readFile(file, 'utf8') }); } catch { /* unreadable copy: leave it */ }
    }
    return out;
  }
}

function stampOf(text: string | null, field: 'savedAt' | 'updatedAt'): number {
  if (!text) return -1;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const v = j?.[field];
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : 0;
  } catch { return -1; }
}

/** True when a changed path (from the project watcher) is inside a project's Pages/. */
export function isUnderPagesDir(projectRoot: string, absOrRelPath: string): boolean {
  const rel = path.isAbsolute(absOrRelPath) ? path.relative(projectRoot, absOrRelPath) : absOrRelPath;
  const first = rel.split(/[\\/]/)[0];
  return first === PAGES_DIR;
}
