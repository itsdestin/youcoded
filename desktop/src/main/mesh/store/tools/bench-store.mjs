// Performance numbers for the adapter and store on a synthetic ~300 MB chat (generated in a temp folder
// and deleted afterwards; nothing real is read or written).
//
//   bash run-tool.sh bench-store.mjs [megabytes=300]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { defaultChainSeeds, initAdapterState, ingest, poll, cheapCheck, scrub, ChatStore } = require(path.join(process.env.MESH_STORE_OUT, 'index.js'));

const MB = Number(process.argv[2] ?? 300);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-bench-'));
const say = (s) => process.stdout.write(s + '\n');
let peakRss = 0;
const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);

function makeFile(file, bytes) {
  const fd = fs.openSync(file, 'w'); let written = 0; let n = 0; let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let buf = []; let buffered = 0;
  while (written + buffered < bytes) {
    const kind = rand();
    const pad = 'x'.repeat(Math.floor(rand() * (kind < 0.1 ? 40000 : 3000)));
    const o = kind < 0.4 ? { type: 'user', uuid: `u${n}`, message: { role: 'user', content: 'q' + pad } }
      : kind < 0.8 ? { type: 'assistant', uuid: `u${n}`, message: { id: `m${Math.floor(n / 2)}`, model: 'synthetic-model', stop_reason: 'end_turn', content: [{ type: 'text', text: pad }] } }
        : { type: 'last-prompt', uuid: `u${n}`, pad };
    const b = Buffer.from(JSON.stringify(o) + '\n'); buf.push(b); buffered += b.length; n++;
    if (buffered > 8e6) { fs.writeSync(fd, Buffer.concat(buf)); written += buffered; buf = []; buffered = 0; }
  }
  if (buf.length) fs.writeSync(fd, Buffer.concat(buf));
  fs.closeSync(fd);
  return n;
}

async function main() {
  const file = path.join(dir, 'synthetic.jsonl');
  const gen0 = performance.now();
  const lines = makeFile(file, MB * 1e6);
  const size = fs.statSync(file).size;
  say(`synthetic chat: ${(size / 1e6).toFixed(0)} MB, ${lines} lines (generated in ${((performance.now() - gen0) / 1000).toFixed(1)} s)`);
  const seeds = defaultChainSeeds({ chatId: 'bench', version: new Uint8Array(), segment: 0 });
  const opts = { runtime: 'claude-code', seeds };
  const rssBefore = process.memoryUsage().rss;

  // 1. adapter + store append, streamed in batches (the real ingest path)
  const store = await ChatStore.open(path.join(dir, 'store'));
  const V = Buffer.from([1, 2, 3]);
  await store.registerVersion(V, { chatId: 'bench', runtime: 'claude-code' });
  let state = initAdapterState(seeds); let n = 0; let adapterMs = 0; let storeMs = 0;
  const g = ingest(file, state, opts);
  for (;;) {
    const t0 = performance.now();
    const x = await g.next();
    adapterMs += performance.now() - t0;
    if (x.done) break;
    const t1 = performance.now();
    await store.append(V, 0, n, x.value.lines);
    storeMs += performance.now() - t1; n += x.value.lines.length; state = x.value.state;
  }
  say(`adapter alone (read + hash both chains + classify): ${(size / 1e6 / (adapterMs / 1000)).toFixed(0)} MB/s (${(adapterMs / 1000).toFixed(1)} s)`);
  say(`store append, batches of ~8 MB, fsynced: ${(size / 1e6 / (storeMs / 1000)).toFixed(0)} MB/s (${(storeMs / 1000).toFixed(1)} s, ${(n / (storeMs / 1000)).toFixed(0)} lines/s)`);
  say(`peak memory while ingesting ${(size / 1e6).toFixed(0)} MB: ${((peakRss - rssBefore) / 1e6).toFixed(0)} MB above the starting level (peak RSS ${(peakRss / 1e6).toFixed(0)} MB)`);

  // 2. cold head: a brand new store object on the same folder
  await store.close();
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const s2 = await ChatStore.open(path.join(dir, 'store'));
    const h = await s2.head(V);
    times.push(performance.now() - t);
    if (h.lines !== n) throw new Error('head mismatch');
    await s2.close();
  }
  times.sort((a, b) => a - b);
  say(`cold open + head() on the ${n}-line version: median ${times[2].toFixed(1)} ms (min ${times[0].toFixed(1)}, max ${times[4].toFixed(1)})`);

  // 3. range reads
  const s3 = await ChatStore.open(path.join(dir, 'store'));
  const mid = Math.floor(n / 2);
  for (const span of [1, 100, 1000]) {
    const t = performance.now();
    const got = await s3.read(V, 0, mid, mid + span);
    const ms = performance.now() - t;
    const bytes = got === 'evicted' ? 0 : got.reduce((a, b) => a + b.length, 0);
    say(`read ${span} line(s) from the middle: ${ms.toFixed(1)} ms (${(bytes / 1e6).toFixed(2)} MB)`);
  }
  // live path: one ~1 KB line per call, each fsynced (body sync + index sync)
  const live = Buffer.from(JSON.stringify({ type: 'user', uuid: 'live', message: { content: 'x'.repeat(900) } }) + '\n');
  const tl = performance.now();
  for (let i = 0; i < 300; i++) await s3.append(V, 0, n + i, [live]);
  say(`live single-line append (fsynced): ${((performance.now() - tl) / 300).toFixed(2)} ms per line`);
  const th = performance.now(); await s3.hashAt(V, 0, mid); say(`hashAt(middle): ${(performance.now() - th).toFixed(2)} ms`);
  const tr = performance.now(); const re = await s3.replyEnds(V); say(`replyEnds() first call over ${n} lines: ${(performance.now() - tr).toFixed(0)} ms (${re.confirmed.length} ends)`);
  await s3.close();

  // 4. adapter unchanged poll and scrub
  const polls = [];
  for (let i = 0; i < 200; i++) { const t = performance.now(); const c = await cheapCheck(file, state); polls.push(performance.now() - t); if (c.kind !== 'unchanged') throw new Error('not unchanged'); }
  polls.sort((a, b) => a - b);
  say(`unchanged poll (cheapCheck) of the ${(size / 1e6).toFixed(0)} MB file: median ${polls[100].toFixed(2)} ms, p99 ${polls[197].toFixed(2)} ms`);
  const tp = performance.now(); const p = await poll(file, state, opts); say(`full poll() when unchanged: ${(performance.now() - tp).toFixed(2)} ms (${'lines' in p ? p.lines.length : 'rewritten'} new lines)`);
  const ts = performance.now(); const ok = await scrub(file, state, opts); say(`scrub (full re-hash): ${((performance.now() - ts) / 1000).toFixed(1)} s, intact=${ok}`);
}

await main().finally(() => { clearInterval(sample); fs.rmSync(dir, { recursive: true, force: true }); process.stdout.write('temp folder deleted\n'); });
