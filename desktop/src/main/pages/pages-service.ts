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
import { applyScheme, fingerprint, keyPlacement } from './page-connections';
import { hashHtml, savedKeyId, splitSavedKeyId, type PageApproval } from './connections-store';
import { PageRateGate, performPageFetch, type PageCredential } from './page-fetch';
import type { ExternalChangeEvent } from '../artifacts/project-watcher';
import type {
  PageApproveResult, PageConnection, PageFetchRequest, PageFetchResult,
  PageRefreshState, PageSummary, SavedPageKey,
} from '../../shared/pages-types';

const DEBOUNCE_MS = 300;

/** A key must be typed on the computer that will hold it. "No keys on the
 *  phone" was a renderer rule until design review 1 finding 13; it is enforced
 *  here, where a crafted message cannot get past it. */
const NO_KEYS_FROM_REMOTE =
  'A key can only be added on the computer running YouCoded. Open this page there to add it.';

export interface PagesServiceDeps extends PagesStoreDeps {
  /** Fan a fresh list out to every window and to remote clients. */
  broadcast: (pages: PageSummary[]) => void;
  /** The signed-in YouCoded account's bearer token, for a `youcoded` connection. */
  youcodedToken?: () => Promise<string | null> | string | null;
  /** The app's stored GitHub token, for a `github` connection. */
  githubToken?: () => Promise<string | null>;
  /** Test injection, handed straight to guardedFetch. Production leaves both
   *  unset and gets the real network. */
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

class PagesService {
  readonly store: PagesStore;
  private watcher: FSWatcher | null = null;
  private watchedRoot: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Freshness, per page. In memory and never on disk (design §3, finding 10):
   *  a fetch can happen 60x a minute, and approvals must not share that write
   *  path. It rides the `pages:changed` broadcast instead. */
  private readonly freshness = new Map<string, PageRefreshState>();
  private readonly gate = new PageRateGate();

  constructor(private readonly deps: PagesServiceDeps) {
    this.store = new PagesStore({ ...deps, refreshState: (id) => this.freshness.get(id) });
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

  // ── Phase 2: connections, keys and the one door ──────────────────────────

  /**
   * Approve every line the page is still waiting on (design §4 step 8).
   *
   * Keys are stored BEFORE any approval is recorded, so a computer with no
   * keychain — where SecretsStore refuses by design — ends with nothing
   * written and a sentence the card can show (finding 11). Recording the
   * approval first would leave a page marked connected with no key behind it.
   */
  async approve(id: string, keys: Record<string, string>, opts: { remote: boolean }): Promise<PageApproveResult> {
    const store = this.deps.connections;
    if (!store) return { ok: false, message: 'Page connections are not available on this computer.' };
    const info = await this.store.connectionsOf(id);
    const pageKey = await this.store.approvalKeyFor(id);
    if (!info || !pageKey) return { ok: false, message: 'This page is no longer in your library.' };

    let recorded: Record<string, PageApproval>;
    try { recorded = await store.approvalsFor(pageKey); }
    catch (e) { return { ok: false, message: messageOf(e) }; }
    const waiting = info.connections.filter((c) => recorded[c.id]?.fingerprint !== fingerprint(c));
    if (waiting.length === 0) {
      // Nothing waits for a yes, so this is the person dismissing "code changed
      // since you allowed this" (deck 3, Q-code-change): the current code
      // becomes the approved code. The fingerprints are untouched — this can
      // never widen what the page reaches.
      const htmlHash = hashHtml(info.html);
      const restamped: Record<string, PageApproval> = {};
      for (const c of info.connections) {
        const r = recorded[c.id];
        if (r && r.htmlHash !== htmlHash) restamped[c.id] = { ...r, htmlHash };
      }
      if (Object.keys(restamped).length > 0) {
        try { await store.recordApprovals(pageKey, restamped); }
        catch (e) { return { ok: false, message: messageOf(e) }; }
      }
      return { ok: true, pages: await this.listAndWatch() };
    }

    for (const c of waiting) {
      if (c.kind !== 'key') continue;
      const typed = (keys?.[c.id] ?? '').trim();
      const reuseSaved = typed === '' || typed === 'saved';
      if (!reuseSaved && opts.remote) return { ok: false, message: NO_KEYS_FROM_REMOTE };
      try {
        if (reuseSaved) {
          if (!(await store.savedKey(c.service, c.address))) {
            return { ok: false, message: `No ${c.service} key is saved on this computer yet. Add one to let this page use it.` };
          }
        } else {
          await store.saveKey(c.service, c.address, typed, keyPlacement(c));
        }
      } catch (e) { return { ok: false, message: messageOf(e) }; }
    }

    const at = new Date().toISOString();
    const htmlHash = hashHtml(info.html);
    const fresh: Record<string, PageApproval> = {};
    for (const c of waiting) fresh[c.id] = { fingerprint: fingerprint(c), approvedAt: at, htmlHash };
    try { await store.recordApprovals(pageKey, fresh); }
    catch (e) { return { ok: false, message: messageOf(e) }; }
    const pages = await this.listAndWatch();
    await this.pruneAgainst(pages);
    return { ok: true, pages };
  }

  /** Stop using one connection. The band goes with it: a time for a page that
   *  can no longer reach anything would be a time for nothing. */
  async removeConnection(id: string, connectionId: string): Promise<PageSummary[]> {
    const pageKey = await this.store.approvalKeyFor(id);
    if (pageKey && this.deps.connections) {
      await this.deps.connections.removeApproval(pageKey, connectionId).catch(() => { /* already gone */ });
    }
    this.freshness.delete(id);
    return this.listAndWatch();
  }

  /**
   * The band's refresh button. Main deliberately does NOT invent a new time
   * here: the page itself re-fetches (its `youcoded.onRefresh`), and the time
   * comes from the app's own record of the last successful request, recorded
   * in `fetch()` below. So this answers with the list as it stands — a page
   * that ignores the request still shows a true time rather than a fresh one
   * it did not earn.
   */
  async refresh(_id: string): Promise<PageSummary[]> {
    return this.listAndWatch();
  }

  /** Settings › Connected accounts: every saved key and who uses it. */
  async savedKeys(): Promise<SavedPageKey[]> {
    const store = this.deps.connections;
    if (!store) return [];
    let snapshot;
    try { snapshot = await store.read(); } catch { return []; }
    const pages = await this.listAndWatch();
    const out: SavedPageKey[] = [];
    for (const id of Object.keys(snapshot.keys)) {
      const parts = splitSavedKeyId(id);
      if (!parts) continue;
      out.push({
        ...parts,
        usedBy: pages
          .filter((p) => (p.connections ?? []).some((c) => c.kind === 'key' && c.approved && savedKeyId(c.service, c.address) === id))
          .map((p) => ({ id: p.id, name: p.name })),
      });
    }
    out.sort((a, b) => a.service.localeCompare(b.service) || a.address.localeCompare(b.address));
    await this.pruneAgainst(pages);
    return out;
  }

  async deleteSavedKey(service: string, address: string): Promise<SavedPageKey[]> {
    const before = await this.listAndWatch();
    // Every page that stood on this key is paused now, so its band is stale.
    // Read that list BEFORE the delete, while the approvals still say who.
    const affected = before
      .filter((p) => (p.connections ?? []).some((c) => c.kind === 'key' && c.service === service && c.address === address))
      .map((p) => p.id);
    await this.deps.connections?.deleteSavedKey(service, address).catch(() => { /* nothing saved under that name */ });
    for (const id of affected) this.freshness.delete(id);
    const keys = await this.savedKeys();
    this.broadcastNow();
    return keys;
  }

  /** `pages:fetch` — §4 in full. The caller is the host frame's postMessage
   *  bridge; the credential never travels back with the answer. */
  async fetch(id: string, request: PageFetchRequest): Promise<PageFetchResult> {
    if (!(await this.gate.acquire(id))) {
      return { ok: false, reason: 'too-many-requests', message: 'This page is asking for information faster than the app will allow. It will be able to try again shortly.' };
    }
    try {
      const store = this.deps.connections;
      const info = await this.store.connectionsOf(id);
      const pageKey = await this.store.approvalKeyFor(id);
      if (!store || !info || !pageKey) {
        return { ok: false, reason: 'not-approved', message: 'This page is no longer in your library.' };
      }
      let approved: Record<string, string> = {};
      try {
        const records = await store.approvalsFor(pageKey);
        approved = Object.fromEntries(Object.entries(records).map(([k, v]) => [k, v.fingerprint]));
      } catch (e) { return { ok: false, reason: 'not-approved', message: messageOf(e) }; }

      const result = await performPageFetch(request, {
        connections: info.connections,
        approved,
        credential: (c) => this.credentialFor(c),
        // guardedFetch owns the 30s deadline; this is only the handle it needs.
        signal: new AbortController().signal,
        fetchImpl: this.deps.fetchImpl,
        lookup: this.deps.lookup,
      });
      // Step 7: freshness is recorded per page AND per connection, and ONLY on
      // a 2xx (finding 12) — otherwise a page pinging an approved URL on a
      // timer could keep the band green over week-old numbers.
      this.noteFreshness(id, result.ok && result.status >= 200 && result.status < 300);
      return result;
    } finally {
      this.gate.release(id);
    }
  }

  private noteFreshness(id: string, succeeded: boolean): void {
    const prev = this.freshness.get(id) ?? { at: null, failed: false };
    const next: PageRefreshState = succeeded ? { at: new Date().toISOString(), failed: false } : { at: prev.at, failed: true };
    if (prev.at === next.at && prev.failed === next.failed) return;
    this.freshness.set(id, next);
    this.schedule();
  }

  /** Resolve what this connection sends. Nothing is decrypted until the host
   *  match and the method check have already passed. */
  private async credentialFor(c: PageConnection): Promise<PageCredential | null> {
    const store = this.deps.connections;
    switch (c.kind) {
      case 'public':
      case 'open':
        return null;
      case 'key': {
        if (!store) return null;
        const record = await store.savedKey(c.service, c.address);
        if (!record) return null;
        const value = await store.keyValue(record).catch(() => null);
        // The RECORDED placement, not the manifest's current one: the recorded
        // one is what the person approved.
        // The raw key rides as `secret` too, so redaction also catches a service
        // that echoes the bare key back without its "Bearer" word.
        return value ? { in: record.in, param: record.param, value: record.in === 'header' ? applyScheme(record.scheme, value) : value, secret: value } : null;
      }
      case 'youcoded': {
        const token = await this.deps.youcodedToken?.();
        return token ? { in: 'header', param: 'authorization', value: `Bearer ${token}` } : null;
      }
      case 'github': {
        const token = await this.deps.githubToken?.();
        return token ? { in: 'header', param: 'authorization', value: `token ${token}` } : null;
      }
    }
  }

  /**
   * Drop records nothing points at: approvals whose page is gone, and keys no
   * page uses (their secret goes too). Only ever called with a listing we just
   * built, and never with an empty one — an empty list is a normal transient
   * state while the Personal sync root is still appearing, and pruning against
   * it would silently revoke every grant on the machine.
   */
  private async pruneAgainst(pages: PageSummary[]): Promise<void> {
    const store = this.deps.connections;
    if (!store || pages.length === 0) return;
    const livePageKeys = new Set<string>();
    const usedKeyIds = new Set<string>();
    for (const p of pages) {
      const key = await this.store.approvalKeyFor(p.id);
      if (key) livePageKeys.add(key);
      for (const c of p.connections ?? []) if (c.kind === 'key') usedKeyIds.add(savedKeyId(c.service, c.address));
    }
    await store.prune(livePageKeys, usedKeyIds).catch(() => { /* housekeeping, never a user-visible failure */ });
  }

  private broadcastNow(): void {
    void this.listAndWatch().then((pages) => this.deps.broadcast(pages)).catch(() => {});
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

/** A thrown store failure already carries a sentence the person can act on
 *  (an unreadable file, a busy lock, a computer with no keychain). Never
 *  replace it with a guess — docs/error-message-standards.md. */
function messageOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.trim() || 'The app could not save this approval.';
}

let service: PagesService | null = null;

export function initPagesService(deps: PagesServiceDeps): PagesService {
  service?.stop();
  service = new PagesService(deps);
  service.ensureWatching();
  return service;
}

export function getPagesService(): PagesService | null { return service; }
