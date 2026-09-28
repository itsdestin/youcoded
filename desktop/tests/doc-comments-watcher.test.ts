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
  let changesWithRoot: Array<{ path: string; projectRoot: string | undefined }>;
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
    changesWithRoot = [];
    initDocCommentsWatcher((sourcePath, projectRoot) => {
      changes.push(sourcePath);
      changesWithRoot.push({ path: sourcePath, projectRoot });
    });
  });
  afterEach(async () => {
    __resetDocCommentsWatcherForTest();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('reports a project-scoped change as the SOURCE file relative path', async () => {
    const target: CommentsWatchTarget = { kind: 'project', commentsDir, projectRoot: root };
    const res = await watchComments(target, 1);
    expect(res.ok).toBe(true);
    await untilLive(commentsDir, 'docs/plan.md.json');
    unwatchComments(target, 1);
  });

  // F3 (T5 implementation review): the renderer keys its own store by
  // (projectRoot, path) so two projects sharing a relative path never merge —
  // that only works if the push actually CARRIES the project root.
  it('carries the target\'s own project root on the push (F3, T5 review)', async () => {
    const target: CommentsWatchTarget = { kind: 'project', commentsDir, projectRoot: root };
    await watchComments(target, 1);
    await untilLive(commentsDir, 'rooted.md.json');
    await seen(() => expect(changesWithRoot.some((c) => c.path === 'rooted.md')).toBe(true));
    const entry = changesWithRoot.find((c) => c.path === 'rooted.md');
    expect(entry?.projectRoot).toBe(root);
    unwatchComments(target, 1);
  });

  it('coalesces a burst of writes to the SAME file into one push', async () => {
    const target: CommentsWatchTarget = { kind: 'project', commentsDir, projectRoot: root };
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
    const target: CommentsWatchTarget = { kind: 'project', commentsDir, projectRoot: root };
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
    const target: CommentsWatchTarget = { kind: 'project', commentsDir, projectRoot: root };
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
    const target: CommentsWatchTarget = { kind: 'project', commentsDir, projectRoot: root };
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
    const entry = changesWithRoot.find((c) => c.path === '/abs/path/to/loose-file.md');
    expect(entry?.projectRoot).toBeUndefined(); // F3: the fallback (loose-file) scheme has no project root
    unwatchComments(target, 1);
  });

  // T3 follow-up (design §1.5's new bullet, "A second, narrower watcher for a
  // .docx/.xlsx target's OWN file" — round 2 F1, corrected round 3 F1):
  // `resolveWatchTarget` produces a THIRD variant, `{kind:'document', ...}`,
  // for a native-format target — this watches the file's own bytes directly,
  // since there is no sidecar for it at all (§1.1). Every source that can
  // change those bytes (this app's own direct write, the pending-mutation
  // queue's applied write, and a raw external overwrite standing in for a
  // colleague's save in real Word/Excel) must settle into exactly ONE push,
  // and two simultaneous subscribers on the SAME document must refcount
  // exactly like the project/fallback cases above.
  describe('a document target (native-format .docx/.xlsx own-file watch)', () => {
    // `changes` records the target's own `sourcePath` (what a
    // `docComments:changed` push carries, §1.5) — NOT the absolute path
    // written to disk — so this polls for THAT, mirroring `untilLive`'s own
    // "keep rewriting until the watch proves itself live" discipline above.
    async function untilDocumentLive(file: string, sourcePath: string): Promise<void> {
      const landed = () => changes.includes(sourcePath);
      const deadline = Date.now() + PROBE_DEADLINE_MS;
      for (let attempt = 0; Date.now() < deadline; attempt++) {
        await fs.promises.writeFile(file, `attempt ${attempt}`);
        const rewriteAt = Date.now() + PROBE_REWRITE_MS;
        while (Date.now() < rewriteAt) {
          if (landed()) return;
          await wait(25);
        }
      }
      throw new Error(`no event from a document watch on ${file} within ${PROBE_DEADLINE_MS}ms`);
    }

    it('reports a change to the document\'s OWN bytes as its own sourcePath, carrying projectRoot', async () => {
      const docPath = path.join(root, 'report.docx');
      await fs.promises.writeFile(docPath, 'original bytes');
      const target: CommentsWatchTarget = {
        kind: 'document',
        absolutePath: docPath,
        sourcePath: 'report.docx',
        projectRoot: root,
      };
      const res = await watchComments(target, 1);
      expect(res.ok).toBe(true);
      await untilDocumentLive(docPath, 'report.docx');
      await seen(() => expect(changesWithRoot.some((c) => c.path === 'report.docx')).toBe(true));
      const entry = changesWithRoot.find((c) => c.path === 'report.docx');
      expect(entry?.projectRoot).toBe(root);
      unwatchComments(target, 1);
    });

    it('this app\'s own direct write settles into exactly ONE docComments:changed', async () => {
      const docPath = path.join(root, 'direct-write.xlsx');
      await fs.promises.writeFile(docPath, 'original bytes');
      const target: CommentsWatchTarget = {
        kind: 'document', absolutePath: docPath, sourcePath: 'direct-write.xlsx', projectRoot: root,
      };
      await watchComments(target, 1);
      await untilDocumentLive(docPath, 'direct-write.xlsx');
      changes = [];
      // Simulate this app's own write-pipeline.ts atomic write: write a temp
      // file, then rename it over the target (§9.2's own requirement that
      // T9b/T20 never bypass the atomic tmp-write-then-rename, since a raw
      // in-place write would let this watcher observe a transient state).
      const tmp = `${docPath}.tmp`;
      await fs.promises.writeFile(tmp, 'mutated bytes (direct write)');
      await fs.promises.rename(tmp, docPath);
      await seen(() => expect(changes).toContain('direct-write.xlsx'));
      await settle();
      expect(changes.filter((p) => p === 'direct-write.xlsx').length).toBe(1);
      unwatchComments(target, 1);
    });

    it('a pending-mutation-queue-style applied write (also atomic rename) settles into exactly ONE push', async () => {
      const docPath = path.join(root, 'queue-applied.docx');
      await fs.promises.writeFile(docPath, 'original bytes');
      const target: CommentsWatchTarget = {
        kind: 'document', absolutePath: docPath, sourcePath: 'queue-applied.docx', projectRoot: root,
      };
      await watchComments(target, 1);
      await untilDocumentLive(docPath, 'queue-applied.docx');
      changes = [];
      // The queue's applier (T9b/T20) runs through the SAME write-pipeline.ts
      // atomic backup-then-verify-then-rename sequence a direct write does —
      // modeled here as backup + atomic rename, same shape as above, standing
      // in for "whoever wrote the file" (§1.5's own "regardless of who wrote
      // the bytes").
      const backup = `${docPath}.bak`;
      await fs.promises.copyFile(docPath, backup);
      const tmp = `${docPath}.tmp`;
      await fs.promises.writeFile(tmp, 'mutated bytes (queue-applied)');
      await fs.promises.rename(tmp, docPath);
      await seen(() => expect(changes).toContain('queue-applied.docx'));
      await settle();
      expect(changes.filter((p) => p === 'queue-applied.docx').length).toBe(1);
      unwatchComments(target, 1);
    });

    it('a raw external overwrite (a colleague\'s save in real Word/Excel) settles into exactly ONE push', async () => {
      const docPath = path.join(root, 'external-save.docx');
      await fs.promises.writeFile(docPath, 'original bytes');
      const target: CommentsWatchTarget = {
        kind: 'document', absolutePath: docPath, sourcePath: 'external-save.docx', projectRoot: root,
      };
      await watchComments(target, 1);
      await untilDocumentLive(docPath, 'external-save.docx');
      changes = [];
      // A real external app is not obligated to write atomically at all —
      // this exercises a plain in-place overwrite, the case
      // `awaitWriteFinish`'s stability window exists to absorb.
      await fs.promises.writeFile(docPath, 'mutated bytes (external save)');
      await seen(() => expect(changes).toContain('external-save.docx'));
      await settle();
      expect(changes.filter((p) => p === 'external-save.docx').length).toBe(1);
      unwatchComments(target, 1);
    });

    it('refcounts two simultaneous watchers on the SAME document correctly', async () => {
      const docPath = path.join(root, 'shared.xlsx');
      await fs.promises.writeFile(docPath, 'original bytes');
      const target: CommentsWatchTarget = {
        kind: 'document', absolutePath: docPath, sourcePath: 'shared.xlsx', projectRoot: root,
      };
      await watchComments(target, 1);
      await watchComments(target, 2);
      unwatchComments(target, 1);
      // One subscriber left — the watcher must survive.
      await untilDocumentLive(docPath, 'shared.xlsx');
      changes = [];
      unwatchComments(target, 2);
      await wait(50);
      await fs.promises.writeFile(docPath, 'nobody watching anymore');
      await settle();
      expect(changes).toEqual([]);
    });
  });
});
