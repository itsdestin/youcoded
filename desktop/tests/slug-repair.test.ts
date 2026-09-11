import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { classifyPair, uuidSet, Quarantine, repairHomeForks, repairRecordsAndSpace, repairOrphanDirs, runSlugRepair } from '../src/main/conversations/slug-repair';
import { ccProjectSlug, nativeStoreSlug } from '../src/main/slug-encoding';
import { createConversationStore } from '../src/main/conversations/conversation-store';
import * as logger from '../src/main/logger';

const L = (uuid: string) => JSON.stringify({ type: 'user', uuid, message: {} }) + '\n';
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const write = (name: string, content: string) => {
  const p = path.join(tmp, name); fs.writeFileSync(p, content); return p;
};

describe('classifyPair — the merge-safety contract (spec §6.0)', () => {
  it('identical bytes → identical', () => {
    const a = write('a.jsonl', L('u1') + L('u2'));
    const b = write('b.jsonl', L('u1') + L('u2'));
    expect(classifyPair(a, b)).toBe('identical');
  });
  it('strict subset → wrong-is-subset', () => {
    const a = write('a.jsonl', L('u1'));
    const b = write('b.jsonl', L('u1') + L('u2'));
    expect(classifyPair(a, b)).toBe('wrong-is-subset');
  });
  it('strict superset → wrong-is-superset', () => {
    const a = write('a.jsonl', L('u1') + L('u2') + L('u3'));
    const b = write('b.jsonl', L('u1') + L('u2'));
    expect(classifyPair(a, b)).toBe('wrong-is-superset');
  });
  it('bidirectional divergence → fork (NEVER merged)', () => {
    const a = write('a.jsonl', L('u1') + L('uA'));
    const b = write('b.jsonl', L('u1') + L('uB'));
    expect(classifyPair(a, b)).toBe('fork');
  });
  it('equal uuid sets but different bytes (metadata drift) → wrong-is-subset (correct-dir copy wins)', () => {
    const a = write('a.jsonl', L('u1') + JSON.stringify({ type: 'mode' }) + '\n');
    const b = write('b.jsonl', L('u1') + JSON.stringify({ type: 'last-prompt' }) + '\n');
    expect(classifyPair(a, b)).toBe('wrong-is-subset');
  });
  it('same uuid, same set, but the shared message content diverges → fork (never subset)', () => {
    const a = write('a.jsonl', JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'truncat' } }) + '\n' + L('u2'));
    const b = write('b.jsonl', JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'truncated properly' } }) + '\n' + L('u2'));
    expect(classifyPair(a, b)).toBe('fork');
  });
  it('empty vs empty → identical', () => {
    const a = write('a.jsonl', '');
    const b = write('b.jsonl', '');
    expect(classifyPair(a, b)).toBe('identical');
  });
  it('empty wrongCopy vs non-empty correctCopy → wrong-is-subset', () => {
    const a = write('a.jsonl', '');
    const b = write('b.jsonl', L('u1') + L('u2'));
    expect(classifyPair(a, b)).toBe('wrong-is-subset');
  });
  it('non-empty wrongCopy vs empty correctCopy → wrong-is-superset', () => {
    const a = write('a.jsonl', L('u1') + L('u2'));
    const b = write('b.jsonl', '');
    expect(classifyPair(a, b)).toBe('wrong-is-superset');
  });
});

describe('Quarantine (spec §6.0)', () => {
  it('moves preserving home-relative path and writes the decision log', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qhome-'));
    const victim = path.join(home, '.claude', 'projects', 'slug', 's.jsonl');
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, 'x');
    const q = new Quarantine(home);
    expect(q.move(victim, 'test')).toBe(true);
    expect(fs.existsSync(victim)).toBe(false);
    expect(fs.readFileSync(path.join(q.dir, '.claude', 'projects', 'slug', 's.jsonl'), 'utf8')).toBe('x');
    expect(fs.readFileSync(path.join(q.dir, 'decisions.log'), 'utf8')).toContain('MOVE');
  });
  it('quarantine root is under .youcoded, NEVER under .claude/projects', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qhome-'));
    const q = new Quarantine(home);
    expect(q.dir.startsWith(path.join(home, '.youcoded', 'repair-quarantine'))).toBe(true);
  });
});

describe('repairHomeForks (spec §6.1)', () => {
  const F = (uuid: string, cwd: string) => JSON.stringify({ type: 'user', uuid, cwd }) + '\n';
  const old = new Date(Date.now() - 60 * 60 * 1000);            // 1h ago — not live
  const age = (p: string) => fs.utimesSync(p, old, old);

  function makeHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r61-'));
    const P = path.join(home, 'My Proj, & Stuff');
    fs.mkdirSync(P, { recursive: true });
    const projectsDir = path.join(home, '.claude', 'projects');
    const homeSlugDir = path.join(projectsDir, ccProjectSlug(home));
    fs.mkdirSync(homeSlugDir, { recursive: true });
    const quarantine = new Quarantine(home);
    const opts = { projectsDir, homeDir: home, knownFolders: [P], quarantine };
    return { home, P, projectsDir, homeSlugDir, quarantine, opts };
  }

  it('R2-owned foreign transcript with NO correct copy is MOVED to the correct dir', async () => {
    const h = makeHome();
    const f = path.join(h.homeSlugDir, 's1.jsonl');
    fs.writeFileSync(f, F('u1', h.P)); age(f);
    const out = await repairHomeForks(h.opts);
    const dest = path.join(h.projectsDir, ccProjectSlug(h.P), 's1.jsonl');
    expect(out).toEqual([{ sessionId: 's1', homeFolder: h.P, kind: 'moved', paths: [dest] }]);
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('identical copy in the $HOME dir is quarantined; correct copy untouched', async () => {
    const h = makeHome();
    const correctDir = path.join(h.projectsDir, ccProjectSlug(h.P));
    fs.mkdirSync(correctDir, { recursive: true });
    const wrong = path.join(h.homeSlugDir, 's2.jsonl');
    const correct = path.join(correctDir, 's2.jsonl');
    fs.writeFileSync(wrong, F('u1', h.P)); fs.writeFileSync(correct, F('u1', h.P));
    age(wrong); age(correct);
    await repairHomeForks(h.opts);
    expect(fs.existsSync(wrong)).toBe(false);
    expect(fs.existsSync(correct)).toBe(true);
    expect(fs.existsSync(path.join(h.quarantine.dir, path.relative(h.home, wrong)))).toBe(true);
  });

  it('fork: NOTHING moves — both copies snapshotted, disk byte-identical (§7 merge-safety)', async () => {
    const h = makeHome();
    const correctDir = path.join(h.projectsDir, ccProjectSlug(h.P));
    fs.mkdirSync(correctDir, { recursive: true });
    const wrong = path.join(h.homeSlugDir, 's3.jsonl');
    const correct = path.join(correctDir, 's3.jsonl');
    fs.writeFileSync(wrong, F('u1', h.P) + F('uA', h.home));    // diverges one way
    fs.writeFileSync(correct, F('u1', h.P) + F('uB', h.P));     // …and the other
    age(wrong); age(correct);
    const before = [fs.readFileSync(wrong, 'utf8'), fs.readFileSync(correct, 'utf8')];
    const out = await repairHomeForks(h.opts);
    expect(out[0].kind).toBe('fork-surfaced');
    expect(fs.readFileSync(wrong, 'utf8')).toBe(before[0]);
    expect(fs.readFileSync(correct, 'utf8')).toBe(before[1]);
    expect(fs.readFileSync(path.join(h.quarantine.dir, 'decisions.log'), 'utf8')).toContain('ATTENTION fork s3');
    // (review fix, MINOR) both snapshots physically landed in quarantine.
    expect(fs.readFileSync(path.join(h.quarantine.dir, path.relative(h.home, wrong)), 'utf8')).toBe(before[0]);
    expect(fs.readFileSync(path.join(h.quarantine.dir, path.relative(h.home, correct)), 'utf8')).toBe(before[1]);
  });

  it('correct-dir copy is a strict subset of the $HOME copy: quarantine it, promote the superset (review fix, IMPORTANT 2a)', async () => {
    const h = makeHome();
    const correctDir = path.join(h.projectsDir, ccProjectSlug(h.P));
    fs.mkdirSync(correctDir, { recursive: true });
    const wrong = path.join(h.homeSlugDir, 's6.jsonl');
    const correct = path.join(correctDir, 's6.jsonl');
    const supersetBytes = F('u1', h.P) + F('u2', h.P);
    const subsetBytes = F('u1', h.P);
    fs.writeFileSync(wrong, supersetBytes);
    fs.writeFileSync(correct, subsetBytes);
    age(wrong); age(correct);
    const out = await repairHomeForks(h.opts);
    expect(out).toEqual([{ sessionId: 's6', homeFolder: h.P, kind: 'replaced-with-superset', paths: [correct] }]);
    expect(fs.existsSync(wrong)).toBe(false);
    expect(fs.readFileSync(correct, 'utf8')).toBe(supersetBytes);
    const quarantinedCorrect = path.join(h.quarantine.dir, path.relative(h.home, correct));
    expect(fs.readFileSync(quarantinedCorrect, 'utf8')).toBe(subsetBytes);
  });

  it('correct-dir copy is superset-eligible but currently live: pair is deferred, nothing moves (review fix, IMPORTANT 2b)', async () => {
    const h = makeHome();
    const correctDir = path.join(h.projectsDir, ccProjectSlug(h.P));
    fs.mkdirSync(correctDir, { recursive: true });
    const wrong = path.join(h.homeSlugDir, 's7.jsonl');
    const correct = path.join(correctDir, 's7.jsonl');
    const supersetBytes = F('u1', h.P) + F('u2', h.P);
    const subsetBytes = F('u1', h.P);
    fs.writeFileSync(wrong, supersetBytes); age(wrong);
    fs.writeFileSync(correct, subsetBytes);                    // fresh mtime = live; NOT aged
    const out = await repairHomeForks(h.opts);
    expect(out).toEqual([{ sessionId: 's7', homeFolder: h.P, kind: 'deferred-live', paths: [wrong, correct] }]);
    expect(fs.existsSync(wrong)).toBe(true);
    expect(fs.readFileSync(wrong, 'utf8')).toBe(supersetBytes);
    expect(fs.existsSync(correct)).toBe(true);
    expect(fs.readFileSync(correct, 'utf8')).toBe(subsetBytes);
    expect(fs.existsSync(h.quarantine.dir)).toBe(false);
  });

  it('top-level only: a subagent jsonl below the dir is never touched (§6.1 scoping)', async () => {
    const h = makeHome();
    const agent = path.join(h.homeSlugDir, 'sess-id', 'subagents', 'agent-x.jsonl');
    fs.mkdirSync(path.dirname(agent), { recursive: true });
    fs.writeFileSync(agent, F('u1', h.P)); age(agent);
    expect(await repairHomeForks(h.opts)).toEqual([]);
    expect(fs.existsSync(agent)).toBe(true);
  });

  it('live file (fresh mtime) is deferred, not touched (§6.5)', async () => {
    const h = makeHome();
    const f = path.join(h.homeSlugDir, 's4.jsonl');
    fs.writeFileSync(f, F('u1', h.P));                          // fresh mtime = live
    const out = await repairHomeForks(h.opts);
    expect(out).toEqual([{ sessionId: 's4', homeFolder: '', kind: 'deferred-live', paths: [f] }]);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('a transcript whose first cwd IS $HOME is left alone (legitimate resident)', async () => {
    const h = makeHome();
    const f = path.join(h.homeSlugDir, 's5.jsonl');
    fs.writeFileSync(f, F('u1', h.home)); age(f);
    expect(await repairHomeForks(h.opts)).toEqual([]);
    expect(fs.existsSync(f)).toBe(true);
  });
});

// Hoisted to file scope (Task 17): shared by repairRecordsAndSpace (§6.2) and
// runSlugRepair (§6.0/§6.5) test blocks.
const F62 = (uuid: string, cwd: string) => JSON.stringify({ type: 'user', uuid, cwd }) + '\n';
const old62 = new Date(Date.now() - 60 * 60 * 1000);
const age62 = (p: string) => fs.utimesSync(p, old62, old62);

function makeWorld() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r62-'));
  const P = path.join(home, 'PAF Proj, & Co');
  fs.mkdirSync(P, { recursive: true });
  const projectsDir = path.join(home, '.claude', 'projects');
  const correctDir = path.join(projectsDir, ccProjectSlug(P));
  fs.mkdirSync(correctDir, { recursive: true });
  const spaceRoot = path.join(home, 'Conversations');
  const lane = path.join(spaceRoot, 'claude', 'transcripts');
  fs.mkdirSync(lane, { recursive: true });
  const store = createConversationStore(spaceRoot);
  const quarantine = new Quarantine(home);
  const opts = { projectsDir, homeDir: home, knownFolders: [P], quarantine, store, spaceRoot };
  return { home, P, correctDir, lane, store, quarantine, opts, bucket: path.basename(P) };
}

describe('repairRecordsAndSpace (spec §6.2)', () => {
  const F = F62;
  const age = age62;

  it('repairs a record that enshrines $HOME for an R2-owned project session', async () => {
    const w = makeWorld();
    const t = path.join(w.correctDir, 's1.jsonl');
    fs.writeFileSync(t, F('u1', w.P)); age(t);
    await w.store.upsert({ id: 's1', provider: 'claude', projectName: 'destin',
      originalPath: w.home, transcriptRef: 'claude/transcripts/destin/s1.jsonl' });
    await repairRecordsAndSpace(w.opts);
    const rec = await w.store.get('claude', 's1');
    expect(rec?.projectName).toBe(w.bucket);
    expect(rec?.originalPath).toBe(w.P);
    expect(rec?.transcriptRef).toBe(`claude/transcripts/${w.bucket}/s1.jsonl`);
  });

  it('creates a record for a recordless session in a correct project dir', async () => {
    const w = makeWorld();
    const t = path.join(w.correctDir, 's2.jsonl');
    fs.writeFileSync(t, F('u1', w.P)); age(t);
    await repairRecordsAndSpace(w.opts);
    expect((await w.store.get('claude', 's2'))?.projectName).toBe(w.bucket);
  });

  it('keeps the superset space copy, quarantines the truncation-bucket subset — never merges', async () => {
    const w = makeWorld();
    fs.mkdirSync(path.join(w.lane, 'Change'), { recursive: true });
    fs.mkdirSync(path.join(w.lane, 'destin'), { recursive: true });
    const small = path.join(w.lane, 'Change', 's3.jsonl');
    const big = path.join(w.lane, 'destin', 's3.jsonl');
    fs.writeFileSync(small, F('u1', w.P));
    fs.writeFileSync(big, F('u1', w.P) + F('u2', w.P));
    age(small); age(big);
    await repairRecordsAndSpace(w.opts);
    const target = path.join(w.lane, w.bucket, 's3.jsonl');
    expect(fs.existsSync(target)).toBe(true);
    expect(uuidSet(target).size).toBe(2);             // the superset MOVED — nothing merged
    expect(fs.existsSync(small)).toBe(false);         // subset quarantined
    expect(fs.existsSync(big)).toBe(false);           // keeper relocated to the project bucket
  });

  it('a space-only transcript is carried over byte-identical (spec: "CC wins" is undefined for it)', async () => {
    const w = makeWorld();
    fs.mkdirSync(path.join(w.lane, 'Change'), { recursive: true });
    const only = path.join(w.lane, 'Change', 's4.jsonl');
    const content = F('u1', w.P);
    fs.writeFileSync(only, content); age(only);
    await repairRecordsAndSpace(w.opts);
    expect(fs.readFileSync(path.join(w.lane, w.bucket, 's4.jsonl'), 'utf8')).toBe(content);
  });

  it('does NOT re-key untouched sessions in a legitimate bucket', async () => {
    const w = makeWorld();
    fs.mkdirSync(path.join(w.lane, 'destin'), { recursive: true });
    const homeSession = path.join(w.lane, 'destin', 'sH.jsonl');
    fs.writeFileSync(homeSession, F('u1', w.home)); age(homeSession);   // a REAL $HOME session
    await w.store.upsert({ id: 'sH', provider: 'claude', projectName: 'destin',
      originalPath: w.home, transcriptRef: 'claude/transcripts/destin/sH.jsonl' });
    await repairRecordsAndSpace(w.opts);
    expect(fs.existsSync(homeSession)).toBe(true);
    expect((await w.store.get('claude', 'sH'))?.projectName).toBe('destin');
  });

  it('retires an emptied bucket only when it is NOT a known-folder basename', async () => {
    const w = makeWorld();
    fs.mkdirSync(path.join(w.lane, 'Change'), { recursive: true });
    const f = path.join(w.lane, 'Change', 's5.jsonl');
    fs.writeFileSync(f, F('u1', w.P)); age(f);
    await repairRecordsAndSpace(w.opts);
    expect(fs.existsSync(path.join(w.lane, 'Change'))).toBe(false);     // emptied fragment retired
    expect(fs.existsSync(path.join(w.lane, w.bucket))).toBe(true);      // project bucket stays
  });

  // --- Review fix (2026-08-12): fork-gate the space keeper; distinct
  // 'record-repaired' finding kind; structurally protect the $HOME bucket ---

  it('three space copies where two are clean subsets of the keeper: moves proceed (fork gate does not misfire)', async () => {
    const w = makeWorld();
    fs.mkdirSync(path.join(w.lane, 'A'), { recursive: true });
    fs.mkdirSync(path.join(w.lane, 'B'), { recursive: true });
    fs.mkdirSync(path.join(w.lane, 'C'), { recursive: true });
    const keeperFile = path.join(w.lane, 'A', 's7.jsonl');
    const subset1 = path.join(w.lane, 'B', 's7.jsonl');
    const subset2 = path.join(w.lane, 'C', 's7.jsonl');
    fs.writeFileSync(keeperFile, F('u1', w.P) + F('u2', w.P) + F('u3', w.P));
    fs.writeFileSync(subset1, F('u1', w.P));
    fs.writeFileSync(subset2, F('u2', w.P));
    age(keeperFile); age(subset1); age(subset2);
    const out = await repairRecordsAndSpace(w.opts);
    const target = path.join(w.lane, w.bucket, 's7.jsonl');
    expect(fs.existsSync(target)).toBe(true);
    expect(uuidSet(target).size).toBe(3);
    expect(fs.existsSync(subset1)).toBe(false);
    expect(fs.existsSync(subset2)).toBe(false);
    expect(fs.existsSync(keeperFile)).toBe(false);
    expect(out.find(f => f.sessionId === 's7')?.kind).toBe('moved');
    expect((await w.store.get('claude', 's7'))?.projectName).toBe(w.bucket);
  });

  it('two space copies with disjoint uuid sets are an unmerged fork: nothing moves, both snapshotted, no record upsert', async () => {
    const w = makeWorld();
    fs.mkdirSync(path.join(w.lane, 'A'), { recursive: true });
    fs.mkdirSync(path.join(w.lane, 'B'), { recursive: true });
    const a = path.join(w.lane, 'A', 's8.jsonl');
    const b = path.join(w.lane, 'B', 's8.jsonl');
    fs.writeFileSync(a, F('u1', w.P) + F('uA', w.P));
    fs.writeFileSync(b, F('u1', w.P) + F('uB', w.P));
    age(a); age(b);
    const before = [fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8')];
    const out = await repairRecordsAndSpace(w.opts);
    const found = out.find(f => f.sessionId === 's8');
    expect(found?.kind).toBe('fork-surfaced');
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);
    expect(fs.readFileSync(a, 'utf8')).toBe(before[0]);
    expect(fs.readFileSync(b, 'utf8')).toBe(before[1]);
    expect(await w.store.get('claude', 's8')).toBeNull();
  });

  it('two space copies with equal uuid counts but diverging content for a shared uuid: fork, not silently kept', async () => {
    const w = makeWorld();
    fs.mkdirSync(path.join(w.lane, 'A'), { recursive: true });
    fs.mkdirSync(path.join(w.lane, 'B'), { recursive: true });
    const a = path.join(w.lane, 'A', 's9.jsonl');
    const b = path.join(w.lane, 'B', 's9.jsonl');
    fs.writeFileSync(a, JSON.stringify({ type: 'user', uuid: 'u1', cwd: w.P, message: { content: 'truncat' } }) + '\n');
    fs.writeFileSync(b, JSON.stringify({ type: 'user', uuid: 'u1', cwd: w.P, message: { content: 'truncated properly' } }) + '\n');
    age(a); age(b);
    const before = [fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8')];
    const out = await repairRecordsAndSpace(w.opts);
    const found = out.find(f => f.sessionId === 's9');
    expect(found?.kind).toBe('fork-surfaced');
    expect(fs.readFileSync(a, 'utf8')).toBe(before[0]);
    expect(fs.readFileSync(b, 'utf8')).toBe(before[1]);
    expect(await w.store.get('claude', 's9')).toBeNull();
  });

  it('never retires the actual $HOME bucket, even if a move empties it (structural protection, not incidental)', async () => {
    const w = makeWorld();
    const homeBucket = path.basename(w.home);
    fs.mkdirSync(path.join(w.lane, homeBucket), { recursive: true });
    const f = path.join(w.lane, homeBucket, 's6.jsonl');
    fs.writeFileSync(f, F('u1', w.P)); age(f);   // mis-filed under the $HOME bucket, but R2-owned by P
    await repairRecordsAndSpace(w.opts);
    expect(fs.existsSync(path.join(w.lane, w.bucket, 's6.jsonl'))).toBe(true); // moved to the correct bucket
    expect(fs.existsSync(path.join(w.lane, homeBucket))).toBe(true);          // $HOME bucket itself survives, empty
  });

  // --- Final review: scope §6.2 to R2-owned sessions; converge to zero findings ---

  it('healthy session (record ok, single copy already at target bucket) is a zero-finding no-op, and STAYS zero on re-run (CRITICAL 1+2)', async () => {
    const w = makeWorld();
    const t = path.join(w.correctDir, 's10.jsonl');
    fs.writeFileSync(t, F('u1', w.P)); age(t);
    fs.mkdirSync(path.join(w.lane, w.bucket), { recursive: true });
    const spaceCopy = path.join(w.lane, w.bucket, 's10.jsonl');
    fs.writeFileSync(spaceCopy, F('u1', w.P)); age(spaceCopy);
    await w.store.upsert({ id: 's10', provider: 'claude', projectName: w.bucket,
      originalPath: w.P, transcriptRef: `claude/transcripts/${w.bucket}/s10.jsonl` });
    const recBefore = await w.store.get('claude', 's10');

    const out1 = await repairRecordsAndSpace(w.opts);
    expect(out1).toEqual([]); // ZERO findings — healthy session, nothing to do
    expect(await w.store.get('claude', 's10')).toEqual(recBefore); // record untouched

    const out2 = await repairRecordsAndSpace(w.opts); // second run — convergence
    expect(out2).toEqual([]);
  });

  it('record already correct + one stray space copy elsewhere: stray is quarantined, but NO RECORD-REPAIR log line and NO record-repaired finding (2026-08-15 real-data fix)', async () => {
    const w = makeWorld();
    const t = path.join(w.correctDir, 's12.jsonl');
    fs.writeFileSync(t, F('u1', w.P) + F('u2', w.P)); age(t);
    // Keeper copy already sitting at the correct target bucket:
    fs.mkdirSync(path.join(w.lane, w.bucket), { recursive: true });
    const keeperCopy = path.join(w.lane, w.bucket, 's12.jsonl');
    fs.writeFileSync(keeperCopy, F('u1', w.P) + F('u2', w.P)); age(keeperCopy);
    // A stray duplicate copy filed under the wrong bucket (subset of the keeper,
    // so it never contests keeper selection — it's just cleanup):
    fs.mkdirSync(path.join(w.lane, 'Stray'), { recursive: true });
    const stray = path.join(w.lane, 'Stray', 's12.jsonl');
    fs.writeFileSync(stray, F('u1', w.P)); age(stray);
    // Record already correct — nothing for the repair to change:
    await w.store.upsert({ id: 's12', provider: 'claude', projectName: w.bucket,
      originalPath: w.P, transcriptRef: `claude/transcripts/${w.bucket}/s12.jsonl` });
    const recBefore = await w.store.get('claude', 's12');

    const out = await repairRecordsAndSpace(w.opts);

    // Stray copy quarantined (existing behavior) — keeper stays put:
    expect(fs.existsSync(stray)).toBe(false);
    expect(fs.existsSync(keeperCopy)).toBe(true);
    // No RECORD-REPAIR line for this session:
    const decisions = fs.readFileSync(path.join(w.quarantine.dir, 'decisions.log'), 'utf8');
    expect(decisions).not.toContain(`RECORD-REPAIR s12`);
    // No record-repaired finding, and no 'moved' either (keeper never relocated):
    expect(out.find(f => f.sessionId === 's12' && f.kind === 'record-repaired')).toBeUndefined();
    expect(out.find(f => f.sessionId === 's12' && f.kind === 'moved')).toBeUndefined();
    // Record itself is untouched:
    expect(await w.store.get('claude', 's12')).toEqual(recBefore);
  });

  it('a transcript whose firstCwd is foreign, sitting in a known folder\'s correct CC dir, is never entered into the repair set (CRITICAL 1)', async () => {
    const w = makeWorld();
    const peerCwd = 'C:\\Users\\peer\\proj';
    const t = path.join(w.correctDir, 's11.jsonl');
    fs.writeFileSync(t, F('u1', peerCwd)); age(t); // materialized here, but ORIGINATES on a peer device
    await w.store.upsert({ id: 's11', provider: 'claude', projectName: 'peer-project',
      originalPath: peerCwd, transcriptRef: 'claude/transcripts/peer-project/s11.jsonl' });
    const recBefore = await w.store.get('claude', 's11');

    const out = await repairRecordsAndSpace({ ...w.opts, platform: 'linux' });
    expect(out).toEqual([]); // no findings for this session
    expect(await w.store.get('claude', 's11')).toEqual(recBefore); // originalPath (the peer's own path) untouched
  });

  // Review fix (Minor 1): when the upsert itself throws, the finding must say
  // the RECORD write failed, not the rename — the rename already succeeded
  // (or never needed to run). 'rename-failed' read backwards for this site.
  it('an upsert failure surfaces record-repair-failed (never rename-failed) — the rename already succeeded', async () => {
    const w = makeWorld();
    const t = path.join(w.correctDir, 's13.jsonl');
    fs.writeFileSync(t, F('u1', w.P)); age(t);
    // Seed a wrong record so recordChanged is true and the upsert is attempted.
    await w.store.upsert({ id: 's13', provider: 'claude', projectName: 'destin',
      originalPath: w.home, transcriptRef: 'claude/transcripts/destin/s13.jsonl' });
    const flakyStore = {
      ...w.store,
      upsert: async (partial: Parameters<typeof w.store.upsert>[0]) => {
        if (partial.id === 's13') throw new Error('lock timeout');
        return w.store.upsert(partial);
      },
    };
    const out = await repairRecordsAndSpace({ ...w.opts, store: flakyStore as typeof w.store });
    const found = out.find(f => f.sessionId === 's13');
    expect(found?.kind).toBe('record-repair-failed');
    // The old wrong record is still there — the upsert never landed.
    expect((await w.store.get('claude', 's13'))?.projectName).toBe('destin');
  });
});

describe('repairOrphanDirs (spec §6.3)', () => {
  const F = (uuid: string, cwd: string) => JSON.stringify({ type: 'user', uuid, cwd }) + '\n';
  const old = new Date(Date.now() - 60 * 60 * 1000);            // 1h ago — not live
  const age = (p: string) => fs.utimesSync(p, old, old);

  // Task 15 makeHome pattern, extended with the orphan-rule dir (nativeStoreSlug)
  // alongside the CC-rule correct dir — §6.3 only fires when BOTH exist.
  function makeHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r63-'));
    const P = path.join(home, 'My Proj, & Stuff');
    fs.mkdirSync(P, { recursive: true });
    const projectsDir = path.join(home, '.claude', 'projects');
    const correctDir = path.join(projectsDir, ccProjectSlug(P));
    const orphanDir = path.join(projectsDir, nativeStoreSlug(P));
    fs.mkdirSync(correctDir, { recursive: true });
    fs.mkdirSync(orphanDir, { recursive: true });
    const quarantine = new Quarantine(home);
    const opts = { projectsDir, homeDir: home, knownFolders: [P], quarantine };
    return { home, P, projectsDir, correctDir, orphanDir, quarantine, opts };
  }

  it('orphan-rule dir with NO matching correct-dir file: session is MOVED to the correct dir', () => {
    const h = makeHome();
    const f = path.join(h.orphanDir, 's1.jsonl');
    fs.writeFileSync(f, F('u1', h.P)); age(f);
    const out = repairOrphanDirs(h.opts);
    const dest = path.join(h.correctDir, 's1.jsonl');
    expect(out).toEqual([{ sessionId: 's1', homeFolder: h.P, kind: 'moved', paths: [dest] }]);
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('identical copy in the orphan-rule dir is quarantined; correct copy untouched', () => {
    const h = makeHome();
    const wrong = path.join(h.orphanDir, 's2.jsonl');
    const correct = path.join(h.correctDir, 's2.jsonl');
    fs.writeFileSync(wrong, F('u1', h.P)); fs.writeFileSync(correct, F('u1', h.P));
    age(wrong); age(correct);
    const out = repairOrphanDirs(h.opts);
    expect(out).toEqual([{ sessionId: 's2', homeFolder: h.P, kind: 'quarantined', paths: [wrong] }]);
    expect(fs.existsSync(wrong)).toBe(false);
    expect(fs.existsSync(correct)).toBe(true);
    expect(fs.existsSync(path.join(h.quarantine.dir, path.relative(h.home, wrong)))).toBe(true);
  });

  it('fork: NOTHING moves — both copies snapshotted, disk byte-identical', () => {
    const h = makeHome();
    const wrong = path.join(h.orphanDir, 's3.jsonl');
    const correct = path.join(h.correctDir, 's3.jsonl');
    fs.writeFileSync(wrong, F('u1', h.P) + F('uA', h.home));    // diverges one way
    fs.writeFileSync(correct, F('u1', h.P) + F('uB', h.P));     // …and the other
    age(wrong); age(correct);
    const before = [fs.readFileSync(wrong, 'utf8'), fs.readFileSync(correct, 'utf8')];
    const out = repairOrphanDirs(h.opts);
    expect(out).toEqual([{ sessionId: 's3', homeFolder: h.P, kind: 'fork-surfaced', paths: [wrong, correct] }]);
    expect(fs.readFileSync(wrong, 'utf8')).toBe(before[0]);
    expect(fs.readFileSync(correct, 'utf8')).toBe(before[1]);
    expect(fs.readFileSync(path.join(h.quarantine.dir, 'decisions.log'), 'utf8')).toContain('ATTENTION fork s3');
    // fork leaves both originals in place — the orphan dir is NOT emptied.
    expect(fs.existsSync(h.orphanDir)).toBe(true);
    expect(fs.existsSync(wrong)).toBe(true);
  });

  it('correct-dir copy is a strict subset of the orphan copy: quarantine it, promote the superset', () => {
    const h = makeHome();
    const wrong = path.join(h.orphanDir, 's4.jsonl');
    const correct = path.join(h.correctDir, 's4.jsonl');
    const supersetBytes = F('u1', h.P) + F('u2', h.P);
    const subsetBytes = F('u1', h.P);
    fs.writeFileSync(wrong, supersetBytes);
    fs.writeFileSync(correct, subsetBytes);
    age(wrong); age(correct);
    const out = repairOrphanDirs(h.opts);
    expect(out).toEqual([{ sessionId: 's4', homeFolder: h.P, kind: 'replaced-with-superset', paths: [correct] }]);
    expect(fs.existsSync(wrong)).toBe(false);
    expect(fs.readFileSync(correct, 'utf8')).toBe(supersetBytes);
    const quarantinedCorrect = path.join(h.quarantine.dir, path.relative(h.home, correct));
    expect(fs.readFileSync(quarantinedCorrect, 'utf8')).toBe(subsetBytes);
  });

  // Parity fix (disclosed adaptation): §6.1 gained a live-guard on the
  // correct-dir copy before its superset/fork branches (CRITICAL review fix —
  // quarantining/snapshotting a copy CC is actively appending to risks
  // stealing the inode out from under an open fd, or capturing a torn write).
  // §6.3's `correct` is the SAME CC-tracked file, so it needs the same guard.
  it('correct-dir copy is superset-eligible but currently live: pair is deferred, nothing moves', () => {
    const h = makeHome();
    const wrong = path.join(h.orphanDir, 's6.jsonl');
    const correct = path.join(h.correctDir, 's6.jsonl');
    const supersetBytes = F('u1', h.P) + F('u2', h.P);
    const subsetBytes = F('u1', h.P);
    fs.writeFileSync(wrong, supersetBytes); age(wrong);
    fs.writeFileSync(correct, subsetBytes);                    // fresh mtime = live; NOT aged
    const out = repairOrphanDirs(h.opts);
    expect(out).toEqual([{ sessionId: 's6', homeFolder: h.P, kind: 'deferred-live', paths: [wrong, correct] }]);
    expect(fs.existsSync(wrong)).toBe(true);
    expect(fs.readFileSync(wrong, 'utf8')).toBe(supersetBytes);
    expect(fs.existsSync(correct)).toBe(true);
    expect(fs.readFileSync(correct, 'utf8')).toBe(subsetBytes);
  });

  it('fork pair where the correct-dir copy is currently live: pair is deferred, nothing snapshotted', () => {
    const h = makeHome();
    const wrong = path.join(h.orphanDir, 's7.jsonl');
    const correct = path.join(h.correctDir, 's7.jsonl');
    fs.writeFileSync(wrong, F('u1', h.P) + F('uA', h.home)); age(wrong); // diverges one way
    fs.writeFileSync(correct, F('u1', h.P) + F('uB', h.P));              // …and the other; fresh mtime = live
    const out = repairOrphanDirs(h.opts);
    expect(out).toEqual([{ sessionId: 's7', homeFolder: h.P, kind: 'deferred-live', paths: [wrong, correct] }]);
    expect(fs.existsSync(h.quarantine.dir)).toBe(false); // nothing snapshotted yet
  });

  it('an orphan-rule dir emptied by repair is itself quarantined (never left as a dangling empty dir)', () => {
    const h = makeHome();
    const f = path.join(h.orphanDir, 's5.jsonl');
    fs.writeFileSync(f, F('u1', h.P)); age(f); // only file → quarantined case empties the dir
    const correct = path.join(h.correctDir, 's5.jsonl');
    fs.writeFileSync(correct, F('u1', h.P)); age(correct);
    repairOrphanDirs(h.opts);
    expect(fs.existsSync(h.orphanDir)).toBe(false);
    expect(fs.existsSync(path.join(h.quarantine.dir, path.relative(h.home, h.orphanDir)))).toBe(true);
    expect(fs.readFileSync(path.join(h.quarantine.dir, 'decisions.log'), 'utf8')).toContain('emptied orphan dir');
  });

  it('when nativeStoreSlug and ccProjectSlug agree for P, the folder is skipped entirely (no orphan possible)', () => {
    const h = makeHome();
    // A plain path with no special chars: both slug rules produce the same
    // dir name, so there is no separate orphan dir to even look at.
    const plain = path.join(h.home, 'PlainProj');
    fs.mkdirSync(plain, { recursive: true });
    const sameDir = path.join(h.projectsDir, ccProjectSlug(plain));
    fs.mkdirSync(sameDir, { recursive: true });
    fs.writeFileSync(path.join(sameDir, 'sX.jsonl'), F('u1', plain));
    const out = repairOrphanDirs({ ...h.opts, knownFolders: [plain] });
    expect(out).toEqual([]);
    expect(fs.existsSync(path.join(sameDir, 'sX.jsonl'))).toBe(true);
  });

  it('when only the orphan-rule dir exists (no correct dir) it is left alone — not an orphan pair', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r63b-'));
    const P = path.join(home, 'Only, Orphan');
    fs.mkdirSync(P, { recursive: true });
    const projectsDir = path.join(home, '.claude', 'projects');
    const orphanDir = path.join(projectsDir, nativeStoreSlug(P));
    fs.mkdirSync(orphanDir, { recursive: true });
    // NOTE: correctDir deliberately NOT created.
    const f = path.join(orphanDir, 's9.jsonl');
    fs.writeFileSync(f, F('u1', P));
    const quarantine = new Quarantine(home);
    const opts = { projectsDir, homeDir: home, knownFolders: [P], quarantine };
    const out = repairOrphanDirs(opts);
    expect(out).toEqual([]);
    expect(fs.existsSync(f)).toBe(true);
  });
});

describe('runSlugRepair — ordering, deferral, surfacing (spec §6.0/§6.5)', () => {
  const F = (uuid: string, cwd: string) => JSON.stringify({ type: 'user', uuid, cwd }) + '\n';
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const age = (p: string) => fs.utimesSync(p, old, old);

  it('runs 6.2 (space) BEFORE 6.3 (orphan retirement) — the bucket was fed FROM the orphan', async () => {
    // Arrange a world where the ONLY space copy sits in a truncation bucket
    // and equals the orphan's copy: if 6.3 ran first, the orphan (its origin)
    // would be gone before 6.2 relocated the space copy. Assert both outcomes
    // hold at the end AND that the orphan file is in quarantine, not deleted.
    const w = /* makeWorld() from the 6.2 block, plus: */ (() => {
      const base = makeWorld();
      const orphanDir = path.join(base.opts.projectsDir, nativeStoreSlug(base.P));
      fs.mkdirSync(orphanDir, { recursive: true });
      return { ...base, orphanDir };
    })();
    const content = F('u1', w.P);
    const correct = path.join(w.correctDir, 's6.jsonl');
    const orphanCopy = path.join(w.orphanDir, 's6.jsonl');
    fs.writeFileSync(correct, content + F('u2', w.P));       // correct is the superset
    fs.writeFileSync(orphanCopy, content);
    fs.mkdirSync(path.join(w.lane, 'Change'), { recursive: true });
    const spaceCopy = path.join(w.lane, 'Change', 's6.jsonl');
    fs.writeFileSync(spaceCopy, content);
    [correct, orphanCopy, spaceCopy].forEach(age);
    await runSlugRepair({ ...w.opts, stateFile: path.join(w.home, '.youcoded', 'state.json') });
    expect(fs.existsSync(path.join(w.lane, w.bucket, 's6.jsonl'))).toBe(true); // 6.2 relocated it
    expect(fs.existsSync(w.orphanDir)).toBe(false);                            // 6.3 then retired the orphan
    expect(fs.existsSync(orphanCopy)).toBe(false);
    expect(fs.existsSync(path.join(w.quarantine.dir, path.relative(w.home, orphanCopy)))).toBe(true);
  });

  it('bounded deferral: 3rd consecutive live deferral writes WARN + ATTENTION', async () => {
    const w = makeWorld();
    const homeSlugDir = path.join(w.opts.projectsDir, ccProjectSlug(w.home));
    fs.mkdirSync(homeSlugDir, { recursive: true });
    fs.writeFileSync(path.join(homeSlugDir, 'live1.jsonl'), F('u1', w.P)); // fresh mtime — live
    const stateFile = path.join(w.home, '.youcoded', 'state.json');
    await runSlugRepair({ ...w.opts, stateFile });
    await runSlugRepair({ ...w.opts, stateFile });
    await runSlugRepair({ ...w.opts, stateFile });
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.deferred['live1']).toBe(3);
    expect(fs.readFileSync(path.join(w.quarantine.dir, 'decisions.log'), 'utf8')).toContain('ATTENTION deferred live1');
  });

  // Review fix: the deferral contract is per-RUN ("3 runs in a row"), not
  // per-finding. A session live in BOTH the $HOME slug dir (6.1's scan) and
  // an orphan-dir pair (6.3's scan) in the SAME run must still only count as
  // ONE deferral for that run — otherwise it reaches MAX_DEFERRALS in fewer
  // real launches than the contract promises.
  it('a session live in BOTH the $HOME scan (6.1) and an orphan-dir pair (6.3) is deferred ONCE per run, not once per finding', async () => {
    const w = makeWorld();
    const homeSlugDir = path.join(w.opts.projectsDir, ccProjectSlug(w.home));
    fs.mkdirSync(homeSlugDir, { recursive: true });
    fs.writeFileSync(path.join(homeSlugDir, 'dup1.jsonl'), F('u1', w.P)); // fresh mtime — live (6.1 scan)

    const orphanDir = path.join(w.opts.projectsDir, nativeStoreSlug(w.P));
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'dup1.jsonl'), F('u1', w.P));   // fresh mtime — live (6.3 scan)

    const stateFile = path.join(w.home, '.youcoded', 'state.json');
    await runSlugRepair({ ...w.opts, stateFile });
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.deferred['dup1']).toBe(1);
  });

  it('a surfaced fork gets a store note when the record note is empty', async () => {
    const w = makeWorld();
    const homeSlugDir = path.join(w.opts.projectsDir, ccProjectSlug(w.home));
    fs.mkdirSync(homeSlugDir, { recursive: true });
    const wrong = path.join(homeSlugDir, 'sF.jsonl');
    const correct = path.join(w.correctDir, 'sF.jsonl');
    fs.writeFileSync(wrong, F('u1', w.P) + F('uA', w.home));
    fs.writeFileSync(correct, F('u1', w.P) + F('uB', w.P));
    age(wrong); age(correct);
    await w.store.upsert({ id: 'sF', provider: 'claude', projectName: w.bucket, originalPath: w.P, transcriptRef: `claude/transcripts/${w.bucket}/sF.jsonl` });
    await runSlugRepair({ ...w.opts, stateFile: path.join(w.home, '.youcoded', 'state.json') });
    expect((await w.store.get('claude', 'sF'))?.note).toContain('two diverged copies');
  });

  // Review fix (IMPORTANT 1): neither store write in the fork-surfacing path
  // may reject the whole run — a throw there must never cost the hold state
  // (writeState) that was already computed, or main.ts's
  // .finally(resumeSweeps) unpauses the mirror sweeps over an unrecorded
  // hold (the exact run-3 clobber this branch exists to prevent).
  describe('store-write failures never lose the fork hold (review fix, IMPORTANT 1)', () => {
    it('a rejecting setNote does not reject runSlugRepair, and the state file still lists the fork id', async () => {
      const w = makeWorld();
      const homeSlugDir = path.join(w.opts.projectsDir, ccProjectSlug(w.home));
      fs.mkdirSync(homeSlugDir, { recursive: true });
      const wrong = path.join(homeSlugDir, 'sG.jsonl');
      const correct = path.join(w.correctDir, 'sG.jsonl');
      fs.writeFileSync(wrong, F('u1', w.P) + F('uA', w.home));
      fs.writeFileSync(correct, F('u1', w.P) + F('uB', w.P));
      age(wrong); age(correct);
      // A store whose setNote always rejects (simulates a mutateRecord lock
      // timeout — conversation-store.ts:166) — every other method is the
      // real store's, so upsert/get behave normally.
      const flakyStore = {
        ...w.store,
        setNote: async () => { throw new Error('conversation-store: could not write claude/sG (lock timeout)'); },
      };
      const stateFile = path.join(w.home, '.youcoded', 'state.json');
      await expect(runSlugRepair({ ...w.opts, store: flakyStore as typeof w.store, stateFile })).resolves.toBeUndefined();
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state.surfacedForks).toEqual([{ id: 'sG', paths: [wrong, correct] }]);
    });

    it('a rejecting 6.2 upsert does not reject runSlugRepair — logs an ERROR and surfaces a record-repair-failed finding instead', async () => {
      const w = makeWorld();
      const t = path.join(w.correctDir, 'sH.jsonl');
      fs.writeFileSync(t, F('u1', w.P)); age(t);
      // Seed a record with the WRONG projectName/originalPath so recordChanged
      // is true and repairRecordsAndSpace attempts the upsert.
      await w.store.upsert({ id: 'sH', provider: 'claude', projectName: 'destin', originalPath: w.home, transcriptRef: 'claude/transcripts/destin/sH.jsonl' });
      const flakyStore = {
        ...w.store,
        upsert: async (partial: Parameters<typeof w.store.upsert>[0]) => {
          if (partial.id === 'sH') throw new Error('conversation-store: could not write claude/sH (lock timeout)');
          return w.store.upsert(partial);
        },
      };
      const stateFile = path.join(w.home, '.youcoded', 'state.json');
      await expect(runSlugRepair({ ...w.opts, store: flakyStore as typeof w.store, stateFile })).resolves.toBeUndefined();
      // The record was NOT repaired (the upsert never landed) — still wrong.
      const rec = await w.store.get('claude', 'sH');
      expect(rec?.projectName).toBe('destin');
      const log = fs.readFileSync(path.join(w.quarantine.dir, 'decisions.log'), 'utf8');
      expect(log).toContain('ERROR RECORD-REPAIR sH: upsert failed');
      // The run still completed and wrote state (no exception propagated).
      expect(fs.existsSync(stateFile)).toBe(true);
    });
  });

  // Review fix (Minor 2): a throw partway through a LATER stage must never
  // discard findings/holds an EARLIER stage already gathered — finalization
  // (state write + summary log) is what persists them, and it must still run.
  describe('stage isolation — a late-stage throw never drops an earlier stage\'s holds', () => {
    it('6.3 throwing still resolves the run, still persists a fork surfaced by 6.1, and still logs the summary', async () => {
      const w = makeWorld();
      const homeSlugDir = path.join(w.opts.projectsDir, ccProjectSlug(w.home));
      fs.mkdirSync(homeSlugDir, { recursive: true });
      // A true $HOME fork for 6.1 to surface and hold.
      const wrong = path.join(homeSlugDir, 'sI.jsonl');
      const correct = path.join(w.correctDir, 'sI.jsonl');
      fs.writeFileSync(wrong, F('u1', w.P) + F('uA', w.home));
      fs.writeFileSync(correct, F('u1', w.P) + F('uB', w.P));
      age(wrong); age(correct);
      const stateFile = path.join(w.home, '.youcoded', 'state.json');

      const infoSpy = vi.spyOn(logger, 'log');
      const boom = new Error('projectsDir became unreadable mid-scan');
      await expect(runSlugRepair({
        ...w.opts,
        stateFile,
        stages: { repairOrphanDirs: () => { throw boom; } },
      })).resolves.toBeUndefined();

      // 6.1's hold survived 6.3's throw — finalization still ran.
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state.surfacedForks).toEqual([{ id: 'sI', paths: [wrong, correct] }]);

      // The stage failure itself was logged (both to the app log and the
      // quarantine decisions log), and the run still completed its summary.
      expect(infoSpy).toHaveBeenCalledWith('ERROR', 'SlugRepair', 'stage failed',
        expect.objectContaining({ stage: '6.3 repairOrphanDirs', error: expect.stringContaining('projectsDir became unreadable') }));
      expect(infoSpy).toHaveBeenCalledWith('INFO', 'SlugRepair', 'repair pass complete', expect.anything());
      const decisions = fs.readFileSync(path.join(w.quarantine.dir, 'decisions.log'), 'utf8');
      expect(decisions).toContain('ERROR stage 6.3 repairOrphanDirs failed');

      infoSpy.mockRestore();
    });
  });

  // Fork hold (found on the real-data run, T18 run-3): a surfaced fork must
  // stay held across launches — see heldForkIds' WHY in slug-repair-state.ts.
  describe('fork hold', () => {
    it('a fork-surfaced run writes the session id into surfacedForks in the state file', async () => {
      const w = makeWorld();
      const homeSlugDir = path.join(w.opts.projectsDir, ccProjectSlug(w.home));
      fs.mkdirSync(homeSlugDir, { recursive: true });
      const wrong = path.join(homeSlugDir, 'fh1.jsonl');
      const correct = path.join(w.correctDir, 'fh1.jsonl');
      fs.writeFileSync(wrong, F('u1', w.P) + F('uA', w.home));
      fs.writeFileSync(correct, F('u1', w.P) + F('uB', w.P));
      age(wrong); age(correct);
      const stateFile = path.join(w.home, '.youcoded', 'state.json');
      await runSlugRepair({ ...w.opts, stateFile });
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      // Review fix (IMPORTANT 2): surfacedForks now records the fork's paths
      // alongside its id, so a later run can tell "user resolved it" (a
      // recorded path vanished) apart from "this run's scan just didn't
      // reach it" (silence).
      expect(state.surfacedForks).toEqual([{ id: 'fh1', paths: [wrong, correct] }]);
    });

    it('a second run on an already-held fork creates no new snapshot files, still surfaces fork-surfaced', async () => {
      const w = makeWorld();
      const homeSlugDir = path.join(w.opts.projectsDir, ccProjectSlug(w.home));
      fs.mkdirSync(homeSlugDir, { recursive: true });
      const wrong = path.join(homeSlugDir, 'fh2.jsonl');
      const correct = path.join(w.correctDir, 'fh2.jsonl');
      fs.writeFileSync(wrong, F('u1', w.P) + F('uA', w.home));
      fs.writeFileSync(correct, F('u1', w.P) + F('uB', w.P));
      age(wrong); age(correct);
      const stateFile = path.join(w.home, '.youcoded', 'state.json');
      const quarantineRoot = path.join(w.home, '.youcoded', 'repair-quarantine');

      // Each run gets its OWN quarantine (quarantine: undefined lets
      // runSlugRepair default to `new Quarantine(homeDir)`) so the second
      // run's directory can be inspected in isolation — a shared quarantine
      // would make "no new files" ambiguous with "no files added this call".
      await runSlugRepair({ ...w.opts, quarantine: undefined, stateFile }); // run 1 — fresh hold
      const dirsAfterFirst = fs.readdirSync(quarantineRoot);
      expect(dirsAfterFirst).toHaveLength(1);
      const firstDir = path.join(quarantineRoot, dirsAfterFirst[0]);
      expect(fs.existsSync(path.join(firstDir, path.relative(w.home, wrong)))).toBe(true);
      expect(fs.existsSync(path.join(firstDir, path.relative(w.home, correct)))).toBe(true);

      // Guarantee a distinct ISO-millisecond quarantine dir name for run 2.
      await new Promise((r) => setTimeout(r, 5));
      await runSlugRepair({ ...w.opts, quarantine: undefined, stateFile }); // run 2 — already held
      const dirsAfterSecond = fs.readdirSync(quarantineRoot).filter((d) => !dirsAfterFirst.includes(d));
      expect(dirsAfterSecond).toHaveLength(1);
      const secondDir = path.join(quarantineRoot, dirsAfterSecond[0]);

      const countFiles = (dir: string): number => fs.readdirSync(dir, { withFileTypes: true })
        .reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1), 0);
      expect(countFiles(secondDir)).toBe(1); // decisions.log only — no re-snapshotted files

      const log = fs.readFileSync(path.join(secondDir, 'decisions.log'), 'utf8');
      expect(log).toContain('SKIP-SNAPSHOT fork fh2: snapshots already held from a prior run');
      expect(log).toContain('ATTENTION fork fh2'); // still surfaced, not silently dropped

      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      // Still held after run 2 — proves the auto-release logic did NOT drop
      // it, which only happens if run 2 actually re-found it as a fork.
      expect(state.surfacedForks).toEqual([{ id: 'fh2', paths: [wrong, correct] }]);
    });

    it('a run where the fork is gone (one copy resolved away) drops the id from surfacedForks', async () => {
      const w = makeWorld();
      const homeSlugDir = path.join(w.opts.projectsDir, ccProjectSlug(w.home));
      fs.mkdirSync(homeSlugDir, { recursive: true });
      const wrong = path.join(homeSlugDir, 'fh3.jsonl');
      const correct = path.join(w.correctDir, 'fh3.jsonl');
      fs.writeFileSync(wrong, F('u1', w.P) + F('uA', w.home));
      fs.writeFileSync(correct, F('u1', w.P) + F('uB', w.P));
      age(wrong); age(correct);
      const stateFile = path.join(w.home, '.youcoded', 'state.json');

      await runSlugRepair({ ...w.opts, stateFile }); // run 1 — surfaces + holds
      let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state.surfacedForks).toEqual([{ id: 'fh3', paths: [wrong, correct] }]);

      fs.unlinkSync(wrong); // simulate the user resolving the fork themselves

      await runSlugRepair({ ...w.opts, stateFile }); // run 2 — no longer a fork on disk
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      // Released via the IMPORTANT 2 "recorded path no longer exists" check —
      // 6.1 finds nothing for fh3 this run (the wrong-side file is gone), so
      // there's no fresh finding at all; the release is driven purely by
      // `wrong` having vanished from disk, not by silence alone.
      expect(state.surfacedForks).toEqual([]);
    });

    it('a fork held from a prior run is NOT released when a run silently fails to reach it (both copies still on disk, no finding at all) — review fix, IMPORTANT 2', async () => {
      const w = makeWorld();
      const homeSlugDir = path.join(w.opts.projectsDir, ccProjectSlug(w.home));
      fs.mkdirSync(homeSlugDir, { recursive: true });
      const wrong = path.join(homeSlugDir, 'fh4.jsonl');
      const correct = path.join(w.correctDir, 'fh4.jsonl');
      fs.writeFileSync(wrong, F('u1', w.P) + F('uA', w.home));
      fs.writeFileSync(correct, F('u1', w.P) + F('uB', w.P));
      age(wrong); age(correct);
      const stateFile = path.join(w.home, '.youcoded', 'state.json');

      await runSlugRepair({ ...w.opts, stateFile }); // run 1 — surfaces + holds
      const state1 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state1.surfacedForks).toEqual([{ id: 'fh4', paths: [wrong, correct] }]);

      // Run 2: knownFolders no longer includes P (simulates the user un-saving
      // the folder, or readFolders() throwing transiently) — 6.1's scan can't
      // even reach fh4 (its P isn't in knownFolders), so this run produces NO
      // finding for fh4 at all. Both copies are still on disk untouched. An
      // UNRELATED folder Q stands in for P so knownFolders isn't empty (an
      // empty list short-circuits runSlugRepair entirely, which would make
      // this test pass trivially without exercising the release logic).
      const Q = path.join(w.home, 'Other Folder');
      fs.mkdirSync(Q, { recursive: true });
      await runSlugRepair({ ...w.opts, knownFolders: [Q], stateFile });
      const state2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state2.surfacedForks).toEqual([{ id: 'fh4', paths: [wrong, correct] }]);
      expect(fs.existsSync(wrong)).toBe(true);
      expect(fs.existsSync(correct)).toBe(true);
    });

    it('a fork held from a prior run IS released once the pair converges into a clean subset relation — review fix, IMPORTANT 2', async () => {
      const w = makeWorld();
      const homeSlugDir = path.join(w.opts.projectsDir, ccProjectSlug(w.home));
      fs.mkdirSync(homeSlugDir, { recursive: true });
      const wrong = path.join(homeSlugDir, 'fh5.jsonl');
      const correct = path.join(w.correctDir, 'fh5.jsonl');
      fs.writeFileSync(wrong, F('u1', w.P) + F('uA', w.home));
      fs.writeFileSync(correct, F('u1', w.P) + F('uB', w.P));
      age(wrong); age(correct);
      const stateFile = path.join(w.home, '.youcoded', 'state.json');

      await runSlugRepair({ ...w.opts, stateFile }); // run 1 — surfaces + holds
      const state1 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state1.surfacedForks).toEqual([{ id: 'fh5', paths: [wrong, correct] }]);

      // Simulate the user trimming the wrong-side copy so it's now a clean
      // uuid subset of the correct copy (no more diverging uA content) —
      // classifyPair now says 'wrong-is-subset' instead of 'fork'.
      fs.writeFileSync(wrong, F('u1', w.P));
      age(wrong);

      await runSlugRepair({ ...w.opts, stateFile }); // run 2 — converged, not a fork anymore
      const state2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      // Released via the IMPORTANT 2 "positive reclassification" check — this
      // run produced a 'quarantined' finding for fh5, not a 'fork-surfaced' one.
      expect(state2.surfacedForks).toEqual([]);
      expect(fs.existsSync(wrong)).toBe(false); // quarantined, not left on disk
    });
  });
});
