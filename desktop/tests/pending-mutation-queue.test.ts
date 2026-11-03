// Main-process docx/xlsx pending-mutation queue: requests written by the MCP script are applied
// through the REAL docx/xlsx writers, results appear beside them, and hostile requests are refused.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { trackOutsideComments, judgeCommentAsk, takeCommentAnswer, setOutsideCommentsModeLookup, resetOutsideCommentsForTests } from '../src/main/cc-outside-comments';
import {
  startPendingMutationQueue,
  stopPendingMutationQueue,
  __resetPendingMutationQueueForTest,
} from '../src/main/doc-comments/pending-mutation-queue';
import { readDocxComments } from '../src/main/doc-comments/docx-comments';
import * as docCommentsDispatch from '../src/main/doc-comments/doc-comments-dispatch';
import type { PendingMutationRequest, PendingMutationResult } from '../src/shared/doc-comments-types';

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'doc-comments');


/** Per-session secret (the real one is minted by deployClaudeCodeDocCommentsMcp). */
const VALID_TOKEN = 'valid-token-0123456789abcdef0123456789ab';
const FORGED_TOKEN = 'a-completely-different-forged-token-00000000';
const DOCX = 'docs/launch-brief.docx';
const TEXT_SEL = (exact: string) => ({ kind: 'text' as const, selector: { type: 'TextQuoteSelector' as const, exact, prefix: '', suffix: '', occurrence: 0 } });
const OUTSIDE_SELECTOR = TEXT_SEL('Beta opens to 500 customers on March 10');
const NOT_APPROVED = { ok: false, error: 'outside-file-not-approved' };
const OLD = () => new Date(Date.now() - 2 * 60 * 60 * 1000);

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
async function withFixture(relativePath: string, fixtureName = 'launch-brief.docx'): Promise<void> {
  await fs.promises.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await fs.promises.copyFile(path.join(FIXTURES_DIR, fixtureName), path.join(root, relativePath));
}
const pendingDirOf = (realRoot: string) => path.join(realRoot, '.youcoded', 'comments', '.pending');

async function start(sessionId: string, projectRoot: string, token = VALID_TOKEN): Promise<void> {
  sessionIds.push(sessionId);
  await startPendingMutationQueue(sessionId, projectRoot, token);
}
/** New project root holding the docx fixture, queue started for `sessionId`; returns its realpath. */
async function project(sessionId: string, token = VALID_TOKEN): Promise<string> {
  await newRoot();
  await withFixture(DOCX);
  const realRoot = await fs.promises.realpath(root);
  await start(sessionId, root, token);
  return realRoot;
}

/** Writes a request file atomically (tmp then rename) like the real MCP script; `raw` is used verbatim. */
async function writeRaw(realRoot: string, request: Record<string, unknown>): Promise<string> {
  const id = request.id as string;
  const dir = pendingDirOf(realRoot);
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${id}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(request), 'utf8');
  await fs.promises.rename(tmp, target);
  return id;
}
/** Defaults: valid token, honest projectRoot; both overridable so a test can forge them. */
async function writeRequest(
  realRoot: string,
  partial: Omit<PendingMutationRequest, 'id' | 'createdAt' | 'projectRoot' | 'token'> & { projectRoot?: string; token?: string }
): Promise<string> {
  const { projectRoot, token, ...rest } = partial;
  return writeRaw(realRoot, { id: randomUUID(), projectRoot: projectRoot ?? realRoot, token: token ?? VALID_TOKEN, createdAt: Date.now(), ...rest });
}

async function waitForResult(realRoot: string, id: string, timeoutMs = 5000): Promise<PendingMutationResult> {
  const resultPath = path.join(pendingDirOf(realRoot), `${id}.result.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.promises.readFile(resultPath, 'utf8'));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw new Error(`no result for request ${id} within ${timeoutMs}ms`);
}
type Req = Parameters<typeof writeRequest>[1];
const run = async (realRoot: string, req: Req) => waitForResult(realRoot, await writeRequest(realRoot, req));
const listDocx = (realRoot: string, extra: Partial<Req> = {}) => run(realRoot, { kind: 'list', format: 'docx', path: DOCX, ...extra } as Req);
const commentIds = (r: PendingMutationResult) => (r.ok ? r.comments!.map((c) => c.id) : []);
const readBack = async (file = path.join(root, DOCX), rel = DOCX) => readDocxComments(await fs.promises.readFile(file), rel);
const exactOf = (c: any) => c?.selector.kind === 'text' && c.selector.selector.exact;

describe('queue round-trip', () => {
  it('a docx "list" request is applied through the real reader and the request file is removed after', async () => {
    const realRoot = await project('sess-1');
    const id = await writeRequest(realRoot, { kind: 'list', format: 'docx', path: DOCX });
    const result = await waitForResult(realRoot, id);
    expect(commentIds(result)).toContain('w-0');
    // .pending/ must not accumulate one file per call forever.
    expect(fs.existsSync(path.join(pendingDirOf(realRoot), `${id}.json`))).toBe(false);
  });

  it('a docx "add" request lands a real comment, readable back through the same fixture', async () => {
    const realRoot = await project('sess-add');
    const result = await run(realRoot, { kind: 'add', format: 'docx', path: DOCX, selector: OUTSIDE_SELECTOR, text: 'assistant-added comment', author: 'assistant' });
    expect(result.ok).toBe(true);
    const read = await readBack();
    expect(read.ok && read.comments.some((c) => c.text === 'assistant-added comment')).toBe(true);
  });
});

/** Plays the person answering the outside-file card in a Claude Code chat. */
const SERVER = 'youcoded-doc-comments-q1w2e3r4';
function answerOutsideCard(sessionId: string, file: string, how: 'yes' | 'chat' | 'no'): void {
  const manager = new EventEmitter();
  trackOutsideComments(manager);
  manager.emit('doc-comments-mcp-attached', sessionId, root, VALID_TOKEN, SERVER);
  const requestId = `ask-${randomUUID()}`;
  judgeCommentAsk({ sessionId, payload: { tool_name: `mcp__${SERVER}__AddComment`, tool_input: { path: file }, _requestId: requestId } });
  takeCommentAnswer(requestId, how === 'no'
    ? { decision: { behavior: 'deny' } }
    : { decision: { behavior: 'allow' }, ...(how === 'chat' ? { allowOutsideCommentsForSession: true } : {}) });
}

describe('a Word file outside the project, named by a request carrying this chat\'s token', () => {
  afterEach(() => resetOutsideCommentsForTests());

  /** Runs `body` with a started queue and a docx living outside the project; cleans the outside dir. */
  async function outside(sessionId: string, body: (c: { realRoot: string; outside: string; file: string }) => Promise<void>) {
    await newRoot();
    const realRoot = await fs.promises.realpath(root);
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yc-pending-queue-outside-'));
    const file = path.join(dir, 'brief.docx');
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), file);
    try {
      await start(sessionId, root);
      await body({ realRoot, outside: dir, file });
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }
  const listFile = (realRoot: string, file: string, extra: Partial<Req> = {}) => run(realRoot, { kind: 'list', format: 'docx', path: file, ...extra } as Req);

  it('after "Allow for this chat", is read and written in place; nothing is copied under the project', () =>
    outside('sess-outside', async ({ realRoot, file }) => {
      answerOutsideCard('sess-outside', file, 'chat');
      expect(commentIds(await listFile(realRoot, file))).toContain('w-0');
      const added = await run(realRoot, { kind: 'add', format: 'docx', path: file, author: 'assistant', text: 'outside via queue', selector: OUTSIDE_SELECTOR });
      expect(added.ok).toBe(true);
      const read = await readBack(file, file);
      expect(read.ok && read.comments.some((c) => c.text === 'outside via queue')).toBe(true);
      expect(fs.readdirSync(realRoot).filter((n) => n !== '.youcoded')).toEqual([]);
    }));

  it('carrying the right token but no answer from the person, is refused and the file is untouched', () =>
    outside('sess-outside-unasked', async ({ realRoot, file }) => {
      const before = await fs.promises.readFile(file);
      const r = await run(realRoot, { kind: 'add', format: 'docx', path: file, author: 'assistant', text: 'forged', selector: OUTSIDE_SELECTOR });
      expect(r).toEqual(NOT_APPROVED);
      expect((await fs.promises.readFile(file)).equals(before)).toBe(true);
    }));

  it('after "No", is refused', () =>
    outside('sess-outside-no', async ({ realRoot, file }) => {
      answerOutsideCard('sess-outside-no', file, 'no');
      expect(await listFile(realRoot, file)).toEqual(NOT_APPROVED);
    }));

  it('a "Yes" covers that one file, once', () =>
    outside('sess-outside-yes', async ({ realRoot, outside: dir, file }) => {
      const other = path.join(dir, 'other.docx');
      await fs.promises.copyFile(file, other);
      answerOutsideCard('sess-outside-yes', file, 'yes');
      expect(await listFile(realRoot, other)).toEqual(NOT_APPROVED);
      expect((await listFile(realRoot, file)).ok).toBe(true);
      expect(await listFile(realRoot, file)).toEqual(NOT_APPROVED);
    }));

  it('in a chat Claude Code runs without asking (auto mode), goes through with no card answer', () =>
    outside('sess-outside-auto', async ({ realRoot, outside: dir, file }) => {
      answerOutsideCard('sess-outside-auto', path.join(dir, 'unrelated.docx'), 'no');
      setOutsideCommentsModeLookup((sessionId) => (sessionId === 'sess-outside-auto' ? 'auto' : 'normal'));
      expect((await listFile(realRoot, file)).ok).toBe(true);
    }));

  it('is still refused without this chat\'s token', () =>
    outside('sess-outside-forged', async ({ realRoot, file }) => {
      answerOutsideCard('sess-outside-forged', file, 'chat');
      expect(await listFile(realRoot, file, { token: FORGED_TOKEN })).toEqual({ ok: false, error: 'invalid-request-token' });
    }));
});

describe('a move request round-trips through the queue', () => {
  // Bug guarded: the xlsx move branch dropped the fresh id, so MoveComment echoed the OLD id and forced a full-workbook scan.
  it('an xlsx move forwards the fresh id in the result', async () => {
    await newRoot();
    await withFixture('reports/q3.xlsx', 'q3-sales-by-rep.xlsx');
    const realRoot = await fs.promises.realpath(root);
    await start('sess-move-xlsx', root);

    const added = await run(realRoot, {
      kind: 'add', format: 'xlsx', path: 'reports/q3.xlsx',
      selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1', sheet: 'Q3' } },
      text: 'assistant note', author: 'assistant',
    });
    expect(added.ok).toBe(true);
    const oldId = added.ok ? added.id! : '';
    expect(oldId).toMatch(/^xt-/);

    // D10 is not one of this fixture's own legacy Notes on that sheet (B2/B18/B19/B20).
    const moved = await run(realRoot, {
      kind: 'move', format: 'xlsx', path: 'reports/q3.xlsx', commentId: oldId,
      newSelector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'D10', sheet: 'Q3' } },
    });
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(moved.id).toBeDefined();
      expect(moved.id).not.toBe(oldId);
    }
  });

  it('a docx move never carries an id in the result — a docx id does not change on move', async () => {
    const realRoot = await project('sess-move');
    const exact = 'Keep support tickets about the update below 200 per week.';
    const result = await run(realRoot, { kind: 'move', format: 'docx', path: DOCX, commentId: 'w-1', newSelector: TEXT_SEL(exact) });
    expect(result).toEqual({ ok: true });
    const read = await readBack();
    expect(read.ok && exactOf(read.comments.find((c) => c.id === 'w-1'))).toBe(exact);
  });
});

describe('request outcomes', () => {
  it('a missing target file surfaces a failed result instead of hanging', async () => {
    // No docs/ dir at all: the path resolver must walk up past TWO missing levels (realpathWithNonexistentTail).
    await newRoot();
    const realRoot = await fs.promises.realpath(root);
    await start('sess-bad', root);
    expect((await listDocx(realRoot, { path: 'docs/does-not-exist.docx' })).ok).toBe(false);
  });

  it('forwards a reply\'s persisted CommentReply once the writer returns one', async () => {
    const persistedReply = { id: 'w-1-r2', author: 'assistant' as const, text: 'from the queue', createdAt: Date.now() };
    const spy = vi.spyOn(docCommentsDispatch, 'replyToNativeDocxComment').mockResolvedValue({ ok: true, reply: persistedReply } as any);
    try {
      const realRoot = await project('sess-reply-forward');
      expect(await run(realRoot, { kind: 'reply', format: 'docx', path: DOCX, commentId: 'w-1', text: 'from the queue', author: 'assistant' })).toEqual({ ok: true, reply: persistedReply });
    } finally {
      spy.mockRestore();
    }
  });

  it('returns a bare {ok:true} when the writer omits `reply` — the field is optional, never fabricated', async () => {
    const spy = vi.spyOn(docCommentsDispatch, 'replyToNativeDocxComment').mockResolvedValue({ ok: true } as any);
    try {
      const realRoot = await project('sess-reply-bare');
      expect(await run(realRoot, { kind: 'reply', format: 'docx', path: DOCX, commentId: 'w-1', text: 'plain reply', author: 'assistant' })).toEqual({ ok: true });
    } finally {
      spy.mockRestore();
    }
  });

  // The file is open in Office and its editor is still opening: the assistant must hear "queued" so it neither retries nor reports success.
  it('a change kept for an Office editor that is not ready yet is reported as queued, not as done or failed', async () => {
    const spy = vi.spyOn(docCommentsDispatch, 'addNativeDocxComment').mockResolvedValue({ ok: true, queued: true });
    try {
      const realRoot = await project('sess-queued');
      expect(await run(realRoot, { kind: 'add', format: 'docx', path: DOCX, selector: TEXT_SEL('x'), text: 'later', author: 'assistant' })).toEqual({ ok: true, queued: true });
    } finally {
      spy.mockRestore();
    }
  });

  it('an unrecognized `kind` is refused with a typed error and never runs as move', async () => {
    const realRoot = await project('sess-unknown-kind');
    // @ts-expect-error deliberately not one of the real kinds
    const result = await run(realRoot, { kind: 'delete-everything', format: 'docx', path: DOCX, commentId: 'w-1' });
    expect(result).toEqual({ ok: false, error: 'unknown-mutation-kind' });
    const read = await readBack();
    expect(read.ok && exactOf(read.comments.find((c) => c.id === 'w-1'))).toBe('Beta opens to 500 customers on March 10');
  });

  it('a request missing `kind` entirely gets the same refusal', async () => {
    const realRoot = await project('sess-missing-kind');
    const id = await writeRaw(realRoot, { id: randomUUID(), format: 'docx', path: DOCX, projectRoot: realRoot, token: VALID_TOKEN, createdAt: Date.now() });
    expect(await waitForResult(realRoot, id)).toEqual({ ok: false, error: 'unknown-mutation-kind' });
  });

  it('garbage JSON in .pending/ is ignored, and a real request afterward still works', async () => {
    const realRoot = await project('sess-garbage');
    const garbage = path.join(pendingDirOf(realRoot), `${randomUUID()}.json`);
    await fs.promises.writeFile(garbage, 'not json at all');
    // Wait for the watcher to claim and drop it (the signal), then prove it still serves a real request.
    await vi.waitFor(() => expect(fs.existsSync(garbage)).toBe(false));
    expect((await listDocx(realRoot)).ok).toBe(true);
  });

  it('a handled request leaves neither the request nor its claim behind', async () => {
    const realRoot = await project('sess-claim');
    const id = await writeRequest(realRoot, { kind: 'list', format: 'docx', path: DOCX });
    await waitForResult(realRoot, id);
    const dir = pendingDirOf(realRoot);
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(dir, `${id}.json`))).toBe(false);
      expect(fs.existsSync(path.join(dir, `${id}.claimed`))).toBe(false);
    });
  });
});

describe('refcounting: two sessions sharing one project share one watcher', () => {
  it('stopping only one of two refs still processes a request; stopping both is safe', async () => {
    const realRoot = await project('sess-a');
    await start('sess-b', root);
    await stopPendingMutationQueue('sess-a', root);
    expect((await listDocx(realRoot)).ok).toBe(true);
    await stopPendingMutationQueue('sess-b', root);
    // Stopping an id with no ref is a documented no-op, not a throw.
    await expect(stopPendingMutationQueue('sess-a', root)).resolves.toBeUndefined();
  });
});

describe('the applier never trusts a request\'s own projectRoot field', () => {
  it('a forged projectRoot pointing at a DECOY project with a different same-path file is ignored', async () => {
    const realRoot = await project('sess-forged-root');
    // Decoy: same relative path but a fixture with ZERO comments.
    const decoyRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yc-pending-queue-decoy-'));
    try {
      await fs.promises.mkdir(path.join(decoyRoot, 'docs'), { recursive: true });
      await fs.promises.copyFile(path.join(FIXTURES_DIR, 'no-comments.docx'), path.join(decoyRoot, DOCX));
      const result = await listDocx(realRoot, { projectRoot: await fs.promises.realpath(decoyRoot) });
      expect(commentIds(result)).toContain('w-0');
    } finally {
      await fs.promises.rm(decoyRoot, { recursive: true, force: true });
    }
  });

  it('a forged projectRoot naming a directory that does not exist is also ignored', async () => {
    const realRoot = await project('sess-forged-root-2');
    expect(commentIds(await listDocx(realRoot, { projectRoot: '/nonexistent-forged-root-path-xyz' }))).toContain('w-0');
  });
});

describe('every request must carry this session\'s own token', () => {
  it('a request with the WRONG token is refused, never applied', async () => {
    const realRoot = await project('sess-wrong-token');
    expect(await listDocx(realRoot, { token: FORGED_TOKEN })).toEqual({ ok: false, error: 'invalid-request-token' });
  });

  it('a request with NO token field at all is refused', async () => {
    const realRoot = await project('sess-missing-token');
    const id = await writeRaw(realRoot, { id: randomUUID(), kind: 'list', format: 'docx', path: DOCX, projectRoot: realRoot, createdAt: Date.now() });
    expect(await waitForResult(realRoot, id)).toEqual({ ok: false, error: 'invalid-request-token' });
  });

  it('a DIFFERENT session\'s valid token (sharing the same project) is still accepted', async () => {
    const tokenB = 'session-b-token-fedcba9876543210fedcba98';
    const realRoot = await project('sess-a-multi', 'session-a-token-0123456789abcdef01234567');
    await start('sess-b-multi', root, tokenB);
    expect((await listDocx(realRoot, { token: tokenB })).ok).toBe(true);
  });
});

describe('requests already present when the watcher starts', () => {
  it('a pre-planted, back-dated request is never applied, even with a valid token', async () => {
    await newRoot();
    await withFixture(DOCX);
    const realRoot = await fs.promises.realpath(root);
    const dir = pendingDirOf(realRoot);
    await fs.promises.mkdir(dir, { recursive: true });
    // Simulates a file already sitting in a cloned/downloaded project, not a cold-start race.
    const id = randomUUID();
    const target = path.join(dir, `${id}.json`);
    const request: PendingMutationRequest = { id, kind: 'list', format: 'docx', path: DOCX, projectRoot: realRoot, token: VALID_TOKEN, createdAt: Date.now() };
    await fs.promises.writeFile(target, JSON.stringify(request), 'utf8');
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    await fs.promises.utimes(target, oldTime, oldTime);

    await start('sess-preplanted', root);
    // settle (negative assertion): the request must never be picked up.
    await new Promise((r) => setTimeout(r, 1500));
    expect(fs.existsSync(path.join(dir, `${id}.result.json`))).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('a request written just as the watcher starts (a genuine cold-start race) IS still processed', async () => {
    await newRoot();
    await withFixture(DOCX);
    const realRoot = await fs.promises.realpath(root);
    const id = await writeRequest(realRoot, { kind: 'list', format: 'docx', path: DOCX });
    await start('sess-genuine-race', root);
    expect((await waitForResult(realRoot, id)).ok).toBe(true);
  });
});

describe('orphaned files in .pending/ are eventually swept', () => {
  const plant = async (dir: string, name: string, old: boolean, body = '{}') => {
    const f = path.join(dir, name);
    await fs.promises.writeFile(f, body);
    if (old) await fs.promises.utimes(f, OLD(), OLD());
    return f;
  };

  it('a stale result file is removed on the next watcher start; a fresh one is left', async () => {
    await newRoot();
    const dir = pendingDirOf(await fs.promises.realpath(root));
    await fs.promises.mkdir(dir, { recursive: true });
    const stale = await plant(dir, `${randomUUID()}.result.json`, true);
    const fresh = await plant(dir, `${randomUUID()}.result.json`, false);
    await start('sess-sweep', root);
    await vi.waitFor(() => expect(fs.existsSync(stale)).toBe(false));
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('a stale result file is also swept opportunistically after handling a real request', async () => {
    const realRoot = await project('sess-sweep-2');
    const dir = pendingDirOf(realRoot);
    await fs.promises.mkdir(dir, { recursive: true });
    const stale = await plant(dir, `${randomUUID()}.result.json`, true);
    await listDocx(realRoot);
    await vi.waitFor(() => expect(fs.existsSync(stale)).toBe(false));
  });

  // Bug guarded: requests from killed sessions and claims from killed applies piled up forever; only results were swept.
  it('hour-old leftover requests and claims are swept too, fresh ones are left alone', async () => {
    await newRoot();
    const dir = pendingDirOf(await fs.promises.realpath(root));
    await fs.promises.mkdir(dir, { recursive: true });
    const staleRequest = await plant(dir, `${randomUUID()}.json`, true);
    const staleClaim = await plant(dir, `${randomUUID()}.claimed`, true);
    const freshClaim = await plant(dir, `${randomUUID()}.claimed`, false);
    await start('sess-sweep-3', root);
    await vi.waitFor(() => {
      expect(fs.existsSync(staleRequest)).toBe(false);
      expect(fs.existsSync(staleClaim)).toBe(false);
    });
    expect(fs.existsSync(freshClaim)).toBe(true);
  });
});
