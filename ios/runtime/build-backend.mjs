#!/usr/bin/env node
// build-backend.mjs <outDir> — the desktop backend, packed for the iPhone app.
//
// WHY a bundle, when Android ships the compiled tree plus node_modules (app/runtime/build-backend.sh):
//   1. The iPhone's Node is nodejs-mobile's Node 18. Several dependencies are ES-module-only, and Node 18 cannot
//      `require()` an ES module (Node 22+ can). A bundler turns them into the one module format Node 18 loads.
//   2. An iPhone app is a signed, read-only bundle: ~17,000 loose files (Android's layout) are slow to sign,
//      install and open. One file per entry point loads in a fraction of the time on a JIT-less V8.
//
// The backend finds its own files through __dirname (hook scripts, the skill registry, its worker threads). A
// bundle has ONE __dirname for every module, so each source file's `__dirname` / `__filename` is rewritten to the
// path `tsc` would have given it under <outDir>/dist — the layout below is exactly Android's:
//
//   <outDir>/package.json                         name + version (electron-headless.ts reads the version)
//   <outDir>/dist/main/headless/ios-boot.js       what the app starts: loads ios-main.js inside a try (written below)
//   <outDir>/dist/main/headless/ios-main.js       the backend (entry: desktop/src/main/headless/ios-main.ts)
//   <outDir>/dist/main/**/<worker>.js             each worker thread, self-contained, where its starter looks
//   <outDir>/dist/renderer/data/skill-registry.json
//   <outDir>/hook-scripts/ , <outDir>/scripts/install-hooks.js
//
//   <outDir>/dist/ios-shell/worker.js             the built-in command line, one worker thread per command (ios/runtime/shell/)
//
// Needs: `npm ci` in this folder (esbuild, just-bash, just-git) and in desktop/ (the backend's dependencies).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '../../desktop');
const SRC = path.join(DESKTOP, 'src');
let OUT = '';

/** Worker threads the headless backend starts with `new Worker(path.join(__dirname, '<name>.js'))`. Each is its
 *  own bundle at the path its starter computes. Keep in step with `rg "new Worker\(" desktop/src/main`
 *  (guard: desktop/tests/ios-backend-bundle.test.ts). */
export const WORKER_ENTRIES = [
  'main/chatsearch-index/index-worker.ts',
  'main/session-discovery-worker.ts',
  'main/image-resize-worker.ts',
];
const MAIN_ENTRY = 'main/headless/ios-main.ts';

/** The built-in command line (design: docs/active/specs/2026-11-26-iphone-in-app-command-line.md). Its worker thread and
 *  its start-up registration live in ios/runtime/shell/, NOT under desktop/src: the packages it needs (just-bash,
 *  just-git) are installed only here, so desktop and Android can never pull them in. */
const SHELL_DIR = path.join(HERE, 'shell');
const SHELL_WORKER = { file: path.join(SHELL_DIR, 'worker.ts'), out: 'ios-shell/worker.js' };
const SHELL_REGISTER = path.join(SHELL_DIR, 'register.ts');
/** Test-only: with YOUCODED_IOS_SHELL_SELFTEST=1 the simulator build also carries a start-up self-test (shell/selftest.ts),
 *  so CI can run the conformance list inside the real app. Never set for a release build. */
const SELFTEST = process.env.YOUCODED_IOS_SHELL_SELFTEST === '1' ? path.join(SHELL_DIR, 'selftest.ts') : null;

/** Modules that cannot exist on an iPhone (native add-ons built per platform, or a browser driver). Left as
 *  `require()` calls that throw only if a code path that cannot run on a phone is actually reached. */
const EXTERNAL = ['node-pty', 'koffi', 'fsevents', 'playwright-core', '*.node'];
/** Extra, for the built-in shell's worker only: just-bash's own optional pieces, which it loads only inside a try — the two
 *  native compressors (one is LGPL-licensed: never bundled), SQLite (needs WebAssembly, which an iPhone's Node lacks; the
 *  sqlite3 command is left out), the TypeScript compiler (only for its JavaScript runtime, which is off) and the network
 *  guard (the shell is handed the app's own fetch instead). Left as require() calls that throw only if reached. */
const SHELL_EXTERNAL = ['@mongodb-js/zstd', 'node-liblzma', 'sql.js', 'typescript', 'guarded-fetch'];

/** Rewrites `__dirname` / `__filename` in the backend's own sources to the compiled-tree path of that file. */
const virtualPaths = {
  name: 'youcoded-virtual-dirname',
  setup(b) {
    b.onLoad({ filter: /\.(ts|js)$/, namespace: 'file' }, async (args) => {
      if (!args.path.startsWith(SRC + path.sep)) return undefined;
      const text = await fs.promises.readFile(args.path, 'utf8');
      if (!/__dirname|__filename/.test(text)) return undefined;
      const rel = path.relative(SRC, args.path).split(path.sep).join('/');
      const dir = path.posix.dirname(rel);
      const file = rel.replace(/\.ts$/, '.js');
      const contents = text
        .replace(/\b__dirname\b/g, `__ycPath(${JSON.stringify('dist/' + dir)})`)
        .replace(/\b__filename\b/g, `__ycPath(${JSON.stringify('dist/' + file)})`);
      return { contents, loader: args.path.endsWith('.ts') ? 'ts' : 'js' };
    });
  },
};

/** Code-point ranges of one Unicode property, as the body of a character class. Worked out HERE, on the build
 *  machine, whose Node has the Unicode data the iPhone's Node lacks (see ios-compat.ts). */
function unicodeTable(name) {
  const re = new RegExp(`\\p{${name}}`, 'u');
  const esc = (cp) => `\\u{${cp.toString(16).toUpperCase()}}`;
  let body = '';
  let start = -1;
  for (let cp = 0; cp <= 0x110000; cp++) {
    // Lone surrogates cannot be written in a /u class range end-to-end with their neighbours; skip that block.
    const hit = cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) && re.test(String.fromCodePoint(cp));
    if (hit && start < 0) start = cp;
    if (!hit && start >= 0) { body += start === cp - 1 ? esc(start) : `${esc(start)}-${esc(cp - 1)}`; start = -1; }
  }
  return body;
}

/** Every Unicode property the given bundle text names in a `\p{…}` (as a literal, or inside a string). */
function propertiesNamedIn(text) {
  const names = new Set();
  for (const m of text.matchAll(/\\{1,2}[pP]\{([A-Za-z_=]+)\}/g)) names.add(m[1]);
  return names;
}

/** Rewrite every regular-expression LITERAL that names a Unicode property as a `new RegExp("…", "flags")` call.
 *  WHY: on the iPhone's Node such a literal is a syntax error that stops the WHOLE file from loading, before any
 *  fallback can run; as a call it goes through the fallback in ios-compat.ts. Literals are found with the TypeScript
 *  parser (the desktop's own dependency), not a text pattern: telling a regex literal from a division by eye is
 *  exactly the mistake a text pattern makes. */
function lowerPropertyLiterals(file, text) {
  if (!/\\[pP]\{/.test(text)) return text;
  const ts = createRequire(path.join(DESKTOP, 'package.json'))('typescript');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, false, ts.ScriptKind.JS);
  const edits = [];
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const raw = node.getText(source);
      const close = raw.lastIndexOf('/');
      const body = raw.slice(1, close);
      if (/\\[pP]\{/.test(body)) edits.push({ start: node.getStart(source), end: node.getEnd(), text: `new RegExp(${JSON.stringify(body)}, ${JSON.stringify(raw.slice(close + 1))})` });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Everything this build produces: [{ file, out, external?, inject? }] — the source file, where its bundle goes under
 *  <outDir>/dist, extra modules left out of just that bundle, and extra files run first in just that bundle. */
function targets() {
  return [
    // WHY the registration is injected here and not imported by ios-main.ts: that is desktop source, which must never
    // know about the iPhone-only shell (and its packages).
    { file: path.join(SRC, MAIN_ENTRY), out: MAIN_ENTRY.replace(/\.ts$/, '.js'), inject: [SHELL_REGISTER, ...(SELFTEST ? [SELFTEST] : [])] },
    ...WORKER_ENTRIES.map((entry) => ({ file: path.join(SRC, entry), out: entry.replace(/\.ts$/, '.js') })),
    { file: SHELL_WORKER.file, out: SHELL_WORKER.out, external: SHELL_EXTERNAL },
  ];
}

async function bundle(target, unicodeTables = {}) {
  const outfile = path.join(OUT, 'dist', target.out);
  // How many folders up from this bundle's own folder the layout root is ("dist/main/headless" → 3).
  const up = path.posix.dirname('dist/' + target.out).split('/').map(() => '..').join('/');
  const result = await build({
    entryPoints: [target.file],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // Syntax only (optional chaining etc. are fine on 18; this guards anything newer). Library gaps: ios-compat.ts.
    target: 'node18',
    // WHY an alias and not Android's Module._resolveFilename hook: a bundler resolves `electron` at build time.
    alias: {
      electron: path.join(SRC, 'main/headless/electron-headless.ts'),
      // undici needs WebAssembly, which the iPhone's Node lacks: see ios-undici.ts.
      undici: path.join(SRC, 'main/headless/ios-undici.ts'),
      // just-bash's ES-module build imports `undici` by name, which the line above would break; its CommonJS build is one
      // self-contained file, so the shell uses that.
      'just-bash': path.join(HERE, 'node_modules/just-bash/dist/bundle/index.cjs'),
    },
    external: [...EXTERNAL, ...(target.external ?? [])],
    plugins: [virtualPaths],
    // The fills (ios-compat.ts) run before any module of the bundle: see ios-prelude.ts.
    inject: [path.join(SRC, 'main/headless/ios-prelude.ts'), ...(target.inject ?? [])],
    // The shell's .json test list (self-test build only) and nothing else needs a loader beyond the defaults.
    loader: { '.json': 'json' },
    define: { __YC_UNICODE_TABLES__: JSON.stringify(unicodeTables) },
    banner: { js: `const __ycRoot = require('path').resolve(__dirname, ${JSON.stringify(up)});\nconst __ycPath = (rel) => require('path').join(__ycRoot, rel);` },
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
    // Names survive so stack traces in the phone's log stay readable.
    minify: false,
    keepNames: true,
  });
  const built = await fs.promises.readFile(outfile, 'utf8');
  const text = lowerPropertyLiterals(outfile, built);
  if (text !== built) await fs.promises.writeFile(outfile, text);
  return { outfile, inputs: Object.keys(result.metafile.inputs).length, metafile: result.metafile, text };
}

/** Ship the licence and notice files of every npm package built into `metafile`'s bundle, under <outDir>/legal/<name>/.
 *  WHY (iPhone app, card #89): esbuild writes the code of a package into the bundle but drops its licence text
 *  (`legalComments: 'none'`), and just-bash (Apache-2.0) and just-git (MIT) both require theirs to travel with the app.
 *  Used for the built-in shell's bundle, which holds those two and their dependencies. */
async function shipLicenses(metafile) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const m = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.split(path.sep).join('/'));
    if (m) roots.add(m[1]);
  }
  // just-bash's own file is one pre-built bundle with most of its dependencies already inside it, so the metafile cannot
  // see them: add every package it declares (except the ones left out of our bundle) by name.
  const jb = JSON.parse(await fs.promises.readFile(path.join(HERE, 'node_modules/just-bash/package.json'), 'utf8'));
  for (const dep of Object.keys(jb.dependencies ?? {})) {
    if (!SHELL_EXTERNAL.includes(dep) && fs.existsSync(path.join(HERE, 'node_modules', dep))) roots.add(path.join(HERE, 'node_modules', dep));
  }
  for (const root of [...roots].sort()) {
    // The metafile names inputs relative to the folder esbuild ran in (the current one).
    const dir = path.resolve(root);
    const pkgName = JSON.parse(await fs.promises.readFile(path.join(dir, 'package.json'), 'utf8')).name ?? path.basename(dir);
    for (const file of await fs.promises.readdir(dir)) {
      if (!/^(licen[sc]e|notice|copying)/i.test(file)) continue;
      await fs.promises.mkdir(path.join(OUT, 'legal', pkgName), { recursive: true });
      await fs.promises.copyFile(path.join(dir, file), path.join(OUT, 'legal', pkgName, file));
    }
  }
}

async function main() {
  if (!process.argv[2]) { console.error('usage: build-backend.mjs <outDir>'); process.exit(2); }
  OUT = path.resolve(process.argv[2]);
  await fs.promises.rm(OUT, { recursive: true, force: true });
  await fs.promises.mkdir(OUT, { recursive: true });

  // Two passes: the first finds which Unicode properties the code names, the second bakes their tables in.
  const names = new Set();
  for (const target of targets()) {
    for (const n of propertiesNamedIn((await bundle(target)).text)) names.add(n);
  }
  const tables = {};
  for (const name of [...names].sort()) {
    try { tables[name] = unicodeTable(name); } catch { console.warn(`[ios-backend] unknown Unicode property \\p{${name}} left as written`); }
  }
  console.log(`[ios-backend] Unicode properties baked in: ${Object.keys(tables).join(', ') || '(none)'}`);

  for (const target of targets()) {
    const { outfile, inputs, metafile } = await bundle(target, tables);
    if (target.out === SHELL_WORKER.out) await shipLicenses(metafile);
    const size = (await fs.promises.stat(outfile)).size;
    console.log(`[ios-backend] ${path.relative(OUT, outfile)}  ${(size / 1e6).toFixed(1)} MB  (${inputs} modules)`);
  }

  // WHY a separate, tiny first file (2026-11-25, found in the simulator): if the big bundle cannot even be PARSED on
  // the phone's Node (a syntax the old V8 rejects), nothing inside it runs — including the guard that stops Node
  // from exiting — and Node's own answer to a failed main script is exit(1), which on an iPhone ends the whole app
  // without a word. This file always parses, loads the bundle inside a try, and reports a failure the way the app
  // understands (the YOUCODED_HEADLESS_EXIT line → "close and reopen"), with the real error in backend.log.
  await fs.promises.writeFile(path.join(OUT, 'dist/main/headless/ios-boot.js'), `'use strict';
process.on('uncaughtException', function (e) { console.error('[ios] uncaught exception:', (e && e.stack) || e); });
try {
  require('./ios-main.js');
} catch (e) {
  console.error('[ios] the backend could not be loaded:', (e && e.stack) || e);
  try { require('fs').writeSync(1, 'YOUCODED_HEADLESS_EXIT 1\\n'); } catch (_) {}
}
`);

  const pkg = JSON.parse(await fs.promises.readFile(path.join(DESKTOP, 'package.json'), 'utf8'));
  await fs.promises.writeFile(path.join(OUT, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version }, null, 2) + '\n');
  await fs.promises.mkdir(path.join(OUT, 'dist/renderer/data'), { recursive: true });
  await fs.promises.copyFile(path.join(SRC, 'renderer/data/skill-registry.json'), path.join(OUT, 'dist/renderer/data/skill-registry.json'));
  await fs.promises.cp(path.join(DESKTOP, 'hook-scripts'), path.join(OUT, 'hook-scripts'), { recursive: true });
  await fs.promises.mkdir(path.join(OUT, 'scripts'), { recursive: true });
  await fs.promises.copyFile(path.join(DESKTOP, 'scripts/install-hooks.js'), path.join(OUT, 'scripts/install-hooks.js'));
  console.log(`[ios-backend] done: ${OUT}`);
}

// Run only as a script: the bundle test imports WORKER_ENTRIES without building.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
