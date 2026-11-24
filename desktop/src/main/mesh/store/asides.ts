// Set-asides and quarantine (split out of store.ts to keep it inside its line budget). A damaged copy is MOVED (index AND bodies) to aside/<vhex>-<n>/ or, when the store itself found it
// unrepairable, aside/<vhex>-q<n>/, never deleted. Crash rule 3: a sealed intent note names the target first; load() finishes an interrupted move. The quarantine marker lives in marks.bin.
import * as nodePath from 'node:path';
import { writeFileAtomic, mkdirDurable, type Fs } from './fsio';
import { StoreError } from './errors';
import { isDiskFull } from './storeutil';
import { readSideFor, writeSideFor, keepBadSideFile } from './sidefile';
import { CHECKPOINT_FILE } from './checkpoint';
import { MARKS_FILE, readDamaged, setMarks } from './marks';
import { readMeta, nextAsideName } from './versionfiles';

const ASIDE_RE = /^[0-9a-f]+-q?\d+$/;

export class Asides {
  constructor(
    private readonly fs: Fs,
    private readonly root: string,
    /** What only the store can do: drop its cached state of a version, create an empty index, and lower the version's high-water record to 0 (the version is empty on purpose). */
    private readonly host: { forget: (key: string) => void; ensureIndex: (dir: string) => Promise<void>; resetHw: (key: string) => Promise<void>; /** Move every parked append of the version folder to rejected/ with the reason `quarantine` (parked.ts rejectAllOnDisk). */ rejectParks: (dir: string) => Promise<void> },
  ) {}
  private vdir(key: string): string { return nodePath.join(this.root, 'versions', key); }

  /** quarantine(), but a full disk (no room for the note of intent) still reports `damaged`: nothing was moved, and the next load with space does it. */
  async quarantineOrReport(key: string, reason: string): Promise<never> {
    try { return await this.quarantine(key, reason); }
    catch (e) { if (isDiskFull(e)) throw new StoreError('damaged', 'pending (the disk is full): ' + reason); throw e; }
  }

  /** Move the whole version (index AND bodies) to aside/<vhex>-q<n>, mark it damaged, report it. Never deletes. */
  private async quarantine(key: string, reason: string): Promise<never> {
    const dir = this.vdir(key);
    const asideName = await nextAsideName(this.fs, this.root, key, true);
    await mkdirDurable(this.fs, nodePath.join(this.root, 'aside', asideName));   // the space-needing step first: a later read that has to finish the move then needs none
    await writeSideFor(this.fs, nodePath.join(dir, 'aside.intent'), { role: 'intent', key }, { asideName, reason }); // DESTRUCTIVE-OK(hint): a note of intent; load() finishes the move it names
    this.host.forget(key);
    await this.finishAside(key, dir);
    throw new StoreError('damaged', asideName);
  }

  /**
   * The copy is damaged (its bytes no longer match its chain): move everything into aside/ (kept, never
   * deleted, retention rule 5.3) and start the version empty so it can be recopied. Parked appends are moved to rejected/ (round 7, F2: a quarantine changes the history identity).
   * Crash rule 3: an intent file names the target first; load() completes an interrupted move.
   * For a version the store already quarantined (`damaged`), this only clears the marker: the quarantined
   * copy is already aside, intact.
   */
  async setAside(key: string): Promise<{ asideName: string }> {
      const dir = this.vdir(key);
      // WHY not readMeta alone (N8): the remedy for a version with a garbage meta.json must not itself need that file
      let metaBad = false;
      try { if (!(await readMeta(this.fs, dir))) throw new StoreError('unknown-version', key.slice(0, 8)); }
      catch (e) { if (e instanceof StoreError && e.code === 'corrupt') metaBad = true; else throw e; }
      const dmg = await readDamaged(this.fs, dir);
      if (dmg) {
        // WHY the check: the marker may only be cleared when the quarantined copy it names is really there (a cross-check, not the marker's say-so)
        const asideOk = dmg.asideName === 'unknown' || await this.fs.exists(nodePath.join(this.root, 'aside', dmg.asideName));
        if (!asideOk) throw new StoreError('corrupt', `the quarantined copy ${dmg.asideName} is missing; the damaged marker is kept`);
        // review 5: the marker is cleared by a NEWER statement in marks.bin (nothing is deleted); an unreadable marks file is kept as marks.bin.bad-N first
        if (dmg.asideName === 'unknown') { if (await this.fs.exists(nodePath.join(dir, MARKS_FILE))) await keepBadSideFile(this.fs, nodePath.join(dir, MARKS_FILE)); }
        else await setMarks(this.fs, dir, { damaged: null }); // DESTRUCTIVE-OK(explicit-request): the caller asked for the marker to be cleared; the aside copy it names was found above
        await this.fs.fsyncDir(dir);
        this.host.forget(key);
        await this.host.ensureIndex(dir);
        return { asideName: dmg.asideName };
      }
      const asideName = await nextAsideName(this.fs, this.root, key, false);
      await mkdirDurable(this.fs, nodePath.join(this.root, 'aside', asideName));   // the space-needing step first (see quarantine)
      await writeSideFor(this.fs, nodePath.join(dir, 'aside.intent'), { role: 'intent', key }, metaBad ? { asideName, moveMeta: true } : { asideName }); // DESTRUCTIVE-OK(hint): a note of intent; load() finishes the move it names
      this.host.forget(key);
      await this.finishAside(key, dir);
      return { asideName };
  }

  async finishAside(key: string, dir: string): Promise<void> {
    const intentPath = nodePath.join(dir, 'aside.intent');
    const ir = await readSideFor(this.fs, intentPath, { role: 'intent', key });
    if (ir.kind === 'absent') return;
    // WHY (review 4, class fix): an intent is a note that exists only while a move is in flight. One that names ANOTHER version is a foreign copy, and one whose aside
    // folder already carries the COMPLETE mark (written last, just before the note is removed) is an older copy of a note that did its job. Acting on either would move
    // a healthy version aside. Both are kept as aside.intent.bad-N and ignored. (An intent that merely fails its checksum is still finished, below.)
    if (ir.kind === 'foreign') { await keepBadSideFile(this.fs, intentPath); return; }   // sealed for another version or kind (envelope.ts): kept, ignored
    if (ir.kind === 'ok' && typeof ir.value?.asideName === 'string' && ASIDE_RE.test(ir.value.asideName) && await this.fs.exists(nodePath.join(this.root, 'aside', ir.value.asideName, 'COMPLETE'))) { await keepBadSideFile(this.fs, intentPath); return; }
    let { asideName, reason, moveMeta } = (ir.kind === 'ok' && ir.value ? ir.value : {}) as { asideName?: string; reason?: string; moveMeta?: boolean };
    // WHY not an error when the note is unreadable (review 3, class fix): the move still has to be finished, and a version must never be wedged by it. A fresh aside
    // name is chosen and the version reports `damaged` until the caller clears it; the files already moved stay where they are.
    if (typeof asideName !== 'string' || !ASIDE_RE.test(asideName)) { asideName = await nextAsideName(this.fs, this.root, key, true); reason = 'the set-aside note was unreadable'; moveMeta = false; }
    const target = nodePath.join(this.root, 'aside', asideName);
    await mkdirDurable(this.fs, target);
    for (const name of await this.fs.readdir(dir)) {
      if (name === 'index.bin' || name === 'index.rebuild' || name === 'summary.json' || name === 'scrub.json' || name === CHECKPOINT_FILE || name === MARKS_FILE || (moveMeta && (name === 'meta.json' || name === 'meta.copy')) || /^body-[0-9a-f]{16}\.bin$/.test(name)) {
        // WHY never overwrite (H2): a rename over an existing aside file would destroy the very copy being kept.
        // The aside copy already holds this file, so the move happened before; what is in the version
        // folder is newer and stays where it is.
        if (await this.fs.exists(nodePath.join(target, name))) continue;
        // DESTRUCTIVE-OK(kept-copy-first): a rename to a name that does not exist in the aside copy; the bytes are kept there
        await this.fs.rename(nodePath.join(dir, name), nodePath.join(target, name));
      }
    }
    await this.fs.fsyncDir(target); await this.fs.fsyncDir(dir);
    // WHY (round 7, F2): this is a HISTORY CHANGE. The parks were made against the copy that just moved aside, and what comes next is whatever a peer recopies, which may be another history, so none of them may
    // ever drain onto it. They are moved to rejected/ (kept, with the reason `quarantine`). The epoch (tails.ts readEpoch) already names this aside folder, which exists since before the first move, so even
    // a crash before this line leaves the parks refused on read; a rerun of this note (every step is repeatable) finishes the move.
    await this.host.rejectParks(dir);
    // WHY (review 3, F7): reading must not fail because the disk is full. With no room for the marker the version is still reported `damaged` (typed), and the intent stays so the marker is written when space returns.
    try { if (reason !== undefined) await setMarks(this.fs, dir, { damaged: { asideName, reason }, partial: null }); } // DESTRUCTIVE-OK(hint): the marker that says where the copy went (marks.bin itself moved aside with the copy, so this is a fresh file)
    catch (e) { if (!isDiskFull(e)) throw e; throw new StoreError('damaged', asideName); }
    await this.host.resetHw(key);   // the version is empty now on purpose: the high-water record must say so, or the empty head would be reported as a rollback
    // WHY the intent goes BEFORE the fresh index (H2): once the moves are durable the intent has done its job.
    // If it outlived the fresh index, a rerun would move that new empty index over the aside copy's index.
    try {
      await writeFileAtomic(this.fs, nodePath.join(target, 'COMPLETE'), Buffer.from('complete\n')); // DESTRUCTIVE-OK(hint): a NEW existence-only mark in the aside folder; it lets a later reader tell this finished note from a live one
      await this.fs.unlink(nodePath.join(dir, 'aside.intent')); // DESTRUCTIVE-OK(hint): the note has done its job; every move it described is durable
      await this.fs.fsyncDir(dir);
    } catch (e) {
      // WHY (review 3 F7 again): a read must not fail for lack of space. The note stays (every step it describes is repeatable) and is finished when space returns.
      if (!isDiskFull(e)) throw e;
      if (reason !== undefined) throw new StoreError('damaged', asideName);
      return;
    }
    // a version whose meta.json was garbage has no registration any more (the caller registers it again): no index to create
    if (reason === undefined && !moveMeta) { try { await this.host.ensureIndex(dir); } catch (e) { if (!isDiskFull(e)) throw e; } }   // a full disk: the empty version is served, the first append creates the index
    void key;
  }
}
