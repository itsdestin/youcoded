// What the person allowed a page to reach, and which saved key it uses.
//
// Design: youcoded-dev/docs/active/specs/2026-09-20-youcoded-pages-phase2-technical-design.md §3
//
// `<userData>/page-connections.json`, per install and NEVER synced — the same
// reasoning as providers/secrets-store.ts: a key is machine-bound ciphertext,
// so an approval that travelled without it would be a promise the other
// machine cannot keep. This file holds POINTERS only; every key value lives in
// SecretsStore (safeStorage), which refuses a plaintext fallback by design.
//
// Three rules from design review 1 are load-bearing here:
//   * finding 3 — a key is keyed by service AND address, so a second page
//     cannot point your OpenWeather key at its own collector.
//   * finding 5 — a project page's approval is keyed by the project's
//     CANONICAL PATH, never its display name, so two clones both called
//     `dashboard` do not share a grant.
//   * finding 10 — an unknown `version` refuses everything with a plain
//     message rather than parsing what it half-understands.
//
// Freshness is deliberately NOT here: a fetch can happen 60x a minute and
// approvals must not share a hot write path. It lives in memory, in
// pages-service.ts.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import type { SecretsStore } from '../providers/secrets-store';
import type { PageHome } from '../../shared/pages-types';

export const CONNECTIONS_FILE = 'page-connections.json';
const VERSION = 1;

/** What one approved connection recorded at the moment Allow was pressed. */
export interface PageApproval {
  /** page-connections.ts fingerprint(): the approval lapses when this moves. */
  fingerprint: string;
  approvedAt: string;
  /** sha256 of page.html as it was then. RECORDED ONLY — whether rewriting a
   *  page's code should make it ask again is a question for Destin (design
   *  review 1, finding 5), so nothing reads this yet. */
  htmlHash: string;
}

/** Where a saved key lives and how the service takes it. */
export interface PageKeyRecord {
  secretRef: string;
  in: 'header' | 'query';
  /** The header name or the query-parameter name. */
  param: string;
  /** The word before the key in a header. Recorded at approval, like the
   *  placement, because what was approved is what is sent. */
  scheme: 'bearer' | 'token' | 'none';
}

interface ConnectionsFile {
  version: number;
  pages: Record<string, Record<string, PageApproval>>;
  keys: Record<string, PageKeyRecord>;
}

export const UNKNOWN_VERSION_MESSAGE =
  'The saved page connections on this computer were written by a newer version of YouCoded, so they cannot be read here. Nothing was changed.';

/** Thrown when the file cannot be honoured as written. The caller shows the
 *  message; it never guesses a cause (docs/error-message-standards.md). */
export class ConnectionsUnreadableError extends Error {}

const EMPTY: ConnectionsFile = { version: VERSION, pages: {}, keys: {} };

/** The key an approval is recorded under. A project page carries the project's
 *  canonical path, not its folder name (finding 5). */
export function approvalKey(home: PageHome, slug: string): string {
  return home.kind === 'project' ? `project@${canonicalize(home.path, null)}:${slug}` : `personal:${slug}`;
}

/** A saved key is identified by service AND address (finding 3). */
export function savedKeyId(service: string, address: string): string {
  return `${service}|${address}`;
}

export function hashHtml(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex');
}

/** Everything one read of the file answers, so a page listing reads it once
 *  rather than once per page. */
export interface ConnectionsSnapshot {
  pages: Record<string, Record<string, PageApproval>>;
  keys: Record<string, PageKeyRecord>;
}

export class PageConnectionsStore {
  private readonly file: string;

  constructor(userDataDir: string, private readonly secrets: SecretsStore) {
    this.file = path.join(userDataDir, CONNECTIONS_FILE);
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /** Throws ConnectionsUnreadableError when the file names a version we do not
   *  understand. Unparseable JSON reads as EMPTY instead: the worst that costs
   *  is being asked to approve again, whereas guessing at half a record could
   *  hand a page a grant nobody gave it. */
  async read(): Promise<ConnectionsSnapshot> {
    let raw: string;
    try { raw = await fs.readFile(this.file, 'utf8'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { pages: {}, keys: {} };
      throw e;
    }
    return parseFile(raw);
  }

  /** The approvals recorded for one page, or {} when it has none. */
  async approvalsFor(pageKey: string): Promise<Record<string, PageApproval>> {
    return (await this.read()).pages[pageKey] ?? {};
  }

  async savedKey(service: string, address: string): Promise<PageKeyRecord | null> {
    return (await this.read()).keys[savedKeyId(service, address)] ?? null;
  }

  /** The key itself, decrypted. Null when the ref is gone (a key deleted on
   *  another window) — never a thrown crypto error carrying secret bytes. */
  async keyValue(record: PageKeyRecord): Promise<string | null> {
    return this.secrets.get(record.secretRef);
  }

  // ── Writing ──────────────────────────────────────────────────────────────

  /** Encrypt and remember one key. Throws with a showable message when the
   *  computer has no keychain — SecretsStore refuses a plaintext fallback by
   *  design, and the caller must then record NO approval (finding 11). */
  async saveKey(service: string, address: string, plaintext: string, placement: { in: 'header' | 'query'; param: string; scheme: 'bearer' | 'token' | 'none' }): Promise<PageKeyRecord> {
    const id = savedKeyId(service, address);
    // Reuse the existing ref when there is one, so replacing a key rotates it
    // in place and every page pointing at it keeps working.
    const existing = (await this.read()).keys[id];
    const secretRef = await this.secrets.set(plaintext, existing?.secretRef);
    const record: PageKeyRecord = { secretRef, in: placement.in, param: placement.param, scheme: placement.in === 'query' ? 'none' : placement.scheme };
    await this.mutate((cur) => { cur.keys[id] = record; return true; });
    return record;
  }

  /** Record every connection the person just allowed, merged into whatever the
   *  page already had. */
  async recordApprovals(pageKey: string, approvals: Record<string, PageApproval>): Promise<void> {
    if (Object.keys(approvals).length === 0) return;
    await this.mutate((cur) => {
      cur.pages[pageKey] = { ...(cur.pages[pageKey] ?? {}), ...approvals };
      return true;
    });
  }

  /** Stop future use of one connection; the page asks again next time. */
  async removeApproval(pageKey: string, connectionId: string): Promise<void> {
    await this.mutate((cur) => {
      const page = cur.pages[pageKey];
      if (!page || !(connectionId in page)) return false;
      delete page[connectionId];
      if (Object.keys(page).length === 0) delete cur.pages[pageKey];
      return true;
    });
  }

  /** Delete a saved key and every approval that was standing on it, then the
   *  secret itself. Cutting the approvals too is the point: leaving them would
   *  show a page as connected while every request it makes is unauthenticated. */
  async deleteSavedKey(service: string, address: string): Promise<void> {
    const id = savedKeyId(service, address);
    const record = (await this.read()).keys[id];
    const prefix = `key|${service}|${address}|`;
    await this.mutate((cur) => {
      let changed = false;
      if (cur.keys[id]) { delete cur.keys[id]; changed = true; }
      for (const [pageKey, page] of Object.entries(cur.pages)) {
        for (const [connId, approval] of Object.entries(page)) {
          if (!approval.fingerprint.startsWith(prefix)) continue;
          delete page[connId];
          changed = true;
        }
        if (Object.keys(page).length === 0) delete cur.pages[pageKey];
      }
      return changed;
    });
    if (record) await this.secrets.delete(record.secretRef).catch(() => { /* the pointer is gone; an undeletable blob is inert */ });
  }

  /**
   * Drop what nothing points at any more: approvals whose page is gone, and
   * keys no page uses. Deleting the last user of a key deletes its secret too,
   * so `native-secrets.json` never accumulates blobs nothing can name.
   *
   * WHY the caller passes the live sets rather than this class computing them:
   * an empty page list is a normal transient state (the Personal sync root can
   * be absent for a moment at startup), and pruning against one would silently
   * revoke every grant on the machine. The caller only prunes after a listing
   * it trusts, and never prunes on an empty one.
   */
  async prune(livePageKeys: ReadonlySet<string>, usedKeyIds: ReadonlySet<string>): Promise<void> {
    const orphanedRefs: string[] = [];
    await this.mutate((cur) => {
      let changed = false;
      for (const pageKey of Object.keys(cur.pages)) {
        if (livePageKeys.has(pageKey)) continue;
        delete cur.pages[pageKey];
        changed = true;
      }
      for (const [id, record] of Object.entries(cur.keys)) {
        if (usedKeyIds.has(id)) continue;
        delete cur.keys[id];
        orphanedRefs.push(record.secretRef);
        changed = true;
      }
      return changed;
    });
    for (const ref of orphanedRefs) await this.secrets.delete(ref).catch(() => { /* inert without its pointer */ });
  }

  /**
   * Read-modify-write inside cas-write's mkdir lock — the pattern
   * secrets-store.ts and pages-store.ts already use, so two YouCoded processes
   * sharing one userData cannot interleave and lose a grant. `mutate` returns
   * false to skip the write entirely.
   */
  private async mutate(mutate: (cur: ConnectionsFile) => boolean): Promise<void> {
    let refused: string | null = null;
    const ok = await mutateFileUnderLock(this.file, (onDisk) => {
      let cur: ConnectionsFile;
      try { cur = onDisk === null ? { version: VERSION, pages: {}, keys: {} } : toFile(parseFile(onDisk)); }
      catch (e) { refused = e instanceof ConnectionsUnreadableError ? e.message : UNKNOWN_VERSION_MESSAGE; return null; }
      return mutate(cur) ? JSON.stringify(cur, null, 2) : null;
    });
    if (refused) throw new ConnectionsUnreadableError(refused);
    if (!ok) throw new Error('The saved page connections file is busy; try again in a moment.');
  }
}

function toFile(snapshot: ConnectionsSnapshot): ConnectionsFile {
  return { version: VERSION, pages: snapshot.pages, keys: snapshot.keys };
}

/** One parser, shared by read() and mutate(), so their tolerance cannot drift. */
function parseFile(raw: string): ConnectionsSnapshot {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { pages: {}, keys: {} }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { pages: {}, keys: {} };
  const o = parsed as Partial<ConnectionsFile>;
  // finding 10: a version we do not know refuses EVERYTHING with a plain
  // sentence. Reading the parts that happen to look familiar would be exactly
  // the half-understanding the refusal exists to prevent.
  if (o.version !== VERSION) throw new ConnectionsUnreadableError(UNKNOWN_VERSION_MESSAGE);
  return { pages: cleanPages(o.pages), keys: cleanKeys(o.keys) };
}

function cleanPages(raw: unknown): Record<string, Record<string, PageApproval>> {
  const out: Record<string, Record<string, PageApproval>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [pageKey, page] of Object.entries(raw as Record<string, unknown>)) {
    if (!page || typeof page !== 'object') continue;
    const kept: Record<string, PageApproval> = {};
    for (const [connId, entry] of Object.entries(page as Record<string, unknown>)) {
      const e = entry as Partial<PageApproval> | null;
      if (!e || typeof e.fingerprint !== 'string' || !e.fingerprint) continue;
      kept[connId] = {
        fingerprint: e.fingerprint,
        approvedAt: typeof e.approvedAt === 'string' ? e.approvedAt : '',
        htmlHash: typeof e.htmlHash === 'string' ? e.htmlHash : '',
      };
    }
    if (Object.keys(kept).length) out[pageKey] = kept;
  }
  return out;
}

function cleanKeys(raw: unknown): Record<string, PageKeyRecord> {
  const out: Record<string, PageKeyRecord> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    const e = entry as Partial<PageKeyRecord> | null;
    if (!e || typeof e.secretRef !== 'string' || !e.secretRef || typeof e.param !== 'string' || !e.param) continue;
    // A record written before schemes existed had none; only the query case
    // was ever valid bare, so an older header record reads as 'none' (what it
    // actually sent) rather than silently changing to Bearer.
    const scheme = e.scheme === 'bearer' || e.scheme === 'token' ? e.scheme : 'none';
    out[id] = { secretRef: e.secretRef, in: e.in === 'query' ? 'query' : 'header', param: e.param, scheme: e.in === 'query' ? 'none' : scheme };
  }
  return out;
}

/** `service|address` split back apart for the Settings list. */
export function splitSavedKeyId(id: string): { service: string; address: string } | null {
  const i = id.lastIndexOf('|');
  if (i <= 0 || i === id.length - 1) return null;
  return { service: id.slice(0, i), address: id.slice(i + 1) };
}
