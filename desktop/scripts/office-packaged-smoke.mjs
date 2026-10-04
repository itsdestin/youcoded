#!/usr/bin/env node
// Run the Office converter that each packaged Mac app actually carries, the way the app runs it.
//
// WHY this exists (final review, 2026-09-30): the add-on's own CI smoke-tests each platform's
// converter, and the app's tests run the one fetch-office.mjs installs on the runner — but nothing
// ever ran the x2t INSIDE YouCoded.app. That copy is the one that was re-signed by electron-builder
// (macOS refuses unsigned code on Apple silicon), sits in Contents/Resources/office/converter/, and
// for the Intel dmg comes from a different bundle than the runner's own. A wrong-arch copy, a
// dylib the re-sign broke, or a missing file would only have shown on a person's Mac.
//
// For each release/<dir>/<name>.app (both dmgs are cut on one Apple-silicon runner):
//   1. `file` says x2t and every dylib beside it are built for the dmg's own CPU
//      (mac-arm64 → arm64, mac → x86_64).
//   2. A small docx is opened (docx → the editor's form), saved back (→ docx) and exported as PDF
//      (with the font list x2t makes itself) through dist/main/office/x2t.js — the app's own code,
//      so the task file, environment and working folder are exactly what the app uses.
// An Intel copy is run through Rosetta when the runner has it; without Rosetta it is checked by
// `file` only, with a warning (it cannot run there at all).
//
// Run from desktop/ after `npm run build`:  node scripts/office-packaged-smoke.mjs [release]
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.resolve(process.argv[2] ?? path.join(DESKTOP, 'release'));
const FIXTURE = path.join(DESKTOP, 'tests', 'office', 'fixtures', 'memo.docx');
const x2t = createRequire(import.meta.url)(path.join(DESKTOP, 'dist', 'main', 'office', 'x2t.js'));

const fail = (msg) => { console.log(`::error::${msg}`); process.exitCode = 1; };
/** The CPU a release folder's app is for, in `file`'s words. */
const archOf = (dir) => (dir.endsWith('-arm64') ? 'arm64' : 'x86_64');

async function canRun(arch) {
  const native = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  if (arch === native) return true;
  // Rosetta: `arch -x86_64` runs only when it is installed.
  return run('arch', ['-x86_64', '/usr/bin/true']).then(() => true, () => false);
}

async function checkApp(dir, app) {
  const want = archOf(dir);
  const root = path.join(app, 'Contents', 'Resources', 'office');
  const conv = path.join(root, 'converter');
  const names = await fsp.readdir(conv).catch(() => null);
  if (!names) return fail(`${app}: no Office converter at Contents/Resources/office/converter`);
  if (!names.includes('x2t')) return fail(`${app}: the Office converter folder has no x2t`);
  // 1. Every piece of native code is for this dmg's CPU.
  const code = ['x2t', ...names.filter((f) => f.endsWith('.dylib'))];
  let wrong = 0;
  for (const n of code) {
    const { stdout } = await run('file', ['-b', path.join(conv, n)]);
    if (!stdout.includes(want)) { wrong++; fail(`${app}: converter/${n} is not built for ${want}: ${stdout.trim()}`); }
  }
  if (wrong) return;
  console.log(`  ${dir}: x2t and ${code.length - 1} dylib(s) are ${want}`);
  if (!(await canRun(want))) {
    console.log(`::warning::${dir}: this runner cannot run ${want} code (no Rosetta), so its converter was checked by file type only`);
    return;
  }
  // 2. Open, save and export a document with the app's own x2t code.
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'yc-office-smoke-'));
  try {
    const bin = path.join(tmp, 'Editor.bin');
    await x2t.convert(root, FIXTURE, bin, x2t.FORMAT.bin, tmp);
    const docx = path.join(tmp, 'saved.docx');
    await x2t.convert(root, bin, docx, x2t.FORMAT.docx, tmp);
    const head = (await fsp.readFile(docx)).subarray(0, 2).toString('latin1');
    if (head !== 'PK') fail(`${app}: the saved docx is not a docx (starts ${JSON.stringify(head)})`);
    const allFontsPath = await x2t.pdfFontData(root, tmp);
    const pdf = path.join(tmp, 'out.pdf');
    await x2t.convert(root, bin, pdf, x2t.FORMAT.pdf, tmp, undefined, { allFontsPath });
    const magic = (await fsp.readFile(pdf)).subarray(0, 5).toString('latin1');
    if (magic !== '%PDF-') fail(`${app}: the exported PDF is not a PDF (starts ${JSON.stringify(magic)})`);
    console.log(`  ${dir}: opened, saved and exported a docx as PDF`);
  } catch (e) {
    fail(`${app}: the converter failed: ${e?.message ?? e}${e?.stderr ? `\n${e.stderr}` : ''}`);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

let found = 0;
for (const dir of await fsp.readdir(RELEASE).catch(() => [])) {
  // Any .app one level down, as verify-mac-signature.sh finds them (the name follows productName).
  for (const name of (await fsp.readdir(path.join(RELEASE, dir)).catch(() => [])).filter((n) => n.endsWith('.app'))) {
    const app = path.join(RELEASE, dir, name);
    found++;
    console.log(`checking ${app}`);
    await checkApp(dir, app);
  }
}
if (!found) fail(`no .app bundle under ${RELEASE}/ - did the mac build run?`);
else if (!process.exitCode) console.log(`${found} macOS bundle(s): the packaged Office converter works`);
