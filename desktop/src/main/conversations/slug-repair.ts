// One-time, idempotent startup repair for data mis-filed by the slug-encoding
// bug. Ground rules (spec §6.0): NEVER unlink (quarantine instead), NEVER
// union two transcripts (parentUuid chains make a merged file undefined
// behavior), classify every duplicate pair by CONTENT at run time, and a true
// fork (case C) is never automated — snapshot, surface, leave the disk alone.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { ccProjectSlug, nativeStoreSlug } from '../slug-encoding';
import { firstCwd, isForeignCwd } from '../transcript-cwd';
import { readFolders } from '../saved-folders';
import { getManagedRoots } from '../sync-spaces/service';
import { getConversationStore } from './service';
import { log } from '../logger';
import { readState, writeState, defaultStateFile } from './slug-repair-state';

export function uuidSet(filePath: string): Set<string> {
  const out = new Set<string>();
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.includes('"uuid"')) continue;
    try {
      const u = (JSON.parse(line) as { uuid?: unknown }).uuid;
      if (typeof u === 'string') out.add(u);
    } catch { /* corrupt line — skip */ }
  }
  return out;
}

export function fileMd5(filePath: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

/** uuid -> md5 of that message's raw line bytes. Raw bytes (not the
 *  JSON.parse'd + re-stringified object) on purpose: CC transcripts are
 *  append-only, so a same-uuid byte difference between two copies of "the
 *  same" message means the line was truncated or corrupted in place, not
 *  that JSON key order/whitespace drifted — raw-byte hashing catches that,
 *  a semantic re-stringify would paper over it. */
function uuidContentHashes(filePath: string): Map<string, string> {
  const out = new Map<string, string>();
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.includes('"uuid"')) continue;
    try {
      const u = (JSON.parse(line) as { uuid?: unknown }).uuid;
      if (typeof u === 'string') out.set(u, crypto.createHash('md5').update(line).digest('hex'));
    } catch { /* corrupt line — skip */ }
  }
  return out;
}

/** wrongCopy = the file in the WRONG location; correctCopy = the file where it
 *  belongs. Equal-uuid-different-bytes lands on 'wrong-is-subset' on purpose:
 *  the action (keep the correct-directory copy) is the same, and per-turn
 *  metadata lines legitimately differ between copies. */
export function classifyPair(wrongCopy: string, correctCopy: string):
  'identical' | 'wrong-is-subset' | 'wrong-is-superset' | 'fork' {
  if (fileMd5(wrongCopy) === fileMd5(correctCopy)) return 'identical';
  // Same-uuid content divergence check. Set-only comparison (uuid present in
  // both files, ignore its bytes) silently blesses a truncated/corrupted
  // shared message as a clean subset or superset — the copy with the intact
  // version would then get quarantined right along with the truncated one.
  // Fork is the safe direction here: quarantine preserves the disk state
  // either way, but 'fork' routes the pair to a human instead of an
  // automated keeper pick that might throw away the only good copy.
  const wHashes = uuidContentHashes(wrongCopy);
  const cHashes = uuidContentHashes(correctCopy);
  for (const [u, h] of wHashes) {
    const ch = cHashes.get(u);
    if (ch !== undefined && ch !== h) return 'fork';
  }
  const w = uuidSet(wrongCopy);
  const c = uuidSet(correctCopy);
  let wOnly = 0; for (const u of w) if (!c.has(u)) wOnly++;
  let cOnly = 0; for (const u of c) if (!w.has(u)) cOnly++;
  if (wOnly === 0) return 'wrong-is-subset';
  if (cOnly === 0) return 'wrong-is-superset';
  return 'fork';
}

/** Quarantine, not deletion. Lives under ~/.youcoded/ — NEVER inside
 *  ~/.claude/projects/: four subsystems readdir that tree and would adopt a
 *  quarantine folder as a project (spec §6.0). */
export class Quarantine {
  readonly homeRoot: string;
  readonly dir: string;
  constructor(homeRoot: string = os.homedir()) {
    this.homeRoot = homeRoot;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.dir = path.join(homeRoot, '.youcoded', 'repair-quarantine', stamp);
  }
  log(line: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, 'decisions.log'), `${new Date().toISOString()} ${line}\n`);
  }
  private destFor(absPath: string): string {
    const rel = path.relative(this.homeRoot, absPath);
    const dest = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    return dest;
  }
  /** MOVE out of the live tree (reversible). Returns false (and only logs) if
   *  the rename fails (e.g. EXDEV) — never falls back to copy+delete for
   *  anything that might hold real content. */
  move(absPath: string, why: string): boolean {
    try {
      fs.renameSync(absPath, this.destFor(absPath));
      this.log(`MOVE ${absPath} (${why})`);
      return true;
    } catch (e) {
      // Adaptation (Task 17, disclosed — real defect found via TDD, not in
      // the brief): retiring an EMPTIED directory whose files were quarantined
      // one at a time moments earlier collides here. Each of those file-moves
      // already created a directory at this exact home-relative path under
      // quarantine, so renaming the now-empty source dir onto it throws
      // ENOTEMPTY even though the source holds nothing of value anymore — the
      // quarantine tree already has everything that was ever inside it.
      // Verified-empty directories are the ONLY case this falls back to a
      // plain rmdir for; anything with real content (a file, or a directory
      // that still has entries) always hits the fail-closed SKIP-MOVE path.
      if (this.isEmptyDir(absPath)) {
        try {
          fs.rmdirSync(absPath);
          this.log(`RETIRE-EMPTY-DIR ${absPath} (${why}) — contents already quarantined individually`);
          return true;
        } catch { /* fall through to the SKIP-MOVE log below */ }
      }
      this.log(`SKIP-MOVE ${absPath} (${why}) — rename failed: ${String(e)}`);
      return false;
    }
  }
  private isEmptyDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0; }
    catch { return false; }
  }
  /** COPY a snapshot — for case C, where the live tree stays untouched. */
  snapshot(absPath: string, why: string): void {
    try {
      fs.copyFileSync(absPath, this.destFor(absPath));
      this.log(`SNAPSHOT ${absPath} (${why})`);
    } catch (e) {
      this.log(`SKIP-SNAPSHOT ${absPath} — copy failed: ${String(e)}`);
    }
  }
}

export interface RepairOpts {
  projectsDir: string;          // ~/.claude/projects
  homeDir: string;              // os.homedir()
  knownFolders: string[];       // saved folders + managed roots, absolute paths
  quarantine: Quarantine;
  liveMs?: number;              // default LIVE_MTIME_MS
  now?: () => number;           // test seam
  // Test seam for isForeignCwd/firstCwd's platform-relative foreign-cwd check
  // (review fix: firstCwd gained an optional trailing platform param so POSIX
  // fixtures don't silently only pass on POSIX CI runners) — default
  // process.platform, threaded through to firstCwd below.
  platform?: NodeJS.Platform;
  // Session ids already held as surfaced forks from a prior run (fork-hold
  // fix, found on the real-data run) — read once at the top of runSlugRepair
  // and threaded through so the fork branches below can skip re-snapshotting
  // an already-held pair. See heldForkIds' WHY in slug-repair-state.ts.
  heldForks?: Set<string>;
}
export interface RepairFinding {
  sessionId: string;
  homeFolder: string;           // the R2 answer (the real project)
  // 'rename-failed' (review fix): the promotion rename itself threw. Both
  // physical copies survive (one at the $HOME path, or one in quarantine +
  // one at $HOME) — this kind exists so a run failure never silently drops
  // a finding, it just can't say where the session finally landed.
  // 'record-repaired' (review fix, §6.2): the session's record was
  // upserted but no file was renamed/moved — distinct from 'moved' so a
  // consumer never treats `paths` as proof a physical relocation happened.
  // 'record-repair-failed' (review fix, Minor 1): the §6.2 upsert itself
  // threw AFTER any file move already succeeded — distinct from
  // 'rename-failed', whose doc above means "the promotion rename threw".
  // Reusing 'rename-failed' here read backwards: no rename failed, the
  // record write did. A consumer branching on kind needs to know which
  // half of the operation actually broke.
  kind: 'moved' | 'quarantined' | 'replaced-with-superset' | 'fork-surfaced' | 'deferred-live' | 'rename-failed' | 'record-repaired' | 'record-repair-failed';
  paths: string[];
}

export const LIVE_MTIME_MS = 10 * 60 * 1000; // "live" = appended within 10 min (spec §6.5: mechanical, written down)

function topLevelJsonl(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      // DIRECT CHILDREN ONLY — subagent transcripts live at
      // <sessionId>/subagents/ below and travel with their parent (§6.1).
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => path.join(dir, e.name));
  } catch { return []; }
}

function isLive(file: string, liveMs: number, now: () => number): boolean {
  try { return now() - fs.statSync(file).mtimeMs < liveMs; } catch { return true; } // unstat-able → treat as live (safe)
}

// MINOR fold (final review): path.resolve normalizes '.'/'..' and separators
// but does NOT realpath — a saved folder reached through a symlink compares
// unequal to its target here, so the repair silently no-ops for it rather
// than misfiling anything. Safe direction; deliberate non-realpath (mirrors
// spec §5.1's symlink discussion for ccProjectSlug itself).
const sameDir = (a: string, b: string) => path.resolve(a) === path.resolve(b);

// WHY async (perf/main-thread-async-reads, Task 2): firstCwd (transcript-cwd.ts)
// now reads asynchronously, so this function awaits it and became async, and its
// only caller, runSlugRepair, awaits this function in turn. Every other
// synchronous fs call in this file deliberately stays synchronous — that task
// converted only firstCwd's call sites.
export async function repairHomeForks(opts: RepairOpts): Promise<RepairFinding[]> {
  const { projectsDir, homeDir, knownFolders, quarantine: q } = opts;
  const liveMs = opts.liveMs ?? LIVE_MTIME_MS;
  const now = opts.now ?? Date.now;
  const platform = opts.platform ?? process.platform;
  const findings: RepairFinding[] = [];
  const homeSlugDir = path.join(projectsDir, ccProjectSlug(homeDir));

  for (const file of topLevelJsonl(homeSlugDir)) {
    const sessionId = path.basename(file, '.jsonl');
    if (isLive(file, liveMs, now)) {
      findings.push({ sessionId, homeFolder: '', kind: 'deferred-live', paths: [file] });
      continue;
    }
    // WHY safe to yield here: this await now sits between the isLive check above
    // and the rename below, which the synchronous version never allowed — but the
    // app's own reconcile/materialize sweeps cannot touch these files meanwhile,
    // because main.ts runs the whole repair inside the paused chain
    // `startConversationStore({ pauseSweeps: true }).then(() => runSlugRepair()).finally(() => resumeSweeps())`.
    const cwd = await firstCwd(file, platform);        // R2 — NOT R1 (§6.1: R1 would
    if (!cwd || isForeignCwd(cwd, platform)) continue; // call the fork a resident and no-op)
    const P = knownFolders.find(p => sameDir(p, cwd));
    if (!P || sameDir(P, homeDir)) continue;

    const correctDir = path.join(projectsDir, ccProjectSlug(P));
    const correct = path.join(correctDir, path.basename(file));
    if (!fs.existsSync(correct)) {
      // Review fix (Important 1) + MINOR fold (final review): every other
      // mutation in this module is guarded; this promotion (mkdir + rename)
      // wasn't. Fail closed — `file` never left until renameSync succeeds,
      // so a failure at either step loses nothing, but an unguarded throw
      // would still abort the whole run and drop every finding already
      // collected. Cover BOTH the mkdir and the rename in one try, not just
      // the rename — an ENOSPC/EACCES on directory creation is the same
      // hazard.
      try {
        fs.mkdirSync(correctDir, { recursive: true });
        fs.renameSync(file, correct);
      } catch (e) {
        q.log(`ERROR ${sessionId}: move-to-correct rename failed — $HOME copy still at ${file}: ${String(e)}`);
        findings.push({ sessionId, homeFolder: P, kind: 'rename-failed', paths: [file] });
        continue;
      }
      q.log(`MOVE-TO-CORRECT ${file} -> ${correct}`);
      findings.push({ sessionId, homeFolder: P, kind: 'moved', paths: [correct] });
      continue;
    }
    switch (classifyPair(file, correct)) {
      case 'identical':
      case 'wrong-is-subset':
        if (q.move(file, `6.1 ${sessionId}: $HOME copy ⊆ correct copy`)) {
          findings.push({ sessionId, homeFolder: P, kind: 'quarantined', paths: [file] });
        }
        break;
      case 'wrong-is-superset': {
        // Review fix (CRITICAL): this branch is the one place that touches
        // the CORRECT-dir copy's inode (quarantine it, then rename `file`
        // over its old path). If CC is actively appending to `correct`,
        // doing that steals the inode out from under the open fd and loses
        // turns — spec §6.5's exact forbidden hazard. Defer the whole pair
        // instead of racing it; a live session will go quiet and get
        // reclassified on a later run.
        if (isLive(correct, liveMs, now)) {
          findings.push({ sessionId, homeFolder: P, kind: 'deferred-live', paths: [file, correct] });
          break;
        }
        if (q.move(correct, `6.1 ${sessionId}: correct copy superseded`)) {
          // Review fix (Important 1): guard the promotion rename. If it
          // throws AFTER the quarantine move already succeeded, `correct`
          // is briefly empty on disk — but nothing is LOST: the superseded
          // copy is safe in quarantine and `file` is still at its original
          // $HOME path. Log exactly where both are and surface a finding
          // instead of throwing and losing the whole run.
          try {
            fs.renameSync(file, correct);
            q.log(`MOVE-TO-CORRECT ${file} -> ${correct} (superset)`);
            findings.push({ sessionId, homeFolder: P, kind: 'replaced-with-superset', paths: [correct] });
          } catch (e) {
            const quarantinedAt = path.join(q.dir, path.relative(q.homeRoot, correct));
            q.log(`ERROR ${sessionId}: promotion rename failed after quarantine — superseded copy at ${quarantinedAt}, $HOME copy still at ${file}: ${String(e)}`);
            findings.push({ sessionId, homeFolder: P, kind: 'rename-failed', paths: [file, quarantinedAt] });
          }
        }
        break;
      }
      case 'fork':
        // Review fix (CRITICAL): snapshotting `correct` while CC is live
        // risks capturing a torn mid-append write. Defer the whole pair
        // rather than partially snapshot — a fork already needs a human
        // decision, so waiting for the session to go quiet costs nothing
        // and this pair gets re-evaluated (still un-classified) next run.
        if (isLive(correct, liveMs, now)) {
          findings.push({ sessionId, homeFolder: P, kind: 'deferred-live', paths: [file, correct] });
          break;
        }
        // Case C — NEVER automated (spec §6.0). Snapshot both, change nothing.
        // Fix (fork hold): a fork already held from a prior run (state's
        // surfacedForks) doesn't need re-snapshotting every launch — the
        // FIRST run's quarantine copies are the ones that matter, and the
        // fork is already frozen out of both mirror directions (see
        // heldForkIds' WHY). Still push the finding + ATTENTION log so it
        // keeps surfacing until a human resolves it.
        if (opts.heldForks?.has(sessionId)) {
          q.log(`SKIP-SNAPSHOT fork ${sessionId}: snapshots already held from a prior run`);
        } else {
          q.snapshot(file, `6.1 FORK ${sessionId} ($HOME copy)`);
          q.snapshot(correct, `6.1 FORK ${sessionId} (project copy)`);
        }
        q.log(`ATTENTION fork ${sessionId}: ${file} vs ${correct} — both left on disk; user decision required`);
        findings.push({ sessionId, homeFolder: P, kind: 'fork-surfaced', paths: [file, correct] });
        break;
    }
  }
  return findings;
}

/** §6.2 — per-session repair of conversation RECORDS and the sync-space
 *  transcript copies the old bug filed under wrong buckets. Built BY SESSION
 *  (never bucket-scoped): spec §4 #6 notes 'destin' is a legitimate bucket
 *  that can ALSO hold a couple of mis-filed sessions, and bucket-scoped
 *  repair would either miss those or destroy every correct record sharing
 *  the bucket. Record repair is metadata-only (projectName/originalPath/
 *  transcriptRef, no lastActive) — Task 12's pinning test proved the
 *  reconcile sweep is record-keyed, so a metadata-only upsert is sufficient
 *  to stop the sweep re-filing the session under the wrong bucket again. */
export async function repairRecordsAndSpace(
  opts: RepairOpts & { store: import('./conversation-store').ConversationStore; spaceRoot: string },
): Promise<RepairFinding[]> {
  const { projectsDir, homeDir, knownFolders, quarantine: q, store, spaceRoot } = opts;
  const liveMs = opts.liveMs ?? LIVE_MTIME_MS;
  const now = opts.now ?? Date.now;
  // Adaptation (disclosed): thread the platform test seam through firstCwd/
  // isForeignCwd here too, same as repairHomeForks (§6.1) — otherwise a
  // POSIX fixture's cwd only reads correctly on a POSIX CI runner.
  const platform = opts.platform ?? process.platform;
  const findings: RepairFinding[] = [];
  const lane = path.join(spaceRoot, 'claude', 'transcripts');
  // Review fix (IMPORTANT 2): protection for the $HOME bucket must be
  // STRUCTURAL, not incidental. Before this fix, knownBasenames only held
  // known-folder basenames — if the actual $HOME bucket (spec: 'destin' is
  // real $HOME data) happened to go empty during a run, nothing stopped it
  // from being retired right alongside a truncation fragment. Add
  // basename(homeDir) explicitly so the protection holds regardless of
  // whether $HOME also happens to collide with a known folder's name.
  const knownBasenames = new Set([...knownFolders.map(p => path.basename(p)), path.basename(homeDir)]);

  // Build the repair set BY SESSION (spec §4 #6: 'destin' is a legitimate
  // bucket with two mis-filed sessions — bucket-scoped repair would either
  // miss them or destroy ~58 correct records).
  const repairSet = new Map<string, string>(); // sessionId -> project folder P
  // (a) every top-level transcript in a known folder's correct CC dir —
  // GATED to R2-owned sessions only (final review, CRITICAL 1). Spec §6.2's
  // own set definition is "R2 home is a known folder P" — it is NOT "every
  // file sitting in P's directory". Without this gate, a foreign-cwd
  // transcript materialized here by sync (majority of some dirs, §1) got
  // added unconditionally, and its record's originalPath — which describes
  // the ORIGIN device, store-core.ts:26 — was silently overwritten with
  // THIS device's path and pushed to the store (and from there synced to
  // peers), with no log line anywhere. Mirrors repairHomeForks' R2 gate above.
  for (const P of knownFolders) {
    const correctDir = path.join(projectsDir, ccProjectSlug(P));
    for (const f of topLevelJsonl(correctDir)) {
      const cwd = await firstCwd(f, platform);
      if (!cwd || isForeignCwd(cwd, platform) || !sameDir(cwd, P)) continue;
      repairSet.set(path.basename(f, '.jsonl'), P);
    }
  }
  // (b) every space transcript whose R2 home is a known folder filed under the
  //     wrong bucket (covers space-only sessions like a943d85d)
  let buckets: string[] = [];
  try { buckets = fs.readdirSync(lane); } catch { /* no space yet */ }
  for (const bucket of buckets) {
    for (const f of topLevelJsonl(path.join(lane, bucket))) {
      const cwd = await firstCwd(f, platform);
      if (!cwd || isForeignCwd(cwd, platform)) continue;
      const P = knownFolders.find(p => sameDir(p, cwd));
      if (P && path.basename(P) !== bucket) repairSet.set(path.basename(f, '.jsonl'), P);
    }
  }

  const emptiedBuckets = new Set<string>();
  for (const [sessionId, P] of repairSet) {
    const bucketName = path.basename(P);
    const target = path.join(lane, bucketName, `${sessionId}.jsonl`);
    const rec = await store.get('claude', sessionId);
    const recordOk = rec && rec.projectName === bucketName && rec.originalPath === P;
    // Space copies across ALL buckets for this session:
    const copies = buckets
      .map(b => path.join(lane, b, `${sessionId}.jsonl`))
      .filter(p => fs.existsSync(p));
    // Fix (final review, CRITICAL 2): convergence must be a true fixed point,
    // not just "zero copies anywhere". The old skip only fired when there
    // were literally no space copies at all, so a HEALTHY session — record
    // already correct, its single copy already sitting in the right bucket —
    // fell through to the live-guard/keeper-selection logic below every
    // single launch: re-evaluated, re-found as a 'record-repaired' finding
    // forever, and a recently-mirrored copy could trip the live guard into a
    // false 'deferred-live' → false ATTENTION surfacing after MAX_DEFERRALS.
    // copiesElsewhere excludes copies already filed under the correct
    // bucket, so "record correct AND nothing left to relocate" is
    // recognized and skipped BEFORE any live-guard check runs against a
    // copy that was never going anywhere.
    const copiesElsewhere = copies.filter(c => !sameDir(path.dirname(c), path.dirname(target)));
    if (recordOk && copiesElsewhere.length === 0) continue; // converged — zero findings

    let moved = false; // did an actual file rename happen for this session?
    if (copies.length > 0) {
      if (copies.some(c => isLive(c, liveMs, now))) {
        findings.push({ sessionId, homeFolder: P, kind: 'deferred-live', paths: copies });
        continue;
      }
      // Keeper = the copy every other copy is a subset of; tie → most uuids.
      const sized = copies.map(c => ({ c, u: uuidSet(c) }))
        .sort((a, b) => b.u.size - a.u.size);
      const keeper = sized[0];

      // Fork gate (spec §6.0 Case C — review fix, CRITICAL). The uuid-count
      // sort above only PICKS a candidate keeper; it does not prove every
      // other copy is actually contained in it. classifyPair already knows
      // how to tell "clean subset" from "diverges" (including same-uuid
      // content divergence), so run it before touching disk: any copy that
      // ISN'T identical-to or a uuid-subset-of the keeper holds content the
      // keeper lacks, and quarantining it would silently discard that
      // content — exactly the forbidden "auto-resolve a fork" hazard §6.1
      // already guards against for the $HOME-fork case. An equal-uuid-COUNT
      // tie between two non-identical copies is NECESSARILY a fork by this
      // same check: equal count + not byte-identical means neither can be a
      // uuid subset of the other, so classifyPair can only return 'fork' for
      // that pair — the containment check subsumes the count tie-break, it
      // is not a separate rule.
      const forkPairs = sized.slice(1).filter(other => {
        const verdict = classifyPair(other.c, keeper.c);
        return verdict !== 'identical' && verdict !== 'wrong-is-subset';
      });
      if (forkPairs.length > 0) {
        // Case C — NEVER automated. Snapshot every copy, change nothing,
        // surface it — mirrors §6.1's fork discipline exactly. Fix (fork
        // hold): skip re-snapshotting a fork already held from a prior run —
        // see the identical WHY on the §6.1 branch above.
        if (opts.heldForks?.has(sessionId)) {
          q.log(`SKIP-SNAPSHOT space fork ${sessionId}: snapshots already held from a prior run`);
        } else {
          for (const { c } of sized) q.snapshot(c, `6.2 FORK ${sessionId} (space copy)`);
        }
        q.log(`ATTENTION space fork ${sessionId}: ${copies.join(', ')} — not a clean containment chain; all copies left on disk, user decision required`);
        findings.push({ sessionId, homeFolder: P, kind: 'fork-surfaced', paths: copies });
        continue; // no moves, no record upsert — the whole session is skipped
      }

      for (const other of sized.slice(1)) {
        if (q.move(other.c, `6.2 ${sessionId}: non-keeper space copy`)) {
          const b = path.basename(path.dirname(other.c));
          if (topLevelJsonl(path.join(lane, b)).length === 0) emptiedBuckets.add(b);
        }
      }
      if (!sameDir(keeper.c, target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Adaptation (disclosed): §6.1's promotion renames are fail-closed
        // (review fix, commit a10bccb4) — this rename can move a session
        // that belongs to a live one just as easily, so it gets the same
        // discipline: log + finding + continue, never throw mid-run. On
        // failure the keeper stays exactly where it was (no record repair
        // below, so nothing points at a target that doesn't exist yet).
        try {
          fs.renameSync(keeper.c, target);
        } catch (e) {
          q.log(`ERROR ${sessionId}: move-bucket rename failed — space copy still at ${keeper.c}: ${String(e)}`);
          findings.push({ sessionId, homeFolder: P, kind: 'rename-failed', paths: [keeper.c] });
          continue;
        }
        q.log(`MOVE-BUCKET ${keeper.c} -> ${target}`);
        moved = true;
        const b = path.basename(path.dirname(keeper.c));
        if (topLevelJsonl(path.join(lane, b)).length === 0) emptiedBuckets.add(b);
      }
    }
    // Record repair — THE step that stops the $HOME fork recurring (spec §4):
    // metadata-only upsert (no lastActive); projectName/originalPath/
    // transcriptRef are local truth and always land (conversation-store.ts).
    // Fix (final review, CRITICAL 1+2 item 3): every record repair is a
    // materially consequential mutation — spec §6.0 requires every decision
    // logged, and this is the write that stops the $HOME fork recurring, so
    // it must be reconstructable from the decisions log alone.
    const targetTranscriptRef = `claude/transcripts/${bucketName}/${sessionId}.jsonl`;
    // Fix (2026-08-15, real-data run 4): only treat this as a REPAIR if a
    // field is actually changing. Before this, a session that reached here
    // purely because it had a stray space copy to quarantine (record already
    // correct) still got a no-op upsert + RECORD-REPAIR log line + a
    // 'record-repaired' finding — 6 such no-op lines on the real device run.
    // The MOVE line above already documents the copy cleanup; an identical
    // old->new upsert is noise that inflates the INFO summary's
    // record-repaired count and rewrites the record file for nothing.
    const recordChanged = !rec || rec.projectName !== bucketName || rec.originalPath !== P
      || rec.transcriptRef !== targetTranscriptRef;
    if (recordChanged) {
      // Review fix (IMPORTANT 1): guard the upsert — it can throw on a lock
      // timeout (conversation-store.ts's mutateRecord/mutateFileUnderLock).
      // Unguarded, that throw rejected the whole runSlugRepair call before
      // writeState() ran, silently losing every finding/hold already
      // computed this run. Fail this ONE session's record repair instead:
      // log it, surface a finding so it isn't silently dropped, and move on
      // — the space-copy cleanup above (if any) already landed regardless.
      try {
        await store.upsert({
          id: sessionId, provider: 'claude',
          projectName: bucketName, originalPath: P,
          transcriptRef: targetTranscriptRef,
        });
      } catch (e) {
        q.log(`ERROR RECORD-REPAIR ${sessionId}: upsert failed: ${String(e)}`);
        // Fix (review, Minor 1): the rename (if any) succeeded — only the
        // record write threw. 'rename-failed' would tell a consumer the
        // opposite of what happened; 'record-repair-failed' says precisely
        // which half broke.
        findings.push({ sessionId, homeFolder: P, kind: 'record-repair-failed', paths: moved ? [target] : [] });
        continue;
      }
      q.log(`RECORD-REPAIR ${sessionId}: projectName '${rec?.projectName ?? ''}' -> '${bucketName}', originalPath '${rec?.originalPath ?? ''}' -> '${P}', transcriptRef '${rec?.transcriptRef ?? ''}' -> '${targetTranscriptRef}'`);
    }
    // Review fix (IMPORTANT 1): a session with no space copies to move (or
    // whose keeper was already correctly bucketed) never touches a file —
    // 'moved' would misdescribe it as a physical relocation that never
    // happened. 'record-repaired' names the no-file-move path precisely;
    // Task 17's consumer can tell the two apart instead of trusting a path
    // that may never have existed. Skip the finding entirely when neither a
    // file moved nor a field changed — the copy cleanup (if any) already has
    // its own MOVE log line, and there's nothing left to call a "repair".
    if (moved || recordChanged) {
      findings.push({ sessionId, homeFolder: P, kind: moved ? 'moved' : 'record-repaired', paths: [target] });
    }
  }

  // Retire ONLY emptied truncation-fragment buckets — never a legitimate one
  // ('destin' is real $HOME data; a known folder's basename is real too).
  for (const b of emptiedBuckets) {
    if (knownBasenames.has(b)) continue;
    const dir = path.join(lane, b);
    try {
      if (fs.readdirSync(dir).length === 0) q.move(dir, `6.2 emptied truncation bucket`);
    } catch { /* already gone */ }
  }
  return findings;
}

/** §6.3 — retire the ORPHAN-rule (`nativeStoreSlug`) project dirs the old bug
 *  left behind, now that a project P has both an orphan dir and the CC-rule
 *  (`ccProjectSlug`) correct dir. Only pairs where the two rules actually
 *  DISAGREE and BOTH dirs exist are in scope — an orphan dir with no correct
 *  sibling is not this function's problem (nothing to reconcile against), and
 *  a P where the two rules agree can't have a separate orphan dir at all.
 *  Per-session classification against the CC-dir copy reuses the exact same
 *  case discipline as §6.1 (identical/subset quarantine, superset promotion,
 *  fork snapshot-and-surface, live defer) — only the source dir differs. */
export function repairOrphanDirs(opts: RepairOpts): RepairFinding[] {
  const { projectsDir, knownFolders, quarantine: q } = opts;
  const liveMs = opts.liveMs ?? LIVE_MTIME_MS;
  const now = opts.now ?? Date.now;
  const findings: RepairFinding[] = [];
  for (const P of knownFolders) {
    const orphanSlug = nativeStoreSlug(P);
    const ccSlug = ccProjectSlug(P);
    if (orphanSlug === ccSlug) continue;                     // rules agree — no orphan possible
    const orphanDir = path.join(projectsDir, orphanSlug);
    const correctDir = path.join(projectsDir, ccSlug);
    if (!fs.existsSync(orphanDir) || !fs.existsSync(correctDir)) continue;
    for (const file of topLevelJsonl(orphanDir)) {
      const sessionId = path.basename(file, '.jsonl');
      if (isLive(file, liveMs, now)) { findings.push({ sessionId, homeFolder: P, kind: 'deferred-live', paths: [file] }); continue; }
      const correct = path.join(correctDir, path.basename(file));
      if (!fs.existsSync(correct)) {
        // Adaptation (disclosed): §6.1's promotion rename is fail-closed
        // (review fix) — this is the same shape (rename an orphan copy into
        // the spot where nothing currently lives), so it gets the same
        // discipline. On failure `file` never left, so nothing is lost.
        try {
          fs.renameSync(file, correct);                      // session exists ONLY in the orphan — preserve it
        } catch (e) {
          q.log(`ERROR ${sessionId}: move-to-correct rename failed — orphan copy still at ${file}: ${String(e)}`);
          findings.push({ sessionId, homeFolder: P, kind: 'rename-failed', paths: [file] });
          continue;
        }
        q.log(`MOVE-TO-CORRECT ${file} -> ${correct} (orphan-only)`);
        findings.push({ sessionId, homeFolder: P, kind: 'moved', paths: [correct] });
        continue;
      }
      switch (classifyPair(file, correct)) {
        case 'identical': case 'wrong-is-subset':
          if (q.move(file, `6.3 ${sessionId}: orphan copy ⊆ correct`)) findings.push({ sessionId, homeFolder: P, kind: 'quarantined', paths: [file] });
          break;
        case 'wrong-is-superset':
          // Adaptation (disclosed): mirrors §6.1's CRITICAL review fix —
          // `correct` is the CC-tracked file here too; quarantining it while
          // CC actively appends would steal the inode out from under an open
          // fd. Defer the whole pair instead of racing it.
          if (isLive(correct, liveMs, now)) {
            findings.push({ sessionId, homeFolder: P, kind: 'deferred-live', paths: [file, correct] });
            break;
          }
          if (q.move(correct, `6.3 ${sessionId}: correct superseded by orphan copy`)) {
            try {
              fs.renameSync(file, correct);
              q.log(`MOVE-TO-CORRECT ${file} -> ${correct} (superset)`);
              findings.push({ sessionId, homeFolder: P, kind: 'replaced-with-superset', paths: [correct] });
            } catch (e) {
              const quarantinedAt = path.join(q.dir, path.relative(q.homeRoot, correct));
              q.log(`ERROR ${sessionId}: promotion rename failed after quarantine — superseded copy at ${quarantinedAt}, orphan copy still at ${file}: ${String(e)}`);
              findings.push({ sessionId, homeFolder: P, kind: 'rename-failed', paths: [file, quarantinedAt] });
            }
          }
          break;
        case 'fork':
          // Same live-guard as the superset branch above — snapshotting
          // `correct` mid-append risks capturing a torn write.
          if (isLive(correct, liveMs, now)) {
            findings.push({ sessionId, homeFolder: P, kind: 'deferred-live', paths: [file, correct] });
            break;
          }
          // Fix (fork hold): skip re-snapshotting a fork already held from a
          // prior run — see the identical WHY on the §6.1 branch above.
          if (opts.heldForks?.has(sessionId)) {
            q.log(`SKIP-SNAPSHOT fork ${sessionId}: snapshots already held from a prior run`);
          } else {
            q.snapshot(file, `6.3 FORK ${sessionId} (orphan)`); q.snapshot(correct, `6.3 FORK ${sessionId} (correct)`);
          }
          q.log(`ATTENTION fork ${sessionId}: ${file} vs ${correct}`);
          findings.push({ sessionId, homeFolder: P, kind: 'fork-surfaced', paths: [file, correct] });
          break;
      }
    }
    try {
      if (fs.readdirSync(orphanDir).length === 0) q.move(orphanDir, '6.3 emptied orphan dir');
    } catch { /* gone */ }
  }
  return findings;
}

const MAX_DEFERRALS = 3;

/** The single startup entry point (spec §6.0/§6.5) — safe to call every
 *  launch. Runs 6.1 -> 6.2 -> 6.3 in that STRICT order (6.2's record repair
 *  depends on 6.1 having settled $HOME copies first; 6.3's orphan retirement
 *  must run LAST because 6.2 can relocate a space copy that originated FROM
 *  an orphan-dir file — retiring the orphan before 6.2 runs would remove the
 *  only surviving source for that relocation). Bounds live-session deferral
 *  so a session that never goes quiet doesn't get silently retried forever —
 *  after MAX_DEFERRALS consecutive live findings it's surfaced via a WARN log
 *  and a quarantine ATTENTION line instead. A surfaced fork gets a one-time
 *  store note, and ONLY when the record's existing note is empty — repair
 *  must never clobber a user's own note. */
// Fix: does NOT pause/resume the reconcile+materialize sweeps itself — the
// CALLER owns that (main.ts, around its startConversationStore({ pauseSweeps:
// true }).then(runSlugRepair).finally(resumeSweeps) chain). A single owner
// avoids double-pause/double-resume bookkeeping; see pauseSweeps' WHY in
// conversations/service.ts for what races if the caller skips this.
export async function runSlugRepair(overrides?: Partial<RepairOpts> & {
  store?: import('./conversation-store').ConversationStore | null;
  spaceRoot?: string;
  stateFile?: string;
  // Test-only seam (review fix, Minor 2): lets a test substitute one stage's
  // implementation (e.g. force it to throw) to exercise the per-stage
  // try/catch below. vi.spyOn on this module's exports would NOT work here —
  // runSlugRepair calls repairHomeForks/repairRecordsAndSpace/repairOrphanDirs
  // as local same-module bindings, which a compiled module calls directly
  // rather than through its exports object, so spying the export never
  // intercepts these call sites. Never set in production.
  stages?: {
    repairHomeForks?: typeof repairHomeForks;
    repairRecordsAndSpace?: typeof repairRecordsAndSpace;
    repairOrphanDirs?: typeof repairOrphanDirs;
  };
}): Promise<void> {
  const homeDir = overrides?.homeDir ?? os.homedir();
  const store = overrides?.store !== undefined ? overrides.store : getConversationStore();
  if (!store) return;                                        // store not up — next launch retries
  const spaceRoot = overrides?.spaceRoot ?? store.root();
  const projectsDir = overrides?.projectsDir ?? path.join(homeDir, '.claude', 'projects');
  let knownFolders = overrides?.knownFolders;
  if (!knownFolders) {
    // Fix: this MUST match runReconcile's knownFolders assembly exactly (service.ts
    // runReconcile) — managed projects first, then saved folders, each source
    // individually try-guarded so one failing source doesn't blank the other. Before
    // this fix the repair only read saved folders, so a managed-only project (not in
    // ~/.claude/youcoded-folders.json) was invisible to the repair even though the
    // reconciler buckets by it — the repair silently did nothing for that project's
    // mis-filed data. Found on the first real-data run, 2026-08-15 (PAF 574 project).
    knownFolders = [];
    try { knownFolders.push(...(getManagedRoots()?.listProjects() ?? []).map(p => p.path)); }
    catch { /* managed roots unreadable — saved folders still cover most cases */ }
    try { knownFolders.push(...readFolders().map(f => f.path)); }
    catch { /* saved folders unreadable — managed projects still cover most cases */ }
  }
  if (knownFolders.length === 0) return;
  const quarantine = overrides?.quarantine ?? new Quarantine(homeDir);
  // Fix (fork hold): load the runner's state file ONCE, up front — both the
  // deferral bookkeeping below AND the heldForks set threaded into opts (so
  // the fork branches can skip re-snapshotting an already-held pair) read
  // from this same snapshot. See heldForkIds' WHY in slug-repair-state.ts.
  const stateFile = overrides?.stateFile ?? defaultStateFile(homeDir);
  const state = readState(stateFile);
  const heldForks = new Set(state.surfacedForks.map(f => f.id));
  const opts: RepairOpts = { projectsDir, homeDir, knownFolders, quarantine, heldForks,
    liveMs: overrides?.liveMs, now: overrides?.now };

  const stageFns = {
    repairHomeForks: overrides?.stages?.repairHomeForks ?? repairHomeForks,
    repairRecordsAndSpace: overrides?.stages?.repairRecordsAndSpace ?? repairRecordsAndSpace,
    repairOrphanDirs: overrides?.stages?.repairOrphanDirs ?? repairOrphanDirs,
  };

  // ORDER IS LOAD-BEARING (spec §6.0): space repair (6.2) BEFORE orphan
  // retirement (6.3) — the truncation bucket was populated FROM the orphan.
  // Fix (review, Minor 2): each stage runs in its OWN try/catch and a throw
  // never aborts the run — it's logged and the run continues to the NEXT
  // stage and on to finalization (state write, notes, summary log). WHY: a
  // filesystem throw partway through a later stage (e.g. a file vanishing
  // between an exists-check and a read in classifyPair — TOCTOU, always
  // possible against a live tree) must never discard the findings/holds an
  // EARLIER stage already gathered — finalization below is what persists
  // them (writeState), and an unguarded throw here would reject the whole
  // async function before that write ever ran, silently losing them. The
  // stage ORDER itself is untouched by this: a failed stage is skipped, not
  // reordered or retried within the same run — 6.1/6.2/6.3 still only ever
  // run in that sequence.
  const all: RepairFinding[] = [];
  try {
    all.push(...await stageFns.repairHomeForks(opts));                    // 6.1
  } catch (e) {
    log('ERROR', 'SlugRepair', 'stage failed', { stage: '6.1 repairHomeForks', error: String(e) });
    quarantine.log(`ERROR stage 6.1 repairHomeForks failed: ${String(e)}`);
  }
  try {
    all.push(...await stageFns.repairRecordsAndSpace({ ...opts, store, spaceRoot })); // 6.2
  } catch (e) {
    log('ERROR', 'SlugRepair', 'stage failed', { stage: '6.2 repairRecordsAndSpace', error: String(e) });
    quarantine.log(`ERROR stage 6.2 repairRecordsAndSpace failed: ${String(e)}`);
  }
  // WHY (final review, IMPORTANT 5): 6.3 runs AFTER 6.2 in this same pass, so
  // a session 6.3 promotes into the correct CC dir THIS run was already past
  // 6.2's scan and does not get its record repaired until the NEXT launch's
  // 6.2 pass picks up the newly-present file. One-launch lag, known and
  // self-correcting (the runner runs every startup) — do not read a
  // surviving wrong record right after a supervised run as a failure; check
  // again after one more launch.
  try {
    all.push(...stageFns.repairOrphanDirs(opts));                         // 6.3
  } catch (e) {
    log('ERROR', 'SlugRepair', 'stage failed', { stage: '6.3 repairOrphanDirs', error: String(e) });
    quarantine.log(`ERROR stage 6.3 repairOrphanDirs failed: ${String(e)}`);
  }

  // Bounded deferral (spec §6.5): live sessions retry next launch, at most
  // MAX_DEFERRALS times, then surface instead of looping silently.
  // Review fix: the deferral contract is per-RUN ("3 runs in a row"), not
  // per-FINDING. One session can produce a 'deferred-live' finding from more
  // than one step in the SAME run — e.g. live in both the $HOME slug dir
  // (§6.1's scan) and an orphan-dir pair (§6.3's scan) — so dedupe to a Set
  // BEFORE incrementing, or a single launch could silently burn through
  // multiple deferrals at once and surface a session in fewer real runs than
  // the contract states.
  const deferredThisRun = new Set(all.filter(f => f.kind === 'deferred-live').map(f => f.sessionId));
  const forkSurfacedThisRun = new Set(all.filter(f => f.kind === 'fork-surfaced').map(f => f.sessionId));
  // Fix (review, IMPORTANT 2 — auto-release on absence of evidence): keyed by
  // id -> the paths that finding recorded, so release decisions below can
  // check the disk, not just "did this run mention the id". Seeded from the
  // pre-run state so an id nothing touches this run keeps its LAST recorded
  // paths (needed for the "one recorded path no longer exists" release
  // check further down).
  const surfacedMap = new Map(state.surfacedForks.map(f => [f.id, f.paths]));
  for (const f of all) {
    if (f.kind !== 'deferred-live') delete state.deferred[f.sessionId];
    // Paths are refreshed to whatever THIS run's finding says, every time a
    // fork surfaces — including a re-surface of an already-held id, so a
    // stale hold never carries paths from before a promotion/rename moved
    // one of the copies.
    if (f.kind === 'fork-surfaced') surfacedMap.set(f.sessionId, f.paths);
  }
  // Fix (review, IMPORTANT 2): a hold releases ONLY on positive evidence the
  // pair is no longer a fork — never on this run simply having nothing to say
  // about the id. Before this fix, silence alone (e.g. the folder that owns
  // the fork dropped out of knownFolders, or readFolders() threw and returned
  // []) released the hold, and materializeSweep — independent of
  // knownFolders, it resolves via the record's originalPath — clobbered the
  // smaller fork copy within seconds of the sweeps resuming. Only ids ALREADY
  // held coming into this run (`heldForks`, the pre-run snapshot) are release
  // candidates; a fork surfaced for the FIRST time this run was just added to
  // `surfacedMap` above and is never a candidate.
  for (const id of heldForks) {
    if (forkSurfacedThisRun.has(id) || deferredThisRun.has(id)) continue; // still a fork, or paused — stays held
    // (a) positive reclassification: THIS run produced some other,
    // non-fork/non-deferred finding for the id — the pair converged into a
    // clean subset/superset relation (or got its record repaired), which
    // only happens once classifyPair no longer calls it a fork.
    const reclassified = all.some(f => f.sessionId === id && f.kind !== 'fork-surfaced' && f.kind !== 'deferred-live');
    // (b) the user resolved it by hand: at least one of the copies this hold
    // was protecting is gone from disk.
    const recordedPaths = surfacedMap.get(id) ?? [];
    const copyMissing = recordedPaths.some(p => !fs.existsSync(p));
    if (reclassified || copyMissing) surfacedMap.delete(id);
    // else: silence with every recorded copy still present on disk — the
    // scan simply never reached this pair this run. Stay held.
  }
  state.surfacedForks = [...surfacedMap].map(([id, paths]) => ({ id, paths }));
  for (const sessionId of deferredThisRun) {
    const n = (state.deferred[sessionId] ?? 0) + 1;
    state.deferred[sessionId] = n;
    if (n >= MAX_DEFERRALS) {
      log('WARN', 'SlugRepair', 'session still live after repeated deferrals — needs manual quiescence', { sessionId, deferrals: n });
      quarantine.log(`ATTENTION deferred ${sessionId} ${n}x — repair it manually while the app is closed`);
    }
  }
  // Fix (review, IMPORTANT 1): persist the hold/deferral bookkeeping computed
  // above BEFORE the store calls below, which can throw (lock timeout —
  // conversation-store.ts's mutateRecord). Before this fix, an unguarded
  // store.setNote() rejecting this whole function meant writeState() (further
  // down) never ran — forks just surfaced/snapshotted this run were never
  // recorded as held, and main.ts's .finally(resumeSweeps) unpaused the
  // mirror sweeps over an unrecorded hold: the exact clobber this branch
  // exists to prevent. Written again (idempotent) at the end so a future edit
  // that adds more post-processing state here doesn't have to remember to
  // move this call again.
  try { writeState(state, stateFile); }
  catch (e) { log('WARN', 'SlugRepair', 'state write failed', { error: String(e) }); }
  // Best-effort store notification for freshly/still-surfaced forks. Wrapped
  // (review fix, IMPORTANT 1) — setNote is documented one-time best-effort;
  // a lock-timeout rejection here must never cost the hold state already
  // written above.
  for (const f of all) {
    if (f.kind !== 'fork-surfaced') continue;
    log('WARN', 'SlugRepair', 'true fork left on disk — user decision required', { sessionId: f.sessionId, paths: f.paths });
    try {
      const rec = await store.get('claude', f.sessionId);
      if (rec && !rec.note) {
        await store.setNote('claude', f.sessionId,
          `Repair notice: this conversation has two diverged copies on disk (see ~/.youcoded/repair-quarantine). Both were preserved.`);
      }
    } catch (e) {
      log('WARN', 'SlugRepair', 'fork note not written', { sessionId: f.sessionId, error: String(e) });
    }
  }
  try { writeState(state, stateFile); }
  catch (e) { log('WARN', 'SlugRepair', 'state write failed', { error: String(e) }); }
  if (all.length) log('INFO', 'SlugRepair', 'repair pass complete', { findings: all.map(f => ({ id: f.sessionId, kind: f.kind })) });
}
