// Guards for "Add vision" (design §E4, task T17).
//
// The load-bearing one is "the shadowing pair" below. `<cacheDir>/X.gguf` and
// `<cacheDir>/X/` are ONE model id to llama-server, which serves exactly one of
// them and silently drops the other — unpredictably, because the outcome follows
// directory-entry order. So these tests do not merely check the end state: they
// re-check the invariant after EVERY filesystem mutation the move makes, on the
// success path, on a failure at every single step, and through the rollback.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  addVisionToModel, moveIntoOwnFolder, healInterruptedMove, interruptedMoveIds,
  REAL_MOVE_OPS, STILL_BUSY_MESSAGE, routerSilentMessage,
  type AddVisionEngine, type AddVisionTiming, type MoveOps,
} from '../src/main/models/add-vision';
import { scanGgufCache } from '../src/main/engine/cache-scan';
import type { EngineModelState } from '../src/shared/engine-types';
import type { QuantOption } from '../src/shared/model-manager-types';

let cacheDir: string;
beforeEach(() => { cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-vision-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(cacheDir, { recursive: true, force: true }); });

const VISION = { path: 'mmproj-F16.gguf', size: 900, sha256: null };

/** Put a finished, flat download on disk. Returns its model id. */
function installFlat(opts: { stem?: string; parts?: number; vision?: boolean; partial?: boolean } = {}): string {
  const stem = opts.stem ?? 'M-Q4_K_M';
  const parts = opts.parts ?? 1;
  const names = parts === 1
    ? [`${stem}.gguf`]
    : Array.from({ length: parts }, (_, i) =>
      `${stem}-${String(i + 1).padStart(5, '0')}-of-${String(parts).padStart(5, '0')}.gguf`);
  names.forEach((n, i) => fs.writeFileSync(path.join(cacheDir, n), Buffer.from(`weights-${i}`)));
  if (opts.partial) fs.writeFileSync(path.join(cacheDir, `${names[0]}.partial`), Buffer.from('leftover'));
  fs.writeFileSync(path.join(cacheDir, `${names[0]}.download.json`), JSON.stringify({
    v: 1, repo: 'unsloth/M-GGUF', quant: 'Q4_K_M',
    files: names.map((n) => `sub/${n}`),
    totalSizeBytes: 100, sha256ByFile: {}, startedAt: 1, completedAt: 2,
    ...(opts.vision === false ? {} : { visionFile: VISION }),
  }));
  return names[0].replace(/\.gguf$/, '');
}

/** Everything under the cache dir, path -> contents, for exact before/after. */
function snapshot(dir = cacheDir, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) Object.assign(out, snapshot(path.join(dir, ent.name), rel));
    else out[rel] = fs.readFileSync(path.join(dir, ent.name), 'utf8');
  }
  return out;
}

/** THE invariant: a loadable flat file and a loadable folder of the same name
 *  must never both exist. "Loadable" is what llama-server's --models-dir walk
 *  picks up: a `*.gguf` flat in the cache dir, and a `*.gguf` one level down. */
function assertNoShadowPair(modelId: string): void {
  const flat = fs.existsSync(path.join(cacheDir, `${modelId}.gguf`));
  const folder = path.join(cacheDir, modelId);
  let folderHasGguf = false;
  try {
    folderHasGguf = fs.readdirSync(folder).some((n) => /\.gguf$/i.test(n));
  } catch { /* no folder yet */ }
  if (flat && folderHasGguf) {
    throw new Error(
      `SHADOWING PAIR: ${modelId}.gguf and ${modelId}/ are both loadable — `
      + `the engine would pick between them unpredictably. Folder: ${fs.readdirSync(folder).join(', ')}`
    );
  }
}

/** Wrap every filesystem mutation the move makes so the invariant is re-checked
 *  the instant each one lands — not only at the end — and record the order.
 *  `failAt` makes the Nth rename (0-based) throw, standing in for a real
 *  EACCES/EBUSY; `undoAlsoFails` then breaks the rollback too.
 *
 *  It goes through the MoveOps seam because `import * as fs` is an ESM namespace
 *  vi.spyOn cannot redefine — measured: the spy records nothing and the real
 *  rename runs anyway, which is a green test proving the opposite of what it
 *  claims. */
function watchMoves(
  modelId: string, order: string[], failAt?: number, undoAlsoFails = false
): MoveOps {
  let forward = 0;
  let failed = false;
  const check = () => assertNoShadowPair(modelId);
  return {
    mkdir: (dir) => { REAL_MOVE_OPS.mkdir(dir); check(); },
    rename: (from, to) => {
      if (!failed && forward === failAt) {
        failed = true;
        throw new Error('EACCES: permission denied, rename');
      }
      if (failed && undoAlsoFails) throw new Error('EPERM: operation not permitted, rename');
      if (!failed) { forward += 1; order.push(path.basename(from)); }
      REAL_MOVE_OPS.rename(from, to);
      check();
    },
    rmdir: (dir) => { REAL_MOVE_OPS.rmdir(dir); check(); },
  };
}

// ---------------------------------------------------------------- the move

describe('moveIntoOwnFolder — the shadowing pair can never exist', () => {
  it('moves a single-file model with no instant where both layouts are loadable', () => {
    const id = installFlat();
    const order: string[] = [];
    // The inode BEFORE. A rename keeps it; a copy-then-delete does not — and a
    // copy is precisely the implementation that would put a loadable file in the
    // folder while the loadable flat one is still there, which the per-step
    // check below cannot see because both halves happen inside one call.
    const inodeBefore = fs.statSync(path.join(cacheDir, `${id}.gguf`)).ino;
    moveIntoOwnFolder(cacheDir, id, `${id}.gguf`, 1, watchMoves(id, order));
    expect(fs.statSync(path.join(cacheDir, id, `${id}.gguf`)).ino).toBe(inodeBefore);
    // The manifest goes first: a folder holding only a manifest is not a model,
    // so the flat file stays the ONLY loadable copy until the one atomic rename
    // that hands the model over.
    expect(order).toEqual([`${id}.gguf.download.json`, `${id}.gguf`]);
    expect(fs.existsSync(path.join(cacheDir, `${id}.gguf`))).toBe(false);
    expect(fs.readFileSync(path.join(cacheDir, id, `${id}.gguf`), 'utf8')).toBe('weights-0');
  });

  it('moves a split set manifest-first, then part 1, then the followers', () => {
    const id = installFlat({ parts: 3, partial: true });
    const order: string[] = [];
    const inodes = fs.readdirSync(cacheDir)
      .map((n) => [n, fs.statSync(path.join(cacheDir, n)).ino] as const);
    moveIntoOwnFolder(cacheDir, id, `${id}.gguf`, 3, watchMoves(id, order));
    // Every file is the SAME file, moved — never a copy (see the single-file
    // case above for why a copy is the dangerous implementation).
    for (const [name, ino] of inodes) {
      expect(fs.statSync(path.join(cacheDir, id, name)).ino).toBe(ino);
    }
    expect(order).toEqual([
      `${id}.gguf.download.json`,          // not a *.gguf — folder still not a model
      `${id}.gguf.partial`,                // nor is this
      `${id}.gguf`,                        // THE handover: one atomic rename
      'M-Q4_K_M-00002-of-00003.gguf',      // followers are never the model's own id
      'M-Q4_K_M-00003-of-00003.gguf',
    ]);
    expect(snapshot()).toEqual({
      [`${id}/${id}.gguf`]: 'weights-0',
      [`${id}/${id}.gguf.partial`]: 'leftover',
      [`${id}/${id}.gguf.download.json`]: expect.any(String),
      [`${id}/M-Q4_K_M-00002-of-00003.gguf`]: 'weights-1',
      [`${id}/M-Q4_K_M-00003-of-00003.gguf`]: 'weights-2',
    });
  });

  it('a failure at EVERY step rolls back to exactly what was there, still flat and loadable', () => {
    // 5 files move for a 3-part set; fail each one in turn, and the mkdir too.
    for (let failAt = 0; failAt < 5; failAt++) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.mkdirSync(cacheDir, { recursive: true });
      const id = installFlat({ parts: 3, partial: true });
      const before = snapshot();
      // The ops assert the invariant after every mutation, rollback included.
      const ops = watchMoves(id, [], failAt);
      expect(() => moveIntoOwnFolder(cacheDir, id, `${id}.gguf`, 3, ops))
        .toThrow(`Could not move ${id} into its own folder: EACCES: permission denied, rename. Nothing was changed.`);
      expect(snapshot()).toEqual(before);                       // byte-for-byte, same paths
      expect(fs.existsSync(path.join(cacheDir, id))).toBe(false); // and no empty folder left behind
    }
  });

  it('reports the OS error when the folder cannot be created, and changes nothing', () => {
    const id = installFlat();
    // A REAL collision, not a stubbed one: something is already sitting at the
    // name the folder needs. mkdir is deliberately non-recursive so this is an
    // error rather than a silent merge into whatever is there.
    fs.writeFileSync(path.join(cacheDir, id), 'in the way');
    const before = snapshot();
    expect(() => moveIntoOwnFolder(cacheDir, id, `${id}.gguf`, 1)).toThrow(
      `Could not move ${id} into its own folder: `
      + `EEXIST: file already exists, mkdir '${path.join(cacheDir, id)}'. Nothing was changed.`
    );
    expect(snapshot()).toEqual(before);
  });

  it('refuses to merge into a folder that is already there — mkdir is deliberately not recursive', () => {
    const id = installFlat();
    // A DIRECTORY in the way, not a file: `mkdir(dir, {recursive: true})` does
    // not throw on one, so this is the case that pins the non-recursive form —
    // which is both the "don't silently merge into someone else's folder" rule
    // and the mutex that makes two concurrent Add-vision calls safe.
    const folder = path.join(cacheDir, id);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'someone-elses-notes.txt'), 'keep me');
    const before = snapshot();
    expect(() => moveIntoOwnFolder(cacheDir, id, `${id}.gguf`, 1)).toThrow(
      `Could not move ${id} into its own folder: `
      + `EEXIST: file already exists, mkdir '${folder}'. Nothing was changed.`
    );
    expect(snapshot()).toEqual(before);
  });

  it('the rollback removes the folder only if it is EMPTY — never a recursive force', () => {
    const id = installFlat();
    const stray = path.join(cacheDir, id, 'another-instance-wrote-this.txt');
    const ops = watchMoves(id, [], 1);          // fail the model file's move
    // Another app instance drops a file into the folder just before the undo
    // finishes — the dev instance and the built app really do share this cache
    // dir. A recursive force would delete it; rmdir refuses, which is the
    // difference between "a check" and "a force".
    const guarded: MoveOps = { ...ops, rmdir: (dir) => { fs.writeFileSync(stray, 'not mine'); ops.rmdir(dir); } };
    let message = '';
    try { moveIntoOwnFolder(cacheDir, id, `${id}.gguf`, 1, guarded); } catch (e: any) { message = e.message; }
    expect(fs.readFileSync(stray, 'utf8')).toBe('not mine');   // untouched
    expect(message).toContain('Putting its files back failed too: ENOTEMPTY');
    expect(message).not.toContain('Nothing was changed');
  });

  it('says where the files are when the rollback itself fails — never "nothing was changed"', () => {
    const id = installFlat({ parts: 2 });
    // Fail the follower's move, then fail every undo.
    const ops = watchMoves(id, [], 2, true);
    let message = '';
    try { moveIntoOwnFolder(cacheDir, id, `${id}.gguf`, 2, ops); } catch (e: any) { message = e.message; }
    expect(message).toBe(
      `Could not move ${id} into its own folder: EACCES: permission denied, rename. `
      + 'Putting its files back failed too: EPERM: operation not permitted, rename. '
      + `Some of them are now in ${path.join(cacheDir, id)} — move them back into ${cacheDir} `
      + 'to use the model again.'
    );
    expect(message).not.toContain('Nothing was changed');
  });
});

// ------------------------------------------------------------- the sequence

interface Recorder {
  log: string[];
  engine: AddVisionEngine;
  downloads: Array<{ repo: string; quant: QuantOption }>;
  timing: AddVisionTiming;
  clock: () => number;
}

/** A fake engine plus a fake clock. `inFlight` and `states` are read one entry
 *  per call, the LAST entry repeating forever — so "busy for ever" is expressed
 *  as a single-entry list and the bound is what has to end the wait. */
function recorder(opts: {
  running?: boolean; inFlight?: number[]; states?: Array<EngineModelState | null>;
} = {}): Recorder {
  const log: string[] = [];
  const downloads: Array<{ repo: string; quant: QuantOption }> = [];
  const inFlight = opts.inFlight ?? [0];
  const states = opts.states ?? ['unloaded' as EngineModelState];
  let idleCalls = 0;
  let stateCalls = 0;
  let clock = 1_000;
  const engine: AddVisionEngine = {
    running: () => opts.running ?? true,
    inFlightFor: () => inFlight[Math.min(idleCalls++, inFlight.length - 1)],
    unload: async () => { log.push('unload'); },
    modelState: async () => {
      log.push('poll');
      return states[Math.min(stateCalls++, states.length - 1)];
    },
    refreshModels: async () => { log.push('reload'); },
  };
  return {
    log, engine, downloads,
    clock: () => clock,
    timing: {
      idlePollMs: 1_000, idleMaxWaitMs: 10_000,
      unloadPollMs: 250, unloadTimeoutMs: 1_000,
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; log.push(`sleep:${ms}`); },
    },
  };
}

function start(r: Recorder) {
  return (repo: string, quant: QuantOption) => {
    r.log.push('download');
    r.downloads.push({ repo, quant });
    return Promise.resolve({ downloadId: 'dl-1' });
  };
}

describe('addVisionToModel — order of operations', () => {
  it('waits for the model to go idle, unloads it, waits for it to REALLY be unloaded, then moves', async () => {
    const id = installFlat();
    const r = recorder({ inFlight: [2, 1, 0], states: ['loaded', 'sleeping', 'unloaded'] });
    const out = await addVisionToModel(cacheDir, id, r.engine, start(r), r.timing);
    expect(out).toEqual({ downloadId: 'dl-1' });
    expect(r.log).toEqual([
      'sleep:1000', 'sleep:1000',                    // two in-flight requests drained
      'unload',
      'poll', 'sleep:250', 'poll', 'sleep:250', 'poll',  // loaded → sleeping → unloaded
      'reload',                                      // the router is told the layout moved
      'download',
    ]);
    // Only after all of that is the model in its folder.
    expect(fs.existsSync(path.join(cacheDir, id, `${id}.gguf`))).toBe(true);
  });

  it("a model that never unloads aborts with the design's exact message, and NOTHING is moved", async () => {
    const id = installFlat();
    const before = snapshot();
    const r = recorder({ states: ['sleeping'] });     // frees memory, child still holds the file
    await expect(addVisionToModel(cacheDir, id, r.engine, start(r), r.timing))
      .rejects.toThrow(STILL_BUSY_MESSAGE);
    expect(STILL_BUSY_MESSAGE).toBe('The model is still busy — try again in a moment.');
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(cacheDir, id))).toBe(false);
    expect(r.log).not.toContain('download');
  });

  it('an unanswerable router is "do not know", never "unloaded" — and says THAT, not "busy"', async () => {
    const id = installFlat();
    const r = recorder({ states: [null] });
    // Two different facts, two different sentences. Reporting "still busy" here
    // would state a cause nobody established — the substitution
    // docs/error-message-standards.md exists to stop.
    await expect(addVisionToModel(cacheDir, id, r.engine, start(r), r.timing)).rejects.toThrow(
      `The engine did not answer when asked whether ${id} is still loaded, so its file was left alone.`
    );
    expect(routerSilentMessage(id)).not.toBe(STILL_BUSY_MESSAGE);
    expect(fs.existsSync(path.join(cacheDir, id))).toBe(false);
  });

  it('the idle wait is BOUNDED — a model busy for ever still gets there', async () => {
    const id = installFlat();
    const r = recorder({ inFlight: [1] });            // never drops to zero
    await addVisionToModel(cacheDir, id, r.engine, start(r), r.timing);
    // 10 s bound at a 1 s poll = ten waits, then it goes ahead anyway.
    expect(r.log.filter((l) => l === 'sleep:1000')).toHaveLength(10);
    expect(r.log).toContain('download');
  });

  it('skips the unload and the poll when no engine is running', async () => {
    const id = installFlat();
    const r = recorder({ running: false, states: [null] });
    await addVisionToModel(cacheDir, id, r.engine, start(r), r.timing);
    // Nothing holds the file and there is no router to ask; polling `null` for
    // fifteen seconds would refuse a move that was always safe.
    expect(r.log).toEqual(['reload', 'download']);
  });

  it('hands the downloader the manifest\'s repo, file set and vision file — the folder is where it lands', async () => {
    const id = installFlat();
    const r = recorder();
    await addVisionToModel(cacheDir, id, r.engine, start(r), r.timing);
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0].repo).toBe('unsloth/M-GGUF');
    expect(r.downloads[0].quant).toMatchObject({
      quant: 'Q4_K_M', files: [`sub/${id}.gguf`], visionFile: VISION, visionBytes: 900,
    });
  });

  it('a model already in its folder (the crash-recovery state) only downloads — no move, no reload', async () => {
    // What a fresh vision download whose projector leg failed leaves behind.
    const id = 'M-Q4_K_M';
    fs.mkdirSync(path.join(cacheDir, id));
    fs.writeFileSync(path.join(cacheDir, id, `${id}.gguf`), 'weights-0');
    fs.writeFileSync(path.join(cacheDir, id, `${id}.gguf.download.json`), JSON.stringify({
      v: 1, repo: 'unsloth/M-GGUF', quant: 'Q4_K_M', files: [`sub/${id}.gguf`],
      totalSizeBytes: 100, sha256ByFile: {}, startedAt: 1, completedAt: 2, visionFile: VISION,
    }));
    const r = recorder();
    const before = snapshot();
    await addVisionToModel(cacheDir, id, r.engine, start(r), r.timing);
    expect(r.log).toEqual(['unload', 'poll', 'download']);   // no 'reload': nothing moved
    expect(snapshot()).toEqual(before);
  });
});

describe('addVisionToModel — what it refuses, and why', () => {
  const cases: Array<[string, () => string, string]> = [
    ['a model that is not installed', () => 'Ghost-Q4_K_M',
      'Ghost-Q4_K_M is not in your models folder, so there is nothing to add a vision file to.'],
    ['a download that never finished', () => {
      const names = ['H-00001-of-00002.gguf'];
      fs.writeFileSync(path.join(cacheDir, names[0]), 'half');
      fs.writeFileSync(path.join(cacheDir, `${names[0]}.download.json`), JSON.stringify({
        v: 1, repo: 'unsloth/H-GGUF', quant: 'Q4_K_M', files: [`sub/${names[0]}`, 'sub/H-00002-of-00002.gguf'],
        totalSizeBytes: 100, sha256ByFile: {}, startedAt: 1, visionFile: VISION,
      }));
      return 'H-00001-of-00002';
    }, 'H-00001-of-00002 has not finished downloading, so its vision file cannot be added yet.'],
    ['a model with no manifest at all', () => {
      fs.writeFileSync(path.join(cacheDir, 'Bare-Q4_K_M.gguf'), 'weights');
      return 'Bare-Q4_K_M';
    }, 'There is no record of where Bare-Q4_K_M came from, so its vision file cannot be downloaded. '
      + 'Delete it in Local Models and download it again.'],
    ['a manifest whose repo was never found', () => {
      fs.writeFileSync(path.join(cacheDir, 'Un-Q4_K_M.gguf'), 'weights');
      fs.writeFileSync(path.join(cacheDir, 'Un-Q4_K_M.gguf.download.json'), JSON.stringify({
        v: 1, repo: null, quant: 'Q4_K_M', files: ['Un-Q4_K_M.gguf'],
        totalSizeBytes: 100, sha256ByFile: {}, startedAt: 1, completedAt: 2,
      }));
      return 'Un-Q4_K_M';
    }, 'There is no record of where Un-Q4_K_M came from, so its vision file cannot be downloaded. '
      + 'Delete it in Local Models and download it again.'],
    ['a repo that publishes no vision file', () => installFlat({ vision: false }),
      "M-Q4_K_M's download record does not name a vision file, so there is nothing to add."],
  ];
  for (const [what, setUp, message] of cases) {
    it(`refuses ${what} with the real reason, and touches nothing`, async () => {
      const id = setUp();
      const before = snapshot();
      const r = recorder();
      await expect(addVisionToModel(cacheDir, id, r.engine, start(r), r.timing)).rejects.toThrow(message);
      expect(snapshot()).toEqual(before);
      expect(r.log).toEqual([]);   // refused before the engine was touched at all
    });
  }

  it('refuses a model that already has its vision file', async () => {
    const id = 'M-Q4_K_M';
    fs.mkdirSync(path.join(cacheDir, id));
    fs.writeFileSync(path.join(cacheDir, id, `${id}.gguf`), 'weights');
    fs.writeFileSync(path.join(cacheDir, id, 'mmproj-F16.gguf'), 'eye');
    const r = recorder();
    await expect(addVisionToModel(cacheDir, id, r.engine, start(r), r.timing))
      .rejects.toThrow('M-Q4_K_M already has its vision file.');
  });

  it('refuses when the record names a different file than the one on disk', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Odd-Q4_K_M.gguf'), 'weights');
    fs.writeFileSync(path.join(cacheDir, 'Odd-Q4_K_M.gguf.download.json'), JSON.stringify({
      v: 1, repo: 'unsloth/Odd-GGUF', quant: 'Q4_K_M', files: ['sub/Other-Q4_K_M.gguf'],
      totalSizeBytes: 100, sha256ByFile: {}, startedAt: 1, completedAt: 2, visionFile: VISION,
    }));
    const r = recorder();
    // Left unchecked the projector would be fetched into `Other-Q4_K_M/`, a
    // folder the engine never reads this model from, and the row would look
    // unchanged for ever.
    await expect(addVisionToModel(cacheDir, 'Odd-Q4_K_M', r.engine, start(r), r.timing)).rejects.toThrow(
      "Odd-Q4_K_M's download record describes a different file (Other-Q4_K_M), "
      + 'so its vision file cannot be placed where the engine would read it. '
      + 'Delete it in Local Models and download it again.'
    );
    expect(fs.existsSync(path.join(cacheDir, 'Odd-Q4_K_M'))).toBe(false);
  });
});

// The move is two or more syscalls. No ordering makes a crash between them
// impossible — only harmless for what the ENGINE serves, which the ordering
// above does guarantee. What it cannot do is tidy up, and both states below were
// dead ends until this healing existed (reproduced 2026-09-05).
describe('healInterruptedMove — a crash mid-move is not a dead end', () => {
  /** The record moved, the weights did not: steps 1–2 done, step 3 not. */
  function crashAfterTheRecord(): string {
    const id = installFlat();
    fs.mkdirSync(path.join(cacheDir, id));
    fs.renameSync(
      path.join(cacheDir, `${id}.gguf.download.json`),
      path.join(cacheDir, id, `${id}.gguf.download.json`));
    return id;
  }

  /** A 3-part set with part 1 moved and its followers not: step 3 done, 4 not. */
  function crashAfterPartOne(): string {
    const id = installFlat({ parts: 3 });
    fs.mkdirSync(path.join(cacheDir, id));
    for (const name of [`${id}.gguf.download.json`, `${id}.gguf`]) {
      fs.renameSync(path.join(cacheDir, name), path.join(cacheDir, id, name));
    }
    return id;
  }

  it('puts the record back beside the weights — instead of advising a delete that would destroy them', async () => {
    const id = crashAfterTheRecord();
    // Before healing this told the user "There is no record of where … came
    // from. Delete it in Local Models and download it again" — while the record
    // sat one directory away and the model itself was fine.
    expect(interruptedMoveIds(cacheDir)).toEqual([id]);
    expect(healInterruptedMove(cacheDir, id)).toBe(true);
    expect(Object.keys(snapshot()).sort()).toEqual([`${id}.gguf`, `${id}.gguf.download.json`]);
    expect(fs.existsSync(path.join(cacheDir, id))).toBe(false);
    // And the retry now works end to end.
    const r = recorder();
    await addVisionToModel(cacheDir, id, r.engine, start(r), r.timing);
    expect(r.log).toContain('download');
  });

  it('puts a half-moved split set back together — instead of leaving it out of the picker for ever', async () => {
    const id = crashAfterPartOne();
    // Every byte was on disk, split across two directories: scanGgufCache needs
    // a COMPLETE set in one place, so the model vanished from the model picker
    // and Local Models offered only Delete.
    expect(scanGgufCache(cacheDir)).toEqual([]);
    expect(healInterruptedMove(cacheDir, id)).toBe(true);
    expect(scanGgufCache(cacheDir).map((m) => m.id)).toEqual([id]);
    expect(fs.existsSync(path.join(cacheDir, id))).toBe(false);
    const r = recorder();
    await addVisionToModel(cacheDir, id, r.engine, start(r), r.timing);
    expect(fs.existsSync(path.join(cacheDir, id, `${id}.gguf`))).toBe(true);
  });

  /** A 3-part set with the record, part 1 AND part 2 moved: step 4 got half way.
   *  This is the fixture the healing ORDER matters for — undo it forwards and
   *  part 1 lands back flat while part 2 is still in the folder, which is the
   *  shadowing pair. */
  function crashMidFollowers(): string {
    const id = installFlat({ parts: 3 });
    fs.mkdirSync(path.join(cacheDir, id));
    for (const name of [`${id}.gguf.download.json`, `${id}.gguf`, 'M-Q4_K_M-00002-of-00003.gguf']) {
      fs.renameSync(path.join(cacheDir, name), path.join(cacheDir, id, name));
    }
    return id;
  }

  it('keeps the invariant while healing — the two sides are never both loadable', () => {
    for (const setUp of [crashAfterPartOne, crashMidFollowers]) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.mkdirSync(cacheDir, { recursive: true });
      const id = setUp();
      healInterruptedMove(cacheDir, id, watchMoves(id, []));   // throws if the pair ever exists
      expect(fs.existsSync(path.join(cacheDir, `${id}.gguf`))).toBe(true);
      expect(fs.existsSync(path.join(cacheDir, id))).toBe(false);
      expect(scanGgufCache(cacheDir).map((m) => m.id)).toEqual([id]);
    }
  });

  it('addVision heals before it reads anything, so a retry after a crash just works', async () => {
    const id = crashAfterTheRecord();
    const r = recorder();
    const out = await addVisionToModel(cacheDir, id, r.engine, start(r), r.timing);
    expect(out).toEqual({ downloadId: 'dl-1' });
    expect(fs.existsSync(path.join(cacheDir, id, `${id}.gguf`))).toBe(true);
  });

  const leaveAlone: Array<[string, () => string]> = [
    ['a real vision model with a flat namesake beside it (the pre-existing collision)', () => {
      const id = installFlat();
      fs.mkdirSync(path.join(cacheDir, id));
      fs.writeFileSync(path.join(cacheDir, id, `${id}.gguf`), 'other build');
      fs.writeFileSync(path.join(cacheDir, id, 'mmproj-F16.gguf'), 'eye');
      return id;
    }],
    // Isolates the projector refusal: the folder holds a projector and NO
    // weights (a vision model whose weights were deleted — cache-scan reports
    // that folder on purpose), so every OTHER condition is satisfied and only
    // "there is a projector in there" stops the heal from eating it.
    ['a leftover projector folder beside a complete flat model', () => {
      const id = installFlat();
      fs.mkdirSync(path.join(cacheDir, id));
      fs.writeFileSync(path.join(cacheDir, id, 'mmproj-F16.gguf'), 'eye');
      return id;
    }],
    // Isolates the parts-add-up refusal: two DIFFERENT downloads of one split
    // filename, one flat and one in a folder. Nothing here is an interrupted
    // move, and merging them would build one set out of two builds' bytes.
    ['two unrelated part-sets of the same name that do not add up', () => {
      const id = 'M-Q4_K_M-00001-of-00003';
      fs.writeFileSync(path.join(cacheDir, `${id}.gguf`), 'build A part 1');
      fs.mkdirSync(path.join(cacheDir, id));
      fs.writeFileSync(path.join(cacheDir, id, 'M-Q4_K_M-00002-of-00003.gguf'), 'build B part 2');
      return id;
    }],
    ['two complete copies of the same id — not one interrupted move', () => {
      const id = installFlat();
      fs.mkdirSync(path.join(cacheDir, id));
      fs.writeFileSync(path.join(cacheDir, id, `${id}.gguf`), 'other build');
      return id;
    }],
    ['a folder holding a whole model and a stray flat .partial', () => {
      const id = 'P-Q4_K_M';
      fs.writeFileSync(path.join(cacheDir, `${id}.gguf.partial`), 'stray');
      fs.mkdirSync(path.join(cacheDir, id));
      fs.writeFileSync(path.join(cacheDir, id, `${id}.gguf`), 'whole');
      return id;
    }],
  ];
  for (const [what, setUp] of leaveAlone) {
    it(`leaves ${what} exactly alone`, () => {
      const id = setUp();
      const before = snapshot();
      expect(healInterruptedMove(cacheDir, id)).toBe(false);
      expect(snapshot()).toEqual(before);
    });
  }
});
