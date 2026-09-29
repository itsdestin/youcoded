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

/** A stand-in for a session's own per-deployment secret (the real one is
 *  minted by `deployClaudeCodeDocCommentsMcp`) — fixed here so tests can
 *  deliberately supply a WRONG one to prove the queue refuses it (finding #1). */
const VALID_TOKEN = 'valid-token-0123456789abcdef0123456789ab';

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

async function withDocxFixture(relativePath: string, fixtureName = 'launch-brief.docx'): Promise<void> {
  await fs.promises.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await fs.promises.copyFile(path.join(FIXTURES_DIR, fixtureName), path.join(root, relativePath));
}

function pendingDirOf(realRoot: string): string {
  return path.join(realRoot, '.youcoded', 'comments', '.pending');
}

/** Starts the queue with `VALID_TOKEN` unless a test needs a different one —
 *  every test in this file that isn't specifically about token verification
 *  itself uses this so the token plumbing stays invisible to them. */
async function start(sessionId: string, projectRoot: string, token = VALID_TOKEN): Promise<void> {
  sessionIds.push(sessionId);
  await startPendingMutationQueue(sessionId, projectRoot, token);
}

/** Writes a request the same atomic way the real MCP script does (tmp then
 *  rename) — this test plays the MCP script's role by hand so it can assert
 *  on the queue's own reaction without spawning a real child process
 *  (claude-code-doc-comments-mcp.test.ts already covers the script's OWN
 *  half of this queue, including its bounded-timeout behaviour). Defaults
 *  `token` to `VALID_TOKEN` and `projectRoot` to the request's own realRoot
 *  (the HONEST value a real script would send) — both are overridable so a
 *  test can deliberately forge either one. */
async function writeRequest(
  realRoot: string,
  partial: Omit<PendingMutationRequest, 'id' | 'createdAt' | 'projectRoot' | 'token'> & { projectRoot?: string; token?: string }
): Promise<string> {
  const id = randomUUID();
  const dir = pendingDirOf(realRoot);
  await fs.promises.mkdir(dir, { recursive: true });
  const { projectRoot, token, ...rest } = partial;
  const request: PendingMutationRequest = {
    id,
    projectRoot: projectRoot ?? realRoot,
    token: token ?? VALID_TOKEN,
    createdAt: Date.now(),
    ...rest,
  };
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
    await start(sessionId, root);

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
    await start(sessionId, root);

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
  // Code review 2026-09-27, desktop F1: the queue's own 'move' branch used to
  // discard `moveNativeXlsxComment`'s returned fresh id (`result.ok ? {ok:
  // true} : ...` never read `result.id`), so the MCP script's MoveComment
  // handler — the only real consumer of this queue's move result — always
  // fell back to echoing the caller's OLD id, forcing a follow-up call to pay
  // for the full-workbook fallback scan the fresh-id fix exists to avoid.
  // This pins that the queue's result file now carries the new id for an
  // xlsx move (never for docx — see the existing test above, whose id
  // legitimately never changes).
  it('an xlsx move forwards the fresh id in the result (F1 fix)', async () => {
    await newRoot();
    await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'q3-sales-by-rep.xlsx'), path.join(root, 'reports', 'q3.xlsx'));
    const realRoot = await fs.promises.realpath(root);
    const sessionId = 'sess-move-xlsx';
    await start(sessionId, root);

    const addId = await writeRequest(realRoot, {
      kind: 'add',
      format: 'xlsx',
      path: 'reports/q3.xlsx',
      selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1', sheet: 'Q3' } },
      text: 'assistant note',
      author: 'assistant',
    });
    const addResult = await waitForResult(realRoot, addId);
    expect(addResult.ok).toBe(true);
    const oldId = addResult.ok ? addResult.id! : '';
    expect(oldId).toMatch(/^xt-/);

    const moveId = await writeRequest(realRoot, {
      kind: 'move',
      format: 'xlsx',
      path: 'reports/q3.xlsx',
      commentId: oldId,
      // D10: not one of this fixture's own genuine legacy Notes (xl/
      // comments1.xml's B2/B18/B19/B20 on this sheet) — see
      // doc-comments-tools.test.ts's matching note.
      newSelector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'D10', sheet: 'Q3' } },
    });
    const moveResult = await waitForResult(realRoot, moveId);
    expect(moveResult.ok).toBe(true);
    if (moveResult.ok) {
      // The whole point of the fix: a fresh id is present, and it differs
      // from the id the request named (the cell hint it embeds changed).
      expect(moveResult.id).toBeDefined();
      expect(moveResult.id).not.toBe(oldId);
    }
  });

  it('a docx move never carries an id in the result — a docx id does not change on move', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    const sessionId = 'sess-move';
    await start(sessionId, root);

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
    await start(sessionId, root);

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
    await start('sess-a', root);
    await start('sess-b', root);

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
    // Spied rather than depending on docx-comments.ts's own current state
    // (that upstream enrichment, §1.6/T3, is owned and being landed
    // elsewhere, concurrently with this task) — this proves the QUEUE'S OWN
    // forwarding is correct for the shape T3's own row specifies, regardless
    // of exactly when that upstream change merges.
    const persistedReply = { id: 'w-1-r2', author: 'assistant' as const, text: 'from the queue', createdAt: Date.now() };
    const spy = vi.spyOn(docCommentsDispatch, 'replyToNativeDocxComment').mockResolvedValue({ ok: true, reply: persistedReply } as any);
    try {
      await newRoot();
      await withDocxFixture('docs/launch-brief.docx');
      const realRoot = await fs.promises.realpath(root);
      const sessionId = 'sess-reply-forward';
      await start(sessionId, root);

      const id = await writeRequest(realRoot, { kind: 'reply', format: 'docx', path: 'docs/launch-brief.docx', commentId: 'w-1', text: 'from the queue', author: 'assistant' });
      const result = await waitForResult(realRoot, id);
      expect(result).toEqual({ ok: true, reply: persistedReply });
    } finally {
      spy.mockRestore();
    }
  });

  it('still returns a bare {ok:true} for a mock that omits `reply` — the field is genuinely optional, not assumed', async () => {
    // Same spy technique, deliberately WITHOUT a `reply` field this time —
    // proves the queue's forwarding is conditional on the field actually
    // being present, not a hard-coded pass-through that would crash or
    // fabricate one when it's absent.
    const spy = vi.spyOn(docCommentsDispatch, 'replyToNativeDocxComment').mockResolvedValue({ ok: true } as any);
    try {
      await newRoot();
      await withDocxFixture('docs/launch-brief.docx');
      const realRoot = await fs.promises.realpath(root);
      const sessionId = 'sess-reply-bare';
      await start(sessionId, root);

      const id = await writeRequest(realRoot, { kind: 'reply', format: 'docx', path: 'docs/launch-brief.docx', commentId: 'w-1', text: 'plain reply', author: 'assistant' });
      const result = await waitForResult(realRoot, id);
      expect(result).toEqual({ ok: true });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a malformed request is dropped, never crashes the watcher', () => {
  it('garbage JSON in .pending/ is ignored, and a real request afterward still works', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    const sessionId = 'sess-garbage';
    await start(sessionId, root);

    const garbagePath = path.join(pendingDirOf(realRoot), `${randomUUID()}.json`);
    await fs.promises.writeFile(garbagePath, 'not json at all');
    // Give the watcher a moment to see and drop it.
    await new Promise((r) => setTimeout(r, 400));

    const id = await writeRequest(realRoot, { kind: 'list', format: 'docx', path: 'docs/launch-brief.docx' });
    const result = await waitForResult(realRoot, id);
    expect(result.ok).toBe(true);
  });
});

describe('the applier never trusts a request\'s own projectRoot field (finding #1, CRITICAL)', () => {
  it('a forged projectRoot pointing at a DECOY project with a different same-path file is ignored — the watcher\'s own verified root wins', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx'); // the REAL project: has comments w-0, w-1, ...
    const realRoot = await fs.promises.realpath(root);
    await start('sess-forged-root', root);

    // A decoy project, same relative path, a DIFFERENT fixture with ZERO
    // comments — if the applier ever used the request's own `projectRoot`
    // instead of the watcher's, this is exactly what it would read instead.
    const decoyRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yc-pending-queue-decoy-'));
    try {
      await fs.promises.mkdir(path.join(decoyRoot, 'docs'), { recursive: true });
      await fs.promises.copyFile(path.join(FIXTURES_DIR, 'no-comments.docx'), path.join(decoyRoot, 'docs', 'launch-brief.docx'));
      const decoyRealRoot = await fs.promises.realpath(decoyRoot);

      const id = await writeRequest(realRoot, {
        kind: 'list',
        format: 'docx',
        path: 'docs/launch-brief.docx',
        projectRoot: decoyRealRoot, // FORGED — the honest value would be realRoot
      });
      const result = await waitForResult(realRoot, id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The REAL project's comments, not the decoy's empty file.
        expect(result.comments!.length).toBeGreaterThan(0);
        expect(result.comments!.map((c) => c.id)).toContain('w-0');
      }
    } finally {
      await fs.promises.rm(decoyRoot, { recursive: true, force: true });
    }
  });

  it('a forged projectRoot naming a directory that does not even exist is ALSO ignored — the real project is still used', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    await start('sess-forged-root-2', root);

    const id = await writeRequest(realRoot, {
      kind: 'list',
      format: 'docx',
      path: 'docs/launch-brief.docx',
      projectRoot: '/nonexistent-forged-root-path-xyz',
    });
    const result = await waitForResult(realRoot, id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.comments!.map((c) => c.id)).toContain('w-0');
  });
});

describe('every request must carry this session\'s own token (finding #1, CRITICAL)', () => {
  it('a request with the WRONG token is refused, never applied', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    await start('sess-wrong-token', root, VALID_TOKEN);

    const id = await writeRequest(realRoot, {
      kind: 'list',
      format: 'docx',
      path: 'docs/launch-brief.docx',
      token: 'a-completely-different-forged-token-00000000',
    });
    const result = await waitForResult(realRoot, id);
    expect(result).toEqual({ ok: false, error: 'invalid-request-token' });
  });

  it('a request with NO token field at all is refused', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    await start('sess-missing-token', root, VALID_TOKEN);

    // Bypasses writeRequest's own default so the field is truly absent, not
    // merely empty — simulates a request an attacker crafted with no idea
    // this field exists.
    const id = randomUUID();
    const dir = pendingDirOf(realRoot);
    const request = { id, kind: 'list', format: 'docx', path: 'docs/launch-brief.docx', projectRoot: realRoot, createdAt: Date.now() };
    const target = path.join(dir, `${id}.json`);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(request), 'utf8');
    await fs.promises.rename(tmp, target);

    const result = await waitForResult(realRoot, id);
    expect(result).toEqual({ ok: false, error: 'invalid-request-token' });
  });

  it('a request carrying a DIFFERENT session\'s valid token (sharing the same project) is still accepted', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    const tokenA = 'session-a-token-0123456789abcdef01234567';
    const tokenB = 'session-b-token-fedcba9876543210fedcba98';
    await start('sess-a-multi', root, tokenA);
    await start('sess-b-multi', root, tokenB);

    const id = await writeRequest(realRoot, { kind: 'list', format: 'docx', path: 'docs/launch-brief.docx', token: tokenB });
    const result = await waitForResult(realRoot, id);
    expect(result.ok).toBe(true);
  });
});

describe('an unrecognized `kind` gets a typed refusal, never silently runs as move (finding #3)', () => {
  it('a bogus kind never mutates anything and reports unknown-mutation-kind', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    await start('sess-unknown-kind', root);

    const id = await writeRequest(realRoot, {
      // @ts-expect-error deliberately not one of the five real kinds
      kind: 'delete-everything',
      format: 'docx',
      path: 'docs/launch-brief.docx',
      commentId: 'w-1',
    });
    const result = await waitForResult(realRoot, id);
    expect(result).toEqual({ ok: false, error: 'unknown-mutation-kind' });

    // Confirms it did NOT fall through to a move: w-1's selector is unchanged.
    const bytes = await fs.promises.readFile(path.join(root, 'docs', 'launch-brief.docx'));
    const read = await readDocxComments(bytes, 'docs/launch-brief.docx');
    expect(read.ok).toBe(true);
    if (read.ok) {
      const original = read.comments.find((c) => c.id === 'w-1');
      expect(original?.selector.kind === 'text' && original.selector.selector.exact).toBe('Beta opens to 500 customers on March 10');
    }
  });

  it('a request missing `kind` entirely gets the same honest refusal', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    await start('sess-missing-kind', root);

    const id = randomUUID();
    const dir = pendingDirOf(realRoot);
    await fs.promises.mkdir(dir, { recursive: true });
    const request = { id, format: 'docx', path: 'docs/launch-brief.docx', projectRoot: realRoot, token: VALID_TOKEN, createdAt: Date.now() };
    const target = path.join(dir, `${id}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(request), 'utf8');
    await fs.promises.rename(tmp, target);

    const result = await waitForResult(realRoot, id);
    expect(result).toEqual({ ok: false, error: 'unknown-mutation-kind' });
  });
});

describe('a file already sitting in the project before the watcher started never fires (finding #1, defense in depth)', () => {
  it('a pre-planted, back-dated request is never applied, even with a valid token', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    const dir = pendingDirOf(realRoot);
    await fs.promises.mkdir(dir, { recursive: true });

    // Plant the request BEFORE the watcher starts, then back-date it well
    // past the freshness margin — simulating a file that was already sitting
    // in a cloned/downloaded project, not one racing a genuine cold start.
    const id = randomUUID();
    const request: PendingMutationRequest = {
      id, kind: 'list', format: 'docx', path: 'docs/launch-brief.docx',
      projectRoot: realRoot, token: VALID_TOKEN, createdAt: Date.now(),
    };
    const target = path.join(dir, `${id}.json`);
    await fs.promises.writeFile(target, JSON.stringify(request), 'utf8');
    const oldTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    await fs.promises.utimes(target, oldTime, oldTime);

    await start('sess-preplanted', root);

    // No result should ever appear — give it a real but bounded wait, then
    // confirm both the request (untouched) and no result exist.
    await new Promise((r) => setTimeout(r, 1500));
    expect(fs.existsSync(target)).toBe(true); // never even picked up
    expect(fs.existsSync(path.join(dir, `${id}.result.json`))).toBe(false);
  });

  it('a request written just as the watcher starts (a genuine cold-start race) IS still processed', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    // Written with a completely fresh (current) mtime, matching what a real
    // MCP script racing session start would produce — no back-dating.
    const id = await writeRequest(realRoot, { kind: 'list', format: 'docx', path: 'docs/launch-brief.docx' });
    await start('sess-genuine-race', root);
    const result = await waitForResult(realRoot, id);
    expect(result.ok).toBe(true);
  });
});

describe('orphaned .result.json files are eventually swept (finding #4)', () => {
  it('a stale result file older than the sweep threshold is removed on the next watcher start', async () => {
    await newRoot();
    const realRoot = await fs.promises.realpath(root);
    const dir = pendingDirOf(realRoot);
    await fs.promises.mkdir(dir, { recursive: true });

    const staleResultPath = path.join(dir, `${randomUUID()}.result.json`);
    await fs.promises.writeFile(staleResultPath, JSON.stringify({ ok: true }));
    const veryOld = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    await fs.promises.utimes(staleResultPath, veryOld, veryOld);

    const freshResultPath = path.join(dir, `${randomUUID()}.result.json`);
    await fs.promises.writeFile(freshResultPath, JSON.stringify({ ok: true }));

    await start('sess-sweep', root);
    // The sweep is fire-and-forget on watcher start — give it a moment.
    await vi.waitFor(() => {
      expect(fs.existsSync(staleResultPath)).toBe(false);
    });
    expect(fs.existsSync(freshResultPath)).toBe(true); // untouched — not stale
  });

  it('a stale result file is also swept opportunistically after handling a real request', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    const dir = pendingDirOf(realRoot);
    await start('sess-sweep-2', root);
    await fs.promises.mkdir(dir, { recursive: true });

    const staleResultPath = path.join(dir, `${randomUUID()}.result.json`);
    await fs.promises.writeFile(staleResultPath, JSON.stringify({ ok: true }));
    const veryOld = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.promises.utimes(staleResultPath, veryOld, veryOld);

    const id = await writeRequest(realRoot, { kind: 'list', format: 'docx', path: 'docs/launch-brief.docx' });
    await waitForResult(realRoot, id);
    await vi.waitFor(() => {
      expect(fs.existsSync(staleResultPath)).toBe(false);
    });
  });

  // 2026-09-28 PR review: leftover requests (a session killed mid-wait) and
  // claims (the app killed mid-apply) used to pile up in the project folder
  // forever — only result files were ever swept.
  it('hour-old leftover requests and claims are swept too, fresh ones are left alone', async () => {
    await newRoot();
    const realRoot = await fs.promises.realpath(root);
    const dir = pendingDirOf(realRoot);
    await fs.promises.mkdir(dir, { recursive: true });
    const veryOld = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const staleRequest = path.join(dir, `${randomUUID()}.json`);
    const staleClaim = path.join(dir, `${randomUUID()}.claimed`);
    for (const f of [staleRequest, staleClaim]) {
      await fs.promises.writeFile(f, '{}');
      await fs.promises.utimes(f, veryOld, veryOld);
    }
    const freshClaim = path.join(dir, `${randomUUID()}.claimed`);
    await fs.promises.writeFile(freshClaim, '{}');

    await start('sess-sweep-3', root);
    await vi.waitFor(() => {
      expect(fs.existsSync(staleRequest)).toBe(false);
      expect(fs.existsSync(staleClaim)).toBe(false);
    });
    expect(fs.existsSync(freshClaim)).toBe(true);
  });
});

// 2026-09-28 PR review.
describe('a request is claimed before it is applied', () => {
  it('a handled request leaves neither the request nor its claim behind', async () => {
    await newRoot();
    await withDocxFixture('docs/launch-brief.docx');
    const realRoot = await fs.promises.realpath(root);
    await start('sess-claim', root);
    const id = await writeRequest(realRoot, { kind: 'list', format: 'docx', path: 'docs/launch-brief.docx' });
    await waitForResult(realRoot, id);
    const dir = pendingDirOf(realRoot);
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(dir, `${id}.json`))).toBe(false);
      expect(fs.existsSync(path.join(dir, `${id}.claimed`))).toBe(false);
    });
  });
});
