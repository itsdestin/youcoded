// claude-code-doc-comments-mcp — T9a/T9b of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §5, §9): the six
// document-comment tools attached to a Claude Code session, spoken to over
// real JSON-RPC exactly as claude-code-mcp.test.ts already does for
// SendUserLink. Covers: tool definitions/descriptions, plain-text sidecar
// read/write, path-containment refusal (incl. symlink), a two-PROCESS lock
// stress test against the SAME real mutateFileUnderLock primitive T1 uses,
// interop with the native store (round trip both directions), a fresh
// invocation with no prior list() call, and the docx/xlsx pending-mutation
// queue's bounded-timeout behaviour when nothing is applying requests.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  deployClaudeCodeDocCommentsMcp,
  DOC_COMMENTS_SERVER_JS,
  DOC_COMMENTS_MCP_DIR,
  __resetDocCommentsMcpSweepForTest,
} from '../src/main/claude-code-doc-comments-mcp';
import {
  DOC_COMMENTS_MCP_SERVER_PREFIX,
  YOUCODED_PROJECT_ROOT_ENV,
  YOUCODED_MCP_TOKEN_ENV,
  DOC_COMMENTS_MCP_POLL_TIMEOUT_ENV,
  docCommentsMcpMutatorTools,
} from '../src/shared/doc-comments-mcp';
import {
  READ_FILE_COMMENTS_DESCRIPTION,
  REPLY_TO_COMMENT_DESCRIPTION,
  RESOLVE_COMMENT_DESCRIPTION,
  REOPEN_COMMENT_DESCRIPTION,
  ADD_COMMENT_DESCRIPTION,
  MOVE_COMMENT_DESCRIPTION,
} from '../src/shared/doc-comments-tool-text';
import { addComment, listComments, replyToComment, deleteReply } from '../src/main/doc-comments/doc-comments-store';
import type { CommentSelector } from '../src/shared/doc-comments-types';

const SERVER_SOURCE = path.join(os.tmpdir(), `yc-doc-comments-mcp-server-${process.pid}.js`);
/** A fixed stand-in for the per-deployment random secret
 *  (`deployClaudeCodeDocCommentsMcp` mints a real one) — this test file
 *  exercises the SCRIPT's own behaviour (T9a), never the queue's
 *  verification of it (T9b, pending-mutation-queue.test.ts owns that). */
const TEST_TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

/** A thin JSON-RPC client over one spawned server process's stdio — same
 *  shape as claude-code-mcp.test.ts's own helper. */
function makeClient(child: ChildProcessWithoutNullStreams) {
  const pending = new Map<number, (msg: any) => void>();
  let nextId = 1;
  let stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => { stderrText += c; });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
      i = buf.indexOf('\n');
    }
  });
  function request(method: string, params?: unknown, timeoutMs = 8000): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method} within ${timeoutMs}ms; stderr: ${stderrText}`)), timeoutMs);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function callTool(name: string, args: unknown, timeoutMs?: number): Promise<any> {
    return request('tools/call', { name, arguments: args }, timeoutMs);
  }
  return { request, callTool, stderrText: () => stderrText };
}

function spawnServer(projectRoot: string, extraEnv: Record<string, string> = {}): { child: ChildProcessWithoutNullStreams; client: ReturnType<typeof makeClient> } {
  const child = spawn(process.execPath, [SERVER_SOURCE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, [YOUCODED_PROJECT_ROOT_ENV]: projectRoot, [YOUCODED_MCP_TOKEN_ENV]: TEST_TOKEN, ...extraEnv },
  });
  return { child, client: makeClient(child) };
}

let root: string;
const spawned: ChildProcessWithoutNullStreams[] = [];

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yc-doc-comments-mcp-'));
});

afterEach(async () => {
  for (const c of spawned) c.kill();
  spawned.length = 0;
  await fs.promises.rm(root, { recursive: true, force: true });
});

function start(projectRoot: string, extraEnv?: Record<string, string>) {
  const { child, client } = spawnServer(projectRoot, extraEnv);
  spawned.push(child);
  return client;
}

/** Waits for the spawned client to write its pending-queue request and returns the file path.
 *  WHY vi.waitFor with a 7 s bound: the client is a spawned process and under load it took
 *  over 1 s to start; this returns the moment the file appears. */
async function waitForRequest(): Promise<{ pendingDir: string; requestFile: string }> {
  const pendingDir = path.join(root, '.youcoded', 'comments', '.pending');
  const requestFile = await vi.waitFor(() => {
    const files = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json') && !f.endsWith('.result.json')) : [];
    if (!files.length) throw new Error('no request yet');
    return path.join(pendingDir, files[0]);
  }, { timeout: 7000, interval: 20 });
  return { pendingDir, requestFile };
}

describe('server source', () => {
  it('writes the source once for every test in this file to spawn from', () => {
    fs.writeFileSync(SERVER_SOURCE, DOC_COMMENTS_SERVER_JS);
    expect(() => execFileSync(process.execPath, ['--check', SERVER_SOURCE])).not.toThrow();
  });

  it('is String.raw-safe (no backtick, no ${ anywhere in the embedded script)', () => {
    expect(DOC_COMMENTS_SERVER_JS.includes('`')).toBe(false);
    expect(DOC_COMMENTS_SERVER_JS.includes('${')).toBe(false);
  });

  it('has no leftover template placeholders after substitution', () => {
    expect(DOC_COMMENTS_SERVER_JS).not.toMatch(/__[A-Z_]+__/);
  });
});

describe('deployment', () => {
  const baseDirs: string[] = [];
  const freshBase = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-doc-comments-mcp-deploy-'));
    baseDirs.push(d);
    return d;
  };
  const deploy = (baseDir: string) => deployClaudeCodeDocCommentsMcp(baseDir, process.execPath, root);
  afterEach(() => {
    for (const d of baseDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    __resetDocCommentsMcpSweepForTest();
  });

  it('writes the server and a config naming it, with the project root and a token baked into env', () => {
    const baseDir = freshBase();
    const deployment = deploy(baseDir);
    expect(deployment.serverPath.startsWith(path.join(baseDir, DOC_COMMENTS_MCP_DIR))).toBe(true);
    expect(fs.existsSync(deployment.serverPath)).toBe(true);
    // WHY: a fresh, unpredictable config key per deployment, never a fixed public constant.
    expect(deployment.serverId.startsWith(`${DOC_COMMENTS_MCP_SERVER_PREFIX}-`)).toBe(true);
    const config = JSON.parse(fs.readFileSync(deployment.configPath, 'utf8'));
    expect(Object.keys(config.mcpServers)).toEqual([deployment.serverId]);
    expect(config.mcpServers[deployment.serverId].env[YOUCODED_PROJECT_ROOT_ENV]).toBe(root);
    // WHY: the returned secret and the one in the spawned process's env must be the SAME value.
    expect(deployment.token.length).toBeGreaterThan(16);
    expect(config.mcpServers[deployment.serverId].env[YOUCODED_MCP_TOKEN_ENV]).toBe(deployment.token);
    // Nothing is pre-approved: a pre-approved read could never ask before reaching an outside file.
    expect(deployment.allowedTools).toEqual([]);
    // deployDir is exactly the directory holding both files, so a caller can delete it wholesale.
    expect(path.dirname(deployment.serverPath)).toBe(deployment.deployDir);
    expect(path.dirname(deployment.configPath)).toBe(deployment.deployDir);
  });

  it('two deployments to the same baseDir never collide and both stay self-consistent', () => {
    const baseDir = freshBase();
    const first = deploy(baseDir);
    const second = deploy(baseDir);
    expect(second.serverId).not.toBe(first.serverId);
    expect(second.token).not.toBe(first.token);
    expect(second.serverPath).not.toBe(first.serverPath);
    expect(second.configPath).not.toBe(first.configPath);
    // WHY: a shared fixed path would have let the second overwrite the first's files.
    const firstConfig = JSON.parse(fs.readFileSync(first.configPath, 'utf8'));
    expect(Object.keys(firstConfig.mcpServers)).toEqual([first.serverId]);
    expect(fs.readFileSync(first.serverPath, 'utf8')).toBe(DOC_COMMENTS_SERVER_JS);
    expect(fs.readFileSync(second.serverPath, 'utf8')).toBe(DOC_COMMENTS_SERVER_JS);
    // Never re-sweeps mid-process, so the sibling created earlier in the SAME run survives.
    expect(fs.existsSync(first.deployDir)).toBe(true);
    expect(fs.existsSync(second.deployDir)).toBe(true);
  });

  // `mode & 0o077` is POSIX-only: Windows reports 0o666 for every file.
  it.skipIf(process.platform === 'win32')('the deploy directory and its config file are owner-only', () => {
    const deployment = deploy(freshBase());
    expect(fs.statSync(deployment.deployDir).mode & 0o077).toBe(0);
    expect(fs.statSync(deployment.configPath).mode & 0o077).toBe(0);
  });

  it('a directory left behind by a previous process run is swept on the first deploy of a fresh process', () => {
    const baseDir = freshBase();
    const leftover = path.join(baseDir, DOC_COMMENTS_MCP_DIR, 'youcoded-doc-comments-oldstale');
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'mcp-config.json'), '{"mcpServers":{}}');
    __resetDocCommentsMcpSweepForTest(); // pretend this is a fresh process
    const deployment = deploy(baseDir);
    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.existsSync(deployment.deployDir)).toBe(true);
  });
});

describe('tools/list — definitions match the shared, T8-pinned description text', () => {
  it('lists all six tools with the exact, signed wording, verbatim', async () => {
    const client = start(root);
    const res = await client.request('tools/list');
    const byName = new Map(res.result.tools.map((t: any) => [t.name, t]));
    expect([...byName.keys()].sort()).toEqual(
      ['AddComment', 'MoveComment', 'ReadFileComments', 'ReopenComment', 'ReplyToComment', 'ResolveComment'].sort()
    );
    expect((byName.get('ReadFileComments') as any).description).toBe(READ_FILE_COMMENTS_DESCRIPTION);
    expect((byName.get('ReplyToComment') as any).description).toBe(REPLY_TO_COMMENT_DESCRIPTION);
    expect((byName.get('ResolveComment') as any).description).toBe(RESOLVE_COMMENT_DESCRIPTION);
    expect((byName.get('ReopenComment') as any).description).toBe(REOPEN_COMMENT_DESCRIPTION);
    // R4's own signed constraint (§5.1) — never paraphrased.
    expect((byName.get('AddComment') as any).description).toBe(ADD_COMMENT_DESCRIPTION);
    expect((byName.get('MoveComment') as any).description).toBe(MOVE_COMMENT_DESCRIPTION);
  });

  it('every mutation tool requires `path` — a bare commentId is not enough', async () => {
    const client = start(root);
    const res = await client.request('tools/list');
    for (const name of ['ReplyToComment', 'ResolveComment', 'ReopenComment', 'MoveComment']) {
      const tool = res.result.tools.find((t: any) => t.name === name);
      expect(tool.inputSchema.required).toContain('path');
    }
    expect(res.result.tools.find((t: any) => t.name === 'AddComment').inputSchema.required).toEqual(['path', 'selector', 'text']);
  });
});

const SELECTOR: CommentSelector = { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'hello', prefix: '', suffix: ' world', occurrence: 0 } };

describe('plain-text sidecar — the six tools end to end', () => {
  it('add, read, reply, resolve, reopen, move all round-trip', async () => {
    const client = start(root);
    const filePath = 'notes.md';

    const added = await client.callTool('AddComment', { path: filePath, selector: SELECTOR, text: 'please clarify' });
    expect(added.result.isError).toBe(false);
    const idMatch = /id: (c-[0-9a-f-]+)/.exec(added.result.content[0].text);
    expect(idMatch).not.toBeNull();
    const commentId = idMatch![1];

    const read1 = await client.callTool('ReadFileComments', { path: filePath });
    expect(read1.result.content[0].text).toContain(commentId);
    expect(read1.result.content[0].text).toContain('please clarify');

    const replied = await client.callTool('ReplyToComment', { path: filePath, commentId, text: 'done' });
    expect(replied.result.isError).toBe(false);

    const resolved = await client.callTool('ResolveComment', { path: filePath, commentId });
    expect(resolved.result.isError).toBe(false);

    const reopened = await client.callTool('ReopenComment', { path: filePath, commentId });
    expect(reopened.result.isError).toBe(false);

    const newSelector: CommentSelector = { kind: 'cell', selector: { type: 'CellSelector', cell: 'B2' } };
    // MoveComment on a plain-text file with a cell selector is a store-level
    // concern (this store never validates selector/format agreement, same as
    // doc-comments-store.ts's own moveComment) — exercised here only to prove
    // the tool call itself round-trips.
    const moved = await client.callTool('MoveComment', { path: filePath, commentId, newSelector });
    expect(moved.result.isError).toBe(false);

    const finalSidecar = JSON.parse(await fs.promises.readFile(path.join(root, '.youcoded', 'comments', `${filePath}.json`), 'utf8'));
    expect(finalSidecar.comments).toHaveLength(1);
    expect(finalSidecar.comments[0].replies).toHaveLength(1);
    expect(finalSidecar.comments[0].resolved).toBe(false);
    expect(finalSidecar.comments[0].history).toHaveLength(2);
    expect(finalSidecar.comments[0].selector).toEqual(newSelector);
  });

  it('a fresh invocation with no prior ReadFileComments/list() call still mutates, given only {path, commentId}', async () => {
    // Seed the comment through the REAL native store, never through this
    // script's own AddComment (which would already have "warmed" it).
    const seeded = await addComment({ path: 'brief.md', projectRoot: root, selector: SELECTOR, text: 'seed', author: 'user' });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    const client = start(root); // a FRESH process — no prior call of any kind
    const res = await client.callTool('ReplyToComment', { path: 'brief.md', commentId: seeded.id, text: 'from a cold script' });
    expect(res.result.isError).toBe(false);
  });

  it('a missing required field fails honestly instead of throwing', async () => {
    const client = start(root);
    const res = await client.callTool('ReplyToComment', { path: 'notes.md' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('required');
  });

  it('a comment id that does not exist fails honestly', async () => {
    const client = start(root);
    const res = await client.callTool('ResolveComment', { path: 'notes.md', commentId: 'c-does-not-exist' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('comment-not-found');
  });
});

describe('interop with the real native store — same file, both directions', () => {
  it('the MCP script reads a comment the native store wrote, and adds a reply the native store then sees', async () => {
    const seeded = await addComment({ path: 'shared.md', projectRoot: root, selector: SELECTOR, text: 'native wrote this', author: 'user' });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    const client = start(root);
    const read = await client.callTool('ReadFileComments', { path: 'shared.md' });
    expect(read.result.content[0].text).toContain('native wrote this');
    const replied = await client.callTool('ReplyToComment', { path: 'shared.md', commentId: seeded.id, text: 'MCP script replied' });
    expect(replied.result.isError).toBe(false);

    const backToNative = await listComments({ path: 'shared.md', projectRoot: root });
    expect(backToNative.ok).toBe(true);
    if (backToNative.ok) {
      expect(backToNative.comments[0].replies.map((r) => r.text)).toContain('MCP script replied');
    }
  });
});

describe('reply ids from the MCP script', () => {
  // 2026-09-28 PR review.
  it('a reply after a middle reply was deleted gets an unused id', async () => {
    const seeded = await addComment({ path: 'ids.md', projectRoot: root, selector: SELECTOR, text: 'root', author: 'user' });
    if (!seeded.ok) throw new Error('setup');
    const ids: string[] = [];
    for (const text of ['one', 'two', 'three']) {
      const r = await replyToComment({ path: 'ids.md', projectRoot: root, id: seeded.id, text, author: 'user' });
      if (!r.ok) throw new Error('setup');
      ids.push(r.reply.id);
    }
    await deleteReply({ path: 'ids.md', projectRoot: root, id: seeded.id, replyId: ids[1] });

    const client = start(root);
    const replied = await client.callTool('ReplyToComment', { path: 'ids.md', commentId: seeded.id, text: 'from the assistant' });
    expect(replied.result.isError).toBe(false);
    const listed = await listComments({ path: 'ids.md', projectRoot: root });
    if (!listed.ok) throw new Error('list failed');
    const replyIds = listed.comments[0].replies.map((r) => r.id);
    expect(new Set(replyIds).size).toBe(replyIds.length);
  });
});

describe('path containment — model-controlled path at the MCP tool-argument surface', () => {
  it('refuses a ../../-shaped path trying to escape the project', async () => {
    const client = start(root);
    const res = await client.callTool('AddComment', { path: '../../etc/passwd', selector: SELECTOR, text: 'x' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('path-outside-project');
  });

  // The person approved this call in the app before it got here (main's
  // cc-outside-comments.ts asks first), so the script keeps the comments in
  // the same per-machine store the app's comments pane reads for that file.
  it('keeps comments on an absolute path outside the project in the app\'s loose-file store', async () => {
    const client = start(root);
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yc-doc-comments-mcp-outside-'));
    const outsideFile = path.join(outside, 'notes.md');
    await fs.promises.writeFile(outsideFile, 'x');
    try {
      const res = await client.callTool('AddComment', { path: outsideFile, selector: SELECTOR, text: 'outside comment' });
      expect(res.result.isError).toBe(false);
      const listed = await listComments({ path: outsideFile });
      expect(listed.ok && listed.comments.map((c) => c.text)).toEqual(['outside comment']);
      expect(fs.existsSync(path.join(root, '.youcoded'))).toBe(false); // nothing misfiled under the project
      const read = await client.callTool('ReadFileComments', { path: outsideFile });
      expect(read.result.content[0].text).toContain('outside comment');
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('sends a Word file outside the project through this chat\'s own queue, naming the outside file', async () => {
    const client = start(root, { [DOC_COMMENTS_MCP_POLL_TIMEOUT_ENV]: '5000' });
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yc-doc-comments-mcp-outside-'));
    try {
      const outsideFile = path.join(outside, 'report.docx');
      await fs.promises.writeFile(outsideFile, 'stands in for a Word file');
      const callPromise = client.callTool('ReadFileComments', { path: outsideFile }, 8000);
      const { pendingDir, requestFile } = await waitForRequest();
      const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
      expect(request).toMatchObject({ kind: 'list', format: 'docx', path: outsideFile });
      // Stand in for the app answering it.
      fs.writeFileSync(path.join(pendingDir, `${request.id}.result.json`), JSON.stringify({ ok: true, comments: [] }));
      const res = await callPromise;
      expect(res.result.isError).toBe(false);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  }, 15000);

  it('a symlink inside the project root that points outside it is refused (realpath, not the string, decides)', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yc-doc-comments-mcp-outside-'));
    try {
      const secret = path.join(outside, 'secret.md');
      await fs.promises.writeFile(secret, 'do not comment on me');
      const link = path.join(root, 'linked.md');
      try {
        await fs.promises.symlink(secret, link);
      } catch {
        return; // no symlink rights on this platform — skip
      }
      const client = start(root);
      const res = await client.callTool('AddComment', { path: 'linked.md', selector: SELECTOR, text: 'x' });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('path-outside-project');
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  // The app shows the outside-file card by the path as written, so a link
  // inside the project named by its FULL path got no card; it must not then be
  // followed out to the real file (to the loose-file store or the Word queue).
  it.each(['secret.md', 'secret.docx'])('a link inside the project to an outside %s is refused when named by its full path too', async (name) => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yc-doc-comments-mcp-outside-'));
    try {
      const secret = path.join(outside, name);
      await fs.promises.writeFile(secret, 'do not comment on me');
      const link = path.join(root, `linked-${name}`);
      try {
        await fs.promises.symlink(secret, link);
      } catch {
        return; // no symlink rights on this platform — skip
      }
      const client = start(root);
      const res = await client.callTool('ReadFileComments', { path: link });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('path-outside-project');
      expect(fs.existsSync(path.join(root, '.youcoded', 'comments', '.pending'))).toBe(false);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it.each(['ReplyToComment', 'ResolveComment', 'ReopenComment', 'MoveComment'])(
    '%s refuses a path-escaping argument too, not just AddComment (review 3, F1)',
    async (toolName) => {
      const client = start(root);
      const args: Record<string, unknown> = { path: '../../etc/passwd', commentId: 'c-doesnt-matter' };
      if (toolName === 'MoveComment') args.newSelector = SELECTOR;
      if (toolName === 'ReplyToComment') args.text = 'x';
      const res = await client.callTool(toolName, args);
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('path-outside-project');
    }
  );
});

describe('the JSON sidecar mutex — a genuine two-process contention stress test', () => {
  it('two independent script processes racing to reply to the SAME comment for the first time both land, none lost', async () => {
    const seeded = await addComment({ path: 'race.md', projectRoot: root, selector: SELECTOR, text: 'race target', author: 'user' });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    const clientA = start(root);
    const clientB = start(root);
    const N = 8;
    const calls: Promise<any>[] = [];
    for (let i = 0; i < N; i++) {
      const client = i % 2 === 0 ? clientA : clientB;
      calls.push(client.callTool('ReplyToComment', { path: 'race.md', commentId: seeded.id, text: `reply-${i}` }));
    }
    const results = await Promise.all(calls);
    for (const r of results) expect(r.result.isError).toBe(false);

    const final = await listComments({ path: 'race.md', projectRoot: root });
    expect(final.ok).toBe(true);
    if (final.ok) {
      const texts = final.comments[0].replies.map((r) => r.text).sort();
      expect(texts).toEqual(Array.from({ length: N }, (_, i) => `reply-${i}`).sort());
    }
  }, 20000);

  it('two processes racing to create the SAME sidecar for the first time both survive (lock-path canonicalization)', async () => {
    const clientA = start(root);
    const clientB = start(root);
    const [a, b] = await Promise.all([
      clientA.callTool('AddComment', { path: 'brand-new.md', selector: SELECTOR, text: 'from A' }),
      clientB.callTool('AddComment', { path: 'brand-new.md', selector: SELECTOR, text: 'from B' }),
    ]);
    expect(a.result.isError).toBe(false);
    expect(b.result.isError).toBe(false);
    const final = await listComments({ path: 'brand-new.md', projectRoot: root });
    expect(final.ok).toBe(true);
    if (final.ok) expect(final.comments).toHaveLength(2);
  }, 20000);
});

describe('docx/xlsx target — the pending-mutation queue client', () => {
  const answer = (pendingDir: string, requestFile: string, result: unknown) =>
    fs.writeFileSync(path.join(pendingDir, `${path.basename(requestFile, '.json')}.result.json`), JSON.stringify(result));
  const claim = (pendingDir: string, requestFile: string) =>
    fs.renameSync(requestFile, path.join(pendingDir, `${path.basename(requestFile, '.json')}.claimed`));
  const queued = (pollMs: string) => start(root, { [DOC_COMMENTS_MCP_POLL_TIMEOUT_ENV]: pollMs });

  it('a .docx ReadFileComments times out honestly (short poll bound) when nothing is applying requests', async () => {
    const client = queued('300');
    await fs.promises.writeFile(path.join(root, 'report.docx'), 'not a real docx — nothing applies this in this test');
    const res = await client.callTool('ReadFileComments', { path: 'report.docx' }, 5000);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('timed-out');
    // WHY: a timed-out request is WITHDRAWN so a slow app can't apply it after the assistant
    // was told it failed (its retry used to post the same comment twice).
    const pendingDir = path.join(root, '.youcoded', 'comments', '.pending');
    expect(fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    expect(res.result.content[0].text).toContain('nothing was changed');
  });

  it('a request the app already claimed is waited for past the normal bound, never reported as unchanged', async () => {
    const client = queued('300');
    const callPromise = client.callTool('ReplyToComment', { path: 'report.docx', commentId: 'w-1', text: 'a reply' }, 8000);
    const { pendingDir, requestFile } = await waitForRequest();
    // Stand in for the app: claim it (the real queue renames before applying), then answer
    // only AFTER the script's 300ms bound has passed.
    claim(pendingDir, requestFile);
    await new Promise((r) => setTimeout(r, 700));
    answer(pendingDir, requestFile, { ok: true, reply: { id: 'w-1-r2', author: 'assistant', text: 'a reply', createdAt: Date.now() } });
    const res = await callPromise;
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain('Reply w-1-r2 added');
  }, 15000);

  it('a change the app kept for an Office editor that is not ready yet is told to the assistant as queued', async () => {
    const client = queued('5000');
    await fs.promises.writeFile(path.join(root, 'report.docx'), 'stands in for an open document');
    const callPromise = client.callTool('ResolveComment', { path: 'report.docx', commentId: 'w-1' }, 8000);
    const { pendingDir, requestFile } = await waitForRequest();
    claim(pendingDir, requestFile);
    answer(pendingDir, requestFile, { ok: true, queued: true });
    const res = await callPromise;
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe("report.docx is open in Office and its editor isn't ready yet. The change is queued and will be made as soon as it is.");
  }, 15000);

  it('a Word/Excel mutation request carries `path`, `format` and the operation-specific fields', async () => {
    const client = queued('5000');
    const callPromise = client.callTool('AddComment', { path: 'report.docx', selector: SELECTOR, text: 'a comment' }, 8000);
    const { requestFile } = await waitForRequest();
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    expect(request.kind).toBe('add');
    expect(request.format).toBe('docx');
    expect(request.path).toBe('report.docx');
    expect(request.projectRoot).toBe(await fs.promises.realpath(root));
    expect(request.selector).toEqual(SELECTOR);
    expect(request.text).toBe('a comment');
    expect(request.author).toBe('assistant');
    // Every request carries this session's own token; the applier is what VERIFIES it.
    expect(request.token).toBe(TEST_TOKEN);
    // Let the (short) poll time out rather than hang the test.
    expect((await callPromise).result.isError).toBe(true);
  }, 15000);

  // WHY: `format` used to be decided from the caller's raw path string, so a `.txt` symlink to a
  // real `.docx` was dispatched as a plain-text sidecar edit instead of a Word mutation.
  it('a .txt symlink pointing at a real .docx submits a request with format "docx", not null', async () => {
    const realDocx = path.join(root, 'report.docx');
    await fs.promises.writeFile(realDocx, 'not a real docx — nothing applies this in this test');
    try {
      await fs.promises.symlink(realDocx, path.join(root, 'notes.txt'));
    } catch {
      return; // no symlink rights on this platform — skip
    }
    const client = queued('5000');
    const callPromise = client.callTool('AddComment', { path: 'notes.txt', selector: SELECTOR, text: 'via disguised symlink' }, 8000);
    const { requestFile } = await waitForRequest();
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    expect(request.format).toBe('docx');
    // The wire `path` keeps the caller's ORIGINAL name; main's own resolution writes the real file.
    expect(request.path).toBe('notes.txt');
    expect((await callPromise).result.isError).toBe(true);
  }, 15000);
});

describe('parity: mutator tools never include the read-only tool', () => {
  it('docCommentsMcpMutatorTools is exactly the five mutation tools, for any server id', () => {
    const id = 'youcoded-doc-comments-deadbeef';
    expect(docCommentsMcpMutatorTools(id)).toEqual([
      `mcp__${id}__ReplyToComment`,
      `mcp__${id}__ResolveComment`,
      `mcp__${id}__ReopenComment`,
      `mcp__${id}__AddComment`,
      `mcp__${id}__MoveComment`,
    ]);
    expect(docCommentsMcpMutatorTools(id)).not.toContain(`mcp__${id}__ReadFileComments`);
  });
});
