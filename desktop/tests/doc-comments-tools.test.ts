// Pins T8 of the doc-comments build (docs/active/specs/2026-09-26-doc-
// comments-build-design.md §5, §5.2a): the six native harness tools
// (ReadFileComments/ReplyToComment/ResolveComment/ReopenComment/AddComment/
// MoveComment) — that they dispatch correctly to the plain-text sidecar
// store vs. the Word/Excel native readers/writers by file extension (the
// SAME nativeFormatFor decision doc-comments-dispatch.ts's own header says
// every caller must share); that every mutation's `path` is containment-
// checked identically to the IPC surface (review 3, F1's own mandate — "T8...
// each add the same shape of test at their own surface"), including a
// symlink-inside-the-project escape; that the chosen §5.2a permissionSubject
// (option 1, Destin "fine w A") actually changes how decidePermission()
// routes a call; and that a comment never previously `list()`-ed in THIS
// process is still reachable by `{path, commentId, ...}` alone (no warm
// per-process cache the way the mock renderer store had one).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ReadFileCommentsTool,
  ReplyToCommentTool,
  ResolveCommentTool,
  ReopenCommentTool,
  AddCommentTool,
  MoveCommentTool,
} from '../src/main/harness/tools/doc-comments-tools';
import type { ToolContext } from '../src/main/harness/tools/types';
import { decidePermission } from '../src/main/harness/permission-engine';
import { addComment } from '../src/main/doc-comments/doc-comments-store';
import type { CellSelector, CommentSelector, TextQuoteSelector } from '../src/shared/doc-comments-types';

const CELL_SELECTOR: CommentSelector = { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1' } as CellSelector };
const TEXT_SELECTOR: CommentSelector = {
  kind: 'text',
  selector: { type: 'TextQuoteSelector', exact: 'hello', prefix: '', suffix: ' world', occurrence: 0 } as TextQuoteSelector,
};
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'doc-comments');

let root: string;

function makeCtx(cwd: string): ToolContext {
  return { sessionId: 'test', cwd, signal: new AbortController().signal, readRegistry: new Map(), todos: [] };
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-tools-'));
});
afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('per-tool execute against a plain-text sidecar target', () => {
  it('AddComment → ReadFileComments → ReplyToComment → ResolveComment → ReopenComment → MoveComment all round-trip', async () => {
    const ctx = makeCtx(root);

    const added = await AddCommentTool.execute({ path: 'docs/plan.md', selector: TEXT_SELECTOR, text: 'Can we cut this?' }, ctx);
    expect(added.isError).toBeFalsy();
    const idMatch = added.text.match(/id: (c-[0-9a-f-]+)\)/);
    expect(idMatch, added.text).toBeTruthy();
    const id = idMatch![1];

    const listed = await ReadFileCommentsTool.execute({ path: 'docs/plan.md' }, ctx);
    expect(listed.isError).toBeFalsy();
    expect(listed.text).toContain(id);
    expect(listed.text).toContain('Can we cut this?');
    expect(listed.text).toContain('open');

    const replied = await ReplyToCommentTool.execute({ path: 'docs/plan.md', commentId: id, text: 'Yes, done.' }, ctx);
    expect(replied).toEqual({ text: `Reply added to comment ${id} on docs/plan.md.` });

    const resolved = await ResolveCommentTool.execute({ path: 'docs/plan.md', commentId: id }, ctx);
    expect(resolved).toEqual({ text: `Comment ${id} on docs/plan.md marked resolved.` });

    const afterResolve = await ReadFileCommentsTool.execute({ path: 'docs/plan.md' }, ctx);
    expect(afterResolve.text).toContain('resolved');
    expect(afterResolve.text).toContain('assistant: Yes, done.');

    const reopened = await ReopenCommentTool.execute({ path: 'docs/plan.md', commentId: id }, ctx);
    expect(reopened).toEqual({ text: `Comment ${id} on docs/plan.md reopened.` });

    const moved = await MoveCommentTool.execute({ path: 'docs/plan.md', commentId: id, newSelector: CELL_SELECTOR }, ctx);
    expect(moved).toEqual({ text: `Comment ${id} on docs/plan.md repointed.` });
  });

  it('ReadFileComments reports "No comments" for a file with none, never an error', async () => {
    const ctx = makeCtx(root);
    const result = await ReadFileCommentsTool.execute({ path: 'docs/empty.md' }, ctx);
    expect(result).toEqual({ text: 'No comments on docs/empty.md.' });
  });

  it('a mutation against an id that does not exist refuses honestly, naming the tool', async () => {
    const ctx = makeCtx(root);
    const result = await ReplyToCommentTool.execute({ path: 'docs/plan.md', commentId: 'c-does-not-exist', text: 'x' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toBe('ReplyToComment failed: comment-not-found');
  });
});

describe('dispatch by extension — Word/Excel targets route through the native readers/writers', () => {
  it('AddComment/ReadFileComments on a .docx target mint a docx-shaped id and read it back', async () => {
    await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), path.join(root, 'docs', 'launch-brief.docx'));
    const ctx = makeCtx(root);
    const textSelector: CommentSelector = {
      kind: 'text',
      selector: { type: 'TextQuoteSelector', exact: 'Marketing emails go out', prefix: '', suffix: '', occurrence: 0 },
    };
    const added = await AddCommentTool.execute({ path: 'docs/launch-brief.docx', selector: textSelector, text: 'assistant note' }, ctx);
    expect(added.isError).toBeFalsy();
    expect(added.text).toMatch(/id: w-/);

    const listed = await ReadFileCommentsTool.execute({ path: 'docs/launch-brief.docx' }, ctx);
    expect(listed.isError).toBeFalsy();
    expect(listed.text).toContain('assistant note');
  });

  it('AddComment/ReadFileComments on a .xlsx target mint an xlsx-shaped id and read it back', async () => {
    await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'q3-sales-by-rep.xlsx'), path.join(root, 'reports', 'q3.xlsx'));
    const ctx = makeCtx(root);
    const cellSelector: CommentSelector = { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1', sheet: 'Q3' } as CellSelector };
    const added = await AddCommentTool.execute({ path: 'reports/q3.xlsx', selector: cellSelector, text: 'assistant note' }, ctx);
    expect(added.isError).toBeFalsy();
    expect(added.text).toMatch(/id: x-/);

    const listed = await ReadFileCommentsTool.execute({ path: 'reports/q3.xlsx' }, ctx);
    expect(listed.isError).toBeFalsy();
    expect(listed.text).toContain('assistant note');
  });
});

describe('path containment refusal at the tool-argument surface (review 3, F1 / review 2, F1)', () => {
  const evil = '../../../../../../etc/passwd';

  it('AddComment refuses a ../../etc/passwd-shaped path', async () => {
    const ctx = makeCtx(root);
    const r = await AddCommentTool.execute({ path: evil, selector: CELL_SELECTOR, text: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('AddComment failed: path-outside-project');
  });

  it('ReplyToComment/ResolveComment/ReopenComment/MoveComment all refuse the same shaped path', async () => {
    const ctx = makeCtx(root);
    await expect(ReplyToCommentTool.execute({ path: evil, commentId: 'c-x', text: 'x' }, ctx))
      .resolves.toEqual({ text: 'ReplyToComment failed: path-outside-project', isError: true });
    await expect(ResolveCommentTool.execute({ path: evil, commentId: 'c-x' }, ctx))
      .resolves.toEqual({ text: 'ResolveComment failed: path-outside-project', isError: true });
    await expect(ReopenCommentTool.execute({ path: evil, commentId: 'c-x' }, ctx))
      .resolves.toEqual({ text: 'ReopenComment failed: path-outside-project', isError: true });
    await expect(MoveCommentTool.execute({ path: evil, commentId: 'c-x', newSelector: CELL_SELECTOR }, ctx))
      .resolves.toEqual({ text: 'MoveComment failed: path-outside-project', isError: true });
  });

  it('ReadFileComments also refuses the same shaped path (a read, but still model-controlled input)', async () => {
    const ctx = makeCtx(root);
    const r = await ReadFileCommentsTool.execute({ path: evil }, ctx);
    expect(r).toEqual({ text: 'ReadFileComments failed: path-outside-project', isError: true });
  });

  it('an absolute path outside the project root is refused the same way', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-tools-outside-'));
    try {
      const ctx = makeCtx(root);
      const r = await AddCommentTool.execute({ path: path.join(outside, 'x.md'), selector: CELL_SELECTOR, text: 'x' }, ctx);
      expect(r).toEqual({ text: 'AddComment failed: path-outside-project', isError: true });
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('a symlink inside the project pointing OUTSIDE it is refused on every mutation tool (realpath, not string containment)', async () => {
    const secret = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-tools-secret-'));
    const secretFile = path.join(secret, 'x.md');
    await fs.promises.writeFile(secretFile, 'do not comment on me');
    const link = path.join(root, 'escape.md');
    try {
      await fs.promises.symlink(secretFile, link);
    } catch {
      return; // no symlink rights on this platform — skip, same precedent as doc-comments-store.test.ts
    }
    try {
      const ctx = makeCtx(root);
      await expect(AddCommentTool.execute({ path: 'escape.md', selector: CELL_SELECTOR, text: 'x' }, ctx))
        .resolves.toEqual({ text: 'AddComment failed: path-outside-project', isError: true });
      await expect(ReplyToCommentTool.execute({ path: 'escape.md', commentId: 'c-x', text: 'x' }, ctx))
        .resolves.toEqual({ text: 'ReplyToComment failed: path-outside-project', isError: true });
      await expect(ResolveCommentTool.execute({ path: 'escape.md', commentId: 'c-x' }, ctx))
        .resolves.toEqual({ text: 'ResolveComment failed: path-outside-project', isError: true });
      await expect(ReopenCommentTool.execute({ path: 'escape.md', commentId: 'c-x' }, ctx))
        .resolves.toEqual({ text: 'ReopenComment failed: path-outside-project', isError: true });
      await expect(MoveCommentTool.execute({ path: 'escape.md', commentId: 'c-x', newSelector: CELL_SELECTOR }, ctx))
        .resolves.toEqual({ text: 'MoveComment failed: path-outside-project', isError: true });
    } finally {
      await fs.promises.rm(secret, { recursive: true, force: true });
    }
  });
});

describe('permission gate: a Word/Excel-targeted mutation is subject-matched by path, a plain-text one is not', () => {
  it('a Word/Excel target uses the real path as its permission subject; a plain-text target has none', () => {
    const docxPath = path.join(root, 'docs', 'brief.docx');
    const xlsxPath = path.join(root, 'reports', 'q3.xlsx');
    const mdPath = path.join(root, 'docs', 'plan.md');

    for (const tool of [ReplyToCommentTool, ResolveCommentTool, ReopenCommentTool, MoveCommentTool]) {
      expect(tool.permissionSubject({ path: docxPath, commentId: 'w-1', text: 'x', newSelector: CELL_SELECTOR } as any)).toBe(docxPath);
      expect(tool.permissionSubject({ path: xlsxPath, commentId: 'x-1', text: 'x', newSelector: CELL_SELECTOR } as any)).toBe(xlsxPath);
      expect(tool.permissionSubject({ path: mdPath, commentId: 'c-1', text: 'x', newSelector: CELL_SELECTOR } as any)).toBeUndefined();
    }
    expect(AddCommentTool.permissionSubject({ path: docxPath, selector: CELL_SELECTOR, text: 'x' } as any)).toBe(docxPath);
    expect(AddCommentTool.permissionSubject({ path: mdPath, selector: CELL_SELECTOR, text: 'x' } as any)).toBeUndefined();

    // ReadFileComments is a read — never gated, in either case.
    expect(ReadFileCommentsTool.permissionSubject({ path: docxPath } as any)).toBeUndefined();
    expect(ReadFileCommentsTool.permissionSubject({ path: mdPath } as any)).toBeUndefined();
  });

  it('that subject actually changes how decidePermission() routes the call: a rule keyed on the .docx path binds a Word-targeted mutation but not a plain-text one', () => {
    const docxPath = path.join(root, 'docs', 'brief.docx');
    const mdPath = path.join(root, 'docs', 'plan.md');
    const layers = {
      presetRules: [{ tool: 'ReplyToComment', pattern: docxPath, action: 'deny' as const }],
      modeRules: [],
      denyList: [],
      rememberedRules: [],
    };

    const docxSubject = ReplyToCommentTool.permissionSubject({ path: docxPath, commentId: 'w-1', text: 'x' } as any);
    expect(decidePermission('ReplyToComment', docxSubject, layers)).toEqual({ action: 'deny', denyListed: false });

    // The SAME rule (keyed on the docx path) must not reach a plain-text
    // target's subject — its subject is undefined (tool-name-only matching),
    // and decidePermission's own safe default when nothing matches is 'ask',
    // never a silent allow OR an accidental match on an unrelated file's rule.
    const mdSubject = ReplyToCommentTool.permissionSubject({ path: mdPath, commentId: 'c-1', text: 'x' } as any);
    expect(mdSubject).toBeUndefined();
    expect(decidePermission('ReplyToComment', mdSubject, layers)).toEqual({ action: 'ask', denyListed: false });
  });
});

describe('a comment never list()-ed in THIS process is still reachable by {path, commentId, ...} alone (review 3, F1)', () => {
  it('reply/resolve/reopen/move all succeed against a cold id — no warm per-process cache', async () => {
    const seeded = await addComment({ path: 'docs/cold.md', projectRoot: root, selector: CELL_SELECTOR, text: 'seed', author: 'user' });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const ctx = makeCtx(root);
    const id = seeded.id;

    await expect(ReplyToCommentTool.execute({ path: 'docs/cold.md', commentId: id, text: 'hi' }, ctx))
      .resolves.toEqual({ text: `Reply added to comment ${id} on docs/cold.md.` });
    await expect(ResolveCommentTool.execute({ path: 'docs/cold.md', commentId: id }, ctx))
      .resolves.toEqual({ text: `Comment ${id} on docs/cold.md marked resolved.` });
    await expect(ReopenCommentTool.execute({ path: 'docs/cold.md', commentId: id }, ctx))
      .resolves.toEqual({ text: `Comment ${id} on docs/cold.md reopened.` });
    await expect(MoveCommentTool.execute({ path: 'docs/cold.md', commentId: id, newSelector: CELL_SELECTOR }, ctx))
      .resolves.toEqual({ text: `Comment ${id} on docs/cold.md repointed.` });
  });
});

describe('AddComment description text', () => {
  it('carries the exact "sparingly" wording verbatim (R4 — this drifting is how R4 quietly regresses)', () => {
    expect(AddCommentTool.description).toBe(
      "Leave a comment on this file — sparingly. Use this only for something that clearly needs the user's "
      + "attention or a decision from them, never to narrate what you just did or are about to do. If you're "
      + "explaining your own edit, say so in your reply to them instead; if nothing needs their decision, don't "
      + 'add a comment at all.',
    );
  });
});
