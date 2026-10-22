#!/usr/bin/env node
// Bring archived file history back into a project's .youcoded/artifacts.json.
//
//   node scripts/restore-artifact-archive.mjs <projectRoot> [--ids ID,ID] [--since 2026-10-01] [--dry-run]
//
// The sidecar cleanup (src/main/artifacts/sidecar-cleanup.ts) moves records of long-gone files into
// <projectRoot>/.youcoded/artifacts-archive/<YYYY-MM>.jsonl.gz instead of deleting them. This puts them back.
// Records whose id (or kind+path) is already in the file are skipped, so running it twice adds nothing.
// Close YouCoded on that project first: this edits the file directly, outside the app's write lock.
// A copy of the file as it was is saved next to it as artifacts.json.pre-restore-<time>.bak before any change.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--ids' && args[args.indexOf(a) - 1] !== '--since');
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ids = flag('--ids')?.split(',').filter(Boolean);
const since = flag('--since') ? Date.parse(flag('--since')) : null;
const dry = args.includes('--dry-run');
if (!root) { console.error('usage: restore-artifact-archive.mjs <projectRoot> [--ids a,b] [--since ISO-date] [--dry-run]'); process.exit(2); }

const sidecarPath = path.join(root, '.youcoded', 'artifacts.json');
const archiveDir = path.join(root, '.youcoded', 'artifacts-archive');
if (!fs.existsSync(sidecarPath)) { console.error(`no ${sidecarPath}`); process.exit(1); }
if (!fs.existsSync(archiveDir)) { console.log('nothing archived for this project'); process.exit(0); }

const byId = new Map();
for (const name of fs.readdirSync(archiveDir).filter((n) => n.endsWith('.jsonl.gz')).sort()) {
  const text = zlib.gunzipSync(fs.readFileSync(path.join(archiveDir, name))).toString('utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r.id === 'string') byId.set(r.id, r); } catch { /* damaged line: skip */ }
  }
}
const wanted = [...byId.values()].filter((r) => {
  if (ids && !ids.includes(r.id)) return false;
  if (since !== null) {
    const newest = Math.max(...(r.versions ?? []).map((v) => Date.parse(v.ts)).filter((n) => !Number.isNaN(n)), -Infinity);
    if (!(newest >= since)) return false;
  }
  return true;
});

const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
const haveId = new Set(sidecar.artifacts.map((r) => r.id));
const havePath = new Set(sidecar.artifacts.map((r) => `${r.kind}\0${r.path}`));
const add = wanted.filter((r) => !haveId.has(r.id) && !havePath.has(`${r.kind}\0${r.path}`));
console.log(`${byId.size} archived, ${wanted.length} match, ${add.length} to bring back (${wanted.length - add.length} already present)`);
if (dry || add.length === 0) process.exit(0);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(sidecarPath, `${sidecarPath}.pre-restore-${stamp}.bak`, fs.constants.COPYFILE_EXCL);
sidecar.artifacts.push(...add);
// updatedAt is the app's compare-and-swap token: it must move forward.
sidecar.updatedAt = new Date(Math.max(Date.now(), Date.parse(sidecar.updatedAt) + 1)).toISOString();
const tmp = `${sidecarPath}.restore.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(sidecar));
fs.renameSync(tmp, sidecarPath);
console.log(`restored ${add.length} records into ${sidecarPath}`);
