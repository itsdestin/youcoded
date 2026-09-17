// YouCoded Pages — the main-process service: one PagesStore, one watcher on
// the Personal space's Pages/, a subscription to the project watcher for
// Pages/ under any known project, and one debounced `pages:changed` broadcast
// with the fresh list. ipc-handlers.ts and remote-server.ts both reach it
// through getPagesService(), so a phone over remote access sees the same
// changes a desktop window does.
//
// Design: youcoded-dev/docs/active/specs/2026-09-17-youcoded-pages-phase1-technical-design.md §3.
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { PagesStore, PAGES_DIR, isUnderPagesDir, type PagesStoreDeps } from './pages-store';
import type { ExternalChangeEvent } from '../artifacts/project-watcher';
import type { PageSummary } from '../../shared/pages-types';

const DEBOUNCE_MS = 300;

export interface PagesServiceDeps extends PagesStoreDeps {
  /** Fan a fresh list out to every window and to remote clients. */
  broadcast: (pages: PageSummary[]) => void;
}

class PagesService {
  readonly store: PagesStore;
  private watcher: FSWatcher | null = null;
  private watchedRoot: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: PagesServiceDeps) {
    this.store = new PagesStore(deps);
  }

  /** Start (or re-point) the Personal watcher. Safe to call again: the
   *  Personal root can appear after sync spaces turn on. The watch is on the
   *  Personal ROOT with everything but Pages/ ignored, because Pages/ itself
   *  usually does not exist until the first page is made and a watch on a
   *  missing folder never fires (found 2026-09-17). */
  ensureWatching(): void {
    const personal = this.deps.personalRoot();
    if (personal === this.watchedRoot) return;
    void this.watcher?.close().catch(() => {});
    this.watcher = null;
    this.watchedRoot = personal;
    if (!personal) return;
    const pagesRoot = path.join(personal, PAGES_DIR);
    try {
      // Same shape as project-watcher.ts: wait for writes to settle so a page
      // the skill is still writing is not listed half-done. depth 4 covers
      // Personal/Pages/<slug>/<file> and the .pins folder.
      this.watcher = chokidar.watch(personal, {
        ignoreInitial: true, followSymlinks: false, depth: 4,
        ignored: (p: string) => p !== personal && p !== pagesRoot && !p.startsWith(pagesRoot + path.sep),
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });
      this.watcher.on('all', () => this.schedule());
      this.watcher.on('error', () => { /* degrade to list()-on-demand, never throw */ });
    } catch { this.watcher = null; }
  }

  /** Watch a project's Pages/ directly once it exists. The project watcher
   *  (review F8) only runs while a window has that project's files open, so a
   *  page made in a folder nobody is browsing would never announce itself. One
   *  small watcher per project that actually has pages (found 2026-09-17). */
  private projectWatchers = new Map<string, FSWatcher>();
  ensureProjectPagesWatched(projectPaths: string[]): void {
    const wanted = new Set(projectPaths.map((p) => path.join(p, PAGES_DIR)));
    for (const [root, w] of this.projectWatchers) {
      if (!wanted.has(root)) { void w.close().catch(() => {}); this.projectWatchers.delete(root); }
    }
    for (const root of wanted) {
      if (this.projectWatchers.has(root)) continue;
      try {
        const w = chokidar.watch(root, {
          ignoreInitial: true, followSymlinks: false, depth: 2,
          awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
        });
        w.on('all', () => this.schedule());
        w.on('error', () => {});
        this.projectWatchers.set(root, w);
      } catch { /* degrade to list()-on-demand */ }
    }
  }

  /** From the project watcher (ipc-handlers' existing sink): a change under a
   *  known project's Pages/ folder is a pages change too (review F8). */
  onProjectChange(evt: ExternalChangeEvent): void {
    const rel = evt.artifactId;
    if (typeof rel === 'string' && isUnderPagesDir(evt.projectRoot, rel)) this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.listAndWatch().then((pages) => this.deps.broadcast(pages)).catch(() => {});
    }, DEBOUNCE_MS);
  }

  /** list() plus keeping the per-project watchers in step with the projects
   *  that have a Pages/ folder right now. */
  async listAndWatch(): Promise<PageSummary[]> {
    const pages = await this.store.list();
    const roots = new Set<string>();
    for (const p of pages) if (p.home.kind === 'project') roots.add(p.home.path);
    this.ensureProjectPagesWatched([...roots]);
    return pages;
  }

  stop(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    void this.watcher?.close().catch(() => {});
    this.watcher = null;
    this.watchedRoot = null;
    for (const w of this.projectWatchers.values()) void w.close().catch(() => {});
    this.projectWatchers.clear();
  }
}

let service: PagesService | null = null;

export function initPagesService(deps: PagesServiceDeps): PagesService {
  service?.stop();
  service = new PagesService(deps);
  service.ensureWatching();
  return service;
}

export function getPagesService(): PagesService | null { return service; }
