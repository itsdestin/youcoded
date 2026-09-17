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
   *  Personal root can appear after sync spaces turn on. */
  ensureWatching(): void {
    const personal = this.deps.personalRoot();
    const root = personal ? path.join(personal, PAGES_DIR) : null;
    if (root === this.watchedRoot) return;
    void this.watcher?.close().catch(() => {});
    this.watcher = null;
    this.watchedRoot = root;
    if (!root) return;
    try {
      // Same shape as project-watcher.ts: wait for writes to settle so a page
      // the skill is still writing is not listed half-done. depth 3 covers
      // Pages/<slug>/<file> and the .pins folder. Watching a folder that does
      // not exist yet is fine: chokidar picks it up when it appears.
      this.watcher = chokidar.watch(root, {
        ignoreInitial: true, followSymlinks: false, depth: 3,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });
      this.watcher.on('all', () => this.schedule());
      this.watcher.on('error', () => { /* degrade to list()-on-demand, never throw */ });
    } catch { this.watcher = null; }
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
      void this.store.list().then((pages) => this.deps.broadcast(pages)).catch(() => {});
    }, DEBOUNCE_MS);
  }

  stop(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    void this.watcher?.close().catch(() => {});
    this.watcher = null;
    this.watchedRoot = null;
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
