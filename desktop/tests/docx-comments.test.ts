// Word (.docx) comment read/write in the Electron main process (no renderer/jsdom).
// Fixtures: tests/fixtures/doc-comments/*.docx (see make-docx-fixtures.mjs); extra shapes are built in memory.
import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp, rm, stat } from 'fs/promises';
// WHY dirname/basename (not slicing at '/'): Windows temp paths use backslashes.
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import JSZip from 'jszip';
import {
  readDocxComments,
  addDocxComment,
  replyToDocxComment,
  resolveDocxComment,
  reopenDocxComment,
  moveDocxComment,
  editDocxComment,
  editDocxReply,
  deleteDocxComment,
  deleteDocxReply,
  writeDocxMutation,
  DOCX_BACKUP_SUFFIX,
} from '../src/main/doc-comments/docx-comments';
import { backupPathFor } from '../src/main/doc-comments/write-pipeline';
import { buildDeclaredOversizeZip, buildRealZipBomb, buildCorruptedEntryZip } from './fixtures/doc-comments/oversized-zip';
import type { CommentSelector } from '../src/shared/doc-comments-types';

const exists = (p: string) => stat(p).then(() => true, () => false);
const FIXTURES_DIR = join(__dirname, 'fixtures', 'doc-comments');
const loadFixture = (name: string) => readFile(join(FIXTURES_DIR, name));
const LB = 'docs/launch-brief.docx';
const MARKETING = 'Marketing emails go out the same morning as the public launch.';

function textSelector(exact: string): CommentSelector {
  return { kind: 'text', selector: { type: 'TextQuoteSelector', exact, prefix: '', suffix: '', occurrence: 0 } };
}

async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ycd-docx-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const withBytes = <T>(name: string, bytes: Buffer, fn: (target: string) => Promise<T>) =>
  inTempDir(async (dir) => {
    const target = join(dir, name);
    await writeFile(target, bytes);
    return fn(target);
  });
const withScratchCopy = async <T>(fixtureName: string, fn: (target: string) => Promise<T>) =>
  withBytes(fixtureName, await loadFixture(fixtureName), fn);

/** All comments read back from the file on disk (throws if the read itself fails). */
async function commentsOf(target: string, path = LB) {
  const r = await readDocxComments(await readFile(target), path);
  if (!r.ok) throw new Error(`read failed: ${r.error}`);
  return r.comments;
}
type Comment = Awaited<ReturnType<typeof commentsOf>>[number];
function quote(c: Comment | undefined) {
  if (c?.selector.kind !== 'text') throw new Error('expected a text selector');
  return c.selector.selector;
}
const byId = (cs: Comment[], id: string) => cs.find((c) => c.id === id);
const add = (target: string, selector: CommentSelector, text = 'x', author: 'user' | 'assistant' = 'user', path = LB) =>
  addDocxComment({ absolutePath: target, path, selector, text, author });
const zipOf = async (target: string) => JSZip.loadAsync(await readFile(target));
const partOf = async (target: string, name: string) => (await zipOf(target)).file(name)!.async('string');
const count = (xml: string, re: RegExp) => (xml.match(re) ?? []).length;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A minimal docx built in memory: `bodyInner` is the whole <w:body>, `commentsInner` the comments part's children. */
async function buildDocx(
  bodyInner: string,
  opts: { commentsInner?: string; commentsRootAttrs?: string; extraEntry?: { name: string; body: string } } = {}
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`);
  zip.file('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/comments" Target="comments.xml"/></Relationships>`);
  zip.file('word/document.xml', `${XML}<w:document ${W} ${W14}><w:body>${bodyInner}</w:body></w:document>`);
  zip.file('word/comments.xml', `${XML}<w:comments ${opts.commentsRootAttrs ?? `${W} ${W14}`}>${opts.commentsInner ?? ''}</w:comments>`);
  if (opts.extraEntry) zip.file(opts.extraEntry.name, opts.extraEntry.body);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const para = (inner: string) => `<w:p>${inner}</w:p>`;
const run = (t: string) => `<w:r><w:t>${t}</w:t></w:r>`;

// WHY the absence of a DOM-environment docblock IS the pin: Electron's main process has no DOM,
// so a global DOMParser here would mean something pulled in a renderer-only assumption.
it('runs in a plain Node environment (no global DOMParser)', () => {
  expect(typeof (globalThis as { DOMParser?: unknown }).DOMParser).toBe('undefined');
});

describe('docx-comments read', () => {
  it('reads top-level comments with author, text, resolved state, selector and reply threads', async () => {
    const result = await readDocxComments(await loadFixture('launch-brief.docx'), LB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comments).toHaveLength(2);

    const goal = result.comments.find((c) => c.text.startsWith('Is 30% realistic'));
    expect(goal).toMatchObject({ author: 'person:Priya Shah', resolved: true, replies: [], path: LB }); // w15:done="1"
    expect(quote(goal).exact).toBe('Move 30% of weekly active users to the new app within six weeks of launch.');

    // Reply thread via w15:paraIdParent
    const timeline = result.comments.find((c) => c.text.startsWith('Legal needs the beta terms'));
    expect(timeline?.resolved).toBe(false); // w15:done="0"
    expect(timeline?.replies).toHaveLength(1);
    expect(timeline?.replies[0]).toMatchObject({
      author: 'person:Marcus Lee',
      text: 'Confirmed with legal — the beta terms are ready as of this morning.',
    });
    expect(timeline?.replies[0].id).toBe(`${timeline?.id}-r1`); // account-ready id shape
    // The reply is never a separate top-level record.
    expect(result.comments).not.toContainEqual(expect.objectContaining({ text: expect.stringContaining('Confirmed with legal') }));

    // TextQuoteSelector with prefix/suffix context
    const q = quote(timeline);
    expect(q.exact).toBe('Beta opens to 500 customers on March 10');
    expect(q.prefix.length).toBeGreaterThan(0);
    expect(q.suffix).toContain(', with the public launch');
  });

  it('returns an empty list for a docx with no comments.xml', async () => {
    expect(await readDocxComments(await loadFixture('no-comments.docx'), 'docs/no-comments.docx')).toEqual({ ok: true, comments: [] });
  });

  it('refuses a non-zip honestly instead of throwing', async () => {
    expect(await readDocxComments(Buffer.from('not a docx'), 'docs/garbage.docx')).toEqual({ ok: false, error: 'invalid-docx' });
  });

  it('finds a comment nested thousands of levels deep without overflowing the stack', async () => {
    const result = await readDocxComments(await loadFixture('deeply-nested.docx'), 'docs/deeply-nested.docx');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].text).toBe('A comment buried very deep in the document tree.');
    expect(quote(result.comments[0]).exact).toBe('A comment buried very deep in the document tree.');
  });

  it('captures a quote spanning multiple runs and two paragraphs, with prefix/suffix', async () => {
    const r = await readDocxComments(await loadFixture('spanning-comment.docx'), 'docs/spanning-comment.docx');
    if (!r.ok) throw new Error(r.error);
    expect(r.comments).toHaveLength(1);
    const [c] = r.comments;
    expect(c.text).toBe('Should this be one paragraph instead of two?');
    expect(quote(c).exact).toBe('first half \nsecond half.');
    expect(quote(c).prefix).toContain('Before the change:');
    expect(quote(c).suffix).toContain('After the note.');
  });
});

describe('docx-comments read — decompression-bomb-shaped archives', () => {
  const DOC = '<w:document><w:body/></w:document>';
  // WHY a named budget: the real-bomb test builds AND decompresses a 201 MB zip (2.3 s alone, measured 2026-09-28);
  // under `verify.sh --full` wall time inflates several-fold past the 30 s default, so ~50x the alone time.
  const REAL_ZIP_BOMB_BUDGET_MS = 120_000;

  it.each(['word/comments.xml', 'word/document.xml'])('refuses %s declaring an implausible uncompressed size', async (entry) => {
    const bytes = await buildDeclaredOversizeZip({ 'word/document.xml': DOC, 'word/comments.xml': '<w:comments/>' }, entry, 500 * 1024 * 1024);
    expect(await readDocxComments(bytes, 'docs/bomb.docx')).toEqual({ ok: false, error: 'archive-too-large' });
  });

  it('refuses an entry whose REAL decompressed bytes exceed the ceiling, with no declared-size lie', async () => {
    const bytes = await buildRealZipBomb({ 'word/document.xml': DOC }, 'word/comments.xml', 201 * 1024 * 1024);
    expect(await readDocxComments(bytes, 'docs/real-bomb.docx')).toEqual({ ok: false, error: 'archive-too-large' });
  }, REAL_ZIP_BOMB_BUDGET_MS);

  it("reports a genuinely corrupted entry as 'invalid-docx', never 'archive-too-large'", async () => {
    const bytes = await buildCorruptedEntryZip(
      { 'word/document.xml': DOC, 'word/comments.xml': '<w:comments><w:comment w:id="0"/></w:comments>' },
      'word/comments.xml'
    );
    expect(await readDocxComments(bytes, 'docs/corrupt.docx')).toEqual({ ok: false, error: 'invalid-docx' });
  });
});

describe('docx-comments write — add', () => {
  it('adds a comment that round-trips through the same reader and leaves existing ones alone', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const result = await add(target, textSelector(MARKETING), 'Confirm the send time with marketing.');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.id).toMatch(/^w-\d+$/);
      const cs = await commentsOf(target);
      const added = byId(cs, result.id);
      expect(added).toMatchObject({ text: 'Confirm the send time with marketing.', author: 'person:You', resolved: false });
      expect(quote(added).exact).toBe(MARKETING);
      expect(byId(cs, 'w-0')).toMatchObject({ author: 'person:Priya Shah', resolved: true, text: expect.stringContaining('Is 30% realistic') });
    });
  });

  it('creates comments.xml (+ content-types override + relationship) for a docx with no comments part', async () => {
    await withScratchCopy('no-comments.docx', async (target) => {
      expect((await zipOf(target)).file('word/comments.xml')).toBeNull();
      const result = await add(target, textSelector('Nothing here has ever been commented on.'), 'First comment this file has ever had.', 'assistant', 'docs/no-comments.docx');
      expect(result.ok).toBe(true);
      expect(await partOf(target, '[Content_Types].xml')).toContain('/word/comments.xml');
      expect(await partOf(target, 'word/_rels/document.xml.rels')).toContain('comments.xml');
      const cs = await commentsOf(target, 'docs/no-comments.docx');
      expect(cs).toHaveLength(1);
      expect(cs[0]).toMatchObject({ author: 'person:Assistant', text: 'First comment this file has ever had.' });
    });
  });

  it('inserts a multi-run, two-paragraph comment around an EXISTING range without disturbing it', async () => {
    await withScratchCopy('spanning-comment.docx', async (target) => {
      const result = await add(target, textSelector('half \nsecond'), 'A second, independent multi-paragraph comment.', 'user', 'docs/spanning-comment.docx');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const cs = await commentsOf(target, 'docs/spanning-comment.docx');
      expect(cs).toHaveLength(2);
      expect(quote(byId(cs, result.id)).exact).toBe('half \nsecond');
      expect(quote(byId(cs, 'w-5')).exact).toBe('first half \nsecond half.');
      expect(byId(cs, 'w-5')?.text).toBe('Should this be one paragraph instead of two?');
    });
  });

  it('splits a run when the quote sits strictly inside it, leaving the other comment on that paragraph intact', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const result = await add(target, textSelector('30%'), 'Just the percentage.');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const cs = await commentsOf(target);
      const q = quote(byId(cs, result.id));
      expect(q.exact).toBe('30%');
      expect(q.prefix).toContain('Move');
      expect(q.suffix).toContain('of weekly');
      expect(quote(byId(cs, 'w-0')).exact).toBe('Move 30% of weekly active users to the new app within six weeks of launch.');
    });
  });

  it('mints (max existing w:id) + 1 against gapped ids, never a count-based id', async () => {
    const body = ['3', '7'].map((id, i) => `<w:p w14:paraId="E000000${i + 1}"><w:commentRangeStart w:id="${id}"/>${run('Commented run.')}<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r></w:p>`).join('')
      + '<w:p w14:paraId="E0000003">' + run('A brand new sentence with nothing commented yet.') + '</w:p>';
    const commentsInner = ['3', '7'].map((id) => `<w:comment w:id="${id}" w:author="Priya Shah" w:date="2026-09-26T09:00:00Z"><w:p w14:paraId="F000000${id}">${run('Note.')}</w:p></w:comment>`).join('');
    await withBytes('gapped.docx', await buildDocx(body, { commentsInner }), async (target) => {
      const result = await add(target, textSelector('A brand new sentence with nothing commented yet.'), 'x', 'user', 'docs/gapped.docx');
      expect(result.ok && result.id).toBe('w-8'); // existing ids 3 and 7
    });
  });

  it.each([
    ['a selector that does not resolve', textSelector('this text does not exist anywhere in the document'), 'selector-not-found'],
    ['a cell selector against a Word target', { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1' } } as CommentSelector, 'invalid-selector'],
  ])('refuses %s, leaving the file untouched', async (_n, selector, error) => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const before = await readFile(target);
      expect(await add(target, selector)).toEqual({ ok: false, error });
      expect(await readFile(target)).toEqual(before);
    });
  });

  // WHY strip instead of refuse: control characters arrive via paste, invisible to the user, so a refusal they cannot act on is worse.
  it('strips XML-illegal control characters from comment text and replies, but keeps tab/newline/CR', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const added = await add(target, textSelector(MARKETING), 'before\x01\x02\x1Fafter');
      expect(added).toEqual({ ok: true, id: expect.any(String), text: 'beforeafter' });
      expect(byId(await commentsOf(target), added.ok ? added.id : '')?.text).toBe('beforeafter');

      const reply = await replyToDocxComment({ absolutePath: target, path: LB, id: 'w-0', text: 'x\x00y', author: 'user' });
      expect(reply).toEqual({ ok: true, reply: { id: expect.any(String), author: 'user', text: 'xy', createdAt: expect.any(Number) } });

      const ws = await add(target, textSelector('Keep support tickets'), 'line one\nline two\ttabbed\rcr');
      expect(ws.ok && ws.text).toBe('line one\nline two\ttabbed\rcr');
    });
  });
});

describe('docx-comments write — reply / resolve / reopen / move / edit / delete', () => {
  it('appends a reply (author stays the caller value) keeping the existing thread', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const result = await replyToDocxComment({ absolutePath: target, path: LB, id: 'w-1', text: 'Sounds good, thanks both.', author: 'user' });
      // WHY 'user' not 'person:You': the response carries the caller's original author so the renderer's optimistic entry swaps in place.
      expect(result).toEqual({ ok: true, reply: { id: 'w-1-r2', author: 'user', text: 'Sounds good, thanks both.', createdAt: expect.any(Number) } });
      const t = byId(await commentsOf(target), 'w-1');
      expect(t?.replies).toHaveLength(2);
      expect(t?.replies[0]).toMatchObject({ author: 'person:Marcus Lee' });
      expect(t?.replies[1]).toMatchObject({ id: 'w-1-r2', author: 'person:You', text: 'Sounds good, thanks both.' });
    });
  });

  it('resolve sets w15:done and reopen clears it, creating commentsExtended.xml if the file had none', async () => {
    await withScratchCopy('spanning-comment.docx', async (target) => {
      const p = 'docs/spanning-comment.docx';
      expect((await zipOf(target)).file('word/commentsExtended.xml')).toBeNull();
      expect(await resolveDocxComment({ absolutePath: target, path: p, id: 'w-5' })).toEqual({ ok: true });
      expect((await commentsOf(target, p))[0].resolved).toBe(true);
      expect(await reopenDocxComment({ absolutePath: target, path: p, id: 'w-5' })).toEqual({ ok: true });
      expect((await commentsOf(target, p))[0].resolved).toBe(false);
    });
  });

  it('resolving an already-resolved comment updates the EXISTING entry rather than duplicating it', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      await reopenDocxComment({ absolutePath: target, path: LB, id: 'w-0' }); // starts resolved
      await resolveDocxComment({ absolutePath: target, path: LB, id: 'w-0' });
      expect(count(await partOf(target, 'word/commentsExtended.xml'), /w15:paraId="10000000"/g)).toBe(1);
      const cs = await commentsOf(target);
      expect(byId(cs, 'w-0')?.resolved).toBe(true);
      expect(byId(cs, 'w-1')).toMatchObject({ resolved: false, replies: [expect.anything()] }); // unrelated entries untouched
    });
  });

  it('move relocates a comment: old range gone, new one resolves, id/replies/resolved state unchanged', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const newText = 'Keep support tickets about the update below 200 per week.';
      expect(await moveDocxComment({ absolutePath: target, path: LB, id: 'w-1', newSelector: textSelector(newText) })).toEqual({ ok: true });
      const xml = await partOf(target, 'word/document.xml');
      expect(xml).not.toMatch(/Beta opens to 500 customers[\s\S]{0,80}w:id="1"/);
      for (const tag of ['commentRangeStart', 'commentRangeEnd', 'commentReference']) {
        expect(count(xml, new RegExp(`w:${tag} w:id="1"`, 'g'))).toBe(1);
      }
      const moved = byId(await commentsOf(target), 'w-1');
      expect(quote(moved).exact).toBe(newText);
      expect(moved?.replies).toHaveLength(1);
      expect(moved?.replies[0]).toMatchObject({ author: 'person:Marcus Lee' });
      expect(moved?.resolved).toBe(false);
    });
  });

  it('move refuses an unresolvable newSelector, leaving the file byte-identical (never a silent delete)', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const before = await readFile(target);
      expect(await moveDocxComment({ absolutePath: target, path: LB, id: 'w-1', newSelector: textSelector('this text is nowhere in the document') }))
        .toEqual({ ok: false, error: 'selector-not-found' });
      expect(await readFile(target)).toEqual(before);
    });
  });

  it('edit replaces the comment text only; author, date, anchor, replies and resolved state survive', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const before = byId(await commentsOf(target), 'w-1');
      expect(await editDocxComment({ absolutePath: target, path: LB, id: 'w-1', text: 'Rewritten note.' })).toEqual({ ok: true, text: 'Rewritten note.' });
      const edited = byId(await commentsOf(target), 'w-1');
      expect(edited?.text).toBe('Rewritten note.');
      expect(edited).toMatchObject({ author: before?.author, createdAt: before?.createdAt, selector: before?.selector, replies: before?.replies });
      const xml = await partOf(target, 'word/document.xml');
      expect(count(xml, /w:commentRangeStart w:id="1"/g)).toBe(1);
      expect(count(xml, /w:commentReference w:id="1"/g)).toBe(1);
    });
  });

  it('editDocxReply replaces one reply text, leaving the parent and the reply author/date untouched', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const before = byId(await commentsOf(target), 'w-1');
      const r = before!.replies[0];
      expect(await editDocxReply({ absolutePath: target, path: LB, id: 'w-1', replyId: r.id, text: 'Edited reply.' }))
        .toEqual({ ok: true, reply: { id: r.id, author: r.author, text: 'Edited reply.', createdAt: r.createdAt } });
      const parent = byId(await commentsOf(target), 'w-1');
      expect(parent?.text).toBe(before?.text);
      expect(parent?.replies).toEqual([{ ...r, text: 'Edited reply.' }]);
    });
  });

  it('delete removes the whole thread (root, reply, both anchors) with no dangling relationships/content-types', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      expect(await deleteDocxComment({ absolutePath: target, path: LB, id: 'w-1' })).toEqual({ ok: true });
      const cs = await commentsOf(target);
      expect(byId(cs, 'w-1')).toBeUndefined();
      expect(byId(cs, 'w-0')).toBeDefined(); // surgical, not a rebuild
      const zip = await zipOf(target);
      const documentXml = await zip.file('word/document.xml')!.async('string');
      expect(documentXml).not.toMatch(/w:id="1"/);
      const relIds = new Set(Array.from((await zip.file('word/_rels/document.xml.rels')!.async('string')).matchAll(/Id="([^"]+)"/g)).map((m) => m[1]));
      for (const m of documentXml.matchAll(/r:id="([^"]+)"/g)) expect(relIds.has(m[1])).toBe(true);
      expect(await zip.file('[Content_Types].xml')!.async('string')).toContain('/word/comments.xml');
    });
  });

  it('delete of a reply-less comment removes only its own anchors, leaving siblings (with replies) untouched', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      expect(await deleteDocxComment({ absolutePath: target, path: LB, id: 'w-0' })).toEqual({ ok: true });
      const cs = await commentsOf(target);
      expect(byId(cs, 'w-0')).toBeUndefined();
      expect(byId(cs, 'w-1')).toBeDefined();
    });
  });

  it('deleteDocxReply removes ONE reply, leaving the root comment and its anchor', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const replyId = byId(await commentsOf(target), 'w-1')!.replies[0].id;
      expect(await deleteDocxReply({ absolutePath: target, path: LB, id: 'w-1', replyId })).toEqual({ ok: true });
      expect(byId(await commentsOf(target), 'w-1')?.replies).toHaveLength(0);
      expect(count(await partOf(target, 'word/document.xml'), /w:commentRangeStart w:id="1"/g)).toBe(1);
    });
  });

  const base = { absolutePath: '', path: LB };
  it.each([
    ['reply', (a: typeof base) => replyToDocxComment({ ...a, id: 'w-999', text: 'x', author: 'user' })],
    ['resolve', (a: typeof base) => resolveDocxComment({ ...a, id: 'w-999' })],
    ['move', (a: typeof base) => moveDocxComment({ ...a, id: 'w-999', newSelector: textSelector('Keep support tickets') })],
    ['edit', (a: typeof base) => editDocxComment({ ...a, id: 'w-999', text: 'x' })],
    ['delete', (a: typeof base) => deleteDocxComment({ ...a, id: 'w-999' })],
    ['edit reply', (a: typeof base) => editDocxReply({ ...a, id: 'w-1', replyId: 'w-1-r9', text: 'x' })],
    ['delete reply', (a: typeof base) => deleteDocxReply({ ...a, id: 'w-1', replyId: 'w-1-r9' })],
  ])('%s refuses an id this file does not have, leaving the file byte-identical', async (_n, op) => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const before = await readFile(target);
      expect(await op({ ...base, absolutePath: target })).toEqual({ ok: false, error: 'comment-not-found' });
      expect(await readFile(target)).toEqual(before);
    });
  });
});

describe('docx-comments write — a file open elsewhere is refused before backup', () => {
  it('refuses with a Word owner file (~$name) beside it, without touching the backup or target, and proceeds once it is gone', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const owner = join(dirname(target), `~$${basename(target)}`);
      await writeFile(owner, 'destin');
      const before = await readFile(target);
      const backupPath = backupPathFor(target, DOCX_BACKUP_SUFFIX);
      expect(await add(target, textSelector('Marketing emails go out'))).toEqual({ ok: false, error: 'file-open-elsewhere' });
      expect(await exists(backupPath)).toBe(false); // never reached the backup step
      expect(await readFile(target)).toEqual(before);
      await rm(owner, { force: true });
      expect(await resolveDocxComment({ absolutePath: target, path: LB, id: 'w-0' })).toEqual({ ok: true });
    });
  });

  it('refuses when a LibreOffice lock file (.~lock.<name>#) sits beside it', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      await writeFile(join(dirname(target), `.~lock.${basename(target)}#`), ',destin,localhost,01-01-2026 00:00,file:///home/destin;');
      expect(await replyToDocxComment({ absolutePath: target, path: LB, id: 'w-0', text: 'x', author: 'user' })).toEqual({ ok: false, error: 'file-open-elsewhere' });
    });
  });

  // WHY: Word shortens its owner file's name (8+ chars drop the first two, exactly 7 drop one), so a full-name-only check missed most documents.
  it.each([
    ['Report2024.docx', '~$port2024.docx'],
    ['Minutes.docx', '~$nutes.docx'],
    ['Budget.docx', '~$Budget.docx'],
  ])('refuses %s while %s sits beside it', async (name, owner) => {
    const bytes = await buildDocx(para(run('Some text here')));
    await withBytes(name, bytes, async (target) => {
      await writeFile(join(dirname(target), owner), 'destin');
      expect(await add(target, textSelector('text'), 'x', 'user', name)).toEqual({ ok: false, error: 'file-open-elsewhere' });
      expect(await readFile(target)).toEqual(bytes);
    });
  });
});

describe('docx-comments write — verify-after-write with automatic rollback', () => {
  const append = (b: number) => async (bytes: Buffer) => ({ ok: true as const, bytes: Buffer.concat([bytes, Buffer.from([b])]) });

  it('a failed verification restores the original bytes exactly and keeps the backup as the standing safety copy', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const before = await readFile(target);
      expect(await writeDocxMutation(target, append(0), async () => false)).toEqual({ ok: false, error: 'verify-failed' });
      expect(await readFile(target)).toEqual(before);
      expect(await readFile(backupPathFor(target, DOCX_BACKUP_SUFFIX))).toEqual(before);
    });
  });

  // WHY: a backup under ~/.claude cannot be RENAMED onto another drive (EXDEV); the restore must not depend on the backup file.
  it('the restore also works when the backup file is gone mid-verify', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const before = await readFile(target);
      const backupPath = backupPathFor(target, DOCX_BACKUP_SUFFIX);
      const result = await writeDocxMutation(target, append(0), async () => { await rm(backupPath, { force: true }); return false; });
      expect(result).toEqual({ ok: false, error: 'verify-failed' });
      expect(await readFile(target)).toEqual(before);
    });
  });

  it('the backup exists WHILE verify runs and is KEPT after success, holding the pre-write bytes', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const backupPath = backupPathFor(target, DOCX_BACKUP_SUFFIX);
      const before = await readFile(target);
      let sawBackup = false;
      const result = await writeDocxMutation(target, async (bytes) => ({ ok: true, bytes }), async () => { sawBackup = await exists(backupPath); return true; });
      expect(result).toEqual({ ok: true });
      expect(sawBackup).toBe(true);
      expect(await readFile(backupPath)).toEqual(before);
    });
  });

  it('keeps one rolling backup per file: a second write overwrites the same path with the latest pre-write bytes', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const backupPath = backupPathFor(target, DOCX_BACKUP_SUFFIX);
      const first = await readFile(target);
      await writeDocxMutation(target, async (bytes) => ({ ok: true, bytes }), async () => true);
      expect(await readFile(backupPath)).toEqual(first);
      const second = await readFile(target);
      expect(await writeDocxMutation(target, append(1), async () => true)).toEqual({ ok: true });
      expect(backupPathFor(target, DOCX_BACKUP_SUFFIX)).toBe(backupPath);
      expect(await readFile(backupPath)).toEqual(second);
    });
  });

  it('two concurrent mutations on one file serialize and neither is lost', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      const [a, b] = await Promise.all([
        add(target, textSelector(MARKETING), 'First concurrent comment.'),
        add(target, textSelector('The payment screen has not been tested on older Android phones.'), 'Second concurrent comment.', 'assistant'),
      ]);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.id).not.toBe(b.id);
      const cs = await commentsOf(target);
      expect(cs).toHaveLength(4);
      expect(cs.map((c) => c.text)).toEqual(expect.arrayContaining(['First concurrent comment.', 'Second concurrent comment.']));
    });
  });

  it('rolls back a write whose output uses an undeclared namespace prefix even if the format check passed', async () => {
    await withBytes('built.docx', await buildDocx(para(run('Some text here'))), async (target) => {
      const before = await readFile(target);
      const result = await writeDocxMutation(
        target,
        async (current) => {
          const zip = await JSZip.loadAsync(current);
          const xml = await zip.file('word/comments.xml')!.async('string');
          zip.file('word/comments.xml', xml.replace('</w:comments>', '<w:comment w:id="0"><w:p w99:paraId="1"/></w:comment></w:comments>'));
          return { ok: true, bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) };
        },
        async () => true
      );
      expect(result).toEqual({ ok: false, error: 'verify-failed' });
      expect(await readFile(target)).toEqual(before);
    });
  });
});

describe('docx-comments write — a realistic Word 365 file (word365-realistic.docx)', () => {
  const WHO = 'docs/word365-realistic.docx';
  const REGION = textSelector('look strong across every region');
  const PARTS = ['word/document.xml', 'word/comments.xml', '[Content_Types].xml', 'word/_rels/document.xml.rels'];
  const snapshot = async (target: string) => Object.fromEntries(await Promise.all(PARTS.map(async (n) => [n, await partOf(target, n)])));

  it('adding a comment succeeds despite a dangling hyperlink r:id, which stays byte-for-byte untouched', async () => {
    await withScratchCopy('word365-realistic.docx', async (target) => {
      const hyperlink = '<w:hyperlink r:id="rId99"><w:r><w:t xml:space="preserve">External reference</w:t></w:r></w:hyperlink>';
      expect(await partOf(target, 'word/document.xml')).toContain(hyperlink);
      // WHY: verification once judged the WHOLE document, failing writes over a relationship this op never touched.
      expect((await add(target, REGION, 'Which regions specifically?', 'user', WHO)).ok).toBe(true);
      expect(await partOf(target, 'word/document.xml')).toContain(hyperlink);
    });
  });

  // Each op may change only the parts it owns; everything else must round-trip byte-identical.
  it.each([
    ['resolve', ['word/comments.xml', 'word/document.xml', '[Content_Types].xml', 'word/_rels/document.xml.rels'],
      (t: string) => resolveDocxComment({ absolutePath: t, path: WHO, id: 'w-0' }), 'w15:done="1"'],
    ['reopen', ['word/comments.xml', 'word/document.xml', '[Content_Types].xml', 'word/_rels/document.xml.rels'],
      (t: string) => reopenDocxComment({ absolutePath: t, path: WHO, id: 'w-0' }), 'w15:done="0"'],
    ['reply', ['word/document.xml', '[Content_Types].xml', 'word/_rels/document.xml.rels'],
      (t: string) => replyToDocxComment({ absolutePath: t, path: WHO, id: 'w-0', text: 'Broken out by region in the appendix.', author: 'user' }), 'Broken out by region in the appendix.'],
  ])('%s leaves untouched parts byte-identical', async (op, untouched, run, expected) => {
    await withScratchCopy('word365-realistic.docx', async (target) => {
      // reopen needs a resolved comment first, so snapshot AFTER that setup
      if (op === 'reopen') await resolveDocxComment({ absolutePath: target, path: WHO, id: 'w-0' });
      const before = await snapshot(target);
      const result = await run(target);
      expect(result.ok).toBe(true);
      const after = await snapshot(target);
      for (const n of untouched) expect(after[n]).toBe(before[n]);
      const changed = op === 'reply' ? after['word/comments.xml'] : await partOf(target, 'word/commentsExtended.xml');
      expect(changed).toContain(expected);
    });
  });

  it('add changes only document.xml (range markers + reference run) and comments.xml; content-types and rels stay identical', async () => {
    await withScratchCopy('word365-realistic.docx', async (target) => {
      const before = await snapshot(target);
      // Whole run start-to-end so no run split is needed: the only diff is the three inserted marker strings.
      const result = await add(target, textSelector('The results look strong across every region this cycle, well ahead of plan.'), 'Which regions specifically?', 'user', WHO);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const id = result.id.slice('w-'.length);
      const after = await snapshot(target);
      expect(after['[Content_Types].xml']).toBe(before['[Content_Types].xml']);
      expect(after['word/_rels/document.xml.rels']).toBe(before['word/_rels/document.xml.rels']);
      const normalized = after['word/document.xml']
        .replace(`<w:commentRangeStart w:id="${id}"/>`, '')
        .replace(`<w:commentRangeEnd w:id="${id}"/>`, '')
        .replace(`<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`, '');
      expect(normalized).toBe(before['word/document.xml']);
    });
  });

  // WHY: splitRunAtOffsets once cloned only w:rPr, dropping the rsid attributes Word stamps on <w:r>.
  it('a comment strictly inside an rsid-bearing run keeps rsidR/rsidRDefault on all three pieces', async () => {
    await withScratchCopy('word365-realistic.docx', async (target) => {
      expect((await add(target, REGION, 'Which regions specifically?', 'user', WHO)).ok).toBe(true);
      const tags = (await partOf(target, 'word/document.xml')).match(/<w:r\b[^>]*>/g) ?? [];
      for (const a of ['w:rsidR', 'w:rsidRDefault']) {
        expect(tags.filter((t) => attr(t, a) === '00CC5678')).toHaveLength(3); // before / quote / after
      }
    });
  });

  /** Order-independent attribute lookup: linkedom does not serialize attributes in set order. */
  function attr(tag: string, name: string): string | null {
    const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
    return m ? m[1] : null;
  }
  const selfClosing = (xml: string, tagName: string) => xml.match(new RegExp(`<${tagName}\\b[^>]*/>`, 'g')) ?? [];

  it('add appends matching w16cid/w16cex entries sharing a fresh durable id when both parts exist; a reply does too', async () => {
    await withScratchCopy('word365-realistic.docx', async (target) => {
      const result = await add(target, REGION, 'Which regions specifically?', 'user', WHO);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const rawId = result.id.slice('w-'.length);
      const block = ((await partOf(target, 'word/comments.xml')).match(/<w:comment\b[^>]*>[\s\S]*?<\/w:comment>/g) ?? []).find((b) => attr(b, 'w:id') === rawId);
      const paraId = attr(block!, 'w14:paraId');
      expect(paraId).not.toBeNull();

      const ids = selfClosing(await partOf(target, 'word/commentsIds.xml'), 'w16cid:commentId');
      expect(ids).toHaveLength(2);
      expect(ids.some((t) => attr(t, 'w16cid:paraId') === 'AAAA0001' && attr(t, 'w16cid:durableId') === '00000001')).toBe(true); // original untouched
      const durable = attr(ids.find((t) => attr(t, 'w16cid:paraId') === paraId)!, 'w16cid:durableId');
      expect(durable).not.toBeNull();
      expect(durable).not.toBe('00000001');
      const ext = selfClosing(await partOf(target, 'word/commentsExtensible.xml'), 'w16cex:commentExtensible');
      expect(ext).toHaveLength(2);
      expect(ext.some((t) => attr(t, 'w16cex:durableId') === '00000001')).toBe(true);
      const newExt = ext.find((t) => attr(t, 'w16cex:durableId') === durable);
      expect(newExt).toBeDefined();
      expect(attr(newExt!, 'w16cex:dateUtc')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
    // A reply is its own new <w:comment>, so it also gets an entry in each part.
    await withScratchCopy('word365-realistic.docx', async (target) => {
      expect((await replyToDocxComment({ absolutePath: target, path: WHO, id: 'w-0', text: 'Broken out by region in the appendix.', author: 'user' })).ok).toBe(true);
      expect(selfClosing(await partOf(target, 'word/commentsIds.xml'), 'w16cid:commentId')).toHaveLength(2);
      expect(selfClosing(await partOf(target, 'word/commentsExtensible.xml'), 'w16cex:commentExtensible')).toHaveLength(2);
    });
  });

  it('never creates commentsIds.xml/commentsExtensible.xml for a file that never had them', async () => {
    await withScratchCopy('launch-brief.docx', async (target) => {
      expect((await add(target, textSelector('Keep support tickets about the update below 200 per week.'), 'By channel too, please.')).ok).toBe(true);
      const zip = await zipOf(target);
      expect(zip.file('word/commentsIds.xml')).toBeNull();
      expect(zip.file('word/commentsExtensible.xml')).toBeNull();
    });
  });
});

describe('docx-comments write — shapes other producers write', () => {
  /** The paragraph's content in document order: text runs and markers flattened to a token list. */
  function paragraphTokens(documentXml: string): string[] {
    const re = /<w:t[^>]*>([^<]*)<\/w:t>|<w:(tab|br|drawing|commentRangeStart|commentRangeEnd|commentReference)\b/g;
    return Array.from(documentXml.matchAll(re), (m) => (m[1] !== undefined ? `"${m[1]}"` : m[2]));
  }
  const splitCase = async (inner: string, quoteText: string) => {
    let tokens: string[] = [];
    await withBytes('built.docx', await buildDocx(para(inner)), async (target) => {
      expect((await add(target, textSelector(quoteText), 'x', 'user', 'built.docx')).ok).toBe(true);
      tokens = paragraphTokens(await partOf(target, 'word/document.xml'));
    });
    return tokens;
  };

  // WHY: splitting a run once deleted tabs/breaks/images in it, and a quote spanning a tab threw (second marker reused a removed run).
  it.each([
    ['text after a tab in the same run', '<w:r><w:tab/><w:t>Alpha beta</w:t></w:r>', 'lph',
      ['tab', '"A"', 'commentRangeStart', '"lph"', 'commentRangeEnd', 'commentReference', '"a beta"']],
    ['a quote spanning a tab inside ONE run', '<w:r><w:t>Hello</w:t><w:tab/><w:t>World</w:t></w:r>', 'llo\tWo',
      ['"He"', 'commentRangeStart', '"llo"', 'tab', '"Wo"', 'commentRangeEnd', 'commentReference', '"rld"']],
    ['a line break and inline image in the split run', '<w:r><w:t>Before</w:t><w:br/><w:drawing/><w:t>After text</w:t></w:r>', 'ter te',
      ['"Before"', 'br', 'drawing', '"Af"', 'commentRangeStart', '"ter te"', 'commentRangeEnd', 'commentReference', '"xt"']],
  ])('splitting a run keeps every tab, break and image: %s', async (_n, inner, q, expected) => {
    expect(await splitCase(inner, q)).toEqual(expected);
  });

  it('a spanning quote still reads back exactly through the same reader', async () => {
    await withBytes('built.docx', await buildDocx(para('<w:r><w:t>Hello</w:t><w:tab/><w:t>World</w:t></w:r>')), async (target) => {
      await add(target, textSelector('llo\tWo'), 'x', 'user', 'built.docx');
      expect((await commentsOf(target, 'built.docx')).map((c) => quote(c).exact)).toEqual(['llo\tWo']);
    });
  });

  it('a tab-stop definition in the paragraph properties is not counted as a tab character', async () => {
    const inner = '<w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>' + run('Plain words');
    await withBytes('built.docx', await buildDocx(para(inner)), async (target) => {
      expect((await add(target, textSelector('Plain'), 'x', 'user', 'built.docx')).ok).toBe(true);
      expect(await partOf(target, 'word/document.xml')).toMatch(/<\/w:pPr><w:commentRangeStart w:id="0"\/>/); // marker in the paragraph, not <w:pPr>
      expect(quote((await commentsOf(target, 'built.docx'))[0]).prefix).toBe('');
    });
  });

  it('declares xmlns:w14 on a comments.xml that never had it before writing w14:paraId', async () => {
    await withBytes('built.docx', await buildDocx(para(run('Some text here')), { commentsRootAttrs: W }), async (target) => {
      expect((await add(target, textSelector('text'), 'x', 'user', 'built.docx')).ok).toBe(true);
      const xml = await partOf(target, 'word/comments.xml');
      expect(xml).toMatch(/<w:comments\b[^>]*xmlns:w14="http:\/\/schemas.microsoft.com\/office\/word\/2010\/wordml"/);
      expect(xml).toContain('w14:paraId=');
    });
  });

  it('adding one comment does not inflate a large compressible part the write never touched', async () => {
    const media = 'lorem ipsum dolor sit amet '.repeat(100_000); // ~2.7 MB, compresses to a few KB
    const bytes = await buildDocx(para(run('Some text here')), { extraEntry: { name: 'word/media/big.txt', body: media } });
    await withBytes('built.docx', bytes, async (target) => {
      expect((await add(target, textSelector('text'), 'x', 'user', 'built.docx')).ok).toBe(true);
      expect((await readFile(target)).length).toBeLessThan(bytes.length + 4096);
    });
  });
});
