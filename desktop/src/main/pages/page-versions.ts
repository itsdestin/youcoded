// page-versions.ts — the page's earlier versions, for the Versions list in its chat (pages-finish step 3, the
// Undo round: Destin picked a versions list over Undo under each reply, and "it should just work like any other
// typical version history menu and let me resume from any of the checkpoints"). Build design:
// youcoded-dev/docs/active/specs/2026-11-05-pages-step3-build.md, section D.
//
// A version is the page folder's own four files, saved before each request in the page's chat. WHY its own
// store and not the synced folder's git history: that history is written by the sync engine every ~15 seconds,
// so one request's change could straddle two of its commits or share one with the next; and writing commits
// into a repository the sync engine owns would race it. The cost: versions stay on this computer.
//
// WHY nothing is ever lost: Put back first saves what is there now, so the list always has a way back.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from '../atomic-write';
import type { PageVersion, PageVersionChange } from '../../shared/pages-types';

/** The files a version holds. Everything else in the folder (pictures, programs, the `.page/` key cache) is not
 *  something the assistant's page edits change, and copying it would make versions large. */
const VERSION_FILES = ['page.html', 'page.json', 'page.md', 'data.json'] as const;
type VersionFile = typeof VERSION_FILES[number];
type Files = Partial<Record<VersionFile, string>>;

/** At most this many per page; the oldest goes first. */
export const MAX_VERSIONS = 40;
/** A label is the request's first line, cut here. */
const LABEL_MAX = 120;

interface Saved { label: string; at: number; files: Files }

const PAGE_PART: ReadonlySet<VersionFile> = new Set(['page.html', 'page.json', 'page.md']);

function changeBetween(a: Files, b: Files): PageVersionChange | null {
  let page = false;
  let data = false;
  for (const f of VERSION_FILES) {
    if ((a[f] ?? null) === (b[f] ?? null)) continue;
    if (PAGE_PART.has(f)) page = true; else data = true;
  }
  return page && data ? 'both' : page ? 'page' : data ? 'data' : null;
}

function sameFiles(a: Files, b: Files): boolean { return changeBetween(a, b) === null; }

export function versionLabel(request: string): string {
  const line = request.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line;
}

export class PageVersions {
  /** One write at a time per page: a second request sent while the first is being saved must not interleave. */
  private chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: { root: () => string; pageDir: (id: string) => Promise<string | null> }) {}

  private dirFor(pageId: string): string {
    // WHY a hash: page ids carry ':' and project names, which are not safe file names everywhere.
    return path.join(this.deps.root(), 'page-versions', crypto.createHash('sha1').update(pageId).digest('hex').slice(0, 20));
  }

  private serial<T>(pageId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(pageId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(work);
    this.chains.set(pageId, next);
    return next;
  }

  private async readNow(pageDir: string): Promise<Files> {
    const out: Files = {};
    await Promise.all(VERSION_FILES.map(async (f) => {
      try { out[f] = await fs.readFile(path.join(pageDir, f), 'utf8'); } catch { /* absent */ }
    }));
    return out;
  }

  private async readAll(pageId: string): Promise<Saved[]> {
    const dir = this.dirFor(pageId);
    let names: string[];
    try { names = await fs.readdir(dir); } catch { return []; }
    const saved: Saved[] = [];
    for (const n of names.filter((x) => /^\d+\.json$/.test(x))) {
      try {
        const v = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')) as Saved;
        if (typeof v?.at === 'number' && v.files && typeof v.files === 'object') saved.push(v);
      } catch { /* a damaged file is skipped, never fatal */ }
    }
    return saved.sort((a, b) => b.at - a.at);
  }

  private async write(pageId: string, v: Saved): Promise<void> {
    const dir = this.dirFor(pageId);
    await fs.mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, `${v.at}.json`), JSON.stringify(v));
  }

  private async prune(pageId: string, all: Saved[]): Promise<void> {
    const dir = this.dirFor(pageId);
    await Promise.all(all.slice(MAX_VERSIONS).map((v) => fs.rm(path.join(dir, `${v.at}.json`), { force: true })));
  }

  /** Save the page as it is now, before `label`. When nothing changed since the newest version, only its label
   *  moves to this request: both name the same state, and the newer request is the one that may change it. */
  checkpoint(pageId: string, label: string): Promise<boolean> {
    return this.serial(pageId, async () => {
      const pageDir = await this.deps.pageDir(pageId);
      if (!pageDir) return false;
      const now = await this.readNow(pageDir);
      if (!now['page.html']) return false;
      const all = await this.readAll(pageId);
      const newest = all[0];
      if (newest && sameFiles(newest.files, now)) {
        await this.write(pageId, { ...newest, label: versionLabel(label) });
        return true;
      }
      // WHY max(): two saves inside one millisecond would otherwise share a file name.
      const at = Math.max(Date.now(), (newest?.at ?? 0) + 1);
      await this.write(pageId, { label: versionLabel(label), at, files: now });
      await this.prune(pageId, [{ label, at, files: now }, ...all]);
      return true;
    });
  }

  /** Newest first. Each version says what is different in the state after it (the next version, or now). */
  async list(pageId: string): Promise<PageVersion[]> {
    const pageDir = await this.deps.pageDir(pageId);
    if (!pageDir) return [];
    const [all, now] = await Promise.all([this.readAll(pageId), this.readNow(pageDir)]);
    return all.map((v, i) => ({ at: v.at, label: v.label, change: changeBetween(v.files, i === 0 ? now : all[i - 1].files) }));
  }

  /** Put a version back: save now first (so this, too, can be undone), then write the version's files; a file
   *  the version did not have is removed. */
  restore(pageId: string, at: number, nowLabel: string): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.serial(pageId, async () => {
      const pageDir = await this.deps.pageDir(pageId);
      if (!pageDir) return { ok: false as const, message: 'This page is no longer in your library.' };
      const all = await this.readAll(pageId);
      const target = all.find((v) => v.at === at);
      if (!target) return { ok: false as const, message: 'That version is no longer saved.' };
      const now = await this.readNow(pageDir);
      if (sameFiles(target.files, now)) return { ok: true as const };
      const newest = all[0];
      if (!newest || !sameFiles(newest.files, now)) {
        const stamp = Math.max(Date.now(), (newest?.at ?? 0) + 1);
        await this.write(pageId, { label: nowLabel, at: stamp, files: now });
        await this.prune(pageId, [{ label: nowLabel, at: stamp, files: now }, ...all]);
      }
      // WHY this order (2026-11-10 review, finding 5): page.html last. Its change is what reloads the open page, and
      // by then the information and notes on disk are already the version's — the page never loads new code over
      // old information.
      for (const f of ['data.json', 'page.json', 'page.md', 'page.html'] as const) {
        const file = path.join(pageDir, f);
        const want = target.files[f];
        // WHY never noteOwnWrite here: that hides a data save from the open page (so a page saving its own data
        // does not reload itself), and after Put back the open page must show what was put back.
        if (want === undefined) await fs.rm(file, { force: true });
        else if (want !== now[f]) await atomicWrite(file, want);
      }
      return { ok: true as const };
    });
  }
}
