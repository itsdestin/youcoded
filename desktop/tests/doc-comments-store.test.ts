// Pins T1 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §1.5): the one-sidecar-per-file store, its containment check
// (review 1 F3, corrected review 2 F1 — realpath the FULL joined path, not
// just the root, so a symlink inside the project can't dodge it), and its
// lock-path canonicalization (review 2 F3 — the project root only, never a
// possibly-nonexistent leaf, so a first-ever write's lock is still stable
// across two aliases of the same project).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
  listComments,
  addComment,
  replyToComment,
  resolveComment,
  reopenComment,
  moveComment,
} from '../src/main/doc-comments/doc-comments-store';
import type {
  CellSelector,
  CommentReply,
  CommentSelector,
  CommentsSidecarFile,
  ResolveEvent,
  TextQuoteSelector,
} from '../src/shared/doc-comments-types';

const TEXT_QUOTE: TextQuoteSelector = { type: 'TextQuoteSelector', exact: 'hello', prefix: '', suffix: ' world', occurrence: 0 };
const TEXT_SELECTOR: CommentSelector = { kind: 'text', selector: TEXT_QUOTE };
const CELL_SELECTOR_A1: CellSelector = { type: 'CellSelector', cell: 'A1' };

let root: string; // the project root

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-'));
});
afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function readSidecar(sidecarPath: string): Promise<CommentsSidecarFile> {
  return JSON.parse(await fs.promises.readFile(sidecarPath, 'utf8'));
}

describe('listComments — missing-file default', () => {
  it('a file with no sidecar returns an empty list, never an error', async () => {
    const result = await listComments({ path: 'docs/plan.md', projectRoot: root });
    expect(result).toEqual({ ok: true, comments: [] });
  });
});

describe('read-modify-write', () => {
  it('add then reply then resolve round-trips through the sidecar on disk', async () => {
    const added = await addComment({
      path: 'docs/plan.md',
      projectRoot: root,
      selector: TEXT_SELECTOR,
      text: 'Can we cut this?',
      author: 'user',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'plan.md.json');
    const onDisk = await readSidecar(sidecarPath);
    expect(onDisk.version).toBe(1);
    expect(onDisk.comments).toHaveLength(1);
    expect(onDisk.comments[0]).toMatchObject({ id: added.id, text: 'Can we cut this?', resolved: false, history: [] });

    const replied = await replyToComment({ path: 'docs/plan.md', projectRoot: root, id: added.id, text: 'Yes', author: 'assistant' });
    expect(replied).toEqual({ ok: true });

    const resolved = await resolveComment({ path: 'docs/plan.md', projectRoot: root, id: added.id, by: 'assistant' });
    expect(resolved).toEqual({ ok: true });

    const reopened = await reopenComment({ path: 'docs/plan.md', projectRoot: root, id: added.id, by: 'user' });
    expect(reopened).toEqual({ ok: true });

    const final = await readSidecar(sidecarPath);
    expect(final.comments).toHaveLength(1);
    const comment = final.comments[0];
    const expectedReply: CommentReply = { id: `${added.id}-r1`, author: 'assistant', text: 'Yes', createdAt: expect.any(Number) };
    expect(comment.replies).toEqual([expectedReply]);
    // Full audit trail (review 1, F13) — both events survive, not just the
    // latest resolved/resolvedAt-shaped state the renderer mock kept.
    const expectedHistory: ResolveEvent[] = [
      { by: 'assistant', at: expect.any(Number), action: 'resolved' },
      { by: 'user', at: expect.any(Number), action: 'reopened' },
    ];
    expect(comment.history).toEqual(expectedHistory);
    expect(comment.resolved).toBe(false);

    const moved = await moveComment({
      path: 'docs/plan.md',
      projectRoot: root,
      id: added.id,
      newSelector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'moved', prefix: '', suffix: '', occurrence: 0 } },
    });
    expect(moved).toEqual({ ok: true });
    const afterMove = await readSidecar(sidecarPath);
    expect(afterMove.comments[0].selector).toEqual({
      kind: 'text',
      selector: { type: 'TextQuoteSelector', exact: 'moved', prefix: '', suffix: '', occurrence: 0 },
    });
  });

  it('mutating a comment id that does not exist refuses without writing anything', async () => {
    // No sidecar exists yet at all — the not-found path must still refuse
    // cleanly rather than creating an empty sidecar as a side effect.
    const result = await replyToComment({ path: 'docs/none.md', projectRoot: root, id: 'c-missing', text: 'x', author: 'user' });
    expect(result).toEqual({ ok: false, error: 'comment-not-found' });
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'none.md.json');
    await expect(fs.promises.access(sidecarPath)).rejects.toThrow();
  });
});

describe('every mutation carries its own path, so no warm list() cache is needed', () => {
  it('reply/resolve/reopen/move succeed against a comment this process never called listComments() for', async () => {
    // Write the sidecar directly, bypassing this store entirely — simulates a
    // FRESH process (the MCP script, §9) acting on a comment id it only knows
    // from a prior session, with no in-memory cache from an earlier list().
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'cold.md.json');
    await fs.promises.mkdir(path.dirname(sidecarPath), { recursive: true });
    const seeded: CommentsSidecarFile = {
      version: 1,
      comments: [
        {
          id: 'c-cold-start',
          path: 'docs/cold.md',
          selector: TEXT_SELECTOR,
          text: 'seeded',
          author: 'user',
          createdAt: Date.now(),
          replies: [],
          resolved: false,
          history: [],
        },
      ],
    };
    await fs.promises.writeFile(sidecarPath, JSON.stringify(seeded));

    const args = { path: 'docs/cold.md', projectRoot: root, id: 'c-cold-start' };
    await expect(replyToComment({ ...args, text: 'hi', author: 'assistant' })).resolves.toEqual({ ok: true });
    await expect(resolveComment({ ...args, by: 'assistant' })).resolves.toEqual({ ok: true });
    await expect(reopenComment({ ...args, by: 'user' })).resolves.toEqual({ ok: true });
    await expect(
      moveComment({ ...args, newSelector: { kind: 'cell', selector: CELL_SELECTOR_A1 } })
    ).resolves.toEqual({ ok: true });
  });
});

describe('fallback path for a file with no project root', () => {
  it('addComment with no projectRoot writes under ~/.youcoded/loose-file-comments/<sha256(path)>.json', async () => {
    // os.homedir() is the suite-wide test sandbox (tests/global-setup.ts /
    // vitest.config.ts) — writing here cannot touch the developer's real home.
    const looseFile = path.join(root, 'standalone.md');
    const result = await addComment({ path: looseFile, selector: TEXT_SELECTOR, text: 'hi', author: 'user' });
    expect(result.ok).toBe(true);

    const hash = createHash('sha256').update(path.resolve(looseFile)).digest('hex');
    const expectedPath = path.join(os.homedir(), '.youcoded', 'loose-file-comments', `${hash}.json`);
    const onDisk = await readSidecar(expectedPath);
    expect(onDisk.comments).toHaveLength(1);
    expect(onDisk.comments[0].text).toBe('hi');

    // And it never touched the project-scoped sidecar location.
    const projectSidecar = path.join(root, '.youcoded', 'comments', 'standalone.md.json');
    await expect(fs.promises.access(projectSidecar)).rejects.toThrow();
  });
});

describe('path containment refusal', () => {
  it('refuses a ../../etc/passwd-shaped path', async () => {
    const result = await addComment({
      path: '../../../../../../etc/passwd',
      projectRoot: root,
      selector: TEXT_SELECTOR,
      text: 'x',
      author: 'user',
    });
    expect(result).toEqual({ ok: false, error: 'path-outside-project' });
  });

  it('refuses an absolute path argument even though it looks like a normal comment target', async () => {
    // path.resolve(root, '<absolute>') ignores `root` entirely per Node
    // semantics, so this must land outside realProjectRoot and be refused —
    // never silently clamped into the project.
    const outsideFile = path.join(os.tmpdir(), `ycd-outside-${process.pid}.txt`);
    await fs.promises.writeFile(outsideFile, 'x');
    try {
      const result = await addComment({ path: outsideFile, projectRoot: root, selector: TEXT_SELECTOR, text: 'x', author: 'user' });
      expect(result).toEqual({ ok: false, error: 'path-outside-project' });
    } finally {
      await fs.promises.rm(outsideFile, { force: true });
    }
  });

  it('a symlink inside the project root cannot reach a target outside it (the string checks all pass — only realpath catches it)', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-outside-'));
    try {
      const secret = path.join(outside, 'secret.md');
      await fs.promises.writeFile(secret, 'do not comment on me');
      const link = path.join(root, 'notes.md');
      try {
        await fs.promises.symlink(secret, link);
      } catch {
        return; // no symlink rights on this platform (Windows, unprivileged) — skip
      }
      const result = await addComment({ path: 'notes.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'x', author: 'user' });
      expect(result).toEqual({ ok: false, error: 'path-outside-project' });
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('an ordinary in-project path is unaffected by the containment check', async () => {
    const result = await addComment({ path: 'src/app.ts', projectRoot: root, selector: TEXT_SELECTOR, text: 'x', author: 'user' });
    expect(result.ok).toBe(true);
  });
});

describe('concurrent-lock behavior — a true concurrency race, not just a sequential check', () => {
  it('two writers racing to create the SAME sidecar for the first time both land — no write is lost', async () => {
    // The single most common case per review 2 (F3): a file's FIRST-EVER
    // comment, where the sidecar does not exist yet for either writer to
    // read before racing to create it.
    const args = { path: 'docs/race.md', projectRoot: root, selector: TEXT_SELECTOR, author: 'user' as const };
    const [a, b] = await Promise.all([
      addComment({ ...args, text: 'first' }),
      addComment({ ...args, text: 'second' }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'race.md.json');
    const onDisk = await readSidecar(sidecarPath);
    expect(onDisk.comments).toHaveLength(2);
    const texts = onDisk.comments.map((c) => c.text).sort();
    expect(texts).toEqual(['first', 'second']);
  });

  it('a burst of concurrent replies to the SAME comment loses none of them', async () => {
    const added = await addComment({ path: 'docs/burst.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'root', author: 'user' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        replyToComment({ path: 'docs/burst.md', projectRoot: root, id: added.id, text: `reply-${i}`, author: 'assistant' })
      )
    );

    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'burst.md.json');
    const onDisk = await readSidecar(sidecarPath);
    expect(onDisk.comments[0].replies).toHaveLength(5);
    const replyIds = onDisk.comments[0].replies.map((r) => r.id).sort();
    expect(new Set(replyIds).size).toBe(5); // every reply id is distinct — none overwrote another
  });
});

describe('lock-path canonicalization uses the project root only, never the possibly-nonexistent leaf', () => {
  it('two aliases of the same project (a symlinked root) race the SAME lock, not two independent ones', async () => {
    const alias = path.join(os.tmpdir(), `ycd-doc-comments-alias-${process.pid}`);
    try {
      await fs.promises.symlink(root, alias, 'dir');
    } catch {
      return; // no symlink rights on this platform — skip
    }
    try {
      // Both writers target the SAME file's FIRST-EVER comment, one through
      // the real root and one through its symlinked alias. If the lock path
      // were derived by realpathing the (not-yet-existing) leaf sidecar —
      // the round-1 fix review 2 corrected — this ENOENTs on both sides and
      // they fall through to non-canonical, non-colliding lock names,
      // silently reopening the alias trap. Canonicalizing the ROOT only means
      // both writers agree on one lock regardless of which alias they used.
      const [a, b] = await Promise.all([
        addComment({ path: 'docs/alias-race.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'via-root', author: 'user' }),
        addComment({ path: 'docs/alias-race.md', projectRoot: alias, selector: TEXT_SELECTOR, text: 'via-alias', author: 'user' }),
      ]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);

      // Both writes must have landed in the ONE real sidecar — proving they
      // shared a lock and neither clobbered the other's read-modify-write.
      const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'alias-race.md.json');
      const onDisk = await readSidecar(sidecarPath);
      expect(onDisk.comments).toHaveLength(2);
      expect(onDisk.comments.map((c) => c.text).sort()).toEqual(['via-alias', 'via-root']);
    } finally {
      await fs.promises.rm(alias, { force: true });
    }
  });
});
