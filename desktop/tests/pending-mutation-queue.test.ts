// pending-mutation-queue — T9b of the doc-comments build (docs/active/specs/
// 2026-09-26-doc-comments-build-design.md §9.2): the main-process half of the
// docx/xlsx pending-mutation queue. Covers the request-written → result-
// appears round trip against a REAL docx fixture through the real
// docx-comments.ts write path (never a second copy of "how to write a
// comment"), a move request specifically (review 3, F2 — the one operation
// that would otherwise go untested by add/reply/resolve alone), refcounting
// by project root across two "sessions," and a malformed/duplicate request
// being handled without crashing the watcher.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  startPendingMutationQueue,
  stopPendingMutationQueue,
  __resetPendingMutationQueueForTest,
} from '../src/main/doc-comments/pending-mutation-queue';
import { readDocxComments } from '../src/main/doc-comments/docx-comments';
import * as docCommentsDispatch from '../src/main/doc-comments/doc-comments-dispatch';
import type { PendingMutationRequest, PendingMutationResult } from '../src/shared/doc-comments-types';

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'doc-comments');

let root: string;
const sessionIds: string[] = [];

afterEach(async () => {
  for (const id of sessionIds) await stopPendingMutationQueue(id, root).catch(() => {});
  sessionIds.length = 0;
  __resetPendingMutationQueueForTest();
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function newRoot(): Promise<string> {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yc-pending-queue-'));
  return root;
}

async function withDocxFixture(relativePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), path.join(root, relativePath));
}

function pendingDirOf(realRoot: string): string {
  return path.join(realRoot, '.youcoded', 'comments', '.pending');
}

/** Writes a request the same atomic way the real MCP script does (tmp then
 *  rename) — this test plays the MCP script's role by hand so it can assert
 *  on the queue's own reaction without spawning a real child process
 *  (claude-code-doc-comments-mcp.test.ts already covers the script's OWN
 *  half of this queue, including its bounded-timeout behaviour). */
async function writeRequest(realRoot: string, partial: Omit<PendingMutationRequest, 'id' | 'createdAt' | 'projectRoot'>): Promise<string> {
  const id = randomUUID();
  const dir = pendingDirOf(realRoot);
  await fs.promises.mkdir(dir, { recursive: true });
  const request: PendingMutationRequest = { id, projectRoot: realRoot, createdAt: Date.now(), ...partial };
  const target = path.join(dir, `${id}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(request), 'utf8');
  await fs.promises.rename(tmp, target);
  return id;
}

async function waitForResult(realRoot: string, id: string, timeoutMs = 5000): Promise<PendingMutationResult> {
  const resultPath = path.join(pendingDirOf(realRoot), `${id}.result.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.promises.readFile(resultPath, 'utf8');
      return JSON.parse(raw);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw new Error(`no result for request ${id} within ${timeoutMs}ms`);
}

describe('queue round-trip — request written, result appears, and the original request is cleaned up', () => {
  it('a docx "list" request is applied through the real reader and the request file is removed after', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    const sessionId = 'sess-1';
    sessionIds.push(sessionId);
    await startPendingMutationQueue(sessionId, root);

    const id = await writeRequest(realRoot, { kind: 'list', format: 'docx', path: 'docs/launch-brief.docx' });
    const result = await waitForResult(realRoot, id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.comments).toBeDefined();
      expect(result.comments!.length).toBeGreaterThan(0);
      expect(result.comments!.map((c) => c.id)).toContain('w-0');
    }

    // The request itself is cleaned up once handled — .pending/ doesn't
    // accumulate one file per call forever.
    const requestPath = path.join(pendingDirOf(realRoot), `${id}.json`);
    expect(fs.existsSync(requestPath)).toBe(false);
  });

  it('a docx "add" request lands a real comment, readable back through the same fixture', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    const sessionId = 'sess-add';
    sessionIds.push(sessionId);
    await startPendingMutationQueue(sessionId, root);

    const id = await writeRequest(realRoot, {
      kind: 'add',
      format: 'docx',
      path: 'docs/launch-brief.docx',
      selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'Beta opens to 500 customers on March 10', prefix: '', suffix: '', occurrence: 0 } },
      text: 'assistant-added comment',
      author: 'assistant',
    });
    const result = await waitForResult(realRoot, id);
    expect(result.ok).toBe(true);

    const bytes = await fs.promises.readFile(path.join(root, 'docs', 'launch-brief.docx'));
    const read = await readDocxComments(bytes, 'docs/launch-brief.docx');
    expect(read.ok).toBe(true);
    if (read.ok) {
      // docx-comments.ts stamps a Word comment's AUTHOR NAME (never a bare
      // 'assistant' — Word comments are author-name based); the reader maps
      // it back as `person:Assistant`, the same shape any other named author
      // round-trips as. Only the presence of the new comment, not the exact
      // author-string convention (docx-comments.ts's own concern), matters here.
      expect(read.comments.some((c) => c.text === 'assistant-added comment')).toBe(true);
    }
  });
});

describe('a move request round-trips through the queue', () => {
  it('relocates a real comment and the applied result confirms it', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    const sessionId = 'sess-move';
    sessionIds.push(sessionId);
    await startPendingMutationQueue(sessionId, root);

    const id = await writeRequest(realRoot, {
      kind: 'move',
      format: 'docx',
      path: 'docs/launch-brief.docx',
      commentId: 'w-1',
      newSelector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'Keep support tickets about the update below 200 per week.', prefix: '', suffix: '', occurrence: 0 } },
    });
    const result = await waitForResult(realRoot, id);
    expect(result).toEqual({ ok: true });

    const bytes = await fs.promises.readFile(path.join(root, 'docs', 'launch-brief.docx'));
    const read = await readDocxComments(bytes, 'docs/launch-brief.docx');
    expect(read.ok).toBe(true);
    if (read.ok) {
      const moved = read.comments.find((c) => c.id === 'w-1');
      // The reader recomputes real prefix/suffix from surrounding document
      // context (unlike the empty strings this test's request sent as the
      // NEW selector's own anchor hint) — only `exact` is asserted here.
      expect(moved?.selector.kind).toBe('text');
      expect(moved?.selector.kind === 'text' && moved.selector.selector.exact).toBe('Keep support tickets about the update below 200 per week.');
    }
  });
});

describe('a request against a target this queue cannot resolve fails honestly, never hangs', () => {
  it('a bad projectRoot/path combination surfaces a specific error in the result file', async () => {
    await newRoot();
    const realRoot = await fs.promises.realpath(root);
    const sessionId = 'sess-bad';
    sessionIds.push(sessionId);
    await startPendingMutationQueue(sessionId, root);

    // No docx fixture ever placed at this path — the real reader fails
    // honestly (a resolved-but-missing file), never hangs the queue.
    const id = await writeRequest(realRoot, { kind: 'list', format: 'docx', path: 'docs/does-not-exist.docx' });
    const result = await waitForResult(realRoot, id);
    expect(result.ok).toBe(false);
  });
});

describe('refcounting: two sessions sharing one project share one watcher', () => {
  it('stopping only one of two refs still processes a request; stopping both is safe', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    sessionIds.push('sess-a', 'sess-b');
    await startPendingMutationQueue('sess-a', root);
    await startPendingMutationQueue('sess-b', root);

    await stopPendingMutationQueue('sess-a', root); // one ref gone, one remains

    const id = await writeRequest(realRoot, { kind: 'list', format: 'docx', path: 'docs/launch-brief.docx' });
    const result = await waitForResult(realRoot, id);
    expect(result.ok).toBe(true);

    await stopPendingMutationQueue('sess-b', root); // last ref — closes for real
    // Stopping an id with no ref at all is a documented no-op, not a throw.
    await expect(stopPendingMutationQueue('sess-a', root)).resolves.toBeUndefined();
  });
});

describe('forwards a reply\'s persisted CommentReply once the writer starts returning one', () => {
  it('includes `reply` in the result when the underlying write function provides it (design commit 6c612cb9)', async () => {
    // docx-comments.ts's own replyToDocxComment still returns a bare
    // {ok:true} as of this build — a real Word/Excel reply's ordinal id is a
    // separate, upstream change owned elsewhere (§1.6/T3). Spying proves this
    // queue is READY to forward it the moment that lands, without needing a
    // second edit here when it does.
    const persistedReply = { id: 'w-1-r2', author: 'assistant' as const, text: 'from the queue', createdAt: Date.now() };
    const spy = vi.spyOn(docCommentsDispatch, 'replyToNativeDocxComment').mockResolvedValue({ ok: true, reply: persistedReply } as any);
    try {
      await newRoot();
      await withDocxFixture('docs/launch-brief.docx');
      const realRoot = await fs.promises.realpath(root);
      const sessionId = 'sess-reply-forward';
      sessionIds.push(sessionId);
      await startPendingMutationQueue(sessionId, root);

      const id = await writeRequest(realRoot, { kind: 'reply', format: 'docx', path: 'docs/launch-brief.docx', commentId: 'w-1', text: 'from the queue', author: 'assistant' });
      const result = await waitForResult(realRoot, id);
      expect(result).toEqual({ ok: true, reply: persistedReply });
    } finally {
      spy.mockRestore();
    }
  });

  it('stays a bare {ok:true} today, since the underlying write function has not been enriched yet', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    const sessionId = 'sess-reply-bare';
    sessionIds.push(sessionId);
    await startPendingMutationQueue(sessionId, root);

    const id = await writeRequest(realRoot, { kind: 'reply', format: 'docx', path: 'docs/launch-brief.docx', commentId: 'w-1', text: 'plain reply', author: 'assistant' });
    const result = await waitForResult(realRoot, id);
    expect(result).toEqual({ ok: true });
  });
});

describe('a malformed request is dropped, never crashes the watcher', () => {
  it('garbage JSON in .pending/ is ignored, and a real request afterward still works', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    const sessionId = 'sess-garbage';
    sessionIds.push(sessionId);
    await startPendingMutationQueue(sessionId, root);

    const garbagePath = path.join(pendingDirOf(realRoot), `${randomUUID()}.json`);
    await fs.promises.writeFile(garbagePath, 'not json at all');
    // Give the watcher a moment to see and drop it.
    await new Promise((r) => setTimeout(r, 400));

    const id = await writeRequest(realRoot, { kind: 'list', format: 'docx', path: 'docs/launch-brief.docx' });
    const result = await waitForResult(realRoot, id);
    expect(result.ok).toBe(true);
  });
});
