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
// Needs: `npm ci` in this folder (esbuild) and in desktop/ (the backend's dependencies).
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

/** Modules that cannot exist on an iPhone (native add-ons built per platform, or a browser driver). Left as
 *  `require()` calls that throw only if a code path that cannot run on a phone is actually reached. */
const EXTERNAL = ['node-pty', 'koffi', 'fsevents', 'playwright-core', '*.node'];

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

async function bundle(entry, unicodeTables = {}) {
  const outfile = path.join(OUT, 'dist', entry.replace(/\.ts$/, '.js'));
  // How many folders up from this bundle's own folder the layout root is ("dist/main/headless" → 3).
  const up = path.posix.dirname('dist/' + entry).split('/').map(() => '..').join('/');
  const result = await build({
    entryPoints: [path.join(SRC, entry)],
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
    },
    external: EXTERNAL,
    plugins: [virtualPaths],
    // The fills (ios-compat.ts) run before any module of the bundle: see ios-prelude.ts.
    inject: [path.join(SRC, 'main/headless/ios-prelude.ts')],
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
  return { outfile, inputs: Object.keys(result.metafile.inputs).length, text };
}

async function main() {
  if (!process.argv[2]) { console.error('usage: build-backend.mjs <outDir>'); process.exit(2); }
  OUT = path.resolve(process.argv[2]);
  await fs.promises.rm(OUT, { recursive: true, force: true });
  await fs.promises.mkdir(OUT, { recursive: true });

  // Two passes: the first finds which Unicode properties the code names, the second bakes their tables in.
  const names = new Set();
  for (const entry of [MAIN_ENTRY, ...WORKER_ENTRIES]) {
    for (const n of propertiesNamedIn((await bundle(entry)).text)) names.add(n);
  }
  const tables = {};
  for (const name of [...names].sort()) {
    try { tables[name] = unicodeTable(name); } catch { console.warn(`[ios-backend] unknown Unicode property \\p{${name}} left as written`); }
  }
  console.log(`[ios-backend] Unicode properties baked in: ${Object.keys(tables).join(', ') || '(none)'}`);

  for (const entry of [MAIN_ENTRY, ...WORKER_ENTRIES]) {
    const { outfile, inputs } = await bundle(entry, tables);
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
