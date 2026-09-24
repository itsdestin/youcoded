// desktop/src/main/project-extensions/store.ts
//
// The per-project settings record (technical design 2026-09-24 §1/§2): one
// record per project key (project-key.ts), holding which plugins/skills/tool
// connections are on. Mirrors sync-spaces/project-registry.ts's fold-on-read /
// locked-read-modify-write pattern:
//   - synced project  -> Personal/ProjectExtensions/<name>.json, one file per
//     project, folded against its OWN conflict copies on read (no writeback —
//     "fold-on-read is load-bearing" per project-registry.ts's header, same
//     reasoning applies here).
//   - unsynced folder -> ~/.youcoded/project-extensions.local.json, ONE file
//     holding a map of canonical path -> record. Never synced (NativeHome
//     owns ~/.youcoded/ writes — see native-home.ts's own header).
//
// All I/O is async (performance rule 1) — every read goes through
// fs.promises / NativeHome.readJsonAsync, every write through the existing
// locked read-modify-write helper (mutateFileUnderLock) or NativeHome's
// mutateJson, which wraps the SAME lock.
import * as fs from 'fs';
import * as path from 'path';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import { laterOf, isConflictCopyName, extractConflictBase } from '../conversations/store-core';
import { validateSyncName } from '../sync-spaces/guards';
import type { NativeHome } from '../native-home';
import {
  seedDefaultOn, itemKeyForSkill, itemKeyForMcp,
  type CatalogSkillEntry, type CatalogMcpEntry, type PluginInstallInfo,
} from './resolve';

export const PROJECT_EXTENSIONS_SCHEMA = 1;

export interface ProjectPluginState {
  on: boolean;
  /** False until the user has explicitly chosen individual parts for this
   *  plugin at least once. See resolve.ts's "first enable turns all parts
   *  on" rule — this is the flag that rule reads. */
  partsChosen: boolean;
  /** Uninstall cascade tombstone (§2) — set alongside on:false by
   *  markPluginRemoved(). Absent (not `false`) when never removed, so a
   *  round-tripped record never grows a stray `"removed":false`. */
  removed?: boolean;
  /** ms epoch — last-writer-wins clock for this WHOLE entry (design §1: "per
   *  entry, last-writer-wins by at"). */
  at: number;
}

export interface ProjectItemState {
  on: boolean;
  /** ms epoch — last-writer-wins clock for this entry. */
  at: number;
}

export interface ProjectExtensionsRecord {
  schemaVersion: number;
  /** ms epoch; 0 means "never seeded". Merges as the earliest non-zero value
   *  across copies (design §2) so every device agrees on one seed moment. */
  seededAt: number;
  plugins: Record<string, ProjectPluginState>;
  items: Record<string, ProjectItemState>;
}

function emptyRecord(): ProjectExtensionsRecord {
  return { schemaVersion: PROJECT_EXTENSIONS_SCHEMA, seededAt: 0, plugins: {}, items: {} };
}

// ---------------------------------------------------------------------------
// Parse — fail-soft everywhere (dev instance + built app share these trees;
// a corrupt/partial file must never throw into a read path). An individual
// malformed plugin/item entry is dropped; the record itself is dropped only
// when its OWN shape (schemaVersion) is unrecognized.
// ---------------------------------------------------------------------------

function parsePluginState(raw: unknown): ProjectPluginState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.on !== 'boolean') return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  // Spread FIRST, then overwrite the fields we validate: a field this build
  // doesn't know about (written by a newer build) round-trips unharmed —
  // design §1's "unknown keys are preserved on write".
  return {
    ...(r as unknown as ProjectPluginState),
    on: r.on,
    partsChosen: r.partsChosen === true,
    removed: r.removed === true ? true : undefined,
    at: r.at,
  };
}

function parseItemState(raw: unknown): ProjectItemState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.on !== 'boolean') return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  return { ...(r as unknown as ProjectItemState), on: r.on, at: r.at };
}

/** Parse an already-JSON.parsed value (NativeHome.mutateJson/readJsonAsync
 *  hand back parsed values, not strings). */
export function parseProjectExtensionsRecordValue(raw: unknown): ProjectExtensionsRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== PROJECT_EXTENSIONS_SCHEMA) return null;
  const plugins: Record<string, ProjectPluginState> = {};
  if (r.plugins && typeof r.plugins === 'object') {
    for (const [k, v] of Object.entries(r.plugins as Record<string, unknown>)) {
      const p = parsePluginState(v);
      if (p) plugins[k] = p; // an unrecognized/malformed key's own entry is skipped, never the whole map
    }
  }
  const items: Record<string, ProjectItemState> = {};
  if (r.items && typeof r.items === 'object') {
    for (const [k, v] of Object.entries(r.items as Record<string, unknown>)) {
      const it = parseItemState(v);
      if (it) items[k] = it;
    }
  }
  return {
    // Fix (T1 review F2): spread the RAW object FIRST, then overwrite the
    // fields this build validates — same "spread first" convention
    // parsePluginState/parseItemState already use for a per-entry unknown
    // field. Without this, a top-level field a NEWER build adds (this record
    // has none today, but the sibling ProjectSync/<name>.json record already
    // hit this exact bug once — see this file's own header comment) would be
    // silently dropped on the next read-modify-write from an older build.
    ...r,
    schemaVersion: PROJECT_EXTENSIONS_SCHEMA,
    seededAt: typeof r.seededAt === 'number' && Number.isFinite(r.seededAt) ? r.seededAt : 0,
    plugins,
    items,
  } as ProjectExtensionsRecord;
}

/** Parse a raw JSON string (the synced side reads raw file text). */
export function parseProjectExtensionsRecord(json: string): ProjectExtensionsRecord | null {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  return parseProjectExtensionsRecordValue(raw);
}

// ---------------------------------------------------------------------------
// Merge — PURE, commutative + associative lattice join (mirrors
// project-registry.ts's mergeProjectEntries): a plain reduce over any copy
// order converges on the same record.
// ---------------------------------------------------------------------------

function pickEarliestNonZero(a: number, b: number): number {
  // design §2: seededAt merges as the EARLIEST non-zero value — 0 means
  // "absent", so it must never win over a real seed instant on the other side.
  if (a === 0) return b;
  if (b === 0) return a;
  return Math.min(a, b);
}

function mergeStateMaps<T extends { at: number }>(
  a: Record<string, T>, b: Record<string, T>,
): Record<string, T> {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Record<string, T> = {};
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    // Whole-entry last-writer-wins by `at`, content-tiebroken (laterOf) —
    // design §1: "per entry, last-writer-wins by at (content tie-break)".
    // Safe to pick the WHOLE object here (unlike project-registry's
    // displayName/description split) because one entry IS one atomic write:
    // on/partsChosen/removed/at all change together in a single user action.
    out[k] = av && bv ? laterOf(av, bv, av.at, bv.at) : (av ?? bv);
  }
  return out;
}

/** PURE two-way merge. Exported for the unit table (design §6). */
export function mergeProjectExtensionsRecords(
  a: ProjectExtensionsRecord, b: ProjectExtensionsRecord,
): ProjectExtensionsRecord {
  return {
    // Fix (T1 review F2): carry over any top-level field neither `a` nor `b`
    // is typed to know about (same reasoning as parseProjectExtensionsRecordValue's
    // own spread-first fix) — b's copy of a shared unknown key wins, which is
    // no worse than dropping it outright, and every field this build DOES
    // know about is overwritten immediately below regardless.
    ...a, ...b,
    schemaVersion: PROJECT_EXTENSIONS_SCHEMA,
    seededAt: pickEarliestNonZero(a.seededAt, b.seededAt),
    plugins: mergeStateMaps(a.plugins, b.plugins),
    items: mergeStateMaps(a.items, b.items),
  };
}

function foldProjectExtensionsRecords(records: ProjectExtensionsRecord[]): ProjectExtensionsRecord {
  return records.reduce((acc, r) => mergeProjectExtensionsRecords(acc, r));
}

// ---------------------------------------------------------------------------
// Key routing — a project key is either a valid sync name (never contains a
// path separator — validateSyncName rejects '/' and '\') or a canonical path
// (always contains at least one '/' after canonicalize()). The two shapes
// can never collide, so this is an exact, mock-free way to route without any
// filesystem existence check (which would misclassify a synced project whose
// local folder hasn't been pulled yet).
// ---------------------------------------------------------------------------

export function isSyncedProjectKey(projectKey: string): boolean {
  return validateSyncName(projectKey) === null;
}

export interface ProjectExtensionsStores {
  /** ~/YouCoded/Personal (ManagedRoots.personalRoot) — synced records live
   *  under its ProjectExtensions/ sibling folder. */
  personalRoot: string;
  /** The ~/.youcoded/ home for the unsynced, local-only store. */
  home: NativeHome;
}

const LOCAL_STORE_REL = 'project-extensions.local.json';

function extensionsDir(personalRoot: string): string {
  return path.join(personalRoot, 'ProjectExtensions');
}

// ---------------------------------------------------------------------------
// Synced store (one file per project name, folded against its own copies)
// ---------------------------------------------------------------------------

/** Read + fold a synced project's record against its OWN conflict copies
 *  only — never the whole ProjectExtensions/ directory. Unlike
 *  project-registry.ts (which enumerates every project at once and has to
 *  disambiguate copies by content), a caller here already knows the exact
 *  canonical name it wants, so `extractConflictBase(n) === '<name>.json'` is
 *  unambiguous — no content-vs-filename trick needed. */
async function readSyncedRecord(personalRoot: string, name: string): Promise<ProjectExtensionsRecord | null> {
  const dir = extensionsDir(personalRoot);
  const canonicalFile = `${name}.json`;
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return null; }
  const toRead = names.filter((n) => n === canonicalFile || extractConflictBase(n) === canonicalFile);
  const records: ProjectExtensionsRecord[] = [];
  for (const n of toRead) {
    try {
      const raw = await fs.promises.readFile(path.join(dir, n), 'utf8');
      const rec = parseProjectExtensionsRecord(raw);
      if (rec) records.push(rec);
    } catch { /* vanished mid-read or unreadable — skip, fail-soft */ }
  }
  if (records.length === 0) return null;
  return foldProjectExtensionsRecords(records);
}

/** Locked read-modify-write on the CANONICAL file only. Writers don't need to
 *  fold conflict copies themselves — read-time fold (above) plus a fresh
 *  `at` on every write already guarantee a correct eventual read, exactly as
 *  project-registry.ts's mutateCanonical comment explains. */
async function mutateSyncedRecord(
  personalRoot: string, name: string,
  fn: (cur: ProjectExtensionsRecord | null) => ProjectExtensionsRecord | null,
): Promise<ProjectExtensionsRecord | null> {
  const dir = extensionsDir(personalRoot);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  let result: ProjectExtensionsRecord | null = null;
  const committed = await mutateFileUnderLock(file, (onDisk) => {
    const cur = onDisk ? parseProjectExtensionsRecord(onDisk) : null;
    const next = fn(cur);
    result = next ?? cur;
    return next === null ? null : JSON.stringify(next, null, 2) + '\n'; // null -> skip the write
  });
  if (!committed) throw new Error(`project-extensions: could not write '${name}' (lock timeout)`);
  return result;
}

async function listSyncedProjectNames(personalRoot: string): Promise<string[]> {
  const dir = extensionsDir(personalRoot);
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.json') && !isConflictCopyName(n))
    .map((n) => n.slice(0, -'.json'.length));
}

// ---------------------------------------------------------------------------
// Local (unsynced) store — one file, a map of canonical path -> record.
// ---------------------------------------------------------------------------

function parseLocalMapValue(raw: unknown): Record<string, ProjectExtensionsRecord> {
  const out: Record<string, ProjectExtensionsRecord> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const rec = parseProjectExtensionsRecordValue(v);
    if (rec) out[k] = rec;
  }
  return out;
}

async function readLocalRecord(home: NativeHome, key: string): Promise<ProjectExtensionsRecord | null> {
  const raw = await home.readJsonAsync(LOCAL_STORE_REL);
  const map = parseLocalMapValue(raw);
  return map[key] ?? null;
}

async function mutateLocalRecord(
  home: NativeHome, key: string,
  fn: (cur: ProjectExtensionsRecord | null) => ProjectExtensionsRecord | null,
): Promise<ProjectExtensionsRecord | null> {
  let result: ProjectExtensionsRecord | null = null;
  await home.mutateJson(LOCAL_STORE_REL, (raw) => {
    // Build the next value from the RAW object (preserving any entry this
    // build can't parse) — only the one key being mutated is replaced by its
    // sanitized form. A single device owns this file (never synced), so no
    // conflict-copy folding applies here.
    const rawMap = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    const cur = parseProjectExtensionsRecordValue((raw as Record<string, unknown> | null)?.[key] ?? null);
    const next = fn(cur);
    result = next ?? cur;
    if (next === null) return rawMap; // no-op — still a valid, unchanged value for mutateJson to write
    rawMap[key] = next;
    return rawMap;
  });
  return result;
}

async function listLocalProjectKeys(home: NativeHome): Promise<string[]> {
  const raw = await home.readJsonAsync(LOCAL_STORE_REL);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.keys(raw as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Public API — routes by key shape (isSyncedProjectKey), so callers never
// need to track synced-ness themselves once they have a project key.
// ---------------------------------------------------------------------------

export async function getProjectExtensions(
  stores: ProjectExtensionsStores, projectKey: string,
): Promise<ProjectExtensionsRecord | null> {
  return isSyncedProjectKey(projectKey)
    ? readSyncedRecord(stores.personalRoot, projectKey)
    : readLocalRecord(stores.home, projectKey);
}

/** Locked read-modify-write, routed the same way. `fn` may return null to
 *  skip the write (mirrors mutateFileUnderLock's own convention) — the
 *  resolved value is then the record as it already stood (or null if it
 *  never existed). */
export async function mutateProjectExtensions(
  stores: ProjectExtensionsStores, projectKey: string,
  fn: (cur: ProjectExtensionsRecord | null) => ProjectExtensionsRecord | null,
): Promise<ProjectExtensionsRecord | null> {
  return isSyncedProjectKey(projectKey)
    ? mutateSyncedRecord(stores.personalRoot, projectKey, fn)
    : mutateLocalRecord(stores.home, projectKey, fn);
}

export interface SeedCatalog {
  skills: CatalogSkillEntry[];
  mcp: CatalogMcpEntry[];
  installs: Record<string, PluginInstallInfo>;
}

/**
 * Seed a project's record ONCE (design §2): writes ONLY when `seededAt` is
 * absent (0). Materializes an explicit on/off for every item/plugin present
 * right now, so "what works today" is identical on every device from this
 * moment on — a peer merges these explicit entries instead of recomputing a
 * rule that could disagree if a later build changes a default.
 *
 * `isNewProject` (default false — the common case: this lazily seeds a
 * project that predates the whole feature, on its first tab-open or first
 * conversation) selects which of resolve.ts's `seedDefaultOn` two answers to
 * write for a bundled plugin: false gives Theme Builder (and every other
 * bundled plugin) an explicit ON, matching what has already been running
 * unconditionally in this project for as long as it has existed; true is for
 * a project's OWN creation-time seed call (a later task's responsibility to
 * wire) and gives Theme Builder its real forward-looking default (off).
 *
 * Pin: calling this twice for the same project writes once (the mutate
 * callback returns null on the second call, a no-op). Callers must NOT call
 * this from a project-listing path — only from opening a project's tab or
 * starting a conversation in it (design §2) — that gate lives in the caller
 * (T2/T3), not here: this function itself is called-once-safe but not
 * called-rarely-enforcing.
 *
 * `seedReferenceInstant` (T6, project-plugin-controls — found verifying the
 * Marketplace post-install panel's "starts off everywhere" contract):
 * defaults to `now`, but a caller that knows roughly how long this project
 * has existed (project-key.ts's `resolveProjectAddedAt`) should pass THAT
 * instead. Reason: `now` is this very call's own timestamp, and an install
 * already on disk can never be later than "right now" — so falling back to
 * `now` for `seedDefaultOn`'s comparison makes rule 2 ("a marketplace plugin
 * installed after the project's seed instant starts off") mathematically
 * unable to fire on a project's FIRST-EVER seed, no matter how recent the
 * install actually was. That is invisible for an old install (which is
 * supposed to stay on either way), but it silently turns a plugin installed
 * moments ago ON in every project that has never opened its Skills & tools
 * tab or started a conversation — exactly the moment the Marketplace's
 * "choose your projects" panel calls `get()` for each one. A project's own
 * `addedAt` is (almost always) well before "just now", so it correctly keeps
 * a genuinely old install on while still putting a brand-new one after it.
 */
export async function ensureSeeded(
  stores: ProjectExtensionsStores,
  projectKey: string,
  catalog: SeedCatalog,
  now: number = Date.now(),
  isNewProject: boolean = false,
  seedReferenceInstant: number = now,
): Promise<ProjectExtensionsRecord> {
  const result = await mutateProjectExtensions(stores, projectKey, (cur) => {
    if (cur && cur.seededAt !== 0) return null; // already seeded — no-op

    const base = cur ?? emptyRecord();
    const items: Record<string, ProjectItemState> = { ...base.items };
    for (const s of catalog.skills) {
      const key = itemKeyForSkill(s);
      if (key in items) continue;
      const on = s.pluginName
        ? seedDefaultOn(s.pluginName, catalog.installs[s.pluginName]?.installedAt, seedReferenceInstant, isNewProject)
        : true; // rule 3: a self/project skill is never plugin-scoped
      items[key] = { on, at: now };
    }
    for (const m of catalog.mcp) {
      const key = itemKeyForMcp(m);
      if (key in items) continue;
      const pluginId = m.origin.kind === 'marketplace' ? m.origin.plugin : undefined;
      const on = pluginId
        ? seedDefaultOn(pluginId, catalog.installs[pluginId]?.installedAt, seedReferenceInstant, isNewProject)
        : true; // rule 3: a user/adopted MCP server is never plugin-scoped
      items[key] = { on, at: now };
    }

    // Plugin-level entries too (design §2 says "items/plugins entries") — an
    // explicit plugins[p] entry with partsChosen:true is what stops the
    // "first enable" rule (resolve.ts) from silently re-triggering the first
    // time the user ever touches that plugin's master switch, which would
    // otherwise blow away the per-item choices just seeded above.
    const plugins: Record<string, ProjectPluginState> = { ...base.plugins };
    const pluginIds = new Set<string>();
    for (const s of catalog.skills) if (s.pluginName) pluginIds.add(s.pluginName);
    for (const m of catalog.mcp) if (m.origin.kind === 'marketplace' && m.origin.plugin) pluginIds.add(m.origin.plugin);
    for (const pluginId of pluginIds) {
      if (pluginId in plugins) continue;
      plugins[pluginId] = {
        on: seedDefaultOn(pluginId, catalog.installs[pluginId]?.installedAt, seedReferenceInstant, isNewProject),
        partsChosen: true,
        at: now,
      };
    }

    return { schemaVersion: PROJECT_EXTENSIONS_SCHEMA, seededAt: now, plugins, items };
  });
  // A record always exists once this resolves: either it was already seeded
  // (mutate returned null -> `cur` itself, non-null by construction of the
  // early-return check) or we just built one.
  return result as ProjectExtensionsRecord;
}

/**
 * `foldedExisting` (T1 review F1 fix): the plugin's entry as FOLDED across
 * every conflict copy, read once by the caller (markPluginRemoved) BEFORE the
 * locked write — never re-derived in here, since this runs inside
 * mutateFileUnderLock's callback and must stay synchronous/pure. Without it,
 * a plugin entry that exists ONLY in an unfolded conflict copy (the canonical
 * file's own `cur.plugins[pluginId]` is absent) made this function return
 * null — a silent no-op — so the tombstone never reached the canonical file
 * and the next fold-on-read kept resurrecting the old, non-removed conflict-
 * copy entry forever. Seeding `existing` from the fold (when the canonical
 * copy itself has nothing) guarantees a write happens, and that write's fresh
 * `at: now` is what makes the read-side lattice-join (mergeStateMaps) prefer
 * it over the stale conflict copy from then on.
 */
function applyPluginRemoved(
  cur: ProjectExtensionsRecord | null, pluginId: string, now: number,
  foldedExisting?: ProjectPluginState,
): ProjectExtensionsRecord | null {
  const base = cur ?? emptyRecord();
  const canonicalExisting = base.plugins[pluginId];
  // Already tombstoned on the FILE WE'RE ABOUT TO WRITE — no-op, avoids clock
  // churn on repeat calls. Checked against the canonical entry specifically
  // (not the folded one): if the canonical copy hasn't been tombstoned yet,
  // this must still write, even when some conflict copy already shows removed.
  if (canonicalExisting?.removed && canonicalExisting.on === false) return null;
  const existing = canonicalExisting ?? foldedExisting;
  if (!existing) return null; // this project never touched the plugin anywhere — never create a phantom entry
  return {
    ...base,
    plugins: { ...base.plugins, [pluginId]: { ...existing, on: false, removed: true, at: now } },
  };
}

/**
 * Uninstall cascade (design §2): write `{on:false, removed:true, at}` into
 * EVERY project record — synced or local — that has an entry for
 * `pluginId`. A project that never touched the plugin is left untouched (no
 * phantom entry is ever created).
 *
 * The synced side checks the FOLDED record (readSyncedRecord) before
 * deciding whether to write, so a plugin entry that currently exists only in
 * an unfolded conflict copy still gets tombstoned — the write always lands
 * on the canonical file with a fresh `at`, which the next read's
 * last-writer-wins fold will always prefer over the older, non-removed copy.
 */
export async function markPluginRemoved(
  stores: ProjectExtensionsStores, pluginId: string, now: number = Date.now(),
): Promise<void> {
  const syncedNames = await listSyncedProjectNames(stores.personalRoot);
  for (const name of syncedNames) {
    const folded = await readSyncedRecord(stores.personalRoot, name);
    if (!folded || !(pluginId in folded.plugins)) continue;
    // Fix (T1 review F1): thread the FOLDED entry through so the locked write
    // (which only ever re-reads the raw canonical file) can still seed and
    // tombstone a plugin whose only on-disk record lives in a conflict copy —
    // see applyPluginRemoved's own comment.
    const foldedExisting = folded.plugins[pluginId];
    await mutateSyncedRecord(stores.personalRoot, name, (cur) => applyPluginRemoved(cur, pluginId, now, foldedExisting));
  }

  const localKeys = await listLocalProjectKeys(stores.home);
  for (const key of localKeys) {
    const cur = await readLocalRecord(stores.home, key);
    if (!cur || !(pluginId in cur.plugins)) continue;
    await mutateLocalRecord(stores.home, key, (c) => applyPluginRemoved(c, pluginId, now));
  }
}
