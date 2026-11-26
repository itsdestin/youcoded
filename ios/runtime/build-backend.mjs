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

async function bundle(entry) {
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
    alias: { electron: path.join(SRC, 'main/headless/electron-headless.ts') },
    external: EXTERNAL,
    plugins: [virtualPaths],
    banner: { js: `const __ycRoot = require('path').resolve(__dirname, ${JSON.stringify(up)});\nconst __ycPath = (rel) => require('path').join(__ycRoot, rel);` },
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
    // Names survive so stack traces in the phone's log stay readable.
    minify: false,
    keepNames: true,
  });
  return { outfile, inputs: Object.keys(result.metafile.inputs).length };
}

async function main() {
  if (!process.argv[2]) { console.error('usage: build-backend.mjs <outDir>'); process.exit(2); }
  OUT = path.resolve(process.argv[2]);
  await fs.promises.rm(OUT, { recursive: true, force: true });
  await fs.promises.mkdir(OUT, { recursive: true });

  for (const entry of [MAIN_ENTRY, ...WORKER_ENTRIES]) {
    const { outfile, inputs } = await bundle(entry);
    const size = (await fs.promises.stat(outfile)).size;
    console.log(`[ios-backend] ${path.relative(OUT, outfile)}  ${(size / 1e6).toFixed(1)} MB  (${inputs} modules)`);
  }

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
