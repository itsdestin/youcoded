// Cross-platform WRITE parity golden generator for T17 of the doc-comments
// build (docs/active/specs/2026-09-26-doc-comments-build-design.md §3.3,
// §3.2a, §8 T17/T21). Companion to `generate-docx-golden.mjs` (T16's READ
// parity generator) — same rationale, applied to the WRITE side: rather than
// hand-transcribing what desktop's real add/reply/resolve/reopen/move
// functions produce, this script runs them for real against a checked-in
// fixture and saves the resulting .docx, plus a JSON sidecar recording the
// exact operation arguments used. The Kotlin test
// (app/src/test/kotlin/com/youcoded/app/doccomments/
// DocxCommentsCrossPlatformParityTest.kt) replays the IDENTICAL operation
// against the SAME original fixture with the Kotlin writer, then compares
// both outputs' PersistedComment[] shape (via Kotlin's own reader, proving
// Kotlin can read what desktop wrote) field-for-field except `createdAt` —
// see this script's own "WHY NOT literal id/date injection" note below for
// why that one field is the sole deliberate exclusion.
//
// WHY NOT literal fixed-id/fixed-date injection (the task brief's own
// suggestion): the only two values `docx-comments.ts`'s write functions mint
// randomly are `w15:paraId`/`w16cid/w16cex durableId` (8 hex digits,
// `generateParaId`/`generateDurableId`) and the `w:date`/`w16cex:dateUtc`
// creation timestamp (`new Date().toISOString()`). Neither paraId nor
// durableId is EVER exposed in `PersistedComment` (§3.2's own read path only
// surfaces a comment's `w:id`-derived `id`, which for `add`/`reply` is fully
// DETERMINISTIC — `(max existing w:id) + 1`, scanned fresh from the file, so
// it already matches between two independent writers applied to the same
// input with no injection needed). The ONE observable non-determinism is
// `PersistedComment.createdAt` — excluded field-by-field in the Kotlin
// parity test's comparison, the same way a real clock is excluded from any
// two-process timing-sensitive test, rather than monkey-patching Node's
// `crypto.randomBytes`/`Date` through a live CJS binding (fragile, and
// buys nothing observable in the comparison this test actually needs).
//
// Usage: `node desktop/tests/fixtures/doc-comments/generate-docx-write-golden.mjs`
// (run BY HAND when a fixture or a writer's own output shape changes, never
// as part of `npm test`/CI — same convention as generate-docx-golden.mjs).
//
// `edit-launch-brief`/`edit-reply-launch-brief`/`delete-reply-launch-brief`/
// `delete-thread-launch-brief` (2026-09-28, design doc §"Edit and delete")
// extend this same golden set to the edit/delete ops, added for this task's
// own T21 parity extension — previously "not extended in this pass" per that
// section's own closing note. All four reuse launch-brief.docx's real w-0
// (no reply) and w-1 (one reply, w-1-r1) comments — the same ids docx-
// comments.test.ts's own edit/delete suite already exercises.
import { createServer } from 'vite';
import { readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(FIXTURES_DIR, '..', '..', '..'); // desktop/tests/fixtures/doc-comments -> desktop/
const GOLDEN_DIR = join(FIXTURES_DIR, 'write-golden');

function textSelector(exact) {
  return { kind: 'text', selector: { type: 'TextQuoteSelector', exact, prefix: '', suffix: '', occurrence: 0 } };
}

// One case per operation, including the spanning-comment and word365-
// realistic fixtures the task brief names explicitly, plus a second `move`
// case on word365-realistic (rsids + existing commentsIds.xml/
// commentsExtensible.xml parts) so move is proven against BOTH a plain and
// an extension-parts-bearing file.
const CASES = [
  {
    name: 'add-launch-brief',
    fixture: 'launch-brief.docx',
    path: 'docs/launch-brief.docx',
    op: 'add',
    args: { exact: 'Marketing emails go out the same morning as the public launch.', text: 'Confirm the send time with marketing.', author: 'user' },
  },
  {
    name: 'add-spanning-comment',
    fixture: 'spanning-comment.docx',
    path: 'docs/spanning-comment.docx',
    op: 'add',
    args: { exact: 'half \nsecond', text: 'A second, independent multi-paragraph comment.', author: 'user' },
  },
  {
    name: 'add-word365-realistic',
    fixture: 'word365-realistic.docx',
    path: 'docs/word365-realistic.docx',
    op: 'add',
    args: { exact: 'The results look strong across', text: 'Which regions specifically?', author: 'assistant' },
  },
  {
    name: 'reply-launch-brief',
    fixture: 'launch-brief.docx',
    path: 'docs/launch-brief.docx',
    op: 'reply',
    args: { id: 'w-1', text: 'Sounds good, thanks both.', author: 'user' },
  },
  {
    name: 'resolve-spanning-comment',
    fixture: 'spanning-comment.docx',
    path: 'docs/spanning-comment.docx',
    op: 'resolve',
    args: { id: 'w-5' },
  },
  {
    name: 'reopen-launch-brief',
    fixture: 'launch-brief.docx', // w-0 starts resolved (w15:done="1")
    path: 'docs/launch-brief.docx',
    op: 'reopen',
    args: { id: 'w-0' },
  },
  {
    name: 'move-launch-brief',
    fixture: 'launch-brief.docx',
    path: 'docs/launch-brief.docx',
    op: 'move',
    args: { id: 'w-1', newExact: 'Keep support tickets about the update below 200 per week.' },
  },
  {
    name: 'move-word365-realistic',
    fixture: 'word365-realistic.docx',
    path: 'docs/word365-realistic.docx',
    op: 'move',
    args: { id: 'w-0', newExact: 'well ahead of plan' },
  },
  // Edit/delete build (2026-09-28, design doc §"Edit and delete"), added for
  // this task's own T21 parity extension. w-0 (no reply) and w-1 (one reply,
  // w-1-r1) on launch-brief.docx are the same two comments the docx-
  // comments.test.ts edit/delete suite already exercises — reused here so
  // this golden pins the SAME real ids rather than inventing new ones.
  {
    name: 'edit-launch-brief',
    fixture: 'launch-brief.docx',
    path: 'docs/launch-brief.docx',
    op: 'edit',
    args: { id: 'w-0', text: 'Edited: is 30% still realistic after the beta feedback call?' },
  },
  {
    name: 'edit-reply-launch-brief',
    fixture: 'launch-brief.docx',
    path: 'docs/launch-brief.docx',
    op: 'edit-reply',
    args: { id: 'w-1', replyId: 'w-1-r1', text: 'Edited: confirmed with legal this afternoon, terms are final.' },
  },
  {
    name: 'delete-reply-launch-brief',
    fixture: 'launch-brief.docx',
    path: 'docs/launch-brief.docx',
    op: 'delete-reply',
    args: { id: 'w-1', replyId: 'w-1-r1' },
  },
  // Deletes w-1's WHOLE thread — root + its one reply (w-1-r1) — proving both
  // the range markers AND the chained reply's own extended/ids/extensible
  // entries are gone, not just the root (§"Edit and delete"'s own "root +
  // replies chained via w15:paraIdParent" delete shape).
  {
    name: 'delete-thread-launch-brief',
    fixture: 'launch-brief.docx',
    path: 'docs/launch-brief.docx',
    op: 'delete',
    args: { id: 'w-1' },
  },
];

async function main() {
  const server = await createServer({ configFile: false, root: DESKTOP_ROOT, ssr: {}, logLevel: 'error' });
  try {
    const mod = await server.ssrLoadModule('/src/main/doc-comments/docx-comments.ts');
    await mkdir(GOLDEN_DIR, { recursive: true });

    for (const testCase of CASES) {
      const { name, fixture, path, op, args } = testCase;
      const bytes = await readFile(join(FIXTURES_DIR, fixture));
      const outPath = join(GOLDEN_DIR, `${name}.tmp.docx`);
      await writeFile(outPath, bytes);

      let result;
      if (op === 'add') {
        result = await mod.addDocxComment({ absolutePath: outPath, path, selector: textSelector(args.exact), text: args.text, author: args.author });
      } else if (op === 'reply') {
        result = await mod.replyToDocxComment({ absolutePath: outPath, path, id: args.id, text: args.text, author: args.author });
      } else if (op === 'resolve') {
        result = await mod.resolveDocxComment({ absolutePath: outPath, path, id: args.id });
      } else if (op === 'reopen') {
        result = await mod.reopenDocxComment({ absolutePath: outPath, path, id: args.id });
      } else if (op === 'move') {
        result = await mod.moveDocxComment({ absolutePath: outPath, path, id: args.id, newSelector: textSelector(args.newExact) });
      } else if (op === 'edit') {
        result = await mod.editDocxComment({ absolutePath: outPath, path, id: args.id, text: args.text });
      } else if (op === 'edit-reply') {
        result = await mod.editDocxReply({ absolutePath: outPath, path, id: args.id, replyId: args.replyId, text: args.text });
      } else if (op === 'delete') {
        result = await mod.deleteDocxComment({ absolutePath: outPath, path, id: args.id });
      } else if (op === 'delete-reply') {
        result = await mod.deleteDocxReply({ absolutePath: outPath, path, id: args.id, replyId: args.replyId });
      } else {
        throw new Error(`unknown op ${op}`);
      }
      if (!result.ok) {
        throw new Error(`${name}: desktop writer failed: ${JSON.stringify(result)}`);
      }

      const finalDocxPath = join(GOLDEN_DIR, `${name}.docx`);
      await copyFile(outPath, finalDocxPath);
      await writeFile(
        join(GOLDEN_DIR, `${name}.json`),
        JSON.stringify({ fixture, path, op, args, result }, null, 2) + '\n',
      );
      console.log(`wrote ${finalDocxPath} (op=${op}, result=${JSON.stringify(result)})`);
    }
  } finally {
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
