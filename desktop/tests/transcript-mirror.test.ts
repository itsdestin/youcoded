// Tests for the CC transcript MOVEMENT module (Phase 2a design §2).
// Uses REAL temp dirs (fs.mkdtempSync) — no memfs — standing in for both
// ~/.claude/projects/<slug>/ (the local side) and the personal space's
// Conversations/ dir (the durable side). The whole point of this module is real
// disk behavior: size-gated whole-file copy, on-demand dir creation, and the
// LOAD-BEARING invariant that a missing/shrunk local file NEVER mutates the
// durable space copy (CC's cleanupPeriodDays deletes local transcripts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mirrorIn, materializeOut } from '../src/main/conversations/transcript-mirror';

let tmp: string;
let localPath: string;   // stands in for ~/.claude/projects/<slug>/<id>.jsonl
let spacePath: string;   // stands in for <space>/Conversations/claude/transcripts/<key>/<id>.jsonl

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-tmirror-'));
  // Deliberately place both under directories that do NOT exist yet, so the
  // "creates dirs on demand" contract is exercised on the first copy.
  localPath = path.join(tmp, 'projects', 'home-a-my-app', 'sess-1.jsonl');
  spacePath = path.join(tmp, 'space', 'Conversations', 'claude', 'transcripts', 'my-app', 'sess-1.jsonl');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Write a file, creating parent dirs. Content length is what the size-gate
// compares, so tests control the gate purely by string length.
function put(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('mirrorIn (local → space, add/update-only)', () => {
  // Contract 1: a brand-new local transcript with no space copy yet is copied
  // in (creating every parent dir) and reports {copied:true}.
  it('copies a new local transcript into the space and creates dirs', async () => {
    put(localPath, 'line-1\nline-2\n');

    const res = await mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spacePath });

    expect(res).toEqual({ copied: true });
    expect(fs.existsSync(spacePath)).toBe(true);          // dir tree created on demand
    expect(read(spacePath)).toBe('line-1\nline-2\n');     // byte-for-byte copy
  });

  // Contract 2: a local file LARGER than the space copy is the append-only
  // growth case — it overwrites the (older, shorter) space copy.
  it('overwrites the space copy when the local file is larger', async () => {
    put(spacePath, 'line-1\n');                 // 7 bytes — older, shorter
    put(localPath, 'line-1\nline-2\nline-3\n'); // 21 bytes — grew via appends

    const res = await mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spacePath });

    expect(res).toEqual({ copied: true });
    // renameSync over an existing dest must atomically REPLACE it (Windows maps
    // to MoveFileEx w/ REPLACE_EXISTING) — this assertion pins that behavior.
    expect(read(spacePath)).toBe('line-1\nline-2\nline-3\n');
  });

  // Contract 3: identical size → NO write at all. Verified via mtime: we stamp
  // the space copy to a fixed past time, mirror, and assert the mtime is
  // unchanged (a rename would bump it to "now"). This is stronger than checking
  // the return flag alone and immune to coarse Windows mtime resolution.
  it('does not write when sizes are identical (mtime unchanged)', async () => {
    put(spacePath, 'same-size\n');
    put(localPath, 'same-size\n'); // identical byte length
    const past = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(spacePath, past, past);
    const before = fs.statSync(spacePath).mtimeMs;

    const res = await mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spacePath });

    expect(res).toEqual({ copied: false });
    expect(fs.statSync(spacePath).mtimeMs).toBe(before); // never rewritten
  });

  // Reviewer pin: same byte length but DIFFERENT content still skips — and the
  // space copy's bytes stay untouched. This pins the module header's deliberate
  // trade-off ("a same-size-different-content case resolves on the next turn's
  // growth"): a future content-hash refactor that starts copying here must trip
  // this red test and re-argue the design first.
  it('same size but different content: no copy, space bytes unchanged', async () => {
    put(spacePath, 'space-bytes\n');
    put(localPath, 'local-bytes\n'); // identical byte length, different content

    const res = await mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spacePath });

    expect(res).toEqual({ copied: false });
    expect(read(spacePath)).toBe('space-bytes\n'); // exact bytes preserved
  });

  // Contract 4 (LOAD-BEARING): the local file is MISSING (CC's cleanupPeriodDays
  // deleted it). mirror-in must be a pure no-op — the durable space copy's BYTES
  // are untouched. Deletion must NEVER propagate into the space.
  it('is a no-op when the local file is missing — space copy byte-identical', async () => {
    put(spacePath, 'durable-history\nkeep-me\n');
    const before = read(spacePath);
    // localPath is intentionally never created.

    const res = await mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spacePath });

    expect(res).toEqual({ copied: false });
    expect(fs.existsSync(spacePath)).toBe(true);   // still there
    expect(read(spacePath)).toBe(before);          // exact same bytes — no truncation
  });

  // Contract 5: the local file SHRANK below the space copy (a /clear rewrite or
  // foreign truncation). The fuller durable copy must NOT be clobbered; the call
  // reports {copied:false, shrunk:true} so the caller knows the record's
  // transcriptRef still points at the longer history.
  it('never clobbers a fuller space copy when local shrank (reports shrunk)', async () => {
    put(spacePath, 'full-history-line-1\nfull-history-line-2\n'); // long, durable
    const before = read(spacePath);
    put(localPath, 'cleared\n');                                  // short, post-/clear

    const res = await mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spacePath });

    expect(res).toEqual({ copied: false, shrunk: true });
    expect(read(spacePath)).toBe(before); // fuller durable copy preserved exactly
  });

  // New (2026-09-10): two callers racing to mirror the SAME dest at once must
  // never collide on the tmp filename — each copy gets its own unique tmp
  // (pid + timestamp + a per-process counter), and both renames land cleanly.
  it('two overlapping mirrors of the same dest never collide on the tmp name', async () => {
    put(localPath, 'line-1\nline-2\n');
    const a = mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spacePath });
    const b = mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spacePath });
    await Promise.all([a, b]);
    expect(fs.readFileSync(spacePath, 'utf8')).toBe(fs.readFileSync(localPath, 'utf8'));
    expect(fs.readdirSync(path.dirname(spacePath)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('materializeOut (space → local, add/update-only)', () => {
  // Contract 6a: local is MISSING — write the space copy out, creating the
  // project slug dir on demand.
  it('writes the space copy to local (creating the slug dir) when local missing', async () => {
    put(spacePath, 'from-other-device\n');
    // localPath's parent dir does not exist yet.

    const res = await materializeOut({ spaceTranscriptPath: spacePath, localJsonlPath: localPath });

    expect(res).toEqual({ copied: true });
    expect(fs.existsSync(localPath)).toBe(true);
    expect(read(localPath)).toBe('from-other-device\n');
  });

  // Contract 6b: local exists but is SMALLER than the space copy — the space
  // copy (grown on another device) wins.
  it('overwrites local when the space copy is larger', async () => {
    put(localPath, 'short\n');                          // 6 bytes
    put(spacePath, 'grown-on-another-device-longer\n'); // longer

    const res = await materializeOut({ spaceTranscriptPath: spacePath, localJsonlPath: localPath });

    expect(res).toEqual({ copied: true });
    expect(read(localPath)).toBe('grown-on-another-device-longer\n');
  });

  // Contract 7: local is LARGER OR EQUAL — never clobber newer/equal local work
  // with an older/equal space copy. Two sub-cases pinned in one test.
  it('leaves local untouched when it is larger or equal to the space copy', async () => {
    // larger-local case
    put(spacePath, 'space\n');                     // 6 bytes
    put(localPath, 'local-is-longer-here\n');      // longer
    const localerBefore = read(localPath);
    let res = await materializeOut({ spaceTranscriptPath: spacePath, localJsonlPath: localPath });
    expect(res).toEqual({ copied: false });
    expect(read(localPath)).toBe(localerBefore);   // untouched

    // equal-size case (fresh paths so the two sub-cases don't interfere)
    const eqLocal = path.join(tmp, 'projects', 'p2', 'eq.jsonl');
    const eqSpace = path.join(tmp, 'space', 'p2', 'eq.jsonl');
    put(eqSpace, 'abcdef\n');
    put(eqLocal, 'ABCDEF\n'); // same length, different content
    res = await materializeOut({ spaceTranscriptPath: eqSpace, localJsonlPath: eqLocal });
    expect(res).toEqual({ copied: false });
    expect(read(eqLocal)).toBe('ABCDEF\n'); // equal size ⇒ local kept, not clobbered
  });

  // Contract 8 first half: space copy MISSING — materialize is a no-op that
  // never creates or deletes anything locally.
  it('is a no-op when the space copy is missing', async () => {
    // Neither file exists.
    const res = await materializeOut({ spaceTranscriptPath: spacePath, localJsonlPath: localPath });
    expect(res).toEqual({ copied: false });
    expect(fs.existsSync(localPath)).toBe(false); // nothing conjured
  });

  // New (review round 1, IMPORTANT finding): shouldCommit re-checked right
  // before the rename. A session resuming mid-copy (materializeSweep/
  // materializeOne's real callers) must see the local file untouched and no
  // orphaned tmp — the copy is discarded, not just skipped up front.
  it('shouldCommit returning false leaves the local dest untouched and no .tmp behind', async () => {
    put(spacePath, 'from-other-device\n');
    // localPath's parent dir does not exist yet — shouldCommit must abort
    // BEFORE the rename, but the mkdir/copy-into-tmp steps still ran.
    const res = await materializeOut({
      spaceTranscriptPath: spacePath,
      localJsonlPath: localPath,
      shouldCommit: () => false, // simulates a session that resumed mid-copy
    });
    expect(res).toEqual({ copied: false });
    expect(fs.existsSync(localPath)).toBe(false); // never renamed into place
    // The tmp file the copy created must be cleaned up, not orphaned.
    expect(fs.existsSync(path.dirname(localPath)) ? fs.readdirSync(path.dirname(localPath)).filter((n) => n.endsWith('.tmp')) : []).toEqual([]);
  });
});

// Contract 8 (explicit): NEITHER direction ever deletes a file. After running
// every path against a fully-populated pair, both originals still exist.
describe('never deletes anything, ever', () => {
  it('every operation leaves pre-existing files present', async () => {
    put(spacePath, 'space-content\n');
    put(localPath, 'local-content-longer\n'); // larger than space

    // mirror-in (local larger ⇒ writes) then materialize-out (local larger ⇒
    // no-op): neither may remove the other side.
    await mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spacePath });
    expect(fs.existsSync(localPath)).toBe(true);
    expect(fs.existsSync(spacePath)).toBe(true);

    await materializeOut({ spaceTranscriptPath: spacePath, localJsonlPath: localPath });
    expect(fs.existsSync(localPath)).toBe(true);
    expect(fs.existsSync(spacePath)).toBe(true);
  });
});

// DEVIATION from the plan's sketch (flagged in the report): the copy tmp file
// lands in the SPACE dir, and '.tmp' is NOT in the sync engine's DEFAULT_IGNORES
// (guards.ts) — a crash-orphaned tmp would sync forever as junk. copyInto sweeps
// stale '<dest>.*.tmp' files (>1h old) in the destination dir on each copy.
describe('stale tmp cleanup', () => {
  it('removes a stale orphaned .tmp for the same dest, keeps fresh/foreign ones', async () => {
    fs.mkdirSync(path.dirname(spacePath), { recursive: true });
    const staleTmp = `${spacePath}.99999.111.tmp`;      // matches <dest>.*.tmp
    const freshTmp = `${spacePath}.88888.222.tmp`;      // matches, but recent
    const foreignTmp = path.join(path.dirname(spacePath), 'other.jsonl.7.9.tmp'); // different dest
    fs.writeFileSync(staleTmp, 'junk');
    fs.writeFileSync(freshTmp, 'junk');
    fs.writeFileSync(foreignTmp, 'junk');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
    fs.utimesSync(staleTmp, old, old);
    fs.utimesSync(foreignTmp, old, old); // old too, but different dest ⇒ kept

    put(localPath, 'trigger-a-copy\n');
    await mirrorIn({ localJsonlPath: localPath, spaceTranscriptPath: spacePath });

    expect(fs.existsSync(staleTmp)).toBe(false);   // swept
    expect(fs.existsSync(freshTmp)).toBe(true);    // too new to sweep
    expect(fs.existsSync(foreignTmp)).toBe(true);  // belongs to another dest
    expect(read(spacePath)).toBe('trigger-a-copy\n'); // copy still succeeded
  });

  // Reviewer pin: the sweep also runs on the materialize-out side — its tmp
  // lands in the LOCAL project-slug dir, and a crash-orphan there is disk junk
  // (harmless to sync, but still junk). Same rules: stale same-dest swept,
  // fresh and foreign-dest kept.
  it('materializeOut sweeps a stale same-dest .tmp in the local dir, keeps fresh/foreign', async () => {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const staleTmp = `${localPath}.77777.333.tmp`;      // matches <dest>.*.tmp
    const freshTmp = `${localPath}.66666.444.tmp`;      // matches, but recent
    const foreignTmp = path.join(path.dirname(localPath), 'other.jsonl.5.6.tmp'); // different dest
    fs.writeFileSync(staleTmp, 'junk');
    fs.writeFileSync(freshTmp, 'junk');
    fs.writeFileSync(foreignTmp, 'junk');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
    fs.utimesSync(staleTmp, old, old);
    fs.utimesSync(foreignTmp, old, old); // old too, but different dest ⇒ kept

    put(spacePath, 'trigger-materialize\n');
    await materializeOut({ spaceTranscriptPath: spacePath, localJsonlPath: localPath });

    expect(fs.existsSync(staleTmp)).toBe(false);   // swept
    expect(fs.existsSync(freshTmp)).toBe(true);    // too new to sweep
    expect(fs.existsSync(foreignTmp)).toBe(true);  // belongs to another dest
    expect(read(localPath)).toBe('trigger-materialize\n'); // copy still succeeded
  });
});
