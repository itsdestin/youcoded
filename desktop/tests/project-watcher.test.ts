// Pins the project-watcher invariants from the 2026-07-20 spec §8:
// - ignore predicate agrees with project-file-discovery (skip dirs, dot dirs,
//   *.tmp) so the watcher never emits events for files the UI will not list
// - events carry by:'external' and NEVER 'agent' (a watcher cannot know who wrote)
// - the app's own writes are suppressed (save→watch→reload loop, §8.4)
// - refcounting: last unsubscribe (or a dead renderer) PARKS the watcher, and
//   it closes only after the grace period — a resubscribe inside the grace must
//   reuse the same chokidar instance, never start a second walk
// - nested git repositories are not watched (they are separate projects, their
//   files are never listed here, and walking them is what made starts expensive)
// - tracked files resolve to their SIDECAR id, not their path — without this the
//   renderer's `evt.artifactId === artifact.id` filter never matches and the
//   conflict banner stays dead for exactly the files that matter
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isWatchIgnoredPath,
  WATCH_SKIP_DIRS,
  initProjectWatchers,
  watchProject,
  unwatchProject,
  dropSubscriber,
  noteOwnWrite,
  __resetProjectWatchersForTest,
  __setWatchGraceMsForTest,
  __watchersStartedForTest,
  type ExternalChangeEvent,
} from '../src/main/artifacts/project-watcher';

describe('isWatchIgnoredPath', () => {
  const root = '/proj';
  it('ignores files under skip dirs and dot dirs', () => {
    expect(isWatchIgnoredPath(root, '/proj/node_modules/x/index.js')).toBe(true);
    expect(isWatchIgnoredPath(root, '/proj/dist/main.js')).toBe(true);
    expect(isWatchIgnoredPath(root, '/proj/.git/hooks/pre-commit')).toBe(true);
    expect(isWatchIgnoredPath(root, '/proj/.youcoded/artifacts.json')).toBe(true);
    expect(isWatchIgnoredPath(root, '/proj/src/.cache/thing.txt')).toBe(true);
  });
  it('ignores the atomic-write .tmp siblings', () => {
    expect(isWatchIgnoredPath(root, '/proj/notes.md.tmp')).toBe(true);
    expect(isWatchIgnoredPath(root, '/proj/src/app.ts.tmp')).toBe(true);
  });
  it('keeps normal files, dotFILES, and the root itself visible', () => {
    expect(isWatchIgnoredPath(root, '/proj/src/app.ts')).toBe(false);
    expect(isWatchIgnoredPath(root, '/proj/.gitignore')).toBe(false);
    expect(isWatchIgnoredPath(root, '/proj/.env')).toBe(false);
    expect(isWatchIgnoredPath(root, '/proj')).toBe(false);
  });
  it('skip-dir set stays in lockstep with project-file-discovery', () => {
    // The discovery SKIP_DIRS is not exported (it is a walk-stop detail), so pin
    // the agreement textually: every entry there must be in WATCH_SKIP_DIRS and
    // vice versa. A mismatch means the watcher emits events for files the UI
    // never lists (or goes blind to listed ones).
    const src = fs.readFileSync(
      path.join(__dirname, '../src/main/artifacts/project-file-discovery.ts'), 'utf8'
    );
    const block = src.match(/const SKIP_DIRS = new Set\(\[([\s\S]*?)\]\)/);
    expect(block, 'SKIP_DIRS not found in project-file-discovery.ts').toBeTruthy();
    const discovered = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(new Set(discovered)).toEqual(WATCH_SKIP_DIRS);
  });
});

describe('project watcher lifecycle', () => {
  let root: string;
  let events: ExternalChangeEvent[];
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // awaitWriteFinish stability is 500ms — give events a wide margin.
  const settle = () => wait(1200);

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-watch-'));
    events = [];
    initProjectWatchers((evt) => events.push(evt));
    // The shipped grace is 60s — far too long to wait for a close. Every case
    // below either re-subscribes immediately (well inside any grace) or waits
    // this out, so shortening it changes nothing the tests are asserting.
    __setWatchGraceMsForTest(100);
  });
  afterEach(async () => {
    __resetProjectWatchersForTest();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('emits by:external with kind add/edit, and never agent', async () => {
    const res = await watchProject(root, 1);
    expect(res.ok).toBe(true);
    await fs.promises.writeFile(path.join(root, 'a.ts'), 'one');
    await settle();
    await fs.promises.writeFile(path.join(root, 'a.ts'), 'two');
    await settle();
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('add');
    expect(kinds).toContain('edit');
    for (const e of events) {
      expect(e.by).toBe('external');
      expect(e.artifactId).toBe('a.ts'); // discovered id IS the relative path
    }
  }, 15000);

  it('suppresses the app own-write echo', async () => {
    await watchProject(root, 1);
    const p = path.join(root, 'b.md');
    noteOwnWrite(p);
    await fs.promises.writeFile(p, 'saved by the app');
    await settle();
    expect(events).toEqual([]);
  }, 15000);

  it('resolves tracked files to their sidecar id', async () => {
    await fs.promises.mkdir(path.join(root, '.youcoded'), { recursive: true });
    await fs.promises.writeFile(
      path.join(root, '.youcoded/artifacts.json'),
      JSON.stringify({ artifacts: [{ id: 'art_123', kind: 'internal', path: 'tracked.md' }], manualIncludes: [] })
    );
    await watchProject(root, 1);
    await fs.promises.writeFile(path.join(root, 'tracked.md'), 'external change');
    await settle();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.artifactId).toBe('art_123');
  }, 15000);

  it('refcounts: watcher survives one unsubscribe, dies after the last + grace', async () => {
    await watchProject(root, 1);
    await watchProject(root, 2);
    unwatchProject(root, 1);
    await fs.promises.writeFile(path.join(root, 'c.txt'), 'still watched');
    await settle();
    expect(events.length).toBeGreaterThan(0);
    events = [];
    unwatchProject(root, 2);
    await wait(400); // grace (100ms here) then the async close
    await fs.promises.writeFile(path.join(root, 'd.txt'), 'nobody watching');
    await settle();
    expect(events).toEqual([]);
  }, 20000);

  it('re-subscribing inside the grace reuses the watcher instead of rebuilding it', async () => {
    // THE tab-thrash fix: Files → Conversations → Files unsubscribes and
    // resubscribes, and a rebuild would re-walk the whole project tree on the
    // main thread. Inverting parkEntry back to an immediate close makes the
    // count 4 and this test red.
    __setWatchGraceMsForTest(10_000);
    const before = __watchersStartedForTest();
    await watchProject(root, 1);
    for (let i = 0; i < 3; i++) {
      unwatchProject(root, 1);
      await watchProject(root, 1);
    }
    expect(__watchersStartedForTest() - before).toBe(1);
    // Still a LIVE watcher, not a parked husk.
    await fs.promises.writeFile(path.join(root, 'f.txt'), 'after the round trip');
    await settle();
    expect(events.length).toBeGreaterThan(0);
  }, 20000);

  it('dropSubscriber releases every ref a dead renderer held', async () => {
    await watchProject(root, 7);
    await watchProject(root, 7); // second host in the same renderer
    dropSubscriber(7);
    await wait(400); // grace (100ms here) then the async close
    await fs.promises.writeFile(path.join(root, 'e.txt'), 'renderer is gone');
    await settle();
    expect(events).toEqual([]);
  }, 15000);

  it('does not watch inside a NESTED git repo, but does watch its siblings', async () => {
    // youcoded-dev holds 43 worktrees and several clones: 9,583 directories
    // within the depth cap, 4 s to chokidar-ready with 300 ms+ event-loop
    // freezes. Discovery already stops at a nested .git, so those files are
    // never listed — watching them was pure cost.
    const nested = path.join(root, 'vendored');
    await fs.promises.mkdir(path.join(nested, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(nested, '.git'), 'gitdir: /elsewhere'); // worktree form
    const sibling = path.join(root, 'mine');
    await fs.promises.mkdir(sibling, { recursive: true });
    await watchProject(root, 1);
    await fs.promises.writeFile(path.join(nested, 'src/inside.ts'), 'nested repo');
    await fs.promises.writeFile(path.join(sibling, 'outside.ts'), 'my own tree');
    await settle();
    const ids = events.map((e) => e.artifactId);
    expect(ids).toContain('mine/outside.ts');
    expect(ids).not.toContain('vendored/src/inside.ts');
  }, 20000);
});
