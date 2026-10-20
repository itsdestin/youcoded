#!/usr/bin/env node
// No-account actual-CLI smoke. Linux/bubblewrap required; never copies auth or types controls.
// --cached-model permits ONE explicit legacy-user ESC to dismiss native cost confirmation.
// Usage: node test-conpty/test-claude-control-bridge.mjs --no-auth [--out NEW_DIRECTORY]
// Add --cached-model to verify pending native cost confirmation, explicit ESC cancellation and recovery.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startFakeApi } from './fake-anthropic.mjs';
import { stripAnsi, sleep } from './cc-capture-lib.mjs';

const self = fileURLToPath(import.meta.url);
const desktop = path.resolve(path.dirname(self), '..');
const argv = process.argv.slice(2);
const option = (name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
// WHY: validate a newly installed CLI without changing the recorded 2.1.302 baseline.
const cli = path.resolve(option('--cli') ?? '/home/destin/.local/share/claude/versions/2.1.302');
const expectedVersion = option('--expect-version') ?? '2.1.302';
const internal = argv.includes('--sandbox-child');
if (!argv.includes('--no-auth')) throw new Error('Explicit --no-auth required; only the local fake API is supported');

if (!internal) {
  const out = option('--out') ? path.resolve(option('--out')) : path.join(os.tmpdir(), `claude-control-smoke-${Date.now()}-${process.pid}`);
  fs.mkdirSync(out, { recursive: false, mode: 0o700 });
  fs.mkdirSync(path.join(out, 'tmp'));
  fs.copyFileSync(self, path.join(out, 'smoke-source.mjs'));
  // WHY: runner, fake API and CLI share one NEW loopback namespace; no route to paid endpoints.
  const args = ['--die-with-parent', '--new-session', '--unshare-net', '--unshare-pid', '--clearenv',
    '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
    '--bind', path.join(out, 'tmp'), '/tmp', '--bind', out, out, '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'HOME', path.join(out, 'home'), '--setenv', 'LANG', 'C.UTF-8',
    '--chdir', desktop, process.execPath, self, '--no-auth', '--sandbox-child', '--out', out, '--cli', cli, '--expect-version', expectedVersion,
    ...(argv.includes('--cached-model') ? ['--cached-model'] : [])];
  const log = fs.openSync(path.join(out, 'runner.log'), 'wx');
  const child = spawn('/usr/bin/bwrap', args, { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { fs.writeSync(log, b); process.stdout.write(b); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
  child.on('error', e => console.error(e));
  const code = await new Promise(resolve => child.on('close', c => resolve(c ?? 1)));
  clearTimeout(timer); fs.closeSync(log);
  console.log(`EVIDENCE ${out}\nEXIT ${code}`);
  process.exitCode = code;
} else {
  const out = path.resolve(option('--out'));
  const write = (name, value) => fs.writeFileSync(path.join(out, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const events = [];
  const mark = (kind, data) => { const e = { at: new Date().toISOString(), kind, data }; events.push(e); fs.appendFileSync(path.join(out, 'events.jsonl'), JSON.stringify(e) + '\n'); };
  const cases = [];
  const check = async (name, fn) => { try { await fn(); cases.push({ name, pass: true }); console.log(`PASS ${name}`); } catch (e) { cases.push({ name, pass: false, error: e.stack }); console.error(`FAIL ${name}: ${e.message}`); } };
  const wait = async (label, predicate, ms = 25000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = predicate(); if (value) return value; await sleep(50); }
    throw new Error(`Timeout: ${label}`);
  };
  const require = createRequire(import.meta.url);
  const { ClaudeControlBridge } = require(path.join(desktop, 'dist/main/claude-control-bridge.js'));
  const pty = require('node-pty');
  const bridge = new ClaudeControlBridge(path.join(out, 'deployment'), { operationTimeoutMs: 12000, pollMs: 5000 });
  const state = {};
  bridge.on('state', (id, s) => { state[id] = s; mark('state', { id, ...s }); });
  bridge.on('settled', (id, request, result) => mark('settled', { id, request, result }));
  // WHY: /tmp has no workspace/home ancestors whose CLAUDE.md could enter the fixture request.
  const home = '/tmp/home', config = path.join(home, '.claude'), project = '/tmp/project';
  fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(project);
  write('safety.json', { noAuth: true, namespace: fs.readlinkSync('/proc/self/ns/net'), cli, envPolicy: 'literal allowlist; dummy local token; no credential copying', terminalControlWrites: 0 });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [project]: { hasTrustDialogAccepted: true } } }));
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
  const requests = [], observerEvents = [], proxyEvents = [], children = [];
  let dropResult = false, api, proxy, observer;
  const transcriptFiles = () => {
    const files = [];
    const walk = dir => { if (!fs.existsSync(dir)) return; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) walk(p); else if (p.endsWith('.jsonl')) files.push(p); } };
    walk(path.join(config, 'projects')); return files;
  };
  const rows = () => transcriptFiles().flatMap(file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [{ file, ...JSON.parse(line) }]; } catch { return []; } }));
  const userCount = text => rows().filter(r => r.type === 'user' && (r.message?.content === text || r.message?.content?.some?.(c => c.type === 'text' && c.text === text))).length;
  const latestPrompt = body => body.messages?.filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : m.content?.filter(c => c.type === 'text').map(c => c.text) ?? []).findLast(text => /^SMOKE_/.test(text));
  const mainWith = text => requests.filter(r => r.main && latestPrompt(r.body) === text);
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  const shut = server => new Promise(resolve => { if (!server) return resolve(); server.closeAllConnections(); server.close(resolve); });
  let prepared, target;
  const execute = async request => { const result = await bridge.execute('actual', request); mark('execute', { request, result }); return result; };
  const send = async (text, sendId = text) => {
    const observerStart = observerEvents.length;
    const result = await execute({ kind: 'send-text', text, sendId }); assert.equal(result.status, 'accepted');
    await wait(`API prompt ${text}`, () => mainWith(text).length);
    await wait(`transcript ${text}`, () => userCount(text) === 1);
    await wait('main turn settled', () => state.actual?.turnId === null && observerEvents.slice(observerStart).some(e => e.event === 'complete' && e.reason === 'answer'));
    return result;
  };
  try {
    api = await startFakeApi(Array.from({ length: 30 }, () => body => {
      const last = latestPrompt(body) ?? '';
      return last === 'SMOKE_STOP_REAL_TURN' ? { text: 'Streaming cancellation target '.repeat(30), wordMs: 100 } : { text: 'LOCAL_FIXTURE_RESPONSE', wordMs: 0 };
    }), { onRequest(req, body) { const r = { path: req.url, main: body.tools?.length > 5, body }; requests.push(r); fs.appendFileSync(path.join(out, 'api.jsonl'), JSON.stringify(r) + '\n'); } });
    observer = http.createServer((req, res) => { let raw = ''; req.on('data', b => raw += b); req.on('end', () => { try { observerEvents.push(JSON.parse(raw)); mark('observer', JSON.parse(raw)); } catch {} res.end('{}'); }); });
    const observerUrl = await listen(observer);
    const plugin = path.join(out, 'observer'); fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true }); fs.mkdirSync(path.join(plugin, 'hooks'));
    fs.writeFileSync(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'claude-control-smoke-observer', version: '1.0.0' }));
    fs.writeFileSync(path.join(plugin, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.js'] }));
    // WHY: observe genuine engine completion/cancellation; this plugin has NO prompt/command/abort capability.
    fs.writeFileSync(path.join(plugin, 'hooks/register.js'), `async function observe($,e,next){if(e.agentId===undefined){try{await $.http.fetch(${JSON.stringify(observerUrl)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'complete',turnId:e.turnId,reason:e.reason})});}catch(_){}}return next(e);}export function register(on){on('turn.complete',observe);}`);
    prepared = await bridge.prepare('actual'); assert.ok(prepared); target = new URL(prepared.env.YOUCODED_CC_CONTROL_URL);
    proxy = http.createServer((req, res) => {
      let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        const dropped = dropResult && req.url === '/result';
        proxyEvents.push({ path: req.url, body, dropped }); mark('proxy', { path: req.url, body, dropped });
        // WHY: drop only the receipt TO the host, not the invocation, claim, state, poll or auth.
        if (dropped) { res.writeHead(503); res.end('{}'); return; }
        const upstream = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, response => {
          let reply = ''; response.on('data', b => reply += b);
          response.on('end', () => {
            let body; try { body = JSON.parse(reply); } catch { body = reply; }
            mark('proxy-response', { path: req.url, status: response.statusCode, body });
            res.writeHead(response.statusCode, response.headers); res.end(reply);
          });
        });
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('{}'); });
        res.on('close', () => { if (!res.writableEnded) upstream.destroy(); }); upstream.end(raw);
      });
    });
    const proxyUrl = await listen(proxy);
    const env = { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: config, TMPDIR: '/tmp', TERM: 'xterm-256color', LANG: 'C.UTF-8',
      ANTHROPIC_BASE_URL: api.url, ANTHROPIC_AUTH_TOKEN: 'localfakeAPI', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...prepared.env, YOUCODED_CC_CONTROL_URL: proxyUrl };
    const version = execFileSync(cli, ['--version'], { env, cwd: project, encoding: 'utf8', timeout: 10000 }).trim();
    assert.equal(version.split(' ')[0], expectedVersion);
    write('build-identity.json', { version, files: Object.fromEntries(['src/main/claude-control-bridge.ts', 'src/main/claude-control-plugin.ts', 'dist/main/claude-control-bridge.js', 'dist/main/claude-control-plugin.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(desktop, file))).digest('hex')])) });
    const args = ['--model', 'sonnet', ...prepared.args, '--plugin-dir', plugin];
    write('launch.json', { cli, args, env: { ...env, YOUCODED_CC_CONTROL_TOKEN: '[redacted]' } });
    const child = pty.spawn(cli, args, { cwd: project, env, cols: 120, rows: 40 }); children.push(child);
    child.onData(data => { fs.appendFileSync(path.join(out, 'terminal.raw'), data); });
    child.onExit(e => mark('cli-exit', e));
    await check('missing handshake is unavailable', async () => {
      assert.equal((await bridge.execute('missing', { kind: 'command', command: 'model', args: 'sonnet' })).status, 'unavailable');
      await bridge.prepare('no-handshake'); assert.equal(bridge.isReady('no-handshake'), false);
      assert.equal((await bridge.execute('no-handshake', { kind: 'command', command: 'clear' })).status, 'unavailable'); bridge.closeSession('no-handshake');
    });
    await check('native CLI production plugin readiness', async () => { await wait('production handshake', () => bridge.isReady('actual')); await wait('session getters', () => state.actual?.claudeSessionId); });
    if (!bridge.isReady('actual')) throw new Error('Cannot exercise production controls without actual CLI handshake');
    if (argv.includes('--cached-model')) {
      await check('cached model confirmation stays pending; explicit legacy ESC cancels and direct controls recover', async () => {
        await send('SMOKE_CACHED_MODEL_HISTORY');
        const previousModel = state.actual.model;
        const apiBefore = requests.length;
        const { Terminal } = require('@xterm/headless');
        const screen = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
        const viewport = () => Array.from({ length: screen.rows }, (_, i) => screen.buffer.active.getLine(screen.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n');
        const screenFeed = child.onData(data => screen.write(data));
        let resolved = false;
        const pending = execute({ kind: 'command', command: 'model', args: 'haiku' }).then(result => { resolved = true; return result; });
        try {
          await wait('native cached-model confirmation viewport', () => /Switch model\?/.test(viewport()) && /No,\s*go\s*back/i.test(viewport()), 8000);
          await sleep(300);
          assert.equal(resolved, false, 'native confirmation must remain unresolved before user dismissal');
          assert.equal(state.actual.model, previousModel);
          assert.equal(requests.length, apiBefore, 'pending confirmation must not invoke a model');
          write('cached-model-pending-screen.txt', viewport());
          mark('cached-model-pending', { previousModel, resolved, apiRequests: requests.length });
          // WHY: this ONE ESC is deliberate retained legacy USER interaction, not structured approval or Stop.
          mark('legacy-user-interaction', { kind: 'cancel-native-model-confirmation', bytesHex: '1b', fullyStructuredApproval: false });
          child.write('\x1b');
          write('safety.json', { noAuth: true, namespace: fs.readlinkSync('/proc/self/ns/net'), cli, envPolicy: 'literal allowlist; dummy local token; no credential copying', terminalControlWrites: 0, legacyUserInteractionWrites: 1, legacyUserInteraction: 'single ESC cancels native cached-model confirmation; not structured approval' });
          const result = await pending;
          assert.equal(result.status, 'accepted');
          assert.equal(result.model, previousModel, 'cancelled model change must report unchanged getter');
          await wait('native confirmation dismissed', () => !/Switch model\?/.test(viewport()));
          write('cached-model-cancelled-screen.txt', viewport());
          const after = await send('SMOKE_AFTER_MODEL_CANCEL');
          assert.equal(after.model, previousModel);
          assert.ok(mainWith('SMOKE_AFTER_MODEL_CANCEL').every(r => r.body.model === previousModel));
          const control = await execute({ kind: 'command', command: 'model', args: 'sonnet' });
          assert.equal(control.status, 'accepted');
          assert.equal(control.model, previousModel);
        } finally { screenFeed.dispose(); screen.dispose(); }
      });
      if (cases.at(-1)?.pass !== true) throw new Error('Cached-model confirmation case failed; stopping to avoid cascading control errors');
    } else {
      await check('cold model command getter and API effect', async () => { const r = await execute({ kind: 'command', command: 'model', args: 'haiku' }); assert.equal(r.status, 'accepted'); assert.match(r.model, /haiku/i); await send('SMOKE_MODEL_EFFECT'); assert.ok(mainWith('SMOKE_MODEL_EFFECT').some(r => /haiku/i.test(r.body.model))); });
    }
    await check('text delivered once with actual transcript', async () => { await send('SMOKE_TEXT_ONCE'); const duplicate = await execute({ kind: 'send-text', text: 'SMOKE_TEXT_ONCE', sendId: 'SMOKE_TEXT_ONCE' }); assert.equal(duplicate.status, 'accepted'); assert.equal(userCount('SMOKE_TEXT_ONCE'), 1); });
    await check('clear changes identity and subsequent text works', async () => { const before = state.actual.claudeSessionId; const r = await execute({ kind: 'command', command: 'clear' }); assert.equal(r.status, 'accepted'); assert.notEqual(r.claudeSessionId, before); await send('SMOKE_AFTER_CLEAR'); assert.equal(bridge.isReady('actual'), true); });
    await check('compact actual effect then further control', async () => { const before = requests.length; const r = await execute({ kind: 'command', command: 'compact' }); assert.equal(r.status, 'accepted'); await wait('compact transcript boundary', () => rows().some(r => r.type === 'system' && r.subtype === 'compact_boundary')); assert.ok(requests.length > before); await send('SMOKE_AFTER_COMPACT'); });
    await check('Stop targets genuine main turn and cancels', async () => {
      const start = observerEvents.length;
      const pending = execute({ kind: 'send-text', text: 'SMOKE_STOP_REAL_TURN', sendId: 'stop-target' });
      await wait('streaming main request', () => mainWith('SMOKE_STOP_REAL_TURN').length);
      const turnId = await wait('active main turn', () => state.actual?.turnId);
      const stop = await execute({ kind: 'stop' }); assert.equal(stop.status, 'accepted');
      await wait('engine cancellation completion', () => observerEvents.slice(start).find(e => e.turnId === turnId && /abort|cancel|interrupt/i.test(e.reason)));
      assert.ok(events.some(e => e.kind === 'proxy-response' && e.data.body?.request?.kind === 'stop' && e.data.body.turnId === turnId), 'Stop operation must address the observed main turn');
      await pending; await send('SMOKE_AFTER_STOP');
    });
    await check('lost receipt returns unknown and dedup prevents second prompt', async () => {
      dropResult = true; const request = { kind: 'send-text', text: 'SMOKE_LOST_RECEIPT', sendId: 'lost-receipt' };
      const r = await execute(request); assert.equal(r.status, 'unknown');
      await wait('lost receipt actual effect', () => userCount(request.text) === 1 && mainWith(request.text).length === 1);
      assert.ok(proxyEvents.some(e => e.path === '/result' && e.dropped));
      const duplicate = await execute(request); assert.equal(duplicate.status, 'unknown');
      dropResult = false;
      await send('SMOKE_DEDUP_BARRIER'); // Positive later control proves the serial queue passed the duplicate.
      assert.equal(mainWith(request.text).length, 1); assert.equal(userCount(request.text), 1);
    });
    await check('close revokes client capability and settles pending', async () => {
      dropResult = true;
      const pending = execute({ kind: 'send-text', text: 'SMOKE_CLOSE_PENDING', sendId: 'close-pending' });
      await wait('close pending claimed', () => userCount('SMOKE_CLOSE_PENDING') === 1);
      bridge.closeSession('actual'); assert.equal(bridge.isReady('actual'), false);
      assert.equal((await pending).status, 'unknown');
      const response = await fetch(target + 'state', { method: 'POST', headers: { authorization: 'Bearer ' + prepared.env.YOUCODED_CC_CONTROL_TOKEN, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 401);
    });
  } catch (e) { cases.push({ name: 'runtime prerequisites', pass: false, error: e.stack }); console.error(e.stack); }
  finally {
    for (const child of children) { try { child.kill('SIGTERM'); } catch {} }
    await bridge.close(); await shut(proxy); await shut(observer); await api?.close();
    write('api-requests.json', requests); write('observer-events.json', observerEvents); write('proxy.json', proxyEvents);
    if (fs.existsSync(path.join(out, 'terminal.raw'))) write('terminal.txt', stripAnsi(fs.readFileSync(path.join(out, 'terminal.raw'), 'utf8')));
    write('transcript-index.json', transcriptFiles().map(file => ({ sandbox: file, host: path.join(out, 'tmp', path.relative('/tmp', file)) })));
    write('summary.json', { pass: cases.length === 9 && cases.every(c => c.pass), cases, cleanup: 'exact PTY child SIGTERM; bridge/proxy/observer/fake API closed; bwrap PID namespace kills descendants on exit' });
    console.log(JSON.stringify(cases, null, 2)); process.exitCode = cases.length === 9 && cases.every(c => c.pass) ? 0 : 1;
  }
}
