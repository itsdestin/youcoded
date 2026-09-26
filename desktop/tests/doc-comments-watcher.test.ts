// Pins T3 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §1.5 "Watching"/"Broadcast scope", §1.6): the chokidar
// relay behind docComments:watch/:unwatch —
// - a change under a project's .youcoded/comments/ directory is reported as
//   the SOURCE file's relative path, debounced (rule 4: coalesce, don't fan
//   out one push per fs event)
// - the MCP pending-mutation queue's .pending/ subdirectory never fires a
//   change (review 2, F20)
// - refcounting: the watcher survives one unsubscribe and closes after the last
// - the fallback (no project root) target watches a single file directly
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  watchComments,
  unwatchComments,
  initDocCommentsWatcher,
  dropDocCommentsSubscriber,
  __resetDocCommentsWatcherForTest,
} from '../src/main/doc-comments/doc-comments-watcher';
import type { CommentsWatchTarget } from '../src/main/doc-comments/doc-comments-store';

describe('doc-comments watcher', () => {
  let root: string;
  let commentsDir: string;
  let changes: string[];
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Rewrite spacing must exceed the 500ms awaitWriteFinish stability window
  // (same reasoning as project-watcher.test.ts's PROBE_REWRITE_MS), or a
  // rewrite restarts the pending write and it never stabilises.
  const PROBE_REWRITE_MS = 2500;
  const PROBE_DEADLINE_MS = 12_500;

  /** Resolve once a write under `dir` is actually reported for `name` — the
   *  watch is live. A write into the macOS startup gap is lost, so it is
   *  rewritten until one lands (project-watcher.test.ts's own precedent). */
  async function untilLive(dir: string, name: string): Promise<void> {
    const file = path.join(dir, name);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const landed = () => changes.includes(name.replace(/\.json$/, ''));
    const deadline = Date.now() + PROBE_DEADLINE_MS;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      await fs.promises.writeFile(file, JSON.stringify({ version: 1, comments: [], attempt }));
      const rewriteAt = Date.now() + PROBE_REWRITE_MS;
      while (Date.now() < rewriteAt) {
        if (landed()) return;
        await wait(25);
      }
    }
    throw new Error(`no event from a watch on ${dir} within ${PROBE_DEADLINE_MS}ms`);
  }

  const seen = (check: () => void) => vi.waitFor(check);
  const settle = () => wait(1200); // > the 500ms stability window + the 300ms debounce

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-comments-watch-'));
    commentsDir = path.join(root, '.youcoded', 'comments');
    await fs.promises.mkdir(commentsDir, { recursive: true });
    changes = [];
    initDocCommentsWatcher((sourcePath) => changes.push(sourcePath));
  });
  afterEach(async () => {
    __resetDocCommentsWatcherForTest();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('reports a project-scoped change as the SOURCE file relative path', async () => {
    const target: CommentsWatchTarget = { kind: 'project', commentsDir };
    const res = await watchComments(target, 1);
    expect(res.ok).toBe(true);
    await untilLive(commentsDir, 'docs/plan.md.json');
    unwatchComments(target, 1);
  });

  it('coalesces a burst of writes to the SAME file into one push', async () => {
    const target: CommentsWatchTarget = { kind: 'project', commentsDir };
    await watchComments(target, 1);
    await untilLive(commentsDir, 'burst.md.json');
    changes = [];
    const file = path.join(commentsDir, 'burst.md.json');
    // Several rapid rewrites inside the SAME debounce window must collapse to
    // one entry in `changes`, not one per write (rule 4).
    for (let i = 0; i < 4; i++) {
      await fs.promises.writeFile(file, JSON.stringify({ version: 1, comments: [], i }));
    }
    await seen(() => expect(changes).toContain('burst.md'));
    await settle();
    expect(changes.filter((p) => p === 'burst.md').length).toBe(1);
    unwatchComments(target, 1);
  });

  it('never fires a change for churn under .pending/ (review 2, F20)', async () => {
    const target: CommentsWatchTarget = { kind: 'project', commentsDir };
    await watchComments(target, 1);
    // Prove the watch is live via an ordinary file first — a negative
    // assertion before a positive signal would be indistinguishable from "not
    // watching yet" (project-watcher.test.ts's own untilLive discipline).
    await untilLive(commentsDir, 'live-check.md.json');
    changes = [];
    const pendingDir = path.join(commentsDir, '.pending');
    await fs.promises.mkdir(pendingDir, { recursive: true });
    const pendingFile = path.join(pendingDir, 'req-1.json');
    await fs.promises.writeFile(pendingFile, '{}');
    await wait(300);
    await fs.promises.rm(pendingFile, { force: true });
    await settle();
    expect(changes).toEqual([]);
    unwatchComments(target, 1);
  });

  it('refcounts: the watcher survives one unsubscribe and closes after the last', async () => {
    const target: CommentsWatchTarget = { kind: 'project', commentsDir };
    await watchComments(target, 1);
    await watchComments(target, 2);
    unwatchComments(target, 1);
    await untilLive(commentsDir, 'still-watched.md.json');
    changes = [];
    unwatchComments(target, 2);
    await wait(50);
    await fs.promises.writeFile(path.join(commentsDir, 'nobody-watching.md.json'), '{}');
    await settle();
    expect(changes).toEqual([]);
  });

  it('a crashed subscriber (dropDocCommentsSubscriber) releases its ref like an explicit unwatch', async () => {
    const target: CommentsWatchTarget = { kind: 'project', commentsDir };
    await watchComments(target, 1);
    dropDocCommentsSubscriber(1);
    await wait(50);
    await fs.promises.writeFile(path.join(commentsDir, 'after-drop.md.json'), '{}');
    await settle();
    expect(changes).toEqual([]);
  });

  it('a fallback target watches a single file and reports the caller-given source path', async () => {
    const sidecarPath = path.join(root, 'loose.json');
    const target: CommentsWatchTarget = { kind: 'fallback', sidecarPath, sourcePath: '/abs/path/to/loose-file.md' };
    const res = await watchComments(target, 1);
    expect(res.ok).toBe(true);
    const landed = () => changes.includes(target.kind === 'fallback' ? target.sourcePath : '');
    const deadline = Date.now() + PROBE_DEADLINE_MS;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      await fs.promises.writeFile(sidecarPath, JSON.stringify({ version: 1, comments: [], attempt }));
      const rewriteAt = Date.now() + PROBE_REWRITE_MS;
      let ok = false;
      while (Date.now() < rewriteAt) {
        if (landed()) { ok = true; break; }
        await wait(25);
      }
      if (ok) break;
    }
    expect(changes).toContain('/abs/path/to/loose-file.md');
    unwatchComments(target, 1);
  });
});
