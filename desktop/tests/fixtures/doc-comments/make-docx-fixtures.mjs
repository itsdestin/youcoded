#!/usr/bin/env node
// Generates the REAL .docx fixtures T10's pinning tests read
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §3.2, §8 T10):
//
//   launch-brief.docx    — a real Word document with REAL comments.xml +
//                          commentsExtended.xml parts: a resolved top-level
//                          comment (w15:done="1") and a second top-level
//                          comment with a reply thread (w15:paraIdParent),
//                          exactly the two shapes T10's test list requires
//                          ("w15:paraIdParent reply reconstruction").
//   no-comments.docx     — a plain Word document with NO comments.xml part
//                          at all, for T10's "a docx with no comments.xml
//                          part doesn't crash" pinning test.
//   spanning-comment.docx — implementation-review F6: one comment range
//                          split across MULTIPLE runs (formatting
//                          boundaries) AND across TWO paragraphs, pinning
//                          that `walkDocument` records the exact quote —
//                          including the paragraph-break newline landing
//                          inside it — rather than only the single-run,
//                          single-paragraph shape every other fixture here
//                          happens to use.
//   deeply-nested.docx    — implementation-review F3: a comment whose
//                          surrounding paragraph sits thousands of levels
//                          deep inside nested `w:sdt`/`w:sdtContent`
//                          wrappers. Pins that `walkDocument`'s iterative
//                          walk finds it without overflowing the call
//                          stack a naive recursive walk would have hit
//                          (empirically confirmed elsewhere: a plain
//                          recursive tree walk in this Node overflows well
//                          under 5,000 levels) — while staying a genuinely
//                          tiny file, because nesting depth costs only a
//                          fixed number of bytes per level and is NOT
//                          bounded by the F2 byte-size ceiling.
//
// Built by hand-assembling the same OOXML parts real Word/Google Docs write
// (Content_Types, package rels, document rels, document.xml,
// comments.xml, commentsExtended.xml), zipped with jszip — the same
// approach and jszip version already proven in the doc-comments MOCK's own
// fixture generator (src/renderer/dev/workbench/fixtures/docs/make.mjs),
// extended here with the commentsExtended.xml part that mockup fixture
// never needed (the mockup never reads resolve/reply state; it seeds those
// in the renderer store instead — doc-comments-store.ts:184-240).
//
// Run from desktop/:
//   node tests/fixtures/doc-comments/make-docx-fixtures.mjs
//
// Checked in as binary .docx files (not base64-in-.ts like the mockup's
// fixture) because these are read directly off disk by a Node test via
// `fs.readFile`, not embedded in a bundled workbench module.
import JSZip from 'jszip';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (t) => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (style, paraId, ...parts) =>
  `<w:p w14:paraId="${paraId}">${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${parts.join('')}</w:p>`;
// A run wrapped in a Word comment range, with the reference mark after it —
// same shape as the mockup's own make.mjs `commented()` helper.
const commented = (id, t) =>
  `<w:commentRangeStart w:id="${id}"/>${run(t)}<w:commentRangeEnd w:id="${id}"/>` +
  `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
const W15 = 'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
const CT_TYPES_BASE = `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/></w:style></w:styles>`;

function outPath(name) {
  return join(dirname(fileURLToPath(import.meta.url)), name);
}

async function writeDocx(name, { contentTypesExtra = '', documentRels, documentXml, extraParts = {} }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${CT_TYPES_BASE}${contentTypesExtra}</Types>`);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', documentRels);
  zip.file('word/styles.xml', STYLES);
  zip.file('word/document.xml', documentXml);
  for (const [path, content] of Object.entries(extraParts)) zip.file(path, content);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  writeFileSync(outPath(name), buf);
  console.log('wrote', name, buf.length, 'bytes');
}

// ---------------------------------------------------------------------------
// launch-brief.docx — same brief text as the mockup's fixture
// (dev/workbench/fixtures/docs/make.mjs), with two top-level comments:
//   w:id=0 — RESOLVED (commentsExtended w15:done="1"), no replies.
//   w:id=1 — unresolved, with ONE reply (w:id=2, w15:paraIdParent -> id 1's
//            paraId) — the "w15:paraIdParent reply reconstruction" case.
// ---------------------------------------------------------------------------
const PARA_ID_0 = '10000000'; // comment 0's own paragraph (inside comments.xml)
const PARA_ID_1 = '10000001'; // comment 1's own paragraph
const PARA_ID_2 = '10000002'; // the reply's own paragraph

const body = [
  para('Heading1', 'A0000001', run('Spring launch brief')),
  para(null, 'A0000002', run('This brief covers the April launch of the redesigned mobile app for existing customers.')),
  para('Heading2', 'A0000003', run('Goals')),
  para(null, 'A0000004', commented(0, 'Move 30% of weekly active users to the new app within six weeks of launch.')),
  para(null, 'A0000005', run('Keep support tickets about the update below 200 per week.')),
  para('Heading2', 'A0000006', run('Timeline')),
  para(null, 'A0000007', commented(1, 'Beta opens to 500 customers on March 10'), run(', with the public launch on April 7.')),
  para(null, 'A0000008', run('Marketing emails go out the same morning as the public launch.')),
  para('Heading2', 'A0000009', run('Risks')),
  para(null, 'A000000A', run('The payment screen has not been tested on older Android phones.')),
  para(null, 'A000000B', run('If the beta finds serious problems, the launch moves to April 21.')),
].join('');

const commentPara = (paraId, ...parts) => `<w:p w14:paraId="${paraId}">${parts.join('')}</w:p>`;
const comment = (id, author, initials, date, paraId, text) =>
  `<w:comment w:id="${id}" w:author="${esc(author)}" w:initials="${initials}" w:date="${date}">` +
  `${commentPara(paraId, run(text))}</w:comment>`;

const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments ${W} ${W14}>${comment(
  0,
  'Priya Shah',
  'PS',
  '2026-09-23T10:00:00Z',
  PARA_ID_0,
  'Is 30% realistic? The last launch reached 18% in the same window.'
)}${comment(1, 'Priya Shah', 'PS', '2026-09-23T10:05:00Z', PARA_ID_1, 'Legal needs the beta terms by March 3 at the latest.')}${comment(
  2,
  'Marcus Lee',
  'ML',
  '2026-09-23T14:20:00Z',
  PARA_ID_2,
  'Confirmed with legal — the beta terms are ready as of this morning.'
)}</w:comments>`;

// w15:commentEx per real comment (§3.2): w15:done marks resolved, and a
// reply's w15:paraIdParent points at its PARENT's own paraId (id 1's, not
// id 0's) — this is the only place the reply relationship is recorded;
// comments.xml itself has no parent/child link.
const commentsExtendedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w15:commentsEx ${W15}>` +
  `<w15:commentEx w15:paraId="${PARA_ID_0}" w15:done="1"/>` +
  `<w15:commentEx w15:paraId="${PARA_ID_1}" w15:done="0"/>` +
  `<w15:commentEx w15:paraId="${PARA_ID_2}" w15:done="0" w15:paraIdParent="${PARA_ID_1}"/>` +
  `</w15:commentsEx>`;

await writeDocx('launch-brief.docx', {
  contentTypesExtra:
    `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>` +
    `<Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>`,
  documentRels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rId3" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/></Relationships>`,
  documentXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} ${W14}><w:body>${body}</w:body></w:document>`,
  extraParts: {
    'word/comments.xml': commentsXml,
    'word/commentsExtended.xml': commentsExtendedXml,
  },
});

// ---------------------------------------------------------------------------
// no-comments.docx — a plain document with NO comments.xml part at all
// (T10: "a docx with no comments.xml part doesn't crash").
// ---------------------------------------------------------------------------
await writeDocx('no-comments.docx', {
  documentRels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  documentXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} ${W14}><w:body>${para('Heading1', 'B0000001', run('Untitled memo'))}${para(
    null,
    'B0000002',
    run('Nothing here has ever been commented on.')
  )}</w:body></w:document>`,
});

// ---------------------------------------------------------------------------
// spanning-comment.docx — implementation-review F6: one comment range (id 5)
// that starts mid-paragraph, is split across TWO separate runs ("first " /
// "half "), crosses a paragraph boundary, and ends mid-SECOND-paragraph
// (also split across two runs, "second " / "half."). The exact quoted text
// is therefore "first half \nsecond half." — the embedded "\n" is the
// paragraph break `walkDocument` appends between the two `<w:p>`s, landing
// INSIDE the comment's own range because the range is still open when it's
// appended. No other fixture in this file exercises a range that spans a
// paragraph break or more than one run.
// ---------------------------------------------------------------------------
const SPANNING_PARA_ID = 'F0000001';
const spanningBody = [
  para(null, 'C0000001', run('Before the change: '), '<w:commentRangeStart w:id="5"/>', run('first '), run('half ')),
  para(
    null,
    'C0000002',
    run('second '),
    run('half.'),
    '<w:commentRangeEnd w:id="5"/>',
    '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="5"/></w:r>',
    run(' After the note.')
  ),
].join('');

const spanningCommentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments ${W} ${W14}>${comment(
  5,
  'Priya Shah',
  'PS',
  '2026-09-26T09:00:00Z',
  SPANNING_PARA_ID,
  'Should this be one paragraph instead of two?'
)}</w:comments>`;

await writeDocx('spanning-comment.docx', {
  contentTypesExtra: `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>`,
  documentRels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>`,
  documentXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} ${W14}><w:body>${spanningBody}</w:body></w:document>`,
  extraParts: {
    'word/comments.xml': spanningCommentsXml,
  },
});

// ---------------------------------------------------------------------------
// deeply-nested.docx — implementation-review F3: the commented paragraph
// sits inside NESTING_DEPTH levels of nested `w:sdt`/`w:sdtContent` wrappers
// (a real, if unusual, OOXML construct — Word's own "structured document
// tag" content-control wrapper, which the schema allows nesting). A
// recursive `visit()`-per-element walk would overflow the call stack long
// before reaching this depth (confirmed empirically elsewhere: a plain
// recursive tree walk in this Node overflows under 5,000 levels); the fixed
// iterative walk has no such ceiling. Each nesting level costs only ~24
// bytes, so this file stays tiny even at a depth chosen to be comfortably
// past where a recursive walk would already have crashed.
// ---------------------------------------------------------------------------
const NESTING_DEPTH = 8000;
const deepCommentText = 'A comment buried very deep in the document tree.';
let deepBody = para('Heading2', 'D0000001', commented(9, deepCommentText));
{
  let open = '';
  let close = '';
  for (let i = 0; i < NESTING_DEPTH; i++) {
    open += '<w:sdt><w:sdtContent>';
    close += '</w:sdtContent></w:sdt>';
  }
  deepBody = open + deepBody + close;
}

const deepCommentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments ${W} ${W14}>${comment(9, 'Priya Shah', 'PS', '2026-09-26T09:10:00Z', 'F0000009', deepCommentText)}</w:comments>`;

await writeDocx('deeply-nested.docx', {
  contentTypesExtra: `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>`,
  documentRels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>`,
  documentXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} ${W14}><w:body>${deepBody}</w:body></w:document>`,
  extraParts: {
    'word/comments.xml': deepCommentsXml,
  },
});
