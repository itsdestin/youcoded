#!/usr/bin/env node
// Generates fixtures/docs.ts: a small Word document as base64, for the doc
// comments mockup (Destin, questions deck Q-4: Word comments shown and made
// in YouCoded). It is a REAL .docx with REAL Word comments — comments.xml plus
// the commentRangeStart/End markers in the body, exactly what Word and Google
// Docs write — so the eventual build can read this same file. The two Priya
// comments here are mirrored by seeds in state/doc-comments-store.ts (the
// mockup does not parse comments.xml yet; mammoth drops it).
// Run from desktop/:  node src/renderer/dev/workbench/fixtures/docs/make.mjs
import JSZip from 'jszip';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (t) => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (style, ...parts) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${parts.join('')}</w:p>`;
// A run wrapped in a Word comment range, with the reference mark after it.
const commented = (id, t) =>
  `<w:commentRangeStart w:id="${id}"/>${run(t)}<w:commentRangeEnd w:id="${id}"/>` +
  `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`;

const body = [
  para('Heading1', run('Spring launch brief')),
  para(null, run('This brief covers the April launch of the redesigned mobile app for existing customers.')),
  para('Heading2', run('Goals')),
  para(null, commented(0, 'Move 30% of weekly active users to the new app within six weeks of launch.')),
  para(null, run('Keep support tickets about the update below 200 per week.')),
  para('Heading2', run('Timeline')),
  para(null, commented(1, 'Beta opens to 500 customers on March 10'), run(', with the public launch on April 7.')),
  para(null, run('Marketing emails go out the same morning as the public launch.')),
  para('Heading2', run('Risks')),
  para(null, run('The payment screen has not been tested on older Android phones.')),
  para(null, run('If the beta finds serious problems, the launch moves to April 21.')),
].join('');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const comment = (id, text) =>
  `<w:comment w:id="${id}" w:author="Priya Shah" w:initials="PS" w:date="2026-09-23T10:00:00Z">` +
  `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:comment>`;

const zip = new JSZip();
zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`);
zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>`);
zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/></w:style></w:styles>`);
zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${body}</w:body></w:document>`);
zip.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments ${W}>${comment(0, 'Is 30% realistic? The last launch reached 18% in the same window.')}${comment(1, 'Legal needs the beta terms by March 3 at the latest.')}</w:comments>`);

const b64 = (await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })).toString('base64');
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs.ts');
writeFileSync(out, `// GENERATED by fixtures/docs/make.mjs — do not edit. A Word document with two
// real Word comments, for the doc comments mockup. Base64 so the workbench can
// serve real .docx bytes to DocxView without a disk.
export const DOC_LAUNCH_BRIEF = '${b64}';
`);
console.log('wrote', out, b64.length, 'chars');
