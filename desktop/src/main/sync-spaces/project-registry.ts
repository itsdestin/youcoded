// desktop/src/main/sync-spaces/project-registry.ts
// The per-project registry that powers cross-device project discovery, rename,
// and stop (spec 2026-07-12 §4/§4a). One JSON file per project, synced INSIDE
// the always-present Personal space so every device sees the same list.
//
// Layout mirrors the Conversation Store (Personal/Conversations/<provider>/<id>.json):
// a VISIBLE per-file folder under Personal. Following that convention sidesteps
// the reserved `.youcoded/` basename (the transport's hidden git dir AND a
// DEFAULT_IGNORES entry — anything under it silently never syncs).
//
// Records are MUTABLE (displayName renames + a `stopped` tombstone), so this IS
// a convergent record set and mirrors the Conversation Store's machinery:
// per-file, fail-soft parse, locked read-modify-write, and fold-on-read that
// resolves the transport's conflict copies. The MERGE is project-specific (§4a):
//   - state: MONOTONIC join — `stopped` dominates. NOT last-writer-wins, so a
//     stale "active + renamed" write from a device that hasn't pulled the stop
//     can never un-stop it. (Consequence: no Resume — spec §15.)
//   - displayName: last-writer-wins by updatedAt (content-tiebroken).
//   - description: last-writer-wins by its OWN clock (descriptionUpdatedAt),
//     NOT updatedAt — a shared clock would let a description write on one
//     device silently revert a rename made on another (§4a addendum).
// FOLD-ON-READ IS LOAD-BEARING: the transport's remote-wins conflict policy can
// leave the WRONG winner as the canonical file, so a stopped project could
// otherwise read active and resurrect. We fold in memory ONLY (no writeback);
// copy files are left in place (rare, inert — they always lose or re-fold
// identically; a future cleanup can prune them).
import fs from 'fs';
import path from 'path';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import { laterOf, isConflictCopyName, extractConflictBase } from '../conversations/store-core';
import { validateSyncName } from './guards';
import { PROJECT_DESCRIPTION_MAX } from '../../shared/artifacts/types';

export const PROJECT_REGISTRY_SCHEMA = 1;

export type ProjectState = 'active' | 'stopped';

export interface ProjectRegistryEntry {
  schemaVersion: number;
  name: string;        // folder name under ~/YouCoded/Projects/ — the immutable sync identity
  repoName: string;    // repoNameForSpace(name) — deterministic, identical on every device
  displayName: string; // synced, user-visible label; defaults to name
  state: ProjectState; // 'stopped' is a tombstone
  updatedAt: number;   // ms epoch — last-writer-wins for displayName
  // User-written description. Its OWN clock, deliberately NOT updatedAt: the
  // merge below picks the newer entry WHOLESALE, so a shared clock would make a
  // description write on one device silently revert a rename made on another.
  description: string | null;
  descriptionUpdatedAt: number; // ms epoch — last-writer-wins for description
}

function registryDir(personalRoot: string): string {
  return path.join(personalRoot, 'ProjectSync');
}

// `name` becomes a filename and this store sits near sync/remote surfaces. Reuse
// the EXACT create/import validator (guards.validateSyncName) so this check can
// never drift looser than the names we actually allow — it covers Windows
// reserved names + the 100-char cap the earlier local regex missed (review #7).
const isSafeName = (s: string): boolean => validateSyncName(s) === null;

function parseEntry(json: string): ProjectRegistryEntry | null {
  let raw: any;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (raw.schemaVersion !== PROJECT_REGISTRY_SCHEMA) return null;
  if (typeof raw.name !== 'string' || !isSafeName(raw.name)) return null;
  if (typeof raw.repoName !== 'string' || !raw.repoName) return null;
  return {
    schemaVersion: PROJECT_REGISTRY_SCHEMA,
    name: raw.name,
    repoName: raw.repoName,
    displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : raw.name,
    state: raw.state === 'stopped' ? 'stopped' : 'active',
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    // Tolerant, NOT schema-gated: a record written by an older build simply has
    // no description. Bumping the schema instead would make THIS build reject
    // every record an older build wrote, and vice versa.
    description: typeof raw.description === 'string' && raw.description.trim()
      ? raw.description.trim().slice(0, PROJECT_DESCRIPTION_MAX)
      : null,
    descriptionUpdatedAt: typeof raw.descriptionUpdatedAt === 'number' && Number.isFinite(raw.descriptionUpdatedAt)
      ? raw.descriptionUpdatedAt
      : 0,
  };
}

// PURE. Field-wise merge (§4a). Commutative + associative (a lattice join over
// state × (updatedAt, displayName) × (descriptionUpdatedAt, description)), so a
// plain reduce over any copy order converges. UNLIKE the Conversation Store's
// title rule, every field here is a clean join, so no special fold accumulator
// is needed.
//
// THE TRAP that makes associativity true rather than merely claimed: `laterOf`
// breaks an EQUAL-clock tie on `JSON.stringify(x) >= JSON.stringify(y)`, so
// whatever you hand it becomes the tiebreak key. Each dimension must therefore
// be passed a wrapper containing ONLY that dimension's own value + clock. Hand
// it the whole entry and the tiebreak reads displayName/state/updatedAt first —
// fields chosen by DIFFERENT rules, so the key mutates as the fold accumulates
// and the answer starts depending on `fs.readdirSync` order (measured: 2,116 of
// 32,768 triples diverged before this wrapper was added). Guard:
// sync-spaces-project-registry.test.ts → "converges on the same record for
// every fold order". Same shape as `notePick` in conversations/store-core.ts.
export function mergeProjectEntries(a: ProjectRegistryEntry, b: ProjectRegistryEntry): ProjectRegistryEntry {
  const state: ProjectState = a.state === 'stopped' || b.state === 'stopped' ? 'stopped' : 'active';
  const newer = laterOf(a, b, a.updatedAt, b.updatedAt); // displayName LWW, content-tiebroken
  // SEPARATE join for the description — see the trap note above. Wrapped to
  // {v, at} so an equal-clock tie can ONLY be broken by the description itself.
  const descPick = laterOf(
    { v: a.description, at: a.descriptionUpdatedAt },
    { v: b.description, at: b.descriptionUpdatedAt },
    a.descriptionUpdatedAt, b.descriptionUpdatedAt,
  );
  return {
    schemaVersion: PROJECT_REGISTRY_SCHEMA,
    name: newer.name,
    repoName: newer.repoName,
    displayName: newer.displayName,
    state,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    description: descPick.v,
    descriptionUpdatedAt: Math.max(a.descriptionUpdatedAt, b.descriptionUpdatedAt),
  };
}

function foldProjectEntries(entries: ProjectRegistryEntry[]): ProjectRegistryEntry {
  return entries.reduce((acc, e) => mergeProjectEntries(acc, e));
}

// Decide which canonical group a registry file belongs to.
//
// CRITICAL (review #1): the conflict-copy detector (store-core's CONFLICT_RE)
// was written for the Conversation Store, whose base names are UUIDs and can
// NEVER contain " (from …)". Here the base name IS the user's folder name, and
// validateSyncName permits spaces + parentheses — so a real project named e.g.
// "Recipes (from Grandma)" would be misread as a conflict copy of "Recipes" and
// SKIPPED on every read (silently defeating stop/rename/discovery for it).
//
// Fix: a file is its OWN canonical whenever the filename equals `${content-name}.json`,
// and that takes PRECEDENCE over the regex. Only a file whose name does NOT match
// its own content is considered a possible transport copy, and only when the
// copy's content carries the canonical name. The greedy CONFLICT_RE stops at the
// LAST " (from …)", so a genuine copy of a paren-named project still folds
// correctly. Returns null for a hand-mangled file that matches neither.
function canonicalBaseFor(fileName: string, entry: ProjectRegistryEntry): string | null {
  if (`${entry.name}.json` === fileName) return fileName; // its own canonical — wins
  if (isConflictCopyName(fileName)) {
    const cb = extractConflictBase(fileName);
    if (cb && `${entry.name}.json` === cb) return cb;      // a real transport copy of this record
  }
  return null;
}

/** Read + fold every registry record. FAIL-SOFT: corrupt/partial/unknown-schema
 *  files are skipped, never thrown (dev instance + built app share the tree).
 *  Conflict copies are folded into their canonical in memory (fold-on-read is
 *  load-bearing — see file header). Copy files are left on disk (inert). */
export function readProjectRegistry(personalRoot: string): ProjectRegistryEntry[] {
  const dir = registryDir(personalRoot);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const groups = new Map<string, ProjectRegistryEntry[]>();
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const full = path.join(dir, n);
    let e: ProjectRegistryEntry | null = null;
    try { if (fs.lstatSync(full).isFile()) e = parseEntry(fs.readFileSync(full, 'utf8')); }
    catch { /* corrupt/vanished — skip */ }
    if (!e) continue;
    const base = canonicalBaseFor(n, e); // review #1: content-name wins over the copy regex
    if (!base) continue;                 // filename matches neither its own content nor a valid copy
    const arr = groups.get(base) ?? [];
    arr.push(e);
    groups.set(base, arr);
  }
  const out: ProjectRegistryEntry[] = [];
  for (const arr of groups.values()) out.push(foldProjectEntries(arr));
  return out;
}

// Monotonic per-process counter so concurrent writes never share a temp path.
let writeSeq = 0;

function writeAtomic(file: string, entry: ProjectRegistryEntry): void {
  // Unique tmp per write (review #8): the dev instance and the built app share
  // ~/YouCoded and can ensureProjectEntry the same new file concurrently; a
  // shared "<file>.tmp" would let two writers interleave into one temp file.
  // rename() is atomic, so the target is never seen half-written.
  const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Create-if-absent an active record (displayName = name). Idempotent: a boot
 *  backfill leaves an existing record — including a synced rename or stop —
 *  untouched, so it neither churns the Personal watcher nor clobbers peer edits. */
export function ensureProjectEntry(personalRoot: string, input: { name: string; repoName: string }): void {
  if (!isSafeName(input.name)) throw new Error(`project-registry: invalid name '${input.name}'`);
  const dir = registryDir(personalRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${input.name}.json`);
  if (fs.existsSync(file)) return;
  writeAtomic(file, {
    schemaVersion: PROJECT_REGISTRY_SCHEMA,
    name: input.name, repoName: input.repoName,
    displayName: input.name, state: 'active', updatedAt: Date.now(),
    description: null, descriptionUpdatedAt: 0,
  });
}

// Locked read-modify-write on the CANONICAL file. Correctness note: writers do
// NOT need to fold conflict copies — read-time fold + stopped-dominance already
// guarantee correct reads, and even if a writer preserves a stale `active`, the
// stopped copy still dominates on the next read. The lock (mutateFileUnderLock)
// exists for the SAME-DEVICE race (dev instance + built app writing this file
// concurrently) where there is no git conflict copy to fold — an unlocked
// read-modify-write there would lose the other writer's field. The callback may
// return null to SKIP the write (no-op — avoids watcher churn + a redundant push).
async function mutateCanonical(
  personalRoot: string, name: string,
  fn: (cur: ProjectRegistryEntry | null) => ProjectRegistryEntry | null,
): Promise<void> {
  if (!isSafeName(name)) throw new Error(`project-registry: invalid name '${name}'`);
  const dir = registryDir(personalRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  const committed = await mutateFileUnderLock(file, (onDisk) => {
    const cur = onDisk ? parseEntry(onDisk) : null;
    const next = fn(cur);
    return next === null ? null : JSON.stringify(next, null, 2) + '\n'; // null → skip write
  });
  if (!committed) throw new Error(`project-registry: could not write ${name} (lock timeout)`);
}

/** Rename: set displayName + bump updatedAt, PRESERVE state AND description.
 *  Spreading `cur` is load-bearing: rebuilding from explicit fields is exactly
 *  how an older build silently drops a field a newer build wrote. */
export function setProjectDisplayName(
  personalRoot: string, name: string, repoName: string, displayName: string,
): Promise<void> {
  return mutateCanonical(personalRoot, name, (cur) => {
    if (cur && cur.displayName === displayName) return null; // no change — skip
    return {
      ...(cur ?? { description: null, descriptionUpdatedAt: 0 }),
      schemaVersion: PROJECT_REGISTRY_SCHEMA, name, repoName,
      state: cur?.state ?? 'active',
      displayName, updatedAt: Date.now(),
    };
  });
}

/** Stop: set state=stopped + bump updatedAt, PRESERVE displayName + description. */
export function setProjectStopped(
  personalRoot: string, name: string, repoName: string,
): Promise<void> {
  return mutateCanonical(personalRoot, name, (cur) => {
    if (cur && cur.state === 'stopped') return null; // already a tombstone — skip
    return {
      ...(cur ?? { description: null, descriptionUpdatedAt: 0 }),
      schemaVersion: PROJECT_REGISTRY_SCHEMA, name, repoName,
      displayName: cur?.displayName ?? name,
      state: 'stopped', updatedAt: Date.now(),
    };
  });
}

/** Describe: set description + bump ONLY descriptionUpdatedAt, PRESERVE
 *  displayName, its clock, and state. Trims + caps; empty becomes null so
 *  "cleared" and "never set" are the same state everywhere. */
export function setProjectDescription(
  personalRoot: string, name: string, repoName: string, description: string,
): Promise<void> {
  const next = description.trim().slice(0, PROJECT_DESCRIPTION_MAX) || null;
  return mutateCanonical(personalRoot, name, (cur) => {
    if (cur && (cur.description ?? null) === next) return null; // no change — skip
    return {
      ...(cur ?? {}),
      schemaVersion: PROJECT_REGISTRY_SCHEMA, name, repoName,
      displayName: cur?.displayName ?? name,
      state: cur?.state ?? 'active',
      updatedAt: cur?.updatedAt ?? 0,   // NOT touched — that clock is displayName's
      description: next,
      descriptionUpdatedAt: Date.now(),
    };
  });
}

// ── Removed projects (project switcher, redesign backlog row 10) ─────────────────────────────
// Destin (project-switcher-1, PQ-1): removing a synced project = "stop syncing on all devices,
// remove from list on all devices". The stop is the existing `stopped` tombstone above. The
// "off every list" half is a SEPARATE marker, one file per project in ProjectSync/Removed/, for
// three reasons:
//  - Older builds must stay safe. They read only `*.json` files directly in ProjectSync/ and
//    skip folders, so they never see this marker — they see a plain stopped project (still
//    listed as "Sync stopped", files kept). A new `state` value would instead read as `active`
//    on an older build (parseEntry maps anything but 'stopped' to active) and RESTART syncing.
//  - It is monotonic like the stop: a marker file is only ever added, so two devices removing
//    the same project at once can only produce a conflict copy that says the same thing.
//  - It touches nothing on disk but this marker: every device keeps its copy of the folder,
//    and the GitHub repository is never contacted.
function removedDir(personalRoot: string): string {
  return path.join(registryDir(personalRoot), 'Removed');
}

/** Mark a project removed from every device's lists. Idempotent. Async: the main process
 *  never blocks on a click's path (performance rule 1). */
export async function markProjectRemoved(personalRoot: string, name: string): Promise<void> {
  if (!isSafeName(name)) throw new Error(`project-registry: invalid name '${name}'`);
  const dir = removedDir(personalRoot);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  if (await fs.promises.access(file).then(() => true, () => false)) return;
  const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify({ schemaVersion: PROJECT_REGISTRY_SCHEMA, name, removedAt: Date.now() }, null, 2) + '\n');
  await fs.promises.rename(tmp, file);
}

/** Every project name marked removed (conflict copies included — they carry the same name).
 *  Async on purpose: it is read on list paths, and the main process never blocks there
 *  (performance rule 1). Fail-soft: a missing folder or a bad file is just "not removed". */
export async function readRemovedProjects(personalRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  let names: string[];
  try { names = await fs.promises.readdir(removedDir(personalRoot)); } catch { return out; }
  await Promise.all(names.filter((n) => n.endsWith('.json')).map(async (n) => {
    try {
      const raw = JSON.parse(await fs.promises.readFile(path.join(removedDir(personalRoot), n), 'utf8'));
      if (raw && typeof raw.name === 'string' && isSafeName(raw.name)) out.add(raw.name);
    } catch { /* corrupt or vanished — skip */ }
  }));
  return out;
}
