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
import { applyScheme, fingerprint, keyPlacement, savedKeyTarget, withApprovedAddress } from './page-connections';
import { log } from '../logger';
import { PlaidItemsStore, cleanPlaidRequest, openPlaidLink, parseCredentials, runPlaid } from './plaid';
import { cleanDeviceAddress } from '../../shared/page-device-address';
import { setPersonalPagesRoot } from '../claude-code-pages-mcp';
import { hashHtml, savedKeyId, splitSavedKeyId, type PageApproval } from './connections-store';
import { PageRateGate, performPageFetch, type PageCredential } from './page-fetch';
import { checkDeviceSocketAccess, performPageSocket, type DeviceSocketAccess, type PageSocketContext } from './page-socket';
import { PageLiveSockets, type LiveWsLike } from './page-live-socket';
import { PageLiveVideos } from './page-live-video';
import type { ExternalChangeEvent } from '../artifacts/project-watcher';
import type {
  PageApproveResult, PageConnection, PageFetchRequest, PageFetchResult,
  PageRefreshState, PageSummary, PlaidResult, SavedPageKey,
} from '../../shared/pages-types';
import { PLAID_SERVICE, plaidAddress } from '../../shared/pages-types';

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
  /** Test injection for a page's socket exchange (page-socket.ts). */
  socketConnect?: PageSocketContext['connect'];
  /** Test injection for a page's LIVE socket (page-live-socket.ts). */
  liveSocketConnect?: (url: string, headers: Record<string, string>) => LiveWsLike;
  /** Test injection: the connected-banks store. Production builds it from `connections`. */
  plaidItems?: PlaidItemsStore;
  /** Test injection: opening Plaid's sign-in page (production: openPlaidLink). */
  openExternal?: (url: string) => Promise<void> | void;
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
  /** Live connections to home devices (page-live-socket.ts). Every connect and
   *  reconnect asks `socketAccess`, so the approval chain is the same one the
   *  one-shot exchange uses and is re-run each time. */
  readonly sockets: PageLiveSockets;
  /** Camera video played by the app (page-live-video.ts): main's own socket per
   *  video, same owners, same access chain, counted apart from `sockets`. */
  readonly videos: PageLiveVideos;
  /** What each page looked like last listing (code stamp + connections), so a
   *  change to either closes that page's live sockets. */
  private readonly seenSignature = new Map<string, string>();

  /** Connected banks (plaid.ts), kept beside the page connections under the same keychain. */
  private readonly plaidItems: PlaidItemsStore | undefined;

  constructor(private readonly deps: PagesServiceDeps) {
    this.store = new PagesStore({ ...deps, refreshState: (id) => this.freshness.get(id) });
    this.plaidItems = deps.plaidItems ?? (deps.connections ? new PlaidItemsStore(deps.connections.userDataDir, deps.connections.secrets) : undefined);
    this.sockets = new PageLiveSockets({
      access: (pageId, url, signal) => this.socketAccess(pageId, url, signal),
      gate: this.gate,
      connect: deps.liveSocketConnect,
    });
    this.videos = new PageLiveVideos({
      access: (pageId, connectionId, signal) => this.videoAccess(pageId, connectionId, signal),
      gate: this.gate,
      connect: deps.liveSocketConnect,
    });
  }

  /** WHY one place: every site that must stop a page's live connections (an
   *  approval change, a removed connection, a deleted key, a changed page)
   *  stops its videos too, so the two cannot drift. */
  private closeLiveFor(pageId: string, connectionId?: string, why?: string): void {
    this.sockets.closeFor(pageId, connectionId, why);
    this.videos.closeFor(pageId, connectionId, why);
  }

  /** A window or remote client went away: its sockets and videos go with it. */
  closeOwner(ownerKey: string): void {
    this.sockets.closeOwner(ownerKey);
    this.videos.closeOwner(ownerKey);
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
    this.closeSocketsOfChangedPages(pages);
    const roots = new Set<string>();
    for (const p of pages) if (p.home.kind === 'project') roots.add(p.home.path);
    this.ensureProjectPagesWatched([...roots]);
    return pages;
  }

  /** WHY: a live socket was approved for one version of a page. When its code
   *  or its connections change underneath it (an edit through chat, a sync
   *  arrival), the socket closes; the page's frame reloads on a code change
   *  anyway, and a connection change must not keep running on the old yes.
   *  A page that disappeared closes too. The first time a page is seen only
   *  records it. */
  /** WHY: the change signature used to be recorded only when a page was listed
   *  through listAndWatch. A page whose first live connection opened before that
   *  (a remote client lists through the store directly) was then only "recorded"
   *  at its first sighting, so an edit made in between never closed the socket.
   *  Recording at the first open makes the connection's own start the baseline. */
  private async seedSignature(pageId: string): Promise<void> {
    if (this.seenSignature.has(pageId)) return;
    try { this.closeSocketsOfChangedPages(await this.store.list()); } catch { /* the connection check that follows reports a real failure */ }
  }

  private closeSocketsOfChangedPages(pages: PageSummary[]): void {
    const now = new Set<string>();
    for (const p of pages) {
      now.add(p.id);
      // Only what the MANIFEST says: whether a line is approved or has a saved
      // key moves on every Allow/Remove and is closed for separately (with the
      // right connection), so it must not close the page's other sockets here.
      const manifest = (p.connections ?? []).map(({ approved: _a, savedKey: _k, ...rest }) => rest);
      const sig = `${p.htmlStamp}|${JSON.stringify(manifest)}`;
      const before = this.seenSignature.get(p.id);
      this.seenSignature.set(p.id, sig);
      if (before !== undefined && before !== sig) this.closeLiveFor(p.id, undefined, 'This page was changed, so its live connection stopped.');
    }
    for (const id of [...this.seenSignature.keys()]) {
      if (!now.has(id)) { this.seenSignature.delete(id); this.closeLiveFor(id, undefined, 'This page is no longer in your library.'); }
    }
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
  async approve(id: string, keys: Record<string, string>, opts: { remote: boolean; addresses?: Record<string, string> }): Promise<PageApproveResult> {
    const store = this.deps.connections;
    if (!store) return { ok: false, message: 'Page connections are not available on this computer.' };
    const info = await this.store.connectionsOf(id);
    const pageKey = await this.store.approvalKeyFor(id);
    if (!info || !pageKey) return { ok: false, message: 'This page is no longer in your library.' };

    let recorded: Record<string, PageApproval>;
    try { recorded = await store.approvalsFor(pageKey); }
    catch (e) { return { ok: false, message: messageOf(e) }; }
    // A device line waiting for a yes takes the address the person allowed
    // (home-device deck, Q-address), re-checked here because the card's check
    // is only a courtesy: a crafted message must not record a website.
    const waiting: PageConnection[] = [];
    for (const c of info.connections) {
      if (recorded[c.id]?.fingerprint === fingerprint(c)) continue;
      if (c.kind !== 'device') { waiting.push(c); continue; }
      const raw = opts.addresses?.[c.id];
      const address = raw === undefined ? c.address : cleanDeviceAddress(raw);
      if (!address) return { ok: false, message: `${String(raw)} is not an address inside your home or Tailscale network, so it cannot be allowed.` };
      waiting.push({ ...c, address });
    }
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
      const target = savedKeyTarget(c);
      if (!target) continue;
      const typed = (keys?.[c.id] ?? '').trim();
      const reuseSaved = typed === '' || typed === 'saved';
      if (!reuseSaved && opts.remote) return { ok: false, message: NO_KEYS_FROM_REMOTE };
      // A Plaid key is both halves as one JSON string (the card builds it);
      // refuse half of one here rather than save something that can never work.
      if (!reuseSaved && c.kind === 'plaid' && !parseCredentials(typed)) {
        return { ok: false, message: 'Paste both the Plaid client ID and the secret to connect.' };
      }
      try {
        if (reuseSaved) {
          if (!(await store.savedKey(target.service, target.address))) {
            return { ok: false, message: `No ${target.service} key is saved on this computer yet. Add one to let this page use it.` };
          }
        } else {
          await store.saveKey(target.service, target.address, typed, keyPlacement(c));
        }
      } catch (e) { return { ok: false, message: messageOf(e) }; }
    }

    const at = new Date().toISOString();
    const htmlHash = hashHtml(info.html);
    const fresh: Record<string, PageApproval> = {};
    for (const c of waiting) {
      fresh[c.id] = { fingerprint: fingerprint(c), approvedAt: at, htmlHash, ...(c.kind === 'device' ? { address: c.address } : {}) };
    }
    try { await store.recordApprovals(pageKey, fresh); }
    catch (e) { return { ok: false, message: messageOf(e) }; }
    // A new approval (maybe a new address or key) is a new yes: sockets opened
    // on the old one close and are asked for again under the new rules.
    this.closeLiveFor(id);
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
    // The person withdrew this connection: its live sockets stop at once.
    this.closeLiveFor(id, connectionId, 'This connection was removed, so its live connection stopped.');
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
          .filter((p) => (p.connections ?? []).some((c) => { const t = savedKeyTarget(c); return !!t && c.approved && savedKeyId(t.service, t.address) === id; }))
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
      .filter((p) => (p.connections ?? []).some((c) => { const t = savedKeyTarget(c); return !!t && t.service === service && t.address === address; }))
      .map((p) => p.id);
    // Which connection of each page stood on this key, for the live sockets.
    const connectionsOn = before.flatMap((p) => (p.connections ?? [])
      .filter((c) => { const t = savedKeyTarget(c); return !!t && t.service === service && t.address === address; })
      .map((c) => ({ page: p.id, connection: c.id })));
    await this.deps.connections?.deleteSavedKey(service, address).catch(() => { /* nothing saved under that name */ });
    for (const id of affected) this.freshness.delete(id);
    for (const c of connectionsOn) this.closeLiveFor(c.page, c.connection, 'The saved key was deleted, so the live connection stopped.');
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
      const door = await this.doorContext(id, new AbortController().signal);
      if (!door.ok) return door.refusal;
      const doorCtx = door.ctx;
      // A socket exchange (renames and room moves on a home device) is the
      // same door with a different transport: same approvals, same rate gate,
      // its own caps and timeout (page-socket.ts).
      const result = request.socket
        ? await performPageSocket(request, { ...doorCtx, connect: this.deps.socketConnect })
        : await performPageFetch(request, { ...doorCtx, pageId: id });
      // Step 7: freshness is recorded per page AND per connection, and ONLY on
      // a 2xx (finding 12) — otherwise a page pinging an approved URL on a
      // timer could keep the band green over week-old numbers.
      this.noteFreshness(id, result.ok && result.status >= 200 && result.status < 300);
      return result;
    } finally {
      this.gate.release(id);
    }
  }

  /** Pages that are mid-way through a bank sign-in, so a second press of
   *  "Connect a bank" does not open a second browser tab. */
  private readonly plaidLinking = new Map<string, AbortController>();

  /** `pages:plaid` — the page asked the app to do one Plaid thing. The page
   *  must hold an APPROVED plaid connection (the fingerprint on disk matches),
   *  and the answer never carries a key or a bank's sign-in. Desktop only:
   *  the remote bridge does not offer it, because a bank sign-in opens a
   *  browser on this computer. */
  async plaid(id: string, raw: unknown): Promise<PlaidResult> {
    const req = cleanPlaidRequest(raw);
    if (!req) return { ok: false, op: 'status', code: 'BAD_REQUEST', message: 'The page asked Plaid for something the app does not do.' };
    const refuse = (message: string, code = 'NOT_APPROVED'): PlaidResult => ({ ok: false, op: req.op, code, message });
    const store = this.deps.connections;
    const items = this.plaidItems;
    if (!store || !items) return refuse('Bank connections are not available on this computer.', 'UNAVAILABLE');
    const info = await this.store.connectionsOf(id);
    const pageKey = await this.store.approvalKeyFor(id);
    if (!info || !pageKey) return refuse('This page is no longer in your library.');
    const c = info.connections.find((x) => x.kind === 'plaid');
    if (!c || c.kind !== 'plaid') return refuse('This page has no bank connection.');
    let records: Record<string, PageApproval>;
    try { records = await store.approvalsFor(pageKey); } catch (e) { return refuse(messageOf(e)); }
    if (records[c.id]?.fingerprint !== fingerprint(c)) return refuse('This page has not been allowed to use your banks yet.');
    const record = await store.savedKey(PLAID_SERVICE, plaidAddress(c.environment));
    const creds = parseCredentials(record ? await store.keyValue(record).catch(() => null) : null);
    if (!creds) return refuse('No Plaid keys are saved on this computer. Open the page’s connections to add them.', 'NO_KEYS');

    // Cancel stops this page's open sign-in. Starting a new one also stops the old one, so a closed browser tab can
    // never leave the Connect button stuck.
    if (req.op === 'cancel') { this.plaidLinking.get(id)?.abort(); this.plaidLinking.delete(id); return { ok: true, op: 'cancel', items: [] }; }
    const linking = req.op === 'connect' || req.op === 'reconnect';
    if (!linking && !(await this.gate.acquire(id))) return refuse('This page is asking faster than the app will allow. Try again shortly.', 'TOO_MANY');
    let mine: AbortController | undefined;
    if (linking) { this.plaidLinking.get(id)?.abort(); mine = new AbortController(); this.plaidLinking.set(id, mine); }
    try {
      const result = await runPlaid({
        env: c.environment, creds, items,
        openExternal: this.deps.openExternal ?? openPlaidLink,
        fetchImpl: this.deps.fetchImpl,
        signal: mine?.signal,
      }, req);
      if (req.op === 'accounts') this.noteFreshness(id, result.ok && result.items.every((i) => i.ok));
      // Plaid's code only (never a key or message), so a failed connection can be diagnosed from the log.
      if (!result.ok && result.code !== 'CANCELLED') log('WARN', 'Pages', 'Plaid request failed', { op: req.op, code: result.code, env: c.environment });
      if (result.ok && req.op === 'accounts') for (const it of result.items) if (!it.ok) log('WARN', 'Pages', 'Plaid bank not answering', { code: it.error?.code, bank: it.institution.name });
      return result;
    } finally {
      if (linking) { if (this.plaidLinking.get(id) === mine) this.plaidLinking.delete(id); } else this.gate.release(id);
    }
  }

  /** What the one door and the live socket both need to judge a request for
   *  this page: its connections, the fingerprints the person approved, and the
   *  credential lookup. A device is reached ONLY at the address the person
   *  allowed. One with no recorded address (an approval from before addresses
   *  were kept, or a hand-edited file) is dropped from the list, so nothing
   *  matches it and the request is refused as not allowed — never sent to the
   *  suggestion. Extracted unchanged from fetch() so a live socket re-runs the
   *  very same chain on every reconnect. */
  private async doorContext(id: string, signal: AbortSignal): Promise<
    { ok: true; ctx: { connections: PageConnection[]; approved: Record<string, string>; credential: (c: PageConnection) => Promise<PageCredential | null>; signal: AbortSignal; fetchImpl?: typeof fetch; lookup?: PagesServiceDeps['lookup'] } }
    | { ok: false; refusal: PageFetchResult }
  > {
    const store = this.deps.connections;
    const info = await this.store.connectionsOf(id);
    const pageKey = await this.store.approvalKeyFor(id);
    if (!store || !info || !pageKey) {
      return { ok: false, refusal: { ok: false, reason: 'not-approved', message: 'This page is no longer in your library.' } };
    }
    let approved: Record<string, string> = {};
    let records: Record<string, PageApproval> = {};
    try {
      records = await store.approvalsFor(pageKey);
      approved = Object.fromEntries(Object.entries(records).map(([k, v]) => [k, v.fingerprint]));
    } catch (e) { return { ok: false, refusal: { ok: false, reason: 'not-approved', message: messageOf(e) } }; }
    const connections = info.connections.flatMap((c) => {
      if (c.kind !== 'device') return [c];
      const address = records[c.id]?.address;
      return address ? [withApprovedAddress(c, address)] : [];
    });
    return {
      ok: true,
      ctx: {
        connections,
        approved,
        credential: (c: PageConnection) => this.credentialFor(c),
        signal,
        fetchImpl: this.deps.fetchImpl,
        lookup: this.deps.lookup,
      },
    };
  }

  /** The live socket's access check: the shared chain, run fresh. */
  private async socketAccess(pageId: string, url: string, signal: AbortSignal): Promise<DeviceSocketAccess> {
    await this.seedSignature(pageId);
    const door = await this.doorContext(pageId, signal);
    return door.ok ? checkDeviceSocketAccess(url, door.ctx) : { ok: false, refusal: door.refusal };
  }

  /** The video's access check: the same shared chain, run fresh, for the
   *  device connection the page NAMED BY ID. The address is the one the person
   *  approved (doorContext already swapped it in) and the socket path is the
   *  profile's own, so a page chooses neither. */
  private async videoAccess(pageId: string, connectionId: string, signal: AbortSignal): Promise<DeviceSocketAccess> {
    await this.seedSignature(pageId);
    const door = await this.doorContext(pageId, signal);
    if (!door.ok) return { ok: false, refusal: door.refusal };
    const c = door.ctx.connections.find((x) => x.id === connectionId);
    if (!c || c.kind !== 'device') return { ok: false, refusal: { ok: false, reason: 'not-approved', message: 'This page has no home device connection by that name.' } };
    return checkDeviceSocketAccess(`http://${c.address}${c.videoProfile?.socketPath ?? '/api/websocket'}`, door.ctx, c.id);
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
      // Plaid's keys go only into plaid.ts's own calls, never onto a page fetch.
      case 'public':
      case 'open':
      case 'plaid':
        return null;
      case 'device':
      case 'key': {
        // A keyed device is a saved key at the ALLOWED address (c.address is
        // already the approved one by the time the door asks).
        if (!store || (c.kind === 'device' && !c.needsKey)) return null;
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
      for (const c of p.connections ?? []) { const t = savedKeyTarget(c); if (t) usedKeyIds.add(savedKeyId(t.service, t.address)); }
    }
    await store.prune(livePageKeys, usedKeyIds).catch(() => { /* housekeeping, never a user-visible failure */ });
  }

  private broadcastNow(): void {
    void this.listAndWatch().then((pages) => this.deps.broadcast(pages)).catch(() => {});
  }

  stop(): void {
    this.sockets.closeAll();
    this.videos.closeAll();
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
  // The assistant's page-data tools (claude-code-pages-mcp.ts) look in the same Personal Pages/ folder.
  setPersonalPagesRoot(() => { const root = deps.personalRoot(); return root ? path.join(root, PAGES_DIR) : null; });
  service?.stop();
  service = new PagesService(deps);
  service.ensureWatching();
  return service;
}

export function getPagesService(): PagesService | null { return service; }
