// Pins T1 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §1.5): the one-sidecar-per-file store, its containment check
// (review 1 F3, corrected review 2 F1 — realpath the FULL joined path, not
// just the root, so a symlink inside the project can't dodge it), and its
// lock-path canonicalization (review 2 F3 — the project root only, never a
// possibly-nonexistent leaf, so a first-ever write's lock is still stable
// across two aliases of the same project). Also pins the commit a219ab9dd
// implementation-review fixes: F1's `rel` now comes from the resolved,
// containment-verified target (never the unresolved path, which could carry
// stray `..` through an outside-rooted symlink); F3's corrupt/unsupported-
// version sidecar refusal; F4's absolute-path requirement on the fallback
// path; and F5's walk-up depth cap.
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
  resolveWatchTarget,
  editComment,
  editReply,
  deleteComment,
  deleteReply,
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

    // T5 review (design §1.6, F2): `reply` returns the persisted
    // `CommentReply` uniformly for the plain sidecar too.
    const replied = await replyToComment({ path: 'docs/plan.md', projectRoot: root, id: added.id, text: 'Yes', author: 'assistant' });
    expect(replied).toEqual({
      ok: true,
      reply: { id: `${added.id}-r1`, author: 'assistant', text: 'Yes', createdAt: expect.any(Number) },
    });

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

// Edit/delete build (2026-09-28, design doc §"Edit and delete") — anyone's
// comment/reply can be edited or deleted (decisions.json), no "edited"
// marker is stored, and deleting a thread's first comment deletes the whole
// thread (replies included).
describe('edit / delete', () => {
  it('editComment overwrites text in place, with no edited marker anywhere in the record', async () => {
    const added = await addComment({ path: 'docs/plan.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'original', author: 'user' });
    if (!added.ok) throw new Error('setup');
    const edited = await editComment({ path: 'docs/plan.md', projectRoot: root, id: added.id, text: 'rewritten' });
    expect(edited).toEqual({ ok: true });
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'plan.md.json');
    const onDisk = await readSidecar(sidecarPath);
    expect(onDisk.comments[0].text).toBe('rewritten');
    expect(Object.keys(onDisk.comments[0])).not.toContain('edited');
    expect(Object.keys(onDisk.comments[0])).not.toContain('editedAt');
  });

  it('editComment against an unknown id refuses cleanly', async () => {
    const result = await editComment({ path: 'docs/plan.md', projectRoot: root, id: 'c-missing', text: 'x' });
    expect(result).toEqual({ ok: false, error: 'comment-not-found' });
  });

  it('editReply overwrites one reply and returns the persisted CommentReply, leaving the parent and other replies untouched', async () => {
    const added = await addComment({ path: 'docs/plan.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'original', author: 'user' });
    if (!added.ok) throw new Error('setup');
    await replyToComment({ path: 'docs/plan.md', projectRoot: root, id: added.id, text: 'reply one', author: 'assistant' });
    const second = await replyToComment({ path: 'docs/plan.md', projectRoot: root, id: added.id, text: 'reply two', author: 'user' });
    if (!second.ok) throw new Error('setup');
    const edited = await editReply({ path: 'docs/plan.md', projectRoot: root, id: added.id, replyId: second.reply.id, text: 'reply two, edited' });
    expect(edited).toEqual({ ok: true, reply: { id: second.reply.id, author: 'user', text: 'reply two, edited', createdAt: expect.any(Number) } });
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'plan.md.json');
    const onDisk = await readSidecar(sidecarPath);
    expect(onDisk.comments[0].text).toBe('original'); // parent untouched
    expect(onDisk.comments[0].replies.map((r) => r.text)).toEqual(['reply one', 'reply two, edited']);
  });

  it('deleteComment removes a thread\'s FIRST comment and every reply with it (decisions.json)', async () => {
    const added = await addComment({ path: 'docs/plan.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'root', author: 'user' });
    if (!added.ok) throw new Error('setup');
    await replyToComment({ path: 'docs/plan.md', projectRoot: root, id: added.id, text: 'a reply', author: 'assistant' });
    const other = await addComment({ path: 'docs/plan.md', projectRoot: root, selector: { kind: 'text', selector: { ...TEXT_QUOTE, exact: 'other' } }, text: 'unrelated thread', author: 'user' });
    if (!other.ok) throw new Error('setup');

    const deleted = await deleteComment({ path: 'docs/plan.md', projectRoot: root, id: added.id });
    expect(deleted).toEqual({ ok: true });
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'plan.md.json');
    const onDisk = await readSidecar(sidecarPath);
    expect(onDisk.comments.map((c) => c.id)).toEqual([other.id]); // the OTHER thread survives, replies-and-all gone with the deleted one
  });

  it('deleteComment against an unknown id refuses cleanly', async () => {
    const result = await deleteComment({ path: 'docs/plan.md', projectRoot: root, id: 'c-missing' });
    expect(result).toEqual({ ok: false, error: 'comment-not-found' });
  });

  it('deleteReply removes ONE reply, leaving the parent comment and its other replies intact', async () => {
    const added = await addComment({ path: 'docs/plan.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'root', author: 'user' });
    if (!added.ok) throw new Error('setup');
    const first = await replyToComment({ path: 'docs/plan.md', projectRoot: root, id: added.id, text: 'reply one', author: 'assistant' });
    const second = await replyToComment({ path: 'docs/plan.md', projectRoot: root, id: added.id, text: 'reply two', author: 'user' });
    if (!first.ok || !second.ok) throw new Error('setup');

    const deleted = await deleteReply({ path: 'docs/plan.md', projectRoot: root, id: added.id, replyId: first.reply.id });
    expect(deleted).toEqual({ ok: true });
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'plan.md.json');
    const onDisk = await readSidecar(sidecarPath);
    expect(onDisk.comments[0].id).toBe(added.id); // the thread itself survives
    expect(onDisk.comments[0].replies).toEqual([expect.objectContaining({ id: second.reply.id, text: 'reply two' })]);
  });

  it('deleteReply against an unknown reply id refuses cleanly, leaving the comment untouched', async () => {
    const added = await addComment({ path: 'docs/plan.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'root', author: 'user' });
    if (!added.ok) throw new Error('setup');
    const result = await deleteReply({ path: 'docs/plan.md', projectRoot: root, id: added.id, replyId: `${added.id}-r9` });
    expect(result).toEqual({ ok: false, error: 'comment-not-found' });
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
    // T5 review (design §1.6, F2): the enriched reply shape applies here too.
    await expect(replyToComment({ ...args, text: 'hi', author: 'assistant' })).resolves.toEqual({
      ok: true,
      reply: { id: 'c-cold-start-r1', author: 'assistant', text: 'hi', createdAt: expect.any(Number) },
    });
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

  it('refuses a relative path with no projectRoot instead of resolving it against the process cwd (F4)', async () => {
    // path.resolve('relative/path') with no base resolves against
    // process.cwd() — never a caller-meaningful directory in the fallback
    // case, since there is no root to resolve against by design (§1.4).
    const result = await addComment({ path: 'relative/standalone.md', selector: TEXT_SELECTOR, text: 'x', author: 'user' });
    expect(result).toEqual({ ok: false, error: 'path-not-absolute' });
  });
});

describe('corrupt or unsupported-version sidecar (F3)', () => {
  it('listComments refuses a sidecar with invalid JSON instead of throwing', async () => {
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'broken.md.json');
    await fs.promises.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.promises.writeFile(sidecarPath, '{ not valid json');

    await expect(listComments({ path: 'docs/broken.md', projectRoot: root })).resolves.toEqual({
      ok: false,
      error: 'sidecar-corrupt',
    });
  });

  it('listComments refuses a sidecar with an unsupported/missing version instead of treating it as valid', async () => {
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'future.md.json');
    await fs.promises.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.promises.writeFile(sidecarPath, JSON.stringify({ version: 2, comments: [] }));

    await expect(listComments({ path: 'docs/future.md', projectRoot: root })).resolves.toEqual({
      ok: false,
      error: 'sidecar-corrupt',
    });
  });

  it('a mutation against a corrupt sidecar refuses without writing anything', async () => {
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'broken2.md.json');
    await fs.promises.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.promises.writeFile(sidecarPath, 'not json at all');
    const before = await fs.promises.readFile(sidecarPath, 'utf8');

    const result = await addComment({ path: 'docs/broken2.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'x', author: 'user' });
    expect(result).toEqual({ ok: false, error: 'sidecar-corrupt' });

    // The mutation must never have touched the file — refusing means refusing,
    // not repairing it into a fresh empty sidecar and losing whatever was there.
    const after = await fs.promises.readFile(sidecarPath, 'utf8');
    expect(after).toBe(before);
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

  it('a symlink OUTSIDE the project that points back INSIDE it cannot push the sidecar out of .youcoded/comments (F1)', async () => {
    // Review F1 (blocker): the old code passed containment (the REAL target
    // is inside the project) but then computed `rel` from the UNRESOLVED
    // path, which still contained the `..` segments used to walk OUT to the
    // symlink before it led back IN — joining that onto the project root put
    // the sidecar outside `.youcoded/comments`. Shape from the finding:
    // project `/x/work/myproject`, symlink `/x/linked -> .../myproject/subdir`,
    // argument `../linked/file.md`.
    const subdir = path.join(root, 'subdir');
    await fs.promises.mkdir(subdir);
    await fs.promises.writeFile(path.join(subdir, 'file.md'), 'hello');

    const outsideLink = path.join(os.tmpdir(), `ycd-doc-comments-linked-${process.pid}`);
    try {
      await fs.promises.symlink(subdir, outsideLink, 'dir');
    } catch {
      return; // no symlink rights on this platform — skip
    }
    try {
      // One '..' from `root` reaches its parent (os.tmpdir(), where mkdtemp
      // put `root`), then into the outside symlink, then back down to the
      // real file — the string path never looks like it stays in-project.
      const relPath = path.join('..', path.basename(outsideLink), 'file.md');
      const result = await addComment({ path: relPath, projectRoot: root, selector: TEXT_SELECTOR, text: 'via-symlink', author: 'user' });
      expect(result.ok).toBe(true);

      // The sidecar must land under <realProjectRoot>/.youcoded/comments —
      // never outside it, and never outside the project root entirely.
      const realRoot = await fs.promises.realpath(root);
      const commentsDir = path.join(realRoot, '.youcoded', 'comments') + path.sep;
      const expectedSidecar = path.join(realRoot, '.youcoded', 'comments', 'subdir', 'file.md.json');
      expect(expectedSidecar.startsWith(commentsDir)).toBe(true);
      const onDisk = await readSidecar(expectedSidecar);
      expect(onDisk.comments).toHaveLength(1);
      expect(onDisk.comments[0].text).toBe('via-symlink');
    } finally {
      await fs.promises.rm(outsideLink, { force: true });
    }
  });
});

describe('walk-up depth cap (F5)', () => {
  it('refuses a path whose non-existent ancestor chain exceeds the walk-up cap, instead of walking forever', async () => {
    // 250 non-existent nested segments — comfortably past any sane cap. This
    // must refuse cleanly (fail closed, matching every other "can't verify
    // containment" case), never hang or throw.
    const deepRel = path.join(...Array.from({ length: 250 }, (_, i) => `level${i}`), 'file.md');
    const result = await addComment({ path: deepRel, projectRoot: root, selector: TEXT_SELECTOR, text: 'x', author: 'user' });
    expect(result).toEqual({ ok: false, error: 'path-outside-project' });
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

// F4 (T5 implementation review): the RENDERER mints the comment id now
// (`c-${randomUUID()}`) and passes it here — main uses it instead of minting
// its own, closing the local-id/server-id swap window the old design had.
describe('addComment — caller-supplied id (F4, T5 review)', () => {
  const CALLER_ID = 'c-11111111-2222-4333-8444-555555555555';

  it('uses the caller-supplied id instead of minting its own', async () => {
    const added = await addComment({
      path: 'docs/id.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'x', author: 'user', id: CALLER_ID,
    });
    expect(added).toEqual({ ok: true, id: CALLER_ID });
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'id.md.json');
    const onDisk = await readSidecar(sidecarPath);
    expect(onDisk.comments[0].id).toBe(CALLER_ID);
  });

  it('still mints its own id when none is supplied (an unupdated caller)', async () => {
    const added = await addComment({ path: 'docs/id2.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'x', author: 'user' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.id).toMatch(/^c-[0-9a-f-]{36}$/i);
  });

  it('refuses a caller-supplied id that is not shaped like this store\'s own ids', async () => {
    const result = await addComment({
      path: 'docs/id3.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'x', author: 'user', id: 'not-a-real-id',
    });
    expect(result).toEqual({ ok: false, error: 'invalid-id' });
  });

  it('refuses a caller-supplied id that collides with one already in this file\'s sidecar', async () => {
    const first = await addComment({
      path: 'docs/id4.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'first', author: 'user', id: CALLER_ID,
    });
    expect(first.ok).toBe(true);
    const second = await addComment({
      path: 'docs/id4.md', projectRoot: root, selector: TEXT_SELECTOR, text: 'second', author: 'user', id: CALLER_ID,
    });
    expect(second).toEqual({ ok: false, error: 'duplicate-id' });
    // The FIRST comment is untouched — a refused duplicate never overwrites.
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'id4.md.json');
    const onDisk = await readSidecar(sidecarPath);
    expect(onDisk.comments).toHaveLength(1);
    expect(onDisk.comments[0].text).toBe('first');
  });
});

// T3 follow-up (design §1.5's new bullet, "A second, narrower watcher for a
// .docx/.xlsx target's OWN file" — round 2 F1, corrected round 3 F1):
// `resolveWatchTarget` must produce the THIRD `{kind:'document', ...}`
// variant for a native-format target, INSTEAD OF (never alongside) the
// `{kind:'project', ...}` sidecar-directory target — a native-format file has
// no sidecar to watch at all (§1.1).
describe('resolveWatchTarget — native-format target replaces the project sidecar watch (T3 follow-up)', () => {
  it('resolves a .docx target inside a known project to a document watch target, not a project one', async () => {
    const abs = path.join(root, 'report.docx');
    await fs.promises.writeFile(abs, 'not a real docx, just needs to exist');
    const result = await resolveWatchTarget({ path: 'report.docx', projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.kind).toBe('document');
    if (result.target.kind !== 'document') return;
    expect(result.target.absolutePath).toBe(await fs.promises.realpath(abs));
    expect(result.target.sourcePath).toBe('report.docx');
    expect(result.target.projectRoot).toBe(root);
  });

  // Live-refresh review (2026-09-27, finding 1 — high): a no-`projectRoot`
  // native-format watch must run the identical `authorizeBytesRead` gate
  // `listNativeComments`/`resolveDocxTarget`/`resolveXlsxTarget` already run
  // for a READ — a temp-dir file that is real and readable but never a saved
  // folder, an indexed project, or a tracked external artifact is refused,
  // mirroring doc-comments-dispatch.test.ts's own "fallback (no projectRoot)
  // source-file gate" tests for list/add exactly (this suite has no fixture
  // for the POSITIVE untracked-but-somehow-authorized case either, for the
  // same reason: constructing a genuinely tracked root outside `tempProjectRoot()`
  // would need the real artifacts-tracking registry this unit test doesn't stand up).
  it('refuses an untracked absolute .xlsx path with no projectRoot, same as list/add', async () => {
    const abs = path.join(root, 'budget.xlsx');
    await fs.promises.writeFile(abs, 'not a real xlsx, just needs to exist');
    const result = await resolveWatchTarget({ path: abs });
    expect(result).toEqual({ ok: false, error: 'path-not-tracked' });
  });

  it('still resolves a plain-text target to the ordinary project sidecar-directory watch', async () => {
    const result = await resolveWatchTarget({ path: 'notes.md', projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.kind).toBe('project');
  });

  it('refuses a .docx target that resolves outside the project, same as list/add', async () => {
    const result = await resolveWatchTarget({ path: '../../etc/passwd.docx', projectRoot: root });
    expect(result).toEqual({ ok: false, error: 'path-outside-project' });
  });
});
