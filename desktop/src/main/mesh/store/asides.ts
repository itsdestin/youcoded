// Set-asides and quarantine, i.e. RETIRING a version id (split out of store.ts to keep it inside its line budget).
//
// THE RULE (restructure, closes review 8 F4 and review 7 F2): a version that was set aside as damaged is RETIRED FOR GOOD. (Three witnesses since review 9 F3: the store-root record retired/<vhex>.ret, the aside folder and retired.json.) Its files are MOVED (index, bodies, checkpoint, marks, ...) to
// aside/<vhex>-<n>/ (or -q<n>/ when the store itself found it unrepairable) and never deleted, and the id is never refilled: the replicator recopies from a peer into a NEW version id.
// WHY this is the simplest mechanism: "retired" is said by TWO things that no single fault can remove together, and neither is a marker that an older copy could undo:
//   1. the aside/<vhex>-<n>/ folder, which lives OUTSIDE the version folder, is never deleted and is created BEFORE anything is moved;
//   2. retired.json inside the version folder (sealed with the version key), written right after it and never rewritten. Only its existence counts; its content is just the aside name for humans.
// Putting old files back into the version folder (a backup restore) changes neither, so load() still refuses with the typed `damaged`. Deleting one of the two leaves the other.
// Crash rule 3: retired.json also is the note of intent (written by finishAside for the aside folder retire() just made): load() finishes an interrupted move (every step is repeatable); the move is finished when aside/<name>/COMPLETE exists.
import * as nodePath from 'node:path';
import { writeFileAtomic, mkdirDurable, type Fs } from './fsio';
import { StoreError } from './errors';
import { isDiskFull } from './storeutil';
import { readSideFor, writeSideFor } from './sidefile';
import { CHECKPOINT_FILE } from './checkpoint';
import { MARKS_FILE } from './marks';
import { nextAsideName } from './versionfiles';

const ASIDE_RE = /^[0-9a-f]+-q?\d+$/;
const RETIRED_FILE = 'retired.json';

export class Asides {
  constructor(
    private readonly fs: Fs,
    private readonly root: string,
    /** What only the store can do: drop its cached state of a version. */
    private readonly host: { forget: (key: string) => void },
  ) {}
  private vdir(key: string): string { return nodePath.join(this.root, 'versions', key); }

  /**
   * The name of the aside folder that retired this version, or null when it is not retired. Two witnesses (see the header): an aside/<vhex>-[q]<n> folder (a bare one counts: retired is the cautious
   * answer when a set-aside stopped before moving anything), or retired.json in the version folder (any file of that name, readable or not: its existence is the signal).
   */
  async retiredName(key: string): Promise<string | null> {
    const re = new RegExp(`^${key}-q?\\d+$`);
    const names = (await this.fs.readdir(nodePath.join(this.root, 'aside'))).filter((n) => re.test(n)).sort();
    if (names.length) return names[0];
    // the other two witnesses: the store-root record (survives a retention job that removes both the aside folder and the retired version folder, review 9 F3) and retired.json
    if (await this.fs.exists(nodePath.join(this.root, 'retired', `${key}.ret`))) return 'unknown';
    return (await this.fs.exists(nodePath.join(this.vdir(key), RETIRED_FILE))) ? 'unknown' : null;
  }

  /** quarantine(), but a full disk (no room for the note) still reports `damaged`: the aside folder was made first, so the version is already retired and the next load with space finishes the move. */
  async quarantineOrReport(key: string, reason: string): Promise<never> {
    try { return await this.retire(key, true, reason); }
    catch (e) { if (isDiskFull(e)) throw new StoreError('damaged', 'pending (the disk is full): ' + reason); throw e; }
  }

  /**
   * The caller says this copy is damaged (or a peer sent a different ending): retire the id. Idempotent: for a version that is already retired it only finishes a move that was interrupted and
   * returns the name of the first aside folder. Never clears anything: there is no way back into a retired id (the replicator uses a new one).
   */
  async setAside(key: string): Promise<{ asideName: string }> {
    const dir = this.vdir(key);
    await this.finishAside(key, dir);
    const had = await this.retiredName(key);
    if (had) return { asideName: had };
    if (!(await this.fs.exists(nodePath.join(dir, 'meta.json'))) && !(await this.fs.exists(nodePath.join(dir, 'meta.copy')))) throw new StoreError('unknown-version', key.slice(0, 8));
    try { await this.retire(key, false, 'set aside on request'); } catch (e) { if (!(e instanceof StoreError && e.code === 'damaged')) throw e; }
    return { asideName: (await this.retiredName(key)) ?? 'unknown' };
  }

  /**
   * WHY a third witness at the store root (review 9 F3): a retention job that deletes aside folders and also reaps leftover retired version folders would otherwise bring the id back (registerVersion would make a fresh
   * empty version under it). retired/<vhex>.ret is the store's own record, in a folder no retention job owns; only its existence counts. WHY it is written from EVERY path that finds an id retired (review 10 F-A): a
   * retirement finished after a crash (a retry, or the next load) never went through retire(), and kept two witnesses for good. A full disk only postpones it.
   */
  private async ensureRootRecord(key: string, asideName: string, reason: string): Promise<void> {
    const p = nodePath.join(this.root, 'retired', `${key}.ret`);
    if (await this.fs.exists(p)) return;
    try { await mkdirDurable(this.fs, nodePath.join(this.root, 'retired')); await writeSideFor(this.fs, p, { role: 'retired-root', key }, { asideName, reason: reason.slice(0, 200) }); } // DESTRUCTIVE-OK(hint): a NEW existence-only statement
    catch (e) { if (!isDiskFull(e)) throw e; }
  }

  /** Retire the id: aside folder first (the step that needs space), then retired.json, then the move. Always ends in `damaged` for the quarantine path. */
  private async retire(key: string, quarantined: boolean, reason: string): Promise<never> {
    const dir = this.vdir(key);
    const asideName = await nextAsideName(this.fs, this.root, key, quarantined);
    await mkdirDurable(this.fs, nodePath.join(this.root, 'aside', asideName));
    await this.ensureRootRecord(key, asideName, reason);
    this.host.forget(key);
    await this.finishAside(key, dir, reason);   // finds the bare aside folder just made, writes retired.json for it, and moves the files
    throw new StoreError('damaged', asideName);
  }

  /** Finish a move that retired.json names (idempotent; a no-op for a version that was never retired and for one whose aside folder says COMPLETE). */
  async finishAside(key: string, dir: string, why = 'the retirement was interrupted before its note was written'): Promise<void> {
    const known = await this.retiredName(key);
    if (known) await this.ensureRootRecord(key, known, why);   // backfill (review 10 F-A): every load and every setAside passes here
    const note = nodePath.join(dir, RETIRED_FILE);
    if (!(await this.fs.exists(note))) {
      // a bare, unfinished aside folder (just made by retire(), or left by a crash before the note) has no note yet: write it now and finish the move, so the files never stay behind in a retired folder
      const bare = await this.retiredName(key);
      if (!bare || !ASIDE_RE.test(bare) || await this.fs.exists(nodePath.join(this.root, 'aside', bare, 'COMPLETE'))) return;
      // a full disk only postpones it (the id is retired either way, and a read never fails for lack of space)
      try { await writeSideFor(this.fs, note, { role: 'retired', key }, { asideName: bare, reason: why }); } // DESTRUCTIVE-OK(hint): a NEW existence-only statement; the version had none
      catch (e) { if (isDiskFull(e)) return; throw e; }
    }
    const ir = await readSideFor(this.fs, note, { role: 'retired', key });
    let { asideName, reason } = (ir.kind === 'ok' && ir.value ? ir.value : {}) as { asideName?: string; reason?: string };
    // WHY not an error when the note is unreadable or foreign (review 3, class fix): the id is retired either way and the move still has to be finished. The folder that retired it is found by name.
    if (typeof asideName !== 'string' || !ASIDE_RE.test(asideName) || !(await this.fs.exists(nodePath.join(this.root, 'aside', asideName)))) {
      const found = await this.retiredName(key);
      asideName = found && ASIDE_RE.test(found) ? found : await nextAsideName(this.fs, this.root, key, true);
      reason = reason ?? 'the retirement note was unreadable';
    }
    const target = nodePath.join(this.root, 'aside', asideName);
    // WHY stop at COMPLETE: the move is finished. Anything in the version folder after that was put back by a restore; it is never moved over the kept copy and never read (the id is retired).
    if (await this.fs.exists(nodePath.join(target, 'COMPLETE'))) return;
    await mkdirDurable(this.fs, target);
    for (const name of await this.fs.readdir(dir)) {
      if (name === 'index.bin' || name === 'index.rebuild' || name === 'summary.json' || name === 'scrub.json' || name === CHECKPOINT_FILE || name === MARKS_FILE || /^body-[0-9a-f]{16}\.bin$/.test(name)) {
        // WHY never overwrite (H2): a rename over an existing aside file would destroy the very copy being kept; a file already there means the move happened before.
        if (await this.fs.exists(nodePath.join(target, name))) continue;
        // DESTRUCTIVE-OK(kept-copy-first): a rename to a name that does not exist in the aside copy; the bytes are kept there
        await this.fs.rename(nodePath.join(dir, name), nodePath.join(target, name));
      }
    }
    await this.fs.fsyncDir(target); await this.fs.fsyncDir(dir);
    // COMPLETE (with the reason, for a human) is written last. WHY a full disk is tolerated (review 3 F7): a read must not fail for lack of space; the id is retired either way and the move is finished when space returns.
    try { await writeFileAtomic(this.fs, nodePath.join(target, 'COMPLETE'), Buffer.from(`complete\n${(reason ?? '').slice(0, 200)}\n`)); } // DESTRUCTIVE-OK(hint): a NEW existence-only mark in the aside folder
    catch (e) { if (!isDiskFull(e)) throw e; }
  }
}
