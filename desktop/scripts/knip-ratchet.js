#!/usr/bin/env node
// knip-ratchet.js — `npm run knip`. Runs knip and RATCHETS its two warning-level
// counts (unused exports, unused exported types) against knip-baseline.json.
//
// WHY THIS EXISTS (2026-09-16, simplification audit §7 G1): knip's `exports`
// and `types` categories are warnings, so CI exited 0 while the unused-export
// count grew from 77 to 136 in six weeks. Nobody had to clean anything up and
// nobody noticed. Flipping them to "error" would demand a big-bang cleanup of
// ~325 findings first, which is exactly the gate nobody ships. A RATCHET is the
// third option: today's counts are the ceiling, a change that adds a finding
// fails, and a change that removes one is asked to lower the ceiling so the
// number can only go down.
//
// What it does, in order:
//   1. runs knip with `--reporter json` (one knip run, not two — it is ~10s)
//   2. prints every finding in a compact human-readable form, because the JSON
//      reporter replaces knip's own output and the point of the tool is that
//      someone reads the findings
//   3. exits non-zero if knip did (an error-severity category: files, unresolved,
//      duplicates, dependencies, unlisted, binaries — see knip.jsonc → rules)
//   4. exits non-zero if `exports` or `types` is ABOVE the baseline
//   5. passes, but says so, if either is BELOW the baseline — lower the number
//      in knip-baseline.json in the same commit; that is the ratchet clicking
//
// Extra arguments are passed through to knip (`npm run knip -- --production`).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DESKTOP = path.join(__dirname, '..');
const BASELINE_PATH = path.join(DESKTOP, 'knip-baseline.json');
// The ratcheted categories. Everything else knip reports is either an error
// (knip's own exit code carries it) or a category this project has at zero.
const RATCHETED = ['exports', 'types'];

// Resolve knip's bin through its package.json rather than node_modules/.bin:
// the .bin entry is a shell shim on POSIX and a .cmd on Windows, and CI runs
// this on all three platforms. `process.execPath` is the node already running.
const knipPkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'node_modules', 'knip', 'package.json'), 'utf8'));
const knipBin = path.join(DESKTOP, 'node_modules', 'knip', knipPkg.bin.knip);

const run = spawnSync(process.execPath, [knipBin, '--reporter', 'json', ...process.argv.slice(2)], {
  cwd: DESKTOP,
  encoding: 'utf8',
  // knip's JSON for this tree is ~100 KB; the default 1 MB buffer would be
  // enough today, but a truncated JSON here reads as "knip is broken".
  maxBuffer: 64 * 1024 * 1024,
});
// knip's configuration hints go to stderr; keep showing them.
if (run.stderr) process.stderr.write(run.stderr);
if (run.error) {
  console.error(`knip failed to start: ${run.error.message}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  process.stdout.write(run.stdout);
  console.error('\nknip-ratchet: could not parse knip --reporter json output (above).');
  process.exit(run.status || 2);
}

// ---- 2. print the findings ----
const counts = {};
const lines = [];
for (const entry of report.issues ?? []) {
  for (const [category, items] of Object.entries(entry)) {
    if (!Array.isArray(items) || items.length === 0) continue;
    counts[category] = (counts[category] ?? 0) + items.length;
    for (const item of items) {
      // exports/types/enumMembers carry a line; dependency-style findings do not.
      const where = item.line ? `${entry.file}:${item.line}:${item.col}` : entry.file;
      lines.push(`${category.padEnd(12)} ${where}  ${item.name ?? ''}`.trimEnd());
    }
  }
}
// The `files` category is a list of unused files, not per-file items.
for (const f of report.files ?? []) {
  counts.files = (counts.files ?? 0) + 1;
  lines.push(`${'files'.padEnd(12)} ${f}`);
}
lines.sort();
if (lines.length) process.stdout.write(lines.join('\n') + '\n\n');

const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(`knip: ${summary || 'no findings'}`);

// ---- 3. knip's own verdict on the error-severity categories ----
let failed = false;
if (run.status !== 0) {
  console.error(`knip exited ${run.status}: an error-severity category above is non-empty (knip.jsonc → rules).`);
  failed = true;
}

// ---- 4 + 5. the ratchet ----
const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
for (const category of RATCHETED) {
  const now = counts[category] ?? 0;
  const max = baseline[category];
  if (typeof max !== 'number') {
    console.error(`knip-ratchet: knip-baseline.json has no numeric "${category}" entry.`);
    failed = true;
  } else if (now > max) {
    console.error(
      `FAIL  knip ${category}: ${now} unused, baseline allows ${max}. ` +
      `This change ADDS unused ${category === 'types' ? 'exported types' : 'exports'} — ` +
      `remove them (or their \`export\`) rather than raising the number in knip-baseline.json.`,
    );
    failed = true;
  } else if (now < max) {
    console.log(
      `ratchet  knip ${category}: ${now} unused, below the baseline of ${max}. ` +
      `Lower "${category}" to ${now} in knip-baseline.json in this same commit so it cannot creep back up.`,
    );
  } else {
    console.log(`ok       knip ${category}: ${now} unused (at the baseline).`);
  }
}

process.exit(failed ? 1 : 0);
