/* Run after npm run build:main. All records/indexes are temporary.
 * Optional --electron-asar: no-window, private-HOME Electron packaging proof.
 * WHY compiled probes: vitest's transforms cannot prove plain Node compatibility
 * or Electron's worker_threads resolution inside the production ASAR layout.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createConversationStore } = require('../dist/main/conversations/conversation-store');
const { refreshChatsearchIndex, resolveTranscriptPathTwoStep } = require('../dist/main/chatsearch-index/refresh-core');
const { createIndexWorkerRunner } = require('../dist/main/chatsearch-index/index-worker-runner');
const { ccProjectSlug, nativeStoreSlug } = require('../dist/main/slug-encoding');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-index-worker-probe-'));
const storeRoot = path.join(tmp, 'records');
const coreHome = path.join(tmp, 'core');
const workerHome = path.join(tmp, 'worker');
const { createTagRegistry } = require('../dist/main/conversations/tag-registry');
const tagsRoot = path.join(tmp, 'tags');
let activeTagsRoot = tagsRoot;
const stamp = '2026-07-26T18:04:11.000Z';
const store = createConversationStore(storeRoot);
const runner = createIndexWorkerRunner();
const count = 800;
const turns = 60;
function transcript(provider, id) { return path.join(storeRoot, provider, 'transcripts', 'project', `${id}.jsonl`); }
function line(provider, i) {
  const text = `synthetic turn ${i} ${'searchable history '.repeat(35)}`;
  return JSON.stringify(provider === 'claude'
    ? { type: 'user', uuid: `u${i}`, promptId: `p${i}`, timestamp: stamp, message: { role: 'user', content: text } }
    : { type: 'user-message', timestamp: Date.parse(stamp), data: { text } }) + '\n';
}
function record(provider, id, ref = `${provider}/transcripts/project/${id}.jsonl`) {
  return { schema: 1, id, provider, projectName: 'project', originalPath: '', title: 'Synthetic conversation',
    lastActive: stamp, device: 'fixture', flags: { 'tag:tag1': { value: true, updatedAt: stamp } },
    transcriptRef: ref, createdAt: stamp, note: '', noteUpdatedAt: stamp };
}
function writeRecord(rec) {
  const dir = path.join(storeRoot, rec.provider);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec));
}
async function legacyCycle() {
  const lanes = await Promise.all(['claude', 'native'].map(async (provider) => ({
    provider, lane: provider, records: await store.list(provider),
    resolveTranscriptPath: (rec) => resolveTranscriptPathTwoStep(rec, provider === 'claude'
      ? path.join(coreHome, '.claude', 'projects', ccProjectSlug(rec.originalPath), `${rec.id}.jsonl`)
      : path.join(coreHome, '.youcoded', 'sessions', nativeStoreSlug(rec.originalPath), `${rec.id}.jsonl`), storeRoot),
  })));
  const tags = activeTagsRoot === null ? [] : await createTagRegistry(activeTagsRoot).list().catch(() => []);
  return refreshChatsearchIndex({ homeRoot: coreHome, storeRoot, lanes, tagLabels: new Map(tags.map((tag) => [tag.id, tag.label])) });
}
const workerCycle = () => runner.run({ homeRoot: workerHome, storeRoot, tagsRoot: activeTagsRoot });
function localPath(home, provider, rec) {
  return provider === 'claude'
    ? path.join(home, '.claude', 'projects', ccProjectSlug(rec.originalPath), `${rec.id}.jsonl`)
    : path.join(home, '.youcoded', 'sessions', nativeStoreSlug(rec.originalPath), `${rec.id}.jsonl`);
}
function writeTranscript(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function snapshot(home) {
  const dir = path.join(home, '.youcoded', 'chatsearch');
  return Object.fromEntries(fs.readdirSync(dir).filter((name) => !name.includes('.tmp-')).sort().map((name) => {
    const raw = fs.readFileSync(path.join(dir, name), 'utf8');
    if (name.endsWith('-meta.json')) {
      const data = JSON.parse(raw);
      delete data.refreshedAt;
      // Missing malformed refs fall back to a home-local guess in both lanes.
      for (const rec of Object.values(data.conversations)) rec.transcriptPath = rec.transcriptPath.replace(home, '<home>');
      return [name, data];
    }
    return [name, raw];
  }));
}
async function measure(name, run) {
  const start = performance.now();
  let beats = 0;
  let maxDelayMs = 0;
  let previous = start;
  let firstMs;
  const beat = () => {
    const now = performance.now();
    firstMs ??= now - start;
    maxDelayMs = Math.max(maxDelayMs, now - previous);
    previous = now;
    beats++;
  };
  const timer = setInterval(beat, 5);
  const first = new Promise((resolve) => setTimeout(() => { beat(); resolve(); }, 0));
  try {
    assert.equal(await run(), true);
    const completionMs = performance.now() - start;
    const beatsDuringWork = beats;
    await first;
    // Include the heartbeat queued behind the final synchronous part of work;
    // otherwise a microtask completion could hide the very stall being measured.
    await new Promise((resolve) => setTimeout(() => { beat(); resolve(); }, 0));
    console.log(JSON.stringify({ name, completionMs: +completionMs.toFixed(1), firstHeartbeatMs: +firstMs.toFixed(1), maxHeartbeatGapMs: +maxDelayMs.toFixed(1), beatsDuringWork }));
  } finally { clearInterval(timer); }
}
async function parity(phase) {
  assert.equal(await legacyCycle(), true);
  assert.equal(await workerCycle(), true);
  assert.deepEqual(snapshot(workerHome), snapshot(coreHome));
  console.log(`PASS compiled worker/core parity: ${phase}`);
}
async function main() {
  fs.mkdirSync(tagsRoot);
  const tag = { schema: 1, id: 'tag1', label: 'Old label', labelUpdatedAt: stamp, createdAt: stamp };
  fs.writeFileSync(path.join(tagsRoot, 'tag1.json'), JSON.stringify(tag));
  fs.writeFileSync(path.join(tagsRoot, 'tag1-conflict.json'), JSON.stringify({ ...tag, label: 'Searchable label', labelUpdatedAt: '2026-07-27T18:04:11.000Z' }));
  fs.writeFileSync(path.join(tagsRoot, 'corrupt.json'), '{broken');
  for (const provider of ['claude', 'native']) {
    const content = (provider === 'native' ? '{"version":1}\n' : '') + Array.from({ length: turns }, (_, i) => line(provider, i)).join('');
    for (let i = 0; i < count; i++) {
      const id = `c${i}`;
      const file = transcript(provider, id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      writeRecord(record(provider, id));
    }
    if (process.platform !== 'win32') {
      fs.symlinkSync('c1.jsonl', transcript(provider, 'linked'));
      writeRecord(record(provider, 'linked'));
    }
    // WHY nonempty originalPath: catch wrong worker-local path construction,
    // not just the synced-ref branch. Both homes have independent live files.
    const originalPath = process.platform === 'win32' ? 'c:\\Projects\\Local History' : '/projects/local history';
    const localFirst = { ...record(provider, 'local-first'), originalPath };
    const fallback = { ...record(provider, 'local-missing'), originalPath };
    writeRecord(localFirst);
    writeRecord(fallback);
    const header = provider === 'native' ? '{"version":1}\n' : '';
    writeTranscript(transcript(provider, localFirst.id), header + line(provider, 900));
    writeTranscript(transcript(provider, fallback.id), header + line(provider, 901));
    for (const home of [coreHome, workerHome]) {
      writeTranscript(localPath(home, provider, localFirst), header + line(provider, 902) + line(provider, 903));
      assert.equal(fs.existsSync(localPath(home, provider, fallback)), false);
    }
    writeRecord(record(provider, 'missing'));
    writeRecord(record(provider, 'escape', '../outside.jsonl'));
    writeRecord(record(provider, 'wrong-lane', `${provider === 'claude' ? 'native' : 'claude'}/transcripts/project/c0.jsonl`));
  }
  console.log(`Fixture: ${count * 2} histories, ${count * turns * 2} turns; all under ${tmp}`);
  await measure('legacy full cycle on main', legacyCycle);
  await measure('compiled worker full cycle', workerCycle);
  assert.deepEqual(snapshot(workerHome), snapshot(coreHome));
  for (const provider of ['claude', 'native']) {
    const data = snapshot(workerHome)[`${provider}-meta.json`];
    assert.equal(data.conversations.c0.turnCount, turns);
    assert.deepEqual(data.conversations.c0.tags, ['Searchable label']);
    assert.equal(data.conversations['local-first'].turnCount, 2);
    assert.equal(data.conversations['local-first'].transcriptPath, localPath(workerHome, provider, data.conversations['local-first']).replace(workerHome, '<home>'));
    assert.equal(data.conversations['local-missing'].turnCount, 1);
    assert.equal(data.conversations['local-missing'].transcriptPath, transcript(provider, 'local-missing'));
    assert.equal(data.conversations['wrong-lane'], undefined);
    assert.equal(data.conversations.missing.tombstone, true);
    if (process.platform !== 'win32') assert.equal(data.conversations.linked.turnCount, 0);
  }
  console.log('PASS initial output, both lanes, malformed refs, missing histories, folded tag files, local-first and synced fallback paths');
  for (const unavailable of [null, path.join(tmp, 'absent-tags')]) {
    activeTagsRoot = unavailable;
    await parity(unavailable === null ? 'absent registry stays unlabeled' : 'unreadable registry stays unlabeled');
    assert.deepEqual(snapshot(workerHome)['claude-meta.json'].conversations.c0.tags, []);
  }
  activeTagsRoot = tagsRoot;
  await parity('unchanged');
  for (const provider of ['claude', 'native']) fs.appendFileSync(transcript(provider, 'c0'), line(provider, turns));
  await parity('growing');
  for (const provider of ['claude', 'native']) fs.writeFileSync(transcript(provider, 'c0'), (provider === 'native' ? '{"version":1}\n' : '') + line(provider, 0));
  await parity('shrunk');
  for (const home of [coreHome, workerHome]) {
    for (const provider of ['claude', 'native']) fs.appendFileSync(path.join(home, '.youcoded', 'chatsearch', `${provider}-turns.jsonl`), '{"orphaned":"interrupted append"}\n');
  }
  await parity('interrupted append repair');
  for (const provider of ['claude', 'native']) fs.unlinkSync(transcript(provider, 'c0'));
  await parity('removed transcripts');
  const before = snapshot(workerHome);
  const lock = path.join(workerHome, '.youcoded', 'chatsearch', '.build-lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), 'other builder');
  assert.equal(await workerCycle(), false);
  assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), 'other builder');
  fs.rmSync(lock, { recursive: true }); // Only the fixture-owned lock, after exit.
  assert.deepEqual(snapshot(workerHome), before);
  console.log('PASS shared build lock skips without mutation');
  for (const provider of ['claude', 'native']) {
    const dir = path.join(storeRoot, provider);
    for (const name of fs.readdirSync(dir)) if (name.endsWith('.json')) fs.unlinkSync(path.join(dir, name));
  }
  await parity('empty store preserves previous nonempty metadata');
  assert.deepEqual(snapshot(workerHome)['claude-meta.json'].conversations, before['claude-meta.json'].conversations);
}
async function electronAsar() {
  const { spawnSync } = require('node:child_process');
  const stage = path.join(tmp, 'stage');
  const archive = path.join(tmp, 'app.asar');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(stage, 'scripts'), { recursive: true });
  fs.mkdirSync(home);
  for (const dir of ['main', 'shared']) fs.cpSync(path.join(__dirname, '..', 'dist', dir), path.join(stage, 'dist', dir), { recursive: true });
  fs.copyFileSync(__filename, path.join(stage, 'scripts', 'probe-chatsearch-worker.js'));
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'chatsearch-asar-probe', version: '1.0.0', main: 'probe-main.js' }));
  fs.writeFileSync(path.join(stage, 'probe-main.js'), `
    const { app } = require('electron');
    const path = require('node:path');
    app.setPath('userData', path.join(process.env.HOME, 'userData'));
    app.disableHardwareAcceleration();
    const timer = setTimeout(() => { console.error('FAIL Electron ASAR probe timed out'); app.exit(1); }, 60_000);
    console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, archive: __dirname, workerEntry: require.resolve('./dist/main/chatsearch-index/index-worker'), userData: app.getPath('userData') }));
    require('./scripts/probe-chatsearch-worker.js').then(() => {
      clearTimeout(timer);
      console.log('Electron ASAR probe clean exit', process.exitCode || 0);
      app.exit(process.exitCode || 0);
    }, (error) => { console.error(error); app.exit(1); });
  `);
  // WHY use the existing builder's CLI: no dependency install or node_modules
  // links are needed. This worker graph uses only builtins and dist/main/shared.
  const cli = path.join(__dirname, '..', 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
  const packed = spawnSync(process.execPath, [cli, 'pack', stage, archive, '--unpack', 'scripts/**'], { encoding: 'utf8', timeout: 60_000 });
  if (packed.status !== 0) throw new Error(`ASAR pack failed: ${packed.error ?? packed.stderr}`);
  assert.equal(fs.existsSync(`${archive}.unpacked/dist/main/chatsearch-index/index-worker.js`), false);
  console.log('ASAR fixture: complete dist/main + dist/shared packed; scripts unpacked, no node_modules symlinks');
  const env = { ...process.env, HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  // Use only this worktree's npm Electron, never an installed application. The
  // wrapper isolates credentials; xvfb provides a disposable display, no windows.
  const result = spawnSync('bash', [path.resolve(__dirname, '../../../scripts/dev-isolation.sh'), 'xvfb-run', '-a', require('electron'), '--no-sandbox', '--disable-gpu', archive], { env, encoding: 'utf8', timeout: 90_000 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`Electron ASAR probe failed: status=${result.status}, signal=${result.signal}, error=${result.error ?? ''}`);
  assert.match(result.stdout, /Electron ASAR probe clean exit 0/);
}

module.exports = (process.argv.includes('--electron-asar') ? electronAsar() : main())
  .catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
    runner.stop();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  });
