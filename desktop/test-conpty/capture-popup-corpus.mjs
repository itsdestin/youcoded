#!/usr/bin/env node
// capture-popup-corpus.mjs — record the real `claude` TUI through many
// situations, WITH ground truth: at every moment, is a Claude Code pop-up
// holding the keyboard, or is the ordinary message box live?
//
// WHY: the app must notice every Claude Code pop-up (known or not) so it never
// types a chat message — or its lost-message Enter — into one, and must never
// see a pop-up that is not there (a card or a refused send for nothing). The
// only honest test input is what Claude Code really draws, so this drives the
// installed binary through a PTY (same isolation as capture-startup-dialogs.mjs)
// and saves every byte with timed labels. tests/popup-detector-bench.test.ts
// replays each capture through the app's own screen reader and scores the
// detectors frame by frame.
//
// Busy situations (streaming replies, tool calls, permission menus,
// AskUserQuestion, plan approval) come from a local stand-in API
// (fake-anthropic.mjs) — free, and the same every run. Scenarios marked
// `auth: 'real'` use the real sign-in (access token only) and send a few real
// messages — only for what the stand-in cannot produce; they are skipped
// unless --with-auth.
//
// Usage (from youcoded/desktop):
//   node test-conpty/capture-popup-corpus.mjs                  # every free scenario
//   node test-conpty/capture-popup-corpus.mjs --only perm-bash,config
//     [--with-auth] [--claude /path/to/claude] [--out tests/fixtures/popup-corpus] [--print] [--jobs 4]
//
// Output: <out>/<scenario>.json
//   { ccVersion, scenario, cols, rows, chunks: [{t, b64}],
//     marks: [{t, label, chunkIndex, data?}], outcome }
// Truth marks: label 'truth', data { state: 'none' | 'popup' | 'pending', note,
// from? }. 'pending' = a transition the bench does not score. `from` = a regex
// source: the bench moves the state's start back to the first frame (after the
// previous mark) where it matches, so a state begins when Claude Code drew it,
// not when the driver noticed.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveClaude, ccVersionOf, makeIsolatedRoot, isolatedEnv, copyAccessTokenOnly, sleep, removeTempTree,
} from './cc-capture-lib.mjs';
import { startFakeApi, fakeApiEnv } from './fake-anthropic.mjs';
import { SCENARIOS } from './popup-scenarios.mjs';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

function viewportText(term) {
  const b = term.buffer.active;
  const out = [];
  for (let i = b.viewportY; i < b.viewportY + term.rows; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out.join('\n');
}

/** Claude Code's ordinary message box is on screen and ready (idle). */
const READY = /^❯ ?.*$\n^─{10,}$/m;

export async function runScenario(s, { claudeBin, ccVersion, print = false }) {
  const cols = s.cols ?? 100;
  const rows = s.rows ?? 35;
  const iso = makeIsolatedRoot(`popup-${s.name}`);
  const cwd = iso.project;
  const sub = (v) => (typeof v === 'string' ? v.replaceAll('$CWD', cwd).replaceAll('$HOME', iso.home) : v);

  for (const [rel, content] of Object.entries(s.files ?? {})) {
    const p = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, sub(content));
  }
  for (const [rel, content] of Object.entries(s.homeFiles ?? {})) {
    const p = path.join(iso.home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, sub(typeof content === 'string' ? content : JSON.stringify(content)));
  }
  const claudeJson = {
    hasCompletedOnboarding: true, theme: 'dark', numStartups: 3,
    projects: { [cwd]: { hasTrustDialogAccepted: true, ...(s.project ?? {}) } },
    ...(s.cfg ?? {}),
  };
  fs.writeFileSync(path.join(iso.configDir, '.claude.json'), JSON.stringify(claudeJson, null, 2));
  if (s.settings) fs.writeFileSync(path.join(iso.configDir, 'settings.json'), JSON.stringify(s.settings, null, 2));

  let api = null;
  let authEnv = {};
  if (s.auth === 'real') copyAccessTokenOnly(iso.configDir);
  else if (s.auth !== 'none') {
    // $CWD / $HOME inside scripted tool inputs (file paths) → this run's temp dirs.
    const script = JSON.parse(JSON.stringify(s.script ?? []), (_k, v) => sub(v));
    api = await startFakeApi(script);
    authEnv = fakeApiEnv(api.url);
  }

  const env = { ...isolatedEnv(iso), DISABLE_AUTOUPDATER: '1', ...authEnv, ...(s.env ?? {}) };
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  const t0 = Date.now();
  const chunks = [];
  const marks = [];
  const outcome = { steps: [] };
  const mark = (label, data) => marks.push({ t: Date.now() - t0, label, chunkIndex: chunks.length, ...(data !== undefined ? { data } : {}) });
  const truth = (state, note, from) => mark('truth', { state, note, ...(from ? { from } : {}) });

  const child = pty.spawn(claudeBin, (s.args ?? []).map(sub), { name: 'xterm-256color', cols, rows, cwd, env });
  let exitCode = null;
  child.onData((d) => {
    chunks.push({ t: Date.now() - t0, b64: Buffer.from(d, 'utf8').toString('base64') });
    term.write(d);
  });
  child.onExit((e) => { exitCode = e.exitCode; });

  const screen = () => viewportText(term);
  async function waitFor(re, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (re.test(screen())) return true;
      if (exitCode !== null) return re.test(screen());
      await sleep(40);
    }
    return false;
  }

  try {
    // Every scenario starts at a live, idle message box — the baseline 'none'.
    // (A scenario whose pop-up opens at launch — noBaseline — starts at once.)
    truth('pending', 'boot');
    if (!s.noBaseline) {
      if (!(await waitFor(READY, 30000))) { outcome.finalScreen = screen(); throw new Error('message box never appeared'); }
      await sleep(s.settle ?? 1200);
      truth('none', 'idle after boot');
    }

    for (const [i, st] of (s.steps ?? []).entries()) {
      if (st.resize) { term.resize(st.resize[0], st.resize[1]); child.resize(st.resize[0], st.resize[1]); mark(`resize ${st.resize[0]}x${st.resize[1]}`); }
      if (st.pending) truth('pending', st.note ?? `step ${i}`);
      if (st.keys !== undefined) {
        // An array = separate key presses (e.g. Esc, Esc) with a pause between.
        const parts = Array.isArray(st.keys) ? st.keys : st.type ? [...st.keys] : [st.keys];
        for (const p of parts) { child.write(p); if (parts.length > 1) await sleep(Array.isArray(st.keys) ? 300 : (st.typeMs ?? 25)); }
        mark('send', st.keys);
      }
      // Label right away: the driver KNOWS the state (e.g. a reply is about to
      // stream — nothing can pop up until the scripted tool call).
      if (st.state && !st.waitFor) truth(st.state, st.note ?? `step ${i}`);
      if (st.waitFor) {
        const re = new RegExp(st.waitFor, 'm');
        const ok = await waitFor(re, st.timeout ?? 15000);
        if (!ok) {
          outcome.finalScreen = screen();
          throw new Error(`step ${i} (${st.note ?? ''}): never saw /${st.waitFor}/`);
        }
        if (st.state) truth(st.state, st.note ?? `step ${i}`, st.from ?? st.waitFor);
      }
      if (st.gone) {
        const re = new RegExp(st.gone, 'm');
        const end = Date.now() + (st.timeout ?? 15000);
        while (re.test(screen()) && Date.now() < end) await sleep(40);
        if (re.test(screen())) { outcome.finalScreen = screen(); throw new Error(`step ${i}: /${st.gone}/ never left`); }
        if (st.state) truth(st.state, st.note ?? `step ${i}`);
      }
      if (st.wait) await sleep(st.wait);
      if (st.snap || print) {
        const txt = screen().replace(/\n{3,}/g, '\n\n');
        if (print) console.log(`--- ${s.name} step ${i} ${st.note ?? ''}\n${txt}`);
        if (st.snap) outcome.steps.push({ step: i, note: st.note, screen: txt });
      }
    }
    await sleep(300);
    truth('pending', 'end');
  } catch (err) {
    outcome.error = String(err?.message ?? err);
  } finally {
    outcome.exitCode = exitCode;
    try { if (exitCode === null) child.kill(); } catch { /* already gone */ }
    await sleep(300);
    if (api) {
      outcome.apiRequests = api.requests.filter((r) => r.main).length;
      await api.close();
    }
  }
  await removeTempTree(iso.root);
  return {
    ccVersion, scenario: s.name, description: s.description ?? '', auth: s.auth ?? 'fake',
    cols, rows, capturedAt: new Date().toISOString(), chunks, marks, outcome,
  };
}

function parseArgs(argv) {
  const get = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
  return {
    claude: get('claude'),
    only: get('only')?.split(',').map((x) => x.trim()).filter(Boolean),
    out: get('out') ?? 'tests/fixtures/popup-corpus',
    withAuth: argv.includes('--with-auth'),
    print: argv.includes('--print'),
    jobs: Number(get('jobs') ?? 4),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2));
  const claudeBin = resolveClaude(opts.claude);
  const ccVersion = ccVersionOf(claudeBin);
  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  const todo = SCENARIOS.filter((s) => (!opts.only || opts.only.includes(s.name)) && (s.auth !== 'real' || opts.withAuth));
  let failed = 0;
  const queue = [...todo];
  // A few at once: each has its own temp home and its own stand-in server.
  await Promise.all(Array.from({ length: Math.max(1, opts.jobs) }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const fx = await runScenario(s, { claudeBin, ccVersion, print: opts.print });
      const bad = fx.outcome.error;
      if (bad) failed++;
      fs.writeFileSync(path.join(outDir, `${s.name}.json`), JSON.stringify(fx));
      console.log(`${bad ? 'FAIL' : 'ok  '} ${s.name}  (${fx.chunks.length} chunks)${bad ? `  — ${bad}` : ''}`);
      if (bad && fx.outcome.finalScreen) console.log(fx.outcome.finalScreen.replace(/\n{3,}/g, '\n\n').split('\n').map((l) => `      | ${l}`).join('\n'));
    }
  }));
  console.log(`\n${todo.length - failed}/${todo.length} captured (Claude Code ${ccVersion})`);
  process.exit(failed ? 1 : 0);
}
