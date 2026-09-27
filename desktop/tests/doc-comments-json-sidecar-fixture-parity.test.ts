// Cross-implementation parity for the plain-text JSON sidecar — T4 of the
// doc-comments build (docs/active/specs/2026-09-26-doc-comments-build-
// design.md §9.1, §9.3, T4's own pinning-test row: "shared JSON fixture both
// platforms round-trip"). §9.3 already accepts, for the harder docx/xlsx
// case (T21), that "both sides match a shared, checked-in golden fixture" is
// the achievable structure across a Node/JVM split — a Node process and a
// JVM process never run inside the same test/CI job. This test applies that
// SAME accepted structure to the simpler JSON-sidecar case: the fixture at
// desktop/tests/fixtures/doc-comments/json-sidecar/thread.json is copied
// VERBATIM to app/src/test/resources/doc-comments/json-sidecar/thread.json
// (DocCommentsStoreTest.kt's own "reads the same fixture" test is that
// file's Kotlin half) — a fixture drift here can never silently make the
// cross-platform parity claim compare two different inputs, the same
// reasoning T16/T18's own docx/xlsx fixture-copy comments give.
//
// What this proves: desktop's real `listComments`/`replyToComment` (T1)
// accept a sidecar in the EXACT shape Android's independently-built
// `CommentsSidecarFile`/`PersistedComment` serializer would produce (field
// names, nesting, value types), and desktop's own mutation keeps that same
// shape afterward — so a sidecar either platform writes is one the OTHER
// platform's reader can consume without translation.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { listComments, replyToComment } from '../src/main/doc-comments/doc-comments-store';
import type { CommentsSidecarFile } from '../src/shared/doc-comments-types';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'doc-comments',
  'json-sidecar',
  'thread.json'
);

let root: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-json-parity-'));
});
afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('shared JSON sidecar fixture — desktop reads the same shape Android writes', () => {
  it('desktop\'s real listComments() parses the checked-in fixture unchanged', async () => {
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'plan.md.json');
    await fs.promises.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.promises.copyFile(FIXTURE_PATH, sidecarPath);

    const result = await listComments({ path: 'docs/plan.md', projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comments).toHaveLength(1);
    const comment = result.comments[0];
    expect(comment).toMatchObject({
      id: 'c-fixture-0001',
      path: 'docs/plan.md',
      text: 'Can we cut this?',
      author: 'person:Priya Shah',
      resolved: true,
    });
    expect(comment.selector).toEqual({
      kind: 'text',
      selector: {
        type: 'TextQuoteSelector',
        exact: 'cut the onboarding step',
        prefix: 'we should probably ',
        suffix: ' before shipping',
        occurrence: 0,
      },
    });
    expect(comment.replies).toEqual([
      { id: 'c-fixture-0001-r1', author: 'user', text: 'Agreed, cutting it.', createdAt: 1758000100000 },
    ]);
    expect(comment.history).toEqual([{ by: 'user', at: 1758000200000, action: 'resolved' }]);
  });

  it('a reply desktop appends keeps the exact field shape Android\'s own reader/writer expects', async () => {
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'plan.md.json');
    await fs.promises.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.promises.copyFile(FIXTURE_PATH, sidecarPath);

    const replied = await replyToComment({
      path: 'docs/plan.md',
      projectRoot: root,
      id: 'c-fixture-0001',
      text: 'from desktop',
      author: 'assistant',
    });
    expect(replied).toEqual({ ok: true });

    const onDisk: CommentsSidecarFile = JSON.parse(await fs.promises.readFile(sidecarPath, 'utf8'));
    expect(onDisk.version).toBe(1);
    const comment = onDisk.comments[0];
    // Every field name/type Android's CommentsSidecarFile.parse/PersistedComment.fromJson
    // (app/src/main/kotlin/com/youcoded/app/doccomments/DocCommentTypes.kt) requires
    // is present with the expected JS type — string ids, numeric timestamps, a
    // boolean `resolved`, arrays for replies/history.
    expect(typeof comment.id).toBe('string');
    expect(typeof comment.path).toBe('string');
    expect(typeof comment.text).toBe('string');
    expect(typeof comment.author).toBe('string');
    expect(typeof comment.createdAt).toBe('number');
    expect(typeof comment.resolved).toBe('boolean');
    expect(Array.isArray(comment.replies)).toBe(true);
    expect(Array.isArray(comment.history)).toBe(true);
    expect(comment.replies).toHaveLength(2);
    const newReply = comment.replies[1];
    expect(newReply.author).toBe('assistant');
    expect(newReply.text).toBe('from desktop');
    expect(typeof newReply.createdAt).toBe('number');
    expect(newReply.id).toBe('c-fixture-0001-r2');
  });
});
