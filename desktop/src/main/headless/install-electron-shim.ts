// install-electron-shim.ts — makes `require('electron')` resolve to electron-headless.ts.
//
// WHY a resolver hook rather than editing every importer (2026-10-14, Android clean rebuild P1):
// see electron-headless.ts. Must run before any backend module loads, so headless-main.ts imports
// this first and only then requires the boot module.
import Module from 'module';
import path from 'path';

const SHIM = path.join(__dirname, 'electron-headless.js');

type Resolve = (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
const mod = Module as unknown as { _resolveFilename: Resolve };
const original = mod._resolveFilename;
mod._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron') return SHIM;
  return original.call(this, request, parent, isMain, options);
};
