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
import fs, { type Stats } from 'fs';
import chokidar, { FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import os from 'os';
import path from 'path';
import {
  isWatchIgnoredPath,
  WATCH_SKIP_DIRS,
  initProjectWatchers,
  watchProject,
  stopProjectWatchers,
  unwatchProject,
  dropSubscriber,
  noteOwnWrite,
  watchDepthFor,
  __ownWritesHeld,
  __resetProjectWatchersForTest,
  __setWatchGraceMsForTest,
  __watchersStartedForTest,
  type ExternalChangeEvent,
} from '../src/main/artifacts/project-watcher';
import { readSource } from './helpers/guard-scope';
import { vi } from 'vitest';

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
    // WHY still a text read (Plan B, 2026-09-16): equality of two sets in two files,
    // one of them unexported, is a cross-file check no ast-grep rule can express.
    // readSource normalises CRLF so a Windows checkout reads the same entries.
    const src = readSource(path.join(__dirname, '../src/main/artifacts/project-file-discovery.ts'));
    const block = src.match(/const SKIP_DIRS = new Set\(\[([\s\S]*?)\]\)/);
    expect(block, 'SKIP_DIRS not found in project-file-discovery.ts').toBeTruthy();
    const discovered = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(new Set(discovered)).toEqual(WATCH_SKIP_DIRS);
  });
});

describe('project watcher metadata probes', () => {
  const root = path.join(os.tmpdir(), 'watch-metadata');
  const directory = { isDirectory: () => true } as Stats;
  const file = { isDirectory: () => false } as Stats;
  let ignored: (p: string, stats?: Stats) => boolean;
  let watcher: EventEmitter & { add: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  let releases: (() => void)[];

  beforeEach(() => {
    releases = [];
    const add = vi.fn().mockResolvedValue(undefined);
    watcher = Object.assign(new EventEmitter(), {
      add, close: vi.fn().mockResolvedValue(undefined),
      _nodeFsHandler: { _addToNodeFs: (dir: string) => add(dir) },
      _incrReadyCount: vi.fn(), _emitReady: vi.fn(), _readdirp: vi.fn(),
    });
    vi.spyOn(chokidar, 'watch').mockImplementation((_paths, options) => {
      ignored = options!.ignored as typeof ignored;
      queueMicrotask(() => watcher.emit('ready'));
      return watcher as unknown as FSWatcher;
    });
  });
  afterEach(async () => {
    stopProjectWatchers();
    for (const release of releases) release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.restoreAllMocks();
    __resetProjectWatchersForTest();
  });

  it('defers directory metadata without sync calls, while the event loop and raw file events stay free', async () => {
    const sync = vi.spyOn(fs, 'accessSync').mockImplementation(() => { throw new Error('must not block main'); });
    const access = vi.spyOn(fs.promises, 'access').mockImplementation(() => new Promise<void>((_resolve, reject) => {
      releases.push(() => reject(new Error('ENOENT')));
    }));
    await watchProject(root, 1);
    const dir = path.join(root, 'ordinary');
    expect(ignored(dir, directory)).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 100; i++) {
      expect(ignored(path.join(root, `file-${i}.txt`))).toBe(false);
      expect(ignored(path.join(root, `file-${i}.txt`), file)).toBe(false);
      expect(ignored(dir, directory)).toBe(true);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(access).toHaveBeenCalledTimes(1);
    expect(watcher.add).not.toHaveBeenCalled();
    releases.shift()!();
    await vi.waitFor(() => expect(watcher.add).toHaveBeenCalledWith(dir));
    expect(ignored(dir, directory)).toBe(false);
    expect(ignored(dir)).toBe(false);
  });

  it('bounds concurrent probes, deduplicates queued directories, and discards the queue on stop', async () => {
    vi.spyOn(fs, 'accessSync').mockImplementation(() => { throw new Error('must not block main'); });
    const access = vi.spyOn(fs.promises, 'access').mockImplementation(() => new Promise<void>((_resolve, reject) => {
      releases.push(() => reject(new Error('ENOENT')));
    }));
    await watchProject(root, 1);
    for (let repeat = 0; repeat < 3; repeat++) {
      for (let i = 0; i < 100; i++) ignored(path.join(root, `dir-${i}`), directory);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(access).toHaveBeenCalledTimes(2);
    releases.shift()!();
    await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(3));
    expect(watcher.add).toHaveBeenCalledTimes(1);
    stopProjectWatchers();
    for (const release of releases.splice(0)) release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(access).toHaveBeenCalledTimes(3);
    expect(watcher.add).toHaveBeenCalledTimes(1);
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it('shares two actual access slots across roots, parked watchers, and close/reopen', async () => {
    const filters: typeof ignored[] = [];
    vi.mocked(chokidar.watch).mockImplementation((_paths, options) => {
      filters.push(options!.ignored as typeof ignored);
      const fake = Object.assign(new EventEmitter(), {
        _nodeFsHandler: { _addToNodeFs: vi.fn().mockResolvedValue(undefined) },
        _incrReadyCount: vi.fn(), _emitReady: vi.fn(), _readdirp: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      });
      queueMicrotask(() => fake.emit('ready'));
      return fake as unknown as FSWatcher;
    });
    const access = vi.spyOn(fs.promises, 'access').mockImplementation(() => new Promise<void>((_resolve, reject) => {
      releases.push(() => reject(new Error('ENOENT')));
    }));
    __setWatchGraceMsForTest(60_000);
    for (let i = 0; i < 3; i++) {
      const r = path.join(root, `root-${i}`);
      await watchProject(r, 1);
      filters[i](path.join(r, 'child'), directory);
      unwatchProject(r, 1);
    }
    expect(access).toHaveBeenCalledTimes(2);
    stopProjectWatchers();
    await watchProject(root, 2);
    filters[3](path.join(root, 'reopened'), directory);
    expect(access).toHaveBeenCalledTimes(2); // closed in-flight I/O still owns its slots
    releases.shift()!();
    await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(3));
    expect(access.mock.calls[2][0]).toBe(path.join(root, 'reopened', '.git'));
    releases.shift()!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(access).toHaveBeenCalledTimes(3); // closed root-2's queued request was removed
  });

  it('retains fail-open live refresh after unknown metadata errors without repeated raw probes', async () => {
    const access = vi.spyOn(fs.promises, 'access').mockRejectedValue(Object.assign(new Error('provider unavailable'), { code: 'EIO' }));
    await watchProject(root, 1);
    const dir = path.join(root, 'cloud');
    expect(ignored(dir, directory)).toBe(true);
    await vi.waitFor(() => expect(watcher.add).toHaveBeenCalled());
    expect(ignored(dir)).toBe(false);
    expect(ignored(dir, directory)).toBe(false);
    expect(access).toHaveBeenCalledTimes(1);
  });

  it('waits for concurrent parent scans and synchronous cleanup before re-adding with a readiness reservation', async () => {
    const first = new PassThrough({ objectMode: true });
    const second = new PassThrough({ objectMode: true });
    const third = new PassThrough({ objectMode: true });
    // watchProject wraps this instance method before any real enumeration starts.
    const originalFactory = vi.mocked(chokidar.watch).getMockImplementation()!;
    vi.mocked(chokidar.watch).mockImplementation((paths, options) => {
      const fake = originalFactory(paths, options);
      vi.mocked(fake._readdirp).mockReturnValueOnce(first as unknown as ReturnType<FSWatcher['_readdirp']>).mockReturnValueOnce(second as unknown as ReturnType<FSWatcher['_readdirp']>).mockReturnValueOnce(third as unknown as ReturnType<FSWatcher['_readdirp']>);
      return fake;
    });
    const access = vi.spyOn(fs.promises, 'access').mockRejectedValue(new Error('ENOENT'));
    await watchProject(root, 1);
    const fake = watcher as unknown as FSWatcher;
    fake._readdirp(root);
    fake._readdirp(root);
    let cleaned = false;
    first.on('end', () => { fake._readdirp(root); }); // rescan starts during end cleanup
    second.on('end', () => { cleaned = true; });
    const dir = path.join(root, 'deferred');
    expect(ignored(dir, directory)).toBe(true);
    await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(watcher.add).not.toHaveBeenCalled();
    expect(ignored(dir, directory)).toBe(true); // pending through all parent scans
    first.resume(); first.end();
    second.resume(); second.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleaned).toBe(true);
    expect(watcher.add).not.toHaveBeenCalled(); // third scan is still active
    let cleanupObserved = false;
    watcher.add.mockImplementation(() => { cleanupObserved = cleaned; return Promise.resolve(); });
    third.resume(); third.end();
    await vi.waitFor(() => expect(watcher.add).toHaveBeenCalledWith(dir));
    expect(cleanupObserved).toBe(true);
    expect(fake._incrReadyCount).toHaveBeenCalledTimes(1);
    expect(ignored(dir, directory)).toBe(false);
  });

  it.each(['close', 'error', 'stop'] as const)('releases a waiting parent scan on %s without stranding or resurrecting it', async (terminal) => {
    const stream = new PassThrough({ objectMode: true });
    const originalFactory = vi.mocked(chokidar.watch).getMockImplementation()!;
    vi.mocked(chokidar.watch).mockImplementation((paths, options) => {
      const fake = originalFactory(paths, options);
      vi.mocked(fake._readdirp).mockReturnValue(stream as unknown as ReturnType<FSWatcher['_readdirp']>);
      return fake;
    });
    vi.spyOn(fs.promises, 'access').mockRejectedValue(new Error('ENOENT'));
    await watchProject(root, 1);
    const fake = watcher as unknown as FSWatcher;
    fake._readdirp(root);
    const dir = path.join(root, 'waiting');
    ignored(dir, directory);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(watcher.add).not.toHaveBeenCalled();
    if (terminal === 'stop') stopProjectWatchers();
    else if (terminal === 'error') stream.emit('error', new Error('provider stream failed'));
    else stream.emit('close');
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (terminal === 'stop') {
      stream.emit('close');
      expect(watcher.add).not.toHaveBeenCalled();
    } else expect(watcher.add).toHaveBeenCalledWith(dir);
    expect(stream.listenerCount('close')).toBe(0);
    expect(stream.listenerCount('error')).toBe(0);
    expect(stream.listenerCount('end')).toBe(0);
  });

  it('caches repository exclusions and enforces original-root depth on re-added directories', async () => {
    vi.spyOn(fs, 'accessSync').mockImplementation(() => { throw new Error('must not block main'); });
    const access = vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined);
    await watchProject(root, 1);
    const repo = path.join(root, 'repo');
    expect(ignored(repo, directory)).toBe(true);
    await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ignored(repo)).toBe(true);
    expect(ignored(repo, directory)).toBe(true);
    expect(watcher.add).not.toHaveBeenCalled();
    const tooDeep = path.join(root, ...Array.from({ length: 7 }, (_, i) => `d${i}`));
    expect(ignored(tooDeep, directory)).toBe(true);
    expect(ignored(path.join(tooDeep, 'file.txt'), file)).toBe(true);
    expect(access).toHaveBeenCalledTimes(1);
  });
});

describe('project watcher lifecycle', () => {
  let root: string;
  let events: ExternalChangeEvent[];
  let probes: ExternalChangeEvent[];
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Used ONLY before a negative assertion ("nothing arrived"), and only after a
  // positive signal has proved the watcher is delivering: awaitWriteFinish
  // stability is 500ms, so this is the window in which an unwanted event would
  // have shown up. Never used to wait FOR an event — see untilLive / seen.
  const settle = () => wait(1200);

  // WHY signals instead of fixed sleeps (2026-09-18): this block failed on macOS
  // CI only, a different case each run — `expected [] to include 'src/app.ts'`,
  // `expected 0 to be greater than 0`, `expected ['add'] to include 'edit'` —
  // while Linux and Windows passed. Two separate causes, both timing:
  //  1. On macOS a DIRECTORY watch is not live when chokidar says 'ready'. Node's
  //     fs.watch goes through libuv's FSEvents backend, whose uv__fsevents_init
  //     only SIGNALS a CoreFoundation thread and returns; that thread later
  //     destroys the process's one FSEventStream and recreates it with the new
  //     path list, starting at kFSEventStreamEventIdSinceNow (libuv
  //     src/unix/fsevents.c). A write that lands before the new stream exists is
  //     never reported — no wait, however long, sees it. inotify (Linux) and
  //     ReadDirectoryChangesW (Windows) are armed synchronously, hence mac-only.
  //  2. Every event passes chokidar's awaitWriteFinish (500ms stable + 100ms
  //     polls on stat), so the delay to emit is load-dependent, and 1200ms was a
  //     guess. When the 'add' of a.ts had not finished stabilising before the
  //     second write, chokidar folded that write into the pending add
  //     (`_pendingWrites` → lastChange) and no 'edit' ever came: `['add']`.
  // So each case first proves the watch is delivering (untilLive), then waits
  // for the event it is about (seen). Neither changes what is asserted.
  const PROBE = /(^|\/)watch-probe-\d+\.txt$/;
  const record = (evt: ExternalChangeEvent) =>
    (PROBE.test(evt.artifactId ?? '') ? probes : events).push(evt);
  let probeSeq = 0;
  // Rewrite spacing must exceed the 500ms stability window, or each rewrite
  // restarts the pending write and it never stabilises. Deadline stays under
  // the setup-waitfor 15s so a dead watch reports HERE, by name.
  const PROBE_REWRITE_MS = 2500;
  const PROBE_DEADLINE_MS = 12_500;

  /** Resolve once a write in `dir` is actually reported — the watch is live. A
   *  probe written into the macOS startup gap is lost, so it is rewritten until
   *  one lands. Probe events go to `probes`, never to `events`. */
  async function untilLive(dir: string): Promise<void> {
    const name = `watch-probe-${probeSeq++}.txt`;
    const file = path.join(dir, name);
    const landed = () => probes.some((e) => (e.artifactId ?? '').split('/').pop() === name);
    const deadline = Date.now() + PROBE_DEADLINE_MS;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      await fs.promises.writeFile(file, `probe attempt ${attempt}`);
      const rewriteAt = Date.now() + PROBE_REWRITE_MS;
      while (Date.now() < rewriteAt) {
        if (landed()) return;
        await wait(25);
      }
    }
    throw new Error(`no event from a watch on ${dir} within ${PROBE_DEADLINE_MS}ms`);
  }

  /** Wait for the recorded (non-probe) events to satisfy `check`. */
  const seen = (check: () => void) => vi.waitFor(check);

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-watch-'));
    events = [];
    probes = [];
    initProjectWatchers(record);
    // The shipped grace is 60s — far too long to wait for a close. Every case
    // below either re-subscribes immediately (well inside any grace) or waits
    // this out, so shortening it changes nothing the tests are asserting.
    __setWatchGraceMsForTest(100);
  });
  afterEach(async () => {
    __resetProjectWatchersForTest();
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('emits by:external with kind add/edit, and never agent', async () => {
    const res = await watchProject(root, 1);
    expect(res.ok).toBe(true);
    await untilLive(root);
    await fs.promises.writeFile(path.join(root, 'a.ts'), 'one');
    // The add must be OUT before the second write, or chokidar merges the two
    // into one pending 'add' (cause 2 above) and the edit is never emitted.
    await seen(() => expect(events.map((e) => e.kind)).toContain('add'));
    await fs.promises.writeFile(path.join(root, 'a.ts'), 'two');
    await seen(() => expect(events.map((e) => e.kind)).toContain('edit'));
    for (const e of events) {
      expect(e.by).toBe('external');
      expect(e.artifactId).toBe('a.ts'); // discovered id IS the relative path
    }
  });

  it('keeps root edits live while provider metadata is blocked, then watches the deferred directory', async () => {
    const dir = path.join(root, 'cloud-folder');
    await fs.promises.mkdir(dir);
    const access = fs.promises.access.bind(fs.promises);
    let release!: () => void;
    const blocked = new Promise<void>((_resolve, reject) => {
      release = () => reject(new Error('ENOENT'));
    });
    const probe = vi.spyOn(fs.promises, 'access').mockImplementation((p, mode) =>
      p === path.join(dir, '.git') ? blocked : access(p, mode));
    try {
      await watchProject(root, 1);
      await seen(() => expect(probe).toHaveBeenCalledWith(path.join(dir, '.git')));
      await untilLive(root);
      await fs.promises.writeFile(path.join(root, 'responsive.txt'), 'still live');
      await seen(() => expect(events.map((e) => e.artifactId)).toContain('responsive.txt'));
      release();
      await untilLive(dir);
      await fs.promises.writeFile(path.join(dir, 'ordinary.txt'), 'one');
      await seen(() => expect(events.some((e) => e.artifactId === 'cloud-folder/ordinary.txt' && e.kind === 'add')).toBe(true));
      await fs.promises.writeFile(path.join(dir, 'ordinary.txt'), 'two');
      await seen(() => expect(events.some((e) => e.artifactId === 'cloud-folder/ordinary.txt' && e.kind === 'edit')).toBe(true));
    } finally {
      release();
      probe.mockRestore();
    }
  });

  it('preserves root-relative depth after deferred directories are re-added', async () => {
    const atLimit = path.join(root, 'a', 'b', 'c', 'd', 'e', 'f');
    const beyond = path.join(atLimit, 'g');
    await fs.promises.mkdir(beyond, { recursive: true });
    await watchProject(root, 1);
    await untilLive(atLimit);
    await fs.promises.writeFile(path.join(beyond, 'hidden.txt'), 'beyond original depth');
    await fs.promises.writeFile(path.join(atLimit, 'visible.txt'), 'at original depth');
    await seen(() => expect(events.map((e) => e.artifactId)).toContain('a/b/c/d/e/f/visible.txt'));
    await settle(); // positive boundary signal first; settle for the excluded write
    expect(events.map((e) => e.artifactId)).not.toContain('a/b/c/d/e/f/g/hidden.txt');
  });

  it('reports files populated during a new directory probe without rewriting them', async () => {
    await watchProject(root, 1);
    await untilLive(root);
    const dir = path.join(root, 'populated');
    const access = fs.promises.access.bind(fs.promises);
    let release!: () => void;
    const blocked = new Promise<void>((_resolve, reject) => { release = () => reject(new Error('ENOENT')); });
    const probe = vi.spyOn(fs.promises, 'access').mockImplementation((p, mode) => p === path.join(dir, '.git') ? blocked : access(p, mode));
    try {
      await fs.promises.mkdir(dir);
      await seen(() => expect(probe).toHaveBeenCalledWith(path.join(dir, '.git')));
      await fs.promises.mkdir(path.join(dir, 'child'));
      await fs.promises.writeFile(path.join(dir, 'one.txt'), 'only write');
      await fs.promises.writeFile(path.join(dir, 'child', 'two.txt'), 'only write');
      await fs.promises.mkdir(path.join(dir, 'repo', '.git'), { recursive: true });
      await fs.promises.writeFile(path.join(dir, 'repo', 'excluded.txt'), 'nested repo');
      await fs.promises.writeFile(path.join(dir, 'excluded.tmp'), 'atomic temp');
      release();
      await seen(() => expect(events.some((e) => e.artifactId === 'populated/one.txt' && e.kind === 'add')).toBe(true));
      await seen(() => expect(events.some((e) => e.artifactId === 'populated/child/two.txt' && e.kind === 'add')).toBe(true));
      await settle(); // positive populated-file signals first, then excluded paths
      expect(events.map((e) => e.artifactId)).not.toContain('populated/repo/excluded.txt');
      expect(events.map((e) => e.artifactId)).not.toContain('populated/excluded.tmp');
    } finally { release(); probe.mockRestore(); }
  });

  it.each(['startup', 'live', 'stopped'] as const)('orders deferred directory adds after their parent snapshot (%s)', async (phase) => {
    const scanRoot = phase === 'live' ? path.join(root, 'populated-parent') : root;
    const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-snapshot-'));
    await fs.promises.mkdir(path.join(staging, 'early'));
    await fs.promises.mkdir(path.join(staging, 'late'));
    await fs.promises.writeFile(path.join(staging, 'late', 'startup.txt'), 'already existed');
    const early = path.join(scanRoot, 'early');
    const late = path.join(scanRoot, 'late');
    let releaseRoot!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRoot = resolve; });
    let probeSettled = false;
    let enumerationFinished = false;
    const access = fs.promises.access.bind(fs.promises);
    const probes = vi.spyOn(fs.promises, 'access').mockImplementation((p, mode) =>
      access(p, mode).finally(() => {
        if (path.resolve(String(p)) === path.resolve(early, '.git')) probeSettled = true;
      }));
    const readdirp = FSWatcher.prototype._readdirp;
    let heldRoot = false;
    // Faithful filtered snapshot: only delay END, never re-filter or invent data.
    // A fast metadata probe can finish while an OS directory stream remains open.
    const streams = vi.spyOn(FSWatcher.prototype, '_readdirp').mockImplementation(function (this: FSWatcher, dir, options) {
      const source = readdirp.call(this, dir, options);
      if (path.resolve(dir) !== path.resolve(scanRoot) || heldRoot || !source) return source;
      heldRoot = true;
      const held = new PassThrough({ objectMode: true });
      source.on('data', (entry) => held.write(entry));
      source.on('error', (error) => held.destroy(error));
      source.on('end', () => {
        enumerationFinished = true;
        void gate.then(() => held.end());
      });
      return held as unknown as ReturnType<typeof readdirp>;
    });
    const watch = chokidar.watch.bind(chokidar);
    let ready = false;
    let watcher!: FSWatcher;
    const removals: string[] = [];
    const factory = vi.spyOn(chokidar, 'watch').mockImplementation((paths, options) => {
      watcher = watch(paths, options);
      watcher.once('ready', () => { ready = true; });
      watcher.on('unlinkDir', (dir) => removals.push(path.resolve(dir)));
      return watcher;
    });
    let starting: Promise<unknown> | undefined;
    let startFinished = false;
    try {
      if (phase === 'live') {
        await watchProject(root, 1);
        await untilLive(root);
        await fs.promises.rename(staging, scanRoot);
      } else {
        await fs.promises.rename(path.join(staging, 'early'), early);
        await fs.promises.rename(path.join(staging, 'late'), late);
        starting = watchProject(root, 1).finally(() => { startFinished = true; });
      }
      await seen(() => { expect(enumerationFinished).toBe(true); expect(probeSettled).toBe(true); });
      await new Promise<void>((resolve) => setImmediate(resolve)); // drain probe continuations
      expect(Object.keys(watcher.getWatched()).map((dir) => path.resolve(dir))).not.toContain(path.resolve(early));
      expect(ready).toBe(phase === 'live');
      if (phase === 'stopped') {
        stopProjectWatchers();
        await seen(() => { expect(startFinished).toBe(true); expect(watcher.closed).toBe(true); });
        expect(await starting).toEqual({ ok: false });
        releaseRoot();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(Object.keys(watcher.getWatched())).toEqual([]);
        return;
      }
      releaseRoot();
      if (starting) { await seen(() => expect(startFinished).toBe(true)); await starting; }
      await untilLive(late);
      await settle(); // late directory is live; settle for unwanted startup adds
      // WHY: ignoreInitial suppresses discovery ADDs, not native CHANGE events.
      // macOS can deliver an edit during setup; suppressing it in production
      // would hide a real concurrent edit. The ready assertion above and this
      // add-only assertion pin the startup-discovery regression precisely.
      if (phase === 'startup') expect(events.filter((event) => event.kind === 'add')).toEqual([]);
      else await seen(() => expect(events.some((event) => event.kind === 'add' && event.artifactId === 'populated-parent/late/startup.txt')).toBe(true));
      expect(removals).not.toContain(path.resolve(early));
      expect(removals).not.toContain(path.resolve(late));
    } finally {
      releaseRoot();
      stopProjectWatchers();
      factory.mockRestore();
      streams.mockRestore();
      probes.mockRestore();
      await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('does not announce deferred startup files as new while later directories emit populated files', async () => {
    const initial = path.join(root, 'initial', 'child');
    await fs.promises.mkdir(initial, { recursive: true });
    await fs.promises.writeFile(path.join(initial, 'existing.txt'), 'initial bytes');
    await watchProject(root, 1);
    await untilLive(initial);
    await settle(); // live signal first; initial files must not appear as external adds
    expect(events.filter((event) => event.kind === 'add')).toEqual([]);
    const later = path.join(initial, 'later');
    await fs.promises.mkdir(later);
    await fs.promises.writeFile(path.join(later, 'new.txt'), 'single write');
    await seen(() => expect(events.some((e) => e.artifactId === 'initial/child/later/new.txt' && e.kind === 'add')).toBe(true));
  });

  it('live-refreshes edits inside directories created after startup', async () => {
    await watchProject(root, 1);
    await untilLive(root);
    const dir = path.join(root, 'new-folder');
    await fs.promises.mkdir(dir);
    await untilLive(dir);
    await fs.promises.writeFile(path.join(dir, 'new.txt'), 'one');
    await seen(() => expect(events.some((e) => e.artifactId === 'new-folder/new.txt' && e.kind === 'add')).toBe(true));
    await fs.promises.writeFile(path.join(dir, 'new.txt'), 'two');
    await seen(() => expect(events.some((e) => e.artifactId === 'new-folder/new.txt' && e.kind === 'edit')).toBe(true));
  });

  it('suppresses the app own-write echo', async () => {
    await watchProject(root, 1);
    // Live first, so "no event" below means suppressed, not "not watching yet".
    await untilLive(root);
    const p = path.join(root, 'b.md');
    noteOwnWrite(p);
    await fs.promises.writeFile(p, 'saved by the app');
    await settle();
    expect(events).toEqual([]);
  });

  it('resolves tracked files to their sidecar id', async () => {
    await fs.promises.mkdir(path.join(root, '.youcoded'), { recursive: true });
    await fs.promises.writeFile(
      path.join(root, '.youcoded/artifacts.json'),
      JSON.stringify({ artifacts: [{ id: 'art_123', kind: 'internal', path: 'tracked.md' }], manualIncludes: [] })
    );
    await watchProject(root, 1);
    await untilLive(root);
    await fs.promises.writeFile(path.join(root, 'tracked.md'), 'external change');
    await seen(() => expect(events.length).toBeGreaterThan(0));
    for (const e of events) expect(e.artifactId).toBe('art_123');
  });

  it('refcounts: watcher survives one unsubscribe, dies after the last + grace', async () => {
    await watchProject(root, 1);
    await watchProject(root, 2);
    unwatchProject(root, 1);
    await untilLive(root);
    await fs.promises.writeFile(path.join(root, 'c.txt'), 'still watched');
    await seen(() => expect(events.length).toBeGreaterThan(0));
    events = [];
    unwatchProject(root, 2);
    await wait(400); // grace (100ms here) then the async close
    await fs.promises.writeFile(path.join(root, 'd.txt'), 'nobody watching');
    await settle();
    expect(events).toEqual([]);
  });

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
    await untilLive(root);
    await fs.promises.writeFile(path.join(root, 'f.txt'), 'after the round trip');
    await seen(() => expect(events.length).toBeGreaterThan(0));
  });

  it('dropSubscriber releases every ref a dead renderer held', async () => {
    await watchProject(root, 7);
    await watchProject(root, 7); // second host in the same renderer
    dropSubscriber(7);
    await wait(400); // grace (100ms here) then the async close
    await fs.promises.writeFile(path.join(root, 'e.txt'), 'renderer is gone');
    await settle();
    expect(events).toEqual([]);
  });

  it('still watches a project root that is ITSELF a git repo', async () => {
    // The failure this guards is silent and total: the nested-repo rule applied
    // to the root would ignore the root, chokidar would watch nothing, and the
    // only symptom is that the file list quietly stops noticing outside edits.
    // Most real projects ARE repos, so this is the common case, not an edge one.
    // (A root the watcher ignores never delivers the probe either, so untilLive
    // fails by name in that case — the guard is intact.)
    await fs.promises.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.promises.mkdir(path.join(root, 'src'), { recursive: true });
    await watchProject(root, 1);
    await untilLive(path.join(root, 'src'));
    await fs.promises.writeFile(path.join(root, 'src/app.ts'), 'in my own repo');
    await seen(() => expect(events.map((e) => e.artifactId)).toContain('src/app.ts'));
  });

  it('parks at most MAX_GRACE_ENTRIES watchers, closing the oldest', async () => {
    // The bound on parked OS watch handles (inotify is capped per user), so a
    // click through a long project list cannot accumulate them.
    __setWatchGraceMsForTest(10_000);
    const roots: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-cap-'));
      roots.push(r);
      await watchProject(r, 1);
      unwatchProject(r, 1);   // straight into the grace
    }
    await wait(200);          // closes are async
    // The four most recent are still parked and still live — proven first, so
    // the silence asserted for the two oldest below is not "nothing is watching".
    await untilLive(roots[5]);
    events = [];
    // The two oldest are gone: a write there emits nothing.
    await fs.promises.writeFile(path.join(roots[0], 'a.txt'), 'evicted');
    await fs.promises.writeFile(path.join(roots[1], 'a.txt'), 'evicted');
    await settle();
    expect(events).toEqual([]);
    await fs.promises.writeFile(path.join(roots[5], 'b.txt'), 'still parked');
    await seen(() => expect(events.length).toBeGreaterThan(0));
    for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true });
  });

  it('leaving mid-walk and coming back does not abandon the walk in flight', async () => {
    // The worst version of the reported symptom: click away DURING the initial
    // scan and back again. The entry exists but has no watcher yet, and treating
    // "no watcher" as "nothing to keep" would throw the half-finished walk away
    // and start a second one — the restart this whole change removes. No timing
    // here: watchProject registers its entry synchronously, before it awaits.
    __setWatchGraceMsForTest(10_000);
    const before = __watchersStartedForTest();
    const first = watchProject(root, 1);   // deliberately NOT awaited
    unwatchProject(root, 1);               // refs -> 0 while the walk is running
    const second = watchProject(root, 1);
    await Promise.all([first, second]);
    expect(__watchersStartedForTest() - before).toBe(1);
    await untilLive(root);
    await fs.promises.writeFile(path.join(root, 'midwalk.txt'), 'still watched');
    await seen(() => expect(events.map((e) => e.artifactId)).toContain('midwalk.txt'));
  });

  it('does not watch inside a NESTED git repo, but does watch its siblings', async () => {
    // youcoded-dev holds 43 worktrees and several clones: 9,583 directories
    // within the depth cap, 4 s to chokidar-ready with 300 ms+ event-loop
    // freezes. Discovery already stops at a nested .git, so those files are
    // never listed — watching them was pure cost.
    const nested = path.join(root, 'vendored');
    await fs.promises.mkdir(path.join(nested, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(nested, '.git'), 'gitdir: /elsewhere'); // worktree form
    const clone = path.join(root, 'clone');
    await fs.promises.mkdir(path.join(clone, '.git'), { recursive: true });
    const sibling = path.join(root, 'mine');
    await fs.promises.mkdir(sibling, { recursive: true });
    await watchProject(root, 1);
    await untilLive(sibling);
    await fs.promises.writeFile(path.join(nested, 'src/inside.ts'), 'nested repo');
    await fs.promises.writeFile(path.join(clone, 'inside.ts'), 'nested clone');
    await fs.promises.writeFile(path.join(sibling, 'outside.ts'), 'my own tree');
    await seen(() => expect(events.map((e) => e.artifactId)).toContain('mine/outside.ts'));
    await settle(); // the nested write went first; give it its window to (wrongly) appear
    expect(events.map((e) => e.artifactId)).not.toContain('vendored/src/inside.ts');
    expect(events.map((e) => e.artifactId)).not.toContain('clone/inside.ts');
  });

  // 2026-09-16 C8: an event names the windows subscribed to its root, so the
  // sink sends it to those and not to every window in the app.
  it('hands the sink the subscriber ids of the changed root only', async () => {
    const delivered: number[][] = [];
    initProjectWatchers((evt, subscriberIds) => { record(evt); delivered.push(subscriberIds); });
    await watchProject(root, 7);
    await watchProject(root, 9);
    const other = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-watch-other-'));
    try {
      await watchProject(other, 11);
      await untilLive(root);
      await fs.promises.writeFile(path.join(root, 'a.txt'), 'hello');
      await seen(() => expect(events.map((e) => e.artifactId)).toContain('a.txt'));
      expect(delivered.length).toBeGreaterThan(0);
      for (const ids of delivered) expect([...ids].sort()).toEqual([7, 9]);
    } finally {
      await fs.promises.rm(other, { recursive: true, force: true });
    }
  });
});

// 2026-09-16 C8: own-write markers under no watcher used to stay forever.
describe('own-write markers expire', () => {
  afterEach(() => { vi.useRealTimers(); __resetProjectWatchersForTest(); });

  it('sweeps expired markers once the map grows past its threshold', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
    for (let i = 0; i < 600; i++) noteOwnWrite(`/nowhere/watched/file-${i}.txt`);
    expect(__ownWritesHeld()).toBe(600);
    vi.setSystemTime(new Date('2026-09-16T12:00:10Z')); // well past OWN_WRITE_TTL_MS
    noteOwnWrite('/nowhere/watched/one-more.txt');
    expect(__ownWritesHeld()).toBe(1);
  });
});

// 2026-09-16 C9: the seeded Home project is watched two levels deep, every
// other root at the discovery depth.
describe('watchDepthFor', () => {
  it('is shallow for the home folder itself and full depth for a project inside it', () => {
    const home = path.join(os.tmpdir(), 'ycd-home');
    expect(watchDepthFor(home, home)).toBe(2);
    expect(watchDepthFor(home + path.sep, home)).toBe(2);
    expect(watchDepthFor(path.join(home, 'proj'), home)).toBe(6);
    expect(watchDepthFor(path.join(os.tmpdir(), 'elsewhere'), home)).toBe(6);
  });
});
