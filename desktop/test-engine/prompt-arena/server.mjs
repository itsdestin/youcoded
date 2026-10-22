#!/usr/bin/env node
// Prompt Arena — blind side-by-side testing of two system prompts on the real
// native assistant engine.
//
//   node test-engine/prompt-arena/server.mjs [--port 5288] [--dist <built dist/>]
//
// Then open http://127.0.0.1:5288. Each test pairs two prompts (and a model for
// each), assigns them to Left/Right at random, and runs each side as its own
// live HarnessSession in its own throwaway folder with the app's full tool set.
// The page never learns which prompt is on which side until the owner presses
// Reveal; the server holds that mapping.
//
// WHY the key is pasted into the page and held only in this process's memory:
// the evaluator's rule (.claude/rules/harness-evaluator.md) is that the key
// lives nowhere between runs and never in the environment, because a model's
// Bash tool can read every same-uid process's environment. A long-running
// tool can't be handed a file that is deleted straight after, so the page
// posts it once per launch over localhost and nothing writes it to disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(flag('port', '5288'));
const DIST = path.resolve(flag('dist', path.join(HERE, '../../dist')));
const DATA = path.join(os.homedir(), '.youcoded-prompt-arena');

if (process.env.OPENROUTER_API_KEY) {
  console.error('prompt-arena: refusing to start with OPENROUTER_API_KEY in the environment — the assistant\'s Bash tool could read it. Unset it and paste the key into the page instead.');
  process.exit(1);
}
if (!fs.existsSync(path.join(DIST, 'main/harness/harness-session.js'))) {
  console.error(`prompt-arena: no built app at ${DIST} — run "npm run build:main" in youcoded/desktop first.`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const { HarnessSession } = require(path.join(DIST, 'main/harness/harness-session.js'));
const { CORE_TOOLS } = require(path.join(DIST, 'main/harness/tools/index.js'));
const { makeOpenRouterFactory } = require(path.join(DIST, 'main/harness/eval/openrouter-factory.js'));
const { makeReviewSearchServices, BATTERY_HARNESS } = require(path.join(DIST, 'main/harness/eval/run-case.js'));
const { assembleSystemPromptParts } = require(path.join(DIST, 'main/harness/prompt-assembly.js'));
const { resolvePreset } = require(path.join(DIST, 'main/harness/preset-registry.js'));
const ROSTER = JSON.parse(fs.readFileSync(path.join(HERE, '../review-roster.json'), 'utf8'));

// WHY 128k and not the evaluator's 64k cap: the evaluator caps context to bound
// the cost of ONE long task, but arena conversations are many short turns, and
// a 64k window would start compacting a chat the owner is still reading.
const CONTEXT_CAP = 128_000;

fs.mkdirSync(path.join(DATA, 'tests'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'sandboxes'), { recursive: true });

// ---------------------------------------------------------------- state ----
let apiKey = null;
let spendCap = 5;
let spent = 0;

const STOCK = { id: 'stock', name: "App's stock prompt", builtin: true, mode: 'stock', text: '', includeEnv: true };
const promptsFile = path.join(DATA, 'prompts.json');
let prompts = fs.existsSync(promptsFile) ? JSON.parse(fs.readFileSync(promptsFile, 'utf8')) : [];
const savePrompts = () => fs.writeFileSync(promptsFile, JSON.stringify(prompts, null, 2));
const allPrompts = () => [{ ...STOCK, text: stockPromptText('/path/to/test-folder') }, ...prompts];

/** tests: id → { meta (persisted), live: { left, right } (sessions, not persisted) } */
const tests = new Map();
for (const f of fs.readdirSync(path.join(DATA, 'tests'))) {
  if (!f.endsWith('.json')) continue;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'tests', f), 'utf8'));
    // A conversation from before a restart can be read and rated, but the
    // assistant no longer remembers it, so it can't be continued.
    for (const s of ['left', 'right']) if (meta.sides[s].events.length) meta.sides[s].stale = true;
    tests.set(meta.id, { meta, live: { left: null, right: null } });
  } catch { /* skip a damaged file rather than refuse to start */ }
}
const saveTimers = new Map();
function saveTest(t, now = false) {
  const write = () => { saveTimers.delete(t.meta.id); fs.writeFileSync(path.join(DATA, 'tests', `${t.meta.id}.json`), JSON.stringify(t.meta)); };
  clearTimeout(saveTimers.get(t.meta.id));
  if (now) write(); else saveTimers.set(t.meta.id, setTimeout(write, 500));
}

// --------------------------------------------------------------- prompts ----
function stockParts(cwd) {
  return assembleSystemPromptParts({ presetBody: resolvePreset('assistant').body, cwd, appVersion: 'prompt-arena', gitSnapshot: '' });
}
function stockPromptText(cwd) { return stockParts(cwd).map((p) => p.text).join('\n\n'); }

/** The exact text a side's assistant receives. */
function buildSystemPrompt(p, cwd) {
  const parts = stockParts(cwd);
  const env = parts.find((x) => x.id === 'env')?.text ?? '';
  if (p.mode === 'stock') return parts.map((x) => x.text).join('\n\n');
  if (p.mode === 'append') {
    // The custom text goes just before the date/folder block, so it reads as
    // part of the app's own instructions rather than an afterthought.
    const before = parts.filter((x) => x.id !== 'env').map((x) => x.text);
    return [...before, p.text, env].filter(Boolean).join('\n\n');
  }
  return p.includeEnv === false ? p.text : `${p.text}\n\n${env}`;
}

// ----------------------------------------------------------------- sides ----
function newSideMeta() { return { events: [], comments: {}, costUsd: 0, stale: false, round: 0 }; }

function liveSide(t, side) {
  if (t.live[side]) return t.live[side];
  const meta = t.meta.sides[side];
  const assign = t.meta.assign[side];
  const p = t.meta.prompts[assign.prompt];
  meta.round += 1;
  const cwd = path.join(DATA, 'sandboxes', `${t.meta.id}-${side}-${meta.round}`);
  fs.mkdirSync(cwd, { recursive: true });
  meta.cwd = cwd;
  const model = ROSTER.find((m) => m.modelId === assign.model);
  const live = { busy: false, pendingAsk: null, resolveAsk: null, stepGates: 0, session: null };
  live.session = new HarnessSession(
    {
      sessionId: `arena-${t.meta.id}-${side}-${meta.round}`,
      cwd,
      harness: BATTERY_HARNESS,
      systemPrompt: buildSystemPrompt(p, cwd),
      contextLength: Math.min(model?.contextLength ?? CONTEXT_CAP, CONTEXT_CAP),
      binding: { providerId: 'openrouter', modelId: assign.model },
      tools: CORE_TOOLS,
      decide: async () => ({ action: 'allow', denyListed: false }),
      // Clarifying questions come to the owner on the page. Everything else the
      // engine asks about (reaching outside the folder, the Bash safety floors,
      // a looping model) is refused, which keeps the side inside its folder.
      askUser: async (req) => {
        if (req.toolName === 'max_steps') return { behavior: ++live.stepGates <= 1 ? 'allow' : 'deny' };
        const questions = req.toolName === 'AskUserQuestion' ? req.toolInput?.questions : undefined;
        if (!Array.isArray(questions)) return { behavior: 'deny' };
        return new Promise((resolve) => {
          live.pendingAsk = { id: crypto.randomUUID(), questions };
          live.resolveAsk = (answers) => {
            live.pendingAsk = null; live.resolveAsk = null;
            resolve(answers ? { behavior: 'allow', updatedInput: { questions, answers } } : { behavior: 'deny' });
          };
        });
      },
      skillCatalog: { list: () => [], load: (id) => { throw new Error(`no skills installed (prompt arena): ${id}`); } },
      toolServices: makeReviewSearchServices(),
    },
    makeOpenRouterFactory(apiKey, assign.model),
  );
  live.session.on('transcript-event', (e) => {
    meta.events.push(e);
    if (e.type === 'turn-complete') {
      const c = e.data?.usage?.providerCostUsd;
      if (typeof c === 'number' && Number.isFinite(c)) { meta.costUsd += c; spent += c; }
    }
    saveTest(t);
  });
  t.live[side] = live;
  return live;
}

function send(t, side, text) {
  const meta = t.meta.sides[side];
  if (meta.stale) return 'This side was started before the tool restarted, so the assistant no longer remembers it. Reset it to start again.';
  const live = liveSide(t, side);
  if (live.busy) return 'This side is still replying.';
  live.busy = true;
  live.session.send(text)
    .catch((err) => meta.events.push({ type: 'session-error', uuid: crypto.randomUUID(), data: { text: err instanceof Error ? err.message : String(err) } }))
    .finally(() => { live.busy = false; saveTest(t, true); });
  return null;
}

function resetSide(t, side) {
  const live = t.live[side];
  if (live) { live.resolveAsk?.(null); live.session.interrupt(); live.session.destroy(); }
  t.live[side] = null;
  const round = t.meta.sides[side].round;
  t.meta.sides[side] = { ...newSideMeta(), round, costUsd: t.meta.sides[side].costUsd };
  saveTest(t, true);
}

// ------------------------------------------------------ conversation view ----
// Same joining rule as harness-eval-blind.mjs: consecutive text deltas sharing a
// partId are one paragraph; ids restart after every tool call.
function toItems(meta) {
  const items = [];
  for (const e of meta.events) {
    const d = e.data ?? {};
    if (e.type === 'user-message') items.push({ id: e.uuid, kind: 'user', text: d.text ?? '' });
    else if (e.type === 'assistant-text') {
      const last = items[items.length - 1];
      if (last?.kind === 'assistant' && last.partId === d.partId) last.text += d.text ?? '';
      else items.push({ id: e.uuid, kind: 'assistant', partId: d.partId, text: d.text ?? '' });
    } else if (e.type === 'tool-use') {
      const item = { id: e.uuid, kind: 'tool', tool: d.toolName, input: d.toolInput ?? {}, toolUseId: d.toolUseId, result: null, files: [] };
      if (d.toolName === 'SendUserFile' && Array.isArray(d.toolInput?.files)) {
        item.files = d.toolInput.files.map((f) => {
          const abs = path.resolve(meta.cwd ?? '/', f);
          const rel = meta.cwd ? path.relative(meta.cwd, abs) : null;
          return { name: path.basename(abs), rel: rel && !rel.startsWith('..') ? rel : null };
        });
      }
      items.push(item);
    } else if (e.type === 'tool-result') {
      const call = items.find((x) => x.kind === 'tool' && x.toolUseId === d.toolUseId);
      if (call) { const r = d.toolResult; call.result = (typeof r === 'string' ? r : JSON.stringify(r ?? '', null, 2)).slice(0, 4000); }
    } else if (e.type === 'session-error') items.push({ id: e.uuid, kind: 'error', text: d.text ?? 'Something went wrong.' });
  }
  return items.filter((x) => x.kind !== 'assistant' || x.text.trim());
}

function view(t) {
  const m = t.meta;
  const side = (s) => ({
    items: toItems(m.sides[s]),
    comments: m.sides[s].comments,
    stale: m.sides[s].stale,
    busy: !!t.live[s]?.busy,
    pendingAsk: t.live[s]?.pendingAsk ?? null,
  });
  const reveal = (s) => ({
    prompt: m.prompts[m.assign[s].prompt].name,
    model: ROSTER.find((r) => r.modelId === m.assign[s].model)?.label ?? m.assign[s].model,
    costUsd: m.sides[s].costUsd,
  });
  return {
    id: m.id, name: m.name, created: m.created, verdict: m.verdict, note: m.note, revealed: m.revealed,
    left: side('left'), right: side('right'),
    reveal: m.revealed ? { left: reveal('left'), right: reveal('right') } : null,
  };
}

function summary(t) {
  const m = t.meta;
  return {
    id: m.id, name: m.name, created: m.created, revealed: m.revealed, verdict: m.verdict,
    busy: !!(t.live.left?.busy || t.live.right?.busy),
    waiting: !!(t.live.left?.pendingAsk || t.live.right?.pendingAsk),
    winner: m.revealed && m.verdict != null && m.verdict !== 0
      ? m.prompts[m.assign[m.verdict < 0 ? 'left' : 'right'].prompt].name : null,
  };
}

function createTest({ name, promptA, promptB, modelA, modelB }, copies = null) {
  const find = (id) => allPrompts().find((p) => p.id === id);
  // A rerun hands over the test's own saved copies, so it repeats exactly what
  // was run even if the library prompt was edited or deleted since.
  const pa = copies?.a ?? find(promptA), pb = copies?.b ?? find(promptB);
  if (!pa || !pb) throw new Error('Pick two prompts.');
  if (!modelA || !modelB) throw new Error('Pick a model.');
  const id = crypto.randomBytes(5).toString('hex');
  // The prompts are COPIED into the test, so editing a prompt later never
  // changes what an earlier test was actually run with.
  const swap = crypto.randomInt(2) === 1;
  const meta = {
    id, name: name?.trim() || `${pa.name} vs ${pb.name}`, created: Date.now(),
    prompts: { a: pa, b: pb },
    assign: swap ? { left: { prompt: 'b', model: modelB }, right: { prompt: 'a', model: modelA } }
                 : { left: { prompt: 'a', model: modelA }, right: { prompt: 'b', model: modelB } },
    sides: { left: newSideMeta(), right: newSideMeta() },
    verdict: null, note: '', revealed: false,
  };
  const t = { meta, live: { left: null, right: null } };
  tests.set(id, t);
  saveTest(t, true);
  return t;
}

// ------------------------------------------------------------------ http ----
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8' };

function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
async function body(req) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 2_000_000) throw new Error('too large'); }
  return s ? JSON.parse(s) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    // WHY the Host check: binding to 127.0.0.1 keeps other machines out, but a
    // web page in the owner's browser could still post to localhost (DNS
    // rebinding). Only a request addressed to this exact host is served.
    if (req.headers.host !== `127.0.0.1:${PORT}` && req.headers.host !== `localhost:${PORT}`) return json(res, 403, { error: 'forbidden' });

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(HERE, 'index.html')));
    }
    if (p.startsWith('/files/')) {
      const [, , id, side, ...rest] = p.split('/');
      const t = tests.get(id);
      const root = t?.meta.sides[side]?.cwd;
      if (!root) return json(res, 404, { error: 'not found' });
      const file = path.resolve(root, decodeURIComponent(rest.join('/')));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }
    if (!p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.method === 'POST' && req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'json only' });

    if (p === '/api/state' && req.method === 'GET') {
      return json(res, 200, {
        hasKey: !!apiKey, spent, spendCap,
        models: ROSTER.map((m) => ({ id: m.modelId, label: m.label })),
        prompts: allPrompts(),
        tests: [...tests.values()].sort((a, b) => b.meta.created - a.meta.created).map(summary),
      });
    }
    if (p === '/api/key' && req.method === 'POST') {
      const b = await body(req);
      if (typeof b.key === 'string' && b.key.trim()) apiKey = b.key.trim();
      if (Number.isFinite(Number(b.cap)) && Number(b.cap) > 0) spendCap = Number(b.cap);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/prompts' && req.method === 'POST') {
      const b = await body(req);
      if (!b.name?.trim() || !b.text?.trim()) return json(res, 400, { error: 'A prompt needs a name and some text.' });
      const entry = { id: b.id && b.id !== 'stock' ? b.id : crypto.randomBytes(4).toString('hex'), name: b.name.trim(), text: b.text, mode: b.mode === 'append' ? 'append' : 'replace', includeEnv: b.includeEnv !== false };
      const i = prompts.findIndex((x) => x.id === entry.id);
      if (i >= 0) prompts[i] = entry; else prompts.push(entry);
      savePrompts();
      return json(res, 200, entry);
    }
    let m;
    if ((m = p.match(/^\/api\/prompts\/([\w-]+)$/)) && req.method === 'DELETE') {
      prompts = prompts.filter((x) => x.id !== m[1]); savePrompts();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/tests' && req.method === 'POST') {
      try { return json(res, 200, view(createTest(await body(req)))); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (!(m = p.match(/^\/api\/tests\/(\w+)(?:\/(\w+))?$/))) return json(res, 404, { error: 'not found' });
    const t = tests.get(m[1]);
    if (!t) return json(res, 404, { error: 'That test no longer exists.' });
    const action = m[2];

    if (!action && req.method === 'GET') return json(res, 200, view(t));
    if (!action && req.method === 'DELETE') {
      for (const s of ['left', 'right']) if (t.live[s]) { t.live[s].resolveAsk?.(null); t.live[s].session.interrupt(); t.live[s].session.destroy(); }
      tests.delete(t.meta.id);
      fs.rmSync(path.join(DATA, 'tests', `${t.meta.id}.json`), { force: true });
      return json(res, 200, { ok: true });
    }
    const b = req.method === 'POST' ? await body(req) : {};
    const sides = (b.sides ?? [b.side]).filter((s) => s === 'left' || s === 'right');

    if (action === 'send') {
      if (!apiKey) return json(res, 400, { error: 'Add your OpenRouter key first.' });
      if (spent >= spendCap) return json(res, 400, { error: `This session has spent $${spent.toFixed(2)}, which reached the $${spendCap.toFixed(2)} limit. Raise the limit to keep going.` });
      if (!b.text?.trim()) return json(res, 400, { error: 'Type a message first.' });
      const errors = sides.map((s) => send(t, s, b.text)).filter(Boolean);
      return errors.length ? json(res, 400, { error: errors[0] }) : json(res, 200, view(t));
    }
    if (action === 'answer') {
      const live = t.live[sides[0]];
      if (!live?.pendingAsk) return json(res, 400, { error: 'That question was already answered.' });
      live.resolveAsk(b.answers ?? null);
      return json(res, 200, view(t));
    }
    if (action === 'stop') {
      for (const s of sides) if (t.live[s]) { t.live[s].resolveAsk?.(null); t.live[s].session.interrupt(); }
      return json(res, 200, view(t));
    }
    if (action === 'reset') { for (const s of sides) resetSide(t, s); return json(res, 200, view(t)); }
    if (action === 'comment') {
      const c = t.meta.sides[sides[0]].comments;
      if (b.text?.trim()) c[b.itemId] = b.text; else delete c[b.itemId];
      saveTest(t); return json(res, 200, view(t));
    }
    if (action === 'verdict') {
      if ('verdict' in b) t.meta.verdict = b.verdict;
      if ('note' in b) t.meta.note = String(b.note ?? '');
      saveTest(t); return json(res, 200, view(t));
    }
    if (action === 'reveal') { t.meta.revealed = true; saveTest(t, true); return json(res, 200, view(t)); }
    if (action === 'rerun') {
      // Same two prompts and models, freshly shuffled, so a rerun is blind again.
      const pa = t.meta.prompts.a, pb = t.meta.prompts.b;
      const ma = (t.meta.assign.left.prompt === 'a' ? t.meta.assign.left : t.meta.assign.right).model;
      const mb = (t.meta.assign.left.prompt === 'b' ? t.meta.assign.left : t.meta.assign.right).model;
      const fresh = createTest({ name: `${t.meta.name} (again)`, modelA: ma, modelB: mb }, { a: pa, b: pb });
      return json(res, 200, view(fresh));
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Prompt Arena: http://127.0.0.1:${PORT}`);
  console.log(`Saved tests and prompts: ${DATA}`);
});
