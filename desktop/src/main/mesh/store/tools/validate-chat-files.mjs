// READ-ONLY validation of the adapter over a folder of real chat files. Reports only counts, sizes and
// 8-character ids; never prints, stores or logs any line content.
//
//   bash run-tool.sh validate-chat-files.mjs <folder> [--runtime claude-code|native] [--workers N<=4] [--include-helpers]
//
// With `--store` every chat is also copied into a throwaway chat store under the OS temp folder (4 MiB body chunks, so big chats span several), the store is closed,
// reopened, verified and its head compared with the adapter's chain values; the temp folder is deleted afterwards. Counts only.
// For each `<project folder>/<chat id>.jsonl` it runs the S1 adapter from line 0 in batches, then polls again
// (must be unchanged or only new lines, never `rewritten`) and runs the full re-hash scrub. Files are only
// ever opened with flag 'r'. A chat that is being written while we read it may legitimately gain lines.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const outDir = isMainThread ? process.env.MESH_STORE_OUT : workerData.outDir;
const { defaultChainSeeds, initAdapterState, ingest, poll, scrub, isRewritten, cheapCheck, ChatStore } = require(path.join(outDir, 'index.js'));
const os = require('node:os');
const USE_STORE = isMainThread ? process.argv.includes('--store') : workerData.store;

let CURRENT_DIR = null;   // the throwaway store of the file being processed, removed even when it fails
async function validate(file, runtime) {
  const id8 = path.basename(file, '.jsonl').slice(0, 8);
  const seeds = defaultChainSeeds({ chatId: 'validation', version: new Uint8Array(), segment: 0 });
  const opts = { runtime, seeds };
  let state = initAdapterState(seeds);
  const r = { id8, bytes: 0, lines: 0, conv: 0, replyEnds: 0, pending: false, user: 0, assistant: 0, bookkeeping: 0, invalid: 0, oversize: 0, tornBytes: 0, rewritten: null, scrubOk: true, secondPoll: 'unchanged' };
  let store = null; let storeDir = null; const V = Buffer.from([0xaa, 1]);
  if (USE_STORE) {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-validate-')); CURRENT_DIR = storeDir;
    store = await ChatStore.open(path.join(storeDir, 's'), { chunkBytes: 4 * 1024 * 1024 });
    await store.registerVersion(V, { chatId: 'validation', runtime });
  }
  const g = ingest(file, state, opts);
  for (;;) {
    const x = await g.next();
    if (x.done) { if (x.value) r.rewritten = x.value.rewritten; break; }
    const b = x.value;
    if (store && b.lines.length) await store.append(V, 0, r.lines, b.lines);
    r.lines += b.lines.length; r.replyEnds += b.replyEnds.length;
    r.user += b.counts.user; r.assistant += b.counts.assistant; r.bookkeeping += b.counts.bookkeeping; r.invalid += b.counts.invalid; r.oversize += b.counts.oversize;
    state = b.state;
  }
  r.bytes = state.offset; r.conv = state.convLines; r.pending = state.rs.cand !== null;
  if (!r.rewritten) {
    const cheap = await cheapCheck(file, state);
    const second = await poll(file, state, opts);
    if (isRewritten(second)) { r.secondPoll = second.rewritten === 'missing' ? 'missing' : 'rewritten'; if (second.rewritten !== 'missing') r.rewritten = second.rewritten; }
    else { r.secondPoll = second.lines.length ? 'grew' : 'unchanged'; r.tornBytes = second.tornBytes; if (cheap.kind === 'suspect') r.rewritten = 'cheap-check-suspect'; }
    if (r.secondPoll === 'unchanged') r.scrubOk = await scrub(file, state, opts).catch(() => false);
  }
  if (store) {
    await store.close();
    const s2 = await ChatStore.open(path.join(storeDir, 's'), { chunkBytes: 4 * 1024 * 1024 });
    await s2.registerVersion(V, { chatId: 'validation', runtime });
    const head = await s2.head(V); const ver = await s2.verify(V);
    r.store = { headOk: head.lines === r.lines && head.hash === state.chain && head.conversationHash === state.conv, verifyOk: ver.ok, damaged: head.damagedFromLine !== null };
    await s2.close(); fs.rmSync(storeDir, { recursive: true, force: true }); CURRENT_DIR = null;
  }
  return r;
}

async function discover(root, includeHelpers) {
  const out = [];
  const walk = async (dir, depth) => {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl') && (includeHelpers || depth === 1)) out.push(p);
      else if (e.isDirectory() && (includeHelpers || depth < 1)) await walk(p, depth + 1);
    }
  };
  await walk(root, 0);
  return out.sort();
}

async function main() {
  const argv = process.argv.slice(2);
  const folder = argv[0];
  if (!folder) { process.stderr.write('usage: validate-chat-files.mjs <folder> [--runtime claude-code|native] [--workers N] [--include-helpers] [--store]\n'); process.exit(2); }
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const workers = Math.max(1, Math.min(4, Number(opt('--workers') ?? 4)));
  const runtime = opt('--runtime') ?? (folder.includes('.youcoded') ? 'native' : 'claude-code');
  const files = await discover(path.resolve(folder), argv.includes('--include-helpers'));
  const results = [];
  let next = 0; const started = Date.now();
  await Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { runtime, outDir, store: argv.includes('--store') } });
    const feed = () => w.postMessage(next < files.length ? { file: files[next++] } : { done: true });
    w.on('message', (m) => { results.push(m); feed(); });
    w.on('error', reject); w.on('exit', () => resolve());
    feed();
  })));
  const sum = (f) => results.reduce((n, r) => n + f(r), 0);
  const list = (pred, show) => results.filter(pred).map(show).join(', ') || 'none';
  const out = [
    `folder files found: ${files.length}; parsed: ${results.length}; workers: ${workers}; runtime: ${runtime}; seconds: ${((Date.now() - started) / 1000).toFixed(1)}`,
    `total bytes: ${sum((r) => r.bytes)}; lines: ${sum((r) => r.lines)}; conversation lines: ${sum((r) => r.conv)}; reply ends confirmed: ${sum((r) => r.replyEnds)}; files ending with an unconfirmed reply: ${results.filter((r) => r.pending).length}`,
    `line kinds: user ${sum((r) => r.user)}, assistant ${sum((r) => r.assistant)}, bookkeeping ${sum((r) => r.bookkeeping)}, invalid JSON ${sum((r) => r.invalid)}, oversize ${sum((r) => r.oversize)}`,
    `files with a torn final line: ${results.filter((r) => r.tornBytes > 0).length} (${list((r) => r.tornBytes > 0, (r) => `${r.id8}:${r.tornBytes}B`)})`,
    `files with invalid JSON lines: ${results.filter((r) => r.invalid > 0).length} (${list((r) => r.invalid > 0, (r) => `${r.id8}:${r.invalid}`)})`,
    `rewrites detected: ${results.filter((r) => r.rewritten).length} (${list((r) => !!r.rewritten, (r) => `${r.id8}:${r.rewritten}`)})`,
    `files that grew while being read: ${results.filter((r) => r.secondPoll === 'grew').length}; vanished: ${results.filter((r) => r.secondPoll === 'missing').length}; scrub failures: ${results.filter((r) => !r.scrubOk).length}`,
    ...(argv.includes('--store') ? [`store copy: files checked ${results.filter((r) => r.store).length}; head differs from the adapter: ${results.filter((r) => r.store && !r.store.headOk).length}; verify failed: ${results.filter((r) => r.store && !r.store.verifyOk).length}; reported damaged: ${results.filter((r) => r.store && r.store.damaged).length}`] : []),
    `largest file: ${Math.max(0, ...results.map((r) => r.bytes))} bytes; files over 100 MB: ${results.filter((r) => r.bytes > 100e6).length}`,
  ];
  process.stdout.write(out.join('\n') + '\n');
}

if (isMainThread) main().catch((e) => { process.stderr.write(String(e && e.message) + '\n'); process.exit(1); });
else {
  parentPort.on('message', async (m) => {
    if (m.done) process.exit(0);
    try { parentPort.postMessage(await validate(m.file, workerData.runtime)); }
    catch (e) { if (CURRENT_DIR) fs.rmSync(CURRENT_DIR, { recursive: true, force: true }); parentPort.postMessage({ id8: path.basename(m.file).slice(0, 8), bytes: 0, lines: 0, conv: 0, replyEnds: 0, pending: false, user: 0, assistant: 0, bookkeeping: 0, invalid: 0, oversize: 0, tornBytes: 0, rewritten: 'error:' + (e.code ?? 'unknown'), scrubOk: false, secondPoll: 'missing' }); }
  });
}
