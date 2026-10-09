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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  docCommentsMcpReadTool,
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
  it('writes the server and a config naming it, with the project root and a token baked into env', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-doc-comments-mcp-deploy-'));
    try {
      const deployment = deployClaudeCodeDocCommentsMcp(baseDir, process.execPath, root);
      expect(deployment.serverPath.startsWith(path.join(baseDir, DOC_COMMENTS_MCP_DIR))).toBe(true);
      expect(fs.existsSync(deployment.serverPath)).toBe(true);
      // Adversarial review 2026-09-27, finding #2: a fresh, unpredictable
      // config key per deployment, never a fixed public constant.
      expect(deployment.serverId.startsWith(`${DOC_COMMENTS_MCP_SERVER_PREFIX}-`)).toBe(true);
      const config = JSON.parse(fs.readFileSync(deployment.configPath, 'utf8'));
      expect(Object.keys(config.mcpServers)).toEqual([deployment.serverId]);
      expect(config.mcpServers[deployment.serverId].env[YOUCODED_PROJECT_ROOT_ENV]).toBe(root);
      // Adversarial review 2026-09-27, finding #1: a real, per-deployment
      // secret, returned to the caller and also baked into the spawned
      // process's own env — the two must be the SAME value.
      expect(deployment.token.length).toBeGreaterThan(16);
      expect(config.mcpServers[deployment.serverId].env[YOUCODED_MCP_TOKEN_ENV]).toBe(deployment.token);
      // Only ReadFileComments is safe to pre-approve (§5.2a) — the five
      // mutation tools are deliberately absent from this list.
      expect(deployment.allowedTools).toEqual([docCommentsMcpReadTool(deployment.serverId)]);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('two deployments to the same baseDir never collide — different server ids, different directories, different tokens', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-doc-comments-mcp-deploy-'));
    try {
      const first = deployClaudeCodeDocCommentsMcp(baseDir, process.execPath, root);
      const second = deployClaudeCodeDocCommentsMcp(baseDir, process.execPath, root);
      expect(second.serverId).not.toBe(first.serverId);
      expect(second.token).not.toBe(first.token);
      expect(second.serverPath).not.toBe(first.serverPath);
      expect(second.configPath).not.toBe(first.configPath);
      // The FIRST deployment's own files must still be intact — a shared
      // fixed path would have let the second overwrite them (this is
      // exactly the collision session-manager.test.ts's own "two sessions"
      // case caught before this fix).
      expect(fs.existsSync(first.configPath)).toBe(true);
      const firstConfig = JSON.parse(fs.readFileSync(first.configPath, 'utf8'));
      expect(Object.keys(firstConfig.mcpServers)).toEqual([first.serverId]);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('re-deploying with the SAME inputs still produces a working, self-consistent server file each time', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-doc-comments-mcp-deploy-'));
    try {
      const first = deployClaudeCodeDocCommentsMcp(baseDir, process.execPath, root);
      const second = deployClaudeCodeDocCommentsMcp(baseDir, process.execPath, root);
      expect(fs.readFileSync(second.serverPath, 'utf8')).toBe(DOC_COMMENTS_SERVER_JS);
      expect(fs.readFileSync(first.serverPath, 'utf8')).toBe(DOC_COMMENTS_SERVER_JS);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  // T9c/T20 adversarial review, finding #1 — cheap hardening (never the real
  // boundary; see the WHY note beside `deployClaudeCodeDocCommentsMcp`'s own
  // token generation for what this can and can't defend against). `mode &
  // 0o077` is POSIX-only (accepted-history-store.test.ts's own precedent) —
  // Windows reports 0o666 for every file, so this assertion is skipped there.
  it('the deploy directory and its config file are owner-only', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-doc-comments-mcp-deploy-'));
    try {
      const deployment = deployClaudeCodeDocCommentsMcp(baseDir, process.execPath, root);
      if (process.platform !== 'win32') {
        expect(fs.statSync(deployment.deployDir).mode & 0o077).toBe(0);
        expect(fs.statSync(deployment.configPath).mode & 0o077).toBe(0);
      }
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  // Finding #3 — the returned `deployDir` is exactly the directory holding
  // both files, so a caller (ipc-handlers.ts) can delete it wholesale.
  it('deployDir names the exact directory the server and config live in', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-doc-comments-mcp-deploy-'));
    try {
      const deployment = deployClaudeCodeDocCommentsMcp(baseDir, process.execPath, root);
      expect(path.dirname(deployment.serverPath)).toBe(deployment.deployDir);
      expect(path.dirname(deployment.configPath)).toBe(deployment.deployDir);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  describe('leftover-deploy sweep (finding #3)', () => {
    afterEach(() => {
      __resetDocCommentsMcpSweepForTest();
    });

    it('a directory left behind by a previous process run is swept on the first deploy of a fresh process', () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-doc-comments-mcp-deploy-'));
      try {
        const leftover = path.join(baseDir, DOC_COMMENTS_MCP_DIR, 'youcoded-doc-comments-oldstale');
        fs.mkdirSync(leftover, { recursive: true });
        fs.writeFileSync(path.join(leftover, 'mcp-config.json'), '{"mcpServers":{}}');
        expect(fs.existsSync(leftover)).toBe(true);

        __resetDocCommentsMcpSweepForTest(); // pretend this is a fresh process
        const deployment = deployClaudeCodeDocCommentsMcp(baseDir, process.execPath, root);

        expect(fs.existsSync(leftover)).toBe(false);
        expect(fs.existsSync(deployment.deployDir)).toBe(true);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it('never re-sweeps mid-process, so a sibling deployment created earlier in the SAME run survives', () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-doc-comments-mcp-deploy-'));
      try {
        __resetDocCommentsMcpSweepForTest();
        const first = deployClaudeCodeDocCommentsMcp(baseDir, process.execPath, root);
        const second = deployClaudeCodeDocCommentsMcp(baseDir, process.execPath, root);
        expect(fs.existsSync(first.deployDir)).toBe(true);
        expect(fs.existsSync(second.deployDir)).toBe(true);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });
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

  it('refuses an absolute path outside the project', async () => {
    const client = start(root);
    const outsideFile = path.join(os.tmpdir(), `yc-doc-comments-mcp-outside-${process.pid}.md`);
    await fs.promises.writeFile(outsideFile, 'x');
    try {
      const res = await client.callTool('AddComment', { path: outsideFile, selector: SELECTOR, text: 'x' });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('path-outside-project');
    } finally {
      await fs.promises.rm(outsideFile, { force: true });
    }
  });

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
  it('a .docx ReadFileComments times out honestly (short poll bound) when nothing is applying requests', async () => {
    const client = start(root, { [DOC_COMMENTS_MCP_POLL_TIMEOUT_ENV]: '300' });
    const docPath = 'report.docx';
    await fs.promises.writeFile(path.join(root, docPath), 'not a real docx — nothing applies this in this test');
    const res = await client.callTool('ReadFileComments', { path: docPath }, 5000);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('timed-out');

    // The request was written where the main-process queue (T9b) looks —
    // the directory only exists after an actual submit.
    const pendingDir = path.join(root, '.youcoded', 'comments', '.pending');
    expect(fs.existsSync(pendingDir)).toBe(true);
    // 2026-09-28 PR review: a timed-out request is WITHDRAWN, so a slow app
    // can't apply it after the assistant was told it failed (its retry used
    // to post the same comment twice) — and the reply says nothing changed.
    expect(fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    expect(res.result.content[0].text).toContain('nothing was changed');
  });

  it('a request the app already claimed is waited for past the normal bound, never reported as unchanged', async () => {
    const client = start(root, { [DOC_COMMENTS_MCP_POLL_TIMEOUT_ENV]: '300' });
    const callPromise = client.callTool('ReplyToComment', { path: 'report.docx', commentId: 'w-1', text: 'a reply' }, 8000);
    const pendingDir = path.join(root, '.youcoded', 'comments', '.pending');
    let requestFile: string | null = null;
    // Same 7 s deadline as the symlink case below (a spawned client, slow to start under load).
    for (const deadline = Date.now() + 7000; !requestFile && Date.now() < deadline;) {
      if (fs.existsSync(pendingDir)) {
        const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json') && !f.endsWith('.result.json'));
        if (files.length) requestFile = path.join(pendingDir, files[0]);
      }
      if (!requestFile) await new Promise((r) => setTimeout(r, 10));
    }
    expect(requestFile).not.toBeNull();
    // Stand in for the app: claim it (the real queue renames before applying),
    // then answer only AFTER the script's 300ms bound has passed.
    const id = path.basename(requestFile!, '.json');
    fs.renameSync(requestFile!, path.join(pendingDir, `${id}.claimed`));
    await new Promise((r) => setTimeout(r, 700));
    fs.writeFileSync(path.join(pendingDir, `${id}.result.json`), JSON.stringify({ ok: true, reply: { id: 'w-1-r2', author: 'assistant', text: 'a reply', createdAt: Date.now() } }));

    const res = await callPromise;
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain('Reply w-1-r2 added');
  }, 15000);

  it('a change the app kept for an Office editor that is not ready yet is told to the assistant as queued', async () => {
    const client = start(root, { [DOC_COMMENTS_MCP_POLL_TIMEOUT_ENV]: '5000' });
    await fs.promises.writeFile(path.join(root, 'report.docx'), 'stands in for an open document');
    const callPromise = client.callTool('ResolveComment', { path: 'report.docx', commentId: 'w-1' }, 8000);
    const pendingDir = path.join(root, '.youcoded', 'comments', '.pending');
    let requestFile: string | null = null;
    for (let i = 0; i < 200 && !requestFile; i++) {
      if (fs.existsSync(pendingDir)) {
        const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json') && !f.endsWith('.result.json'));
        if (files.length) requestFile = path.join(pendingDir, files[0]);
      }
      if (!requestFile) await new Promise((r) => setTimeout(r, 10));
    }
    expect(requestFile).not.toBeNull();
    const id = path.basename(requestFile!, '.json');
    fs.renameSync(requestFile!, path.join(pendingDir, `${id}.claimed`));
    fs.writeFileSync(path.join(pendingDir, `${id}.result.json`), JSON.stringify({ ok: true, queued: true }));
    const res = await callPromise;
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe("report.docx is open in Office and its editor isn't ready yet. The change is queued and will be made as soon as it is.");
  }, 15000);

  it('a Word/Excel mutation request carries `path`, `format` and the operation-specific fields', async () => {
    const client = start(root, { [DOC_COMMENTS_MCP_POLL_TIMEOUT_ENV]: '5000' });
    const docPath = 'report.docx';
    const callPromise = client.callTool('AddComment', { path: docPath, selector: SELECTOR, text: 'a comment' }, 8000);

    const pendingDir = path.join(root, '.youcoded', 'comments', '.pending');
    let requestFile: string | null = null;
    // WHY a 7 s deadline, not 40 × 25 ms (2026-10-09): the client is a spawned process, and at
    // load average ~38 it took longer than 1 s to start and write its request — the test failed
    // in a full run and passed alone. It returns as soon as the file appears; the call's own
    // timeout above is 8 s.
    const deadline = Date.now() + 7000;
    while (!requestFile && Date.now() < deadline) {
      if (fs.existsSync(pendingDir)) {
        const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json') && !f.endsWith('.result.json'));
        if (files.length) requestFile = path.join(pendingDir, files[0]);
      }
      if (!requestFile) await new Promise((r) => setTimeout(r, 25));
    }
    expect(requestFile).not.toBeNull();
    const request = JSON.parse(fs.readFileSync(requestFile!, 'utf8'));
    expect(request.kind).toBe('add');
    expect(request.format).toBe('docx');
    expect(request.path).toBe(docPath);
    expect(request.projectRoot).toBe(await fs.promises.realpath(root));
    expect(request.selector).toEqual(SELECTOR);
    expect(request.text).toBe('a comment');
    expect(request.author).toBe('assistant');
    // Finding #1: every request carries this session's own token — the
    // applier is what actually VERIFIES it (pending-mutation-queue.test.ts).
    expect(request.token).toBe(TEST_TOKEN);

    // Let the (very short) poll time out rather than hang the test.
    const res = await callPromise;
    expect(res.result.isError).toBe(true);
  }, 15000);

  // Review finding #5 (docs/active/reviews/2026-09-27-doc-comments-t9ab-
  // review.md): `format` used to be decided from the caller's raw `path`
  // string, so a `.txt`-named symlink pointing at a real `.docx` submitted a
  // request with `format: null` — dispatched as a plain-text sidecar edit
  // instead of a Word mutation. Fixed by deciding from `located.
  // sourceAbsolutePath` (the already-realpath'd target `locate()` computes)
  // instead.
  it('a .txt symlink pointing at a real .docx submits a request with format "docx", not null', async () => {
    const realDocx = path.join(root, 'report.docx');
    await fs.promises.writeFile(realDocx, 'not a real docx — nothing applies this in this test');
    const link = path.join(root, 'notes.txt');
    try {
      await fs.promises.symlink(realDocx, link);
    } catch {
      return; // no symlink rights on this platform — skip
    }
    const client = start(root, { [DOC_COMMENTS_MCP_POLL_TIMEOUT_ENV]: '5000' });
    const callPromise = client.callTool('AddComment', { path: 'notes.txt', selector: SELECTOR, text: 'via disguised symlink' }, 8000);

    const pendingDir = path.join(root, '.youcoded', 'comments', '.pending');
    let requestFile: string | null = null;
    // Same 7 s deadline as the symlink case below (a spawned client, slow to start under load).
    for (const deadline = Date.now() + 7000; !requestFile && Date.now() < deadline;) {
      if (fs.existsSync(pendingDir)) {
        const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json') && !f.endsWith('.result.json'));
        if (files.length) requestFile = path.join(pendingDir, files[0]);
      }
      if (!requestFile) await new Promise((r) => setTimeout(r, 25));
    }
    expect(requestFile).not.toBeNull();
    const request = JSON.parse(fs.readFileSync(requestFile!, 'utf8'));
    expect(request.format).toBe('docx');
    // The wire `path` still carries the caller's ORIGINAL name — the main
    // process's own resolution (doc-comments-dispatch.ts) is what actually
    // writes into the real file; this script only had to pick the right
    // dispatch BRANCH, not rewrite the argument.
    expect(request.path).toBe('notes.txt');

    // Let the (very short) poll time out rather than hang the test.
    const res = await callPromise;
    expect(res.result.isError).toBe(true);
  }, 15000);

  it('relays a queue result\'s persisted reply id into the success text, when the queue provides one', async () => {
    const client = start(root, { [DOC_COMMENTS_MCP_POLL_TIMEOUT_ENV]: '5000' });
    const docPath = 'report.docx';
    const callPromise = client.callTool('ReplyToComment', { path: docPath, commentId: 'w-1', text: 'a reply' }, 8000);

    const pendingDir = path.join(root, '.youcoded', 'comments', '.pending');
    let requestFile: string | null = null;
    // Same 7 s deadline as the symlink case below (a spawned client, slow to start under load).
    for (const deadline = Date.now() + 7000; !requestFile && Date.now() < deadline;) {
      if (fs.existsSync(pendingDir)) {
        const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json') && !f.endsWith('.result.json'));
        if (files.length) requestFile = path.join(pendingDir, files[0]);
      }
      if (!requestFile) await new Promise((r) => setTimeout(r, 25));
    }
    expect(requestFile).not.toBeNull();
    // Stand in for T9b's own queue (pending-mutation-queue.test.ts pins THAT
    // side): write the result the real applier would once docx-comments.ts's
    // reply function returns a persisted CommentReply (design commit
    // 6c612cb9) — this test proves the SCRIPT'S OWN consumption of that
    // shape, not the applier that produces it.
    const id = path.basename(requestFile!, '.json');
    const resultPath = path.join(pendingDir, `${id}.result.json`);
    fs.writeFileSync(resultPath, JSON.stringify({ ok: true, reply: { id: 'w-1-r7', author: 'assistant', text: 'a reply', createdAt: Date.now() } }));

    const res = await callPromise;
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain('Reply w-1-r7 added');
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
    expect(docCommentsMcpMutatorTools(id)).not.toContain(docCommentsMcpReadTool(id));
  });
});

// Guard (T9c): the doc-comments MCP server exists in TWO places — embedded in
// claude-code-doc-comments-mcp.ts (desktop writes it into userData per
// session) and as an Android asset (ClaudeCodeDocCommentsMcp.kt writes it
// into .claude-mobile per session). They must stay byte-identical, and the
// server-prefix/tool-name vocabulary must agree across TypeScript and Kotlin.
// Same shape as claude-code-mcp.test.ts's own SendUserLink parity test — drift
// here is invisible until a phone silently loses the doc-comments tools.
describe('desktop and Android copies', () => {
  const ANDROID_ASSET = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'doc-comments-mcp.js');
  const ANDROID_DEPLOY_KT = path.join(
    __dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'ClaudeCodeDocCommentsMcp.kt',
  );
  const ANDROID_NAMES_KT = path.join(
    __dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'doccomments', 'DocCommentsMcpNames.kt',
  );

  describe('doc-comments MCP server parity', () => {
    it('the embedded desktop copy is byte-identical to the Android asset', () => {
      // WHY: byte-identical comparison — DOC_COMMENTS_SERVER_JS is a TS
      // string constant (already substituted with the real env var names and
      // tool descriptions, same as what deployClaudeCodeDocCommentsMcp writes
      // to disk), never a disk read, so it cannot be run through readSource.
      expect(DOC_COMMENTS_SERVER_JS).toBe(fs.readFileSync(ANDROID_ASSET, 'utf8'));
    });

    it('the server source stays String.raw-safe', () => {
      // A backtick would end the template early and a ${ would interpolate —
      // either one corrupts the embedded copy silently at build time.
      expect(DOC_COMMENTS_SERVER_JS.includes('`')).toBe(false);
      expect(DOC_COMMENTS_SERVER_JS.includes('${')).toBe(false);
    });

    it('Kotlin declares the same asset filename and env var names', () => {
      const kt = fs.readFileSync(ANDROID_DEPLOY_KT, 'utf8');
      expect(kt).toContain(`const val SERVER_FILE = "doc-comments-mcp.js"`);
      expect(kt).toContain(`const val PROJECT_ROOT_ENV = "${YOUCODED_PROJECT_ROOT_ENV}"`);
      expect(kt).toContain(`const val TOKEN_ENV = "${YOUCODED_MCP_TOKEN_ENV}"`);
    });

    it('Kotlin composes the same server prefix and mutator tool names', () => {
      const kt = fs.readFileSync(ANDROID_NAMES_KT, 'utf8');
      expect(kt).toContain(`const val SERVER_PREFIX = "${DOC_COMMENTS_MCP_SERVER_PREFIX}"`);
      const id = 'youcoded-doc-comments-deadbeef';
      // Kotlin's own mutatorTools()/readTool() can't be called from a TS
      // test — this asserts the bare tool-name LIST agrees literally, the
      // same drift class the desktop-side docCommentsMcpMutatorTools test
      // above guards on the TS side.
      for (const bare of ['ReplyToComment', 'ResolveComment', 'ReopenComment', 'AddComment', 'MoveComment']) {
        expect(docCommentsMcpMutatorTools(id)).toContain(`mcp__${id}__${bare}`);
        expect(kt).toContain(`"${bare}"`);
      }
      expect(docCommentsMcpReadTool(id)).toBe(`mcp__${id}__ReadFileComments`);
    });
  });
});
