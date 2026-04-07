#!/usr/bin/env node
// patch-node-pty.js — Fixes node-pty's spawn-helper path double-replacement on macOS.
//
// node-pty's unixTerminal.js does:
//   helperPath.replace('app.asar', 'app.asar.unpacked')
//
// When pty-worker.js runs under system Node.js (not Electron), the path already
// resolves to app.asar.unpacked/... on disk. The naive .replace() then produces
// app.asar.unpacked.unpacked/... which doesn't exist, causing:
//   "posix_spawn failed: No such file or directory"
//
// Fix: replace the string .replace() with a regex using a negative lookahead
// so it only fires when the path doesn't already contain app.asar.unpacked.
//
// Based on PR #65 by Tanner Morin.

const fs = require('fs');
const path = require('path');

const TARGET = path.join(
  __dirname,
  '..',
  'node_modules',
  'node-pty',
  'lib',
  'unixTerminal.js'
);

if (!fs.existsSync(TARGET)) {
  // node-pty not installed yet or Windows-only build — skip silently
  process.exit(0);
}

const content = fs.readFileSync(TARGET, 'utf8');

const UNSAFE_PATTERN = "helperPath.replace('app.asar', 'app.asar.unpacked')";
const SAFE_REPLACEMENT =
  "helperPath.replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked')";

if (content.includes(SAFE_REPLACEMENT)) {
  console.log('node-pty: spawn-helper patch already applied — skipping');
  process.exit(0);
}

if (!content.includes(UNSAFE_PATTERN)) {
  console.log('node-pty: spawn-helper replacement pattern not found — skipping (may be fixed upstream)');
  process.exit(0);
}

const patched = content.replace(UNSAFE_PATTERN, SAFE_REPLACEMENT);
fs.writeFileSync(TARGET, patched, 'utf8');
console.log('node-pty: patched spawn-helper path replacement with negative lookahead');
