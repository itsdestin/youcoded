#!/usr/bin/env node
// Release walk-through, slice 1: open the REAL packaged app as a brand-new user and record what it shows.
// (plan: youcoded-dev docs/active/plans/2026-11-01-real-app-testing.md, Phase 3)
//
// WHY a recording first: the walk-through must click through screens the way a person does. Before writing
// those clicks, this captures exactly which screens a fresh install meets on a clean machine (first-run
// setup, sign-in, welcome), each as a screenshot plus its visible heading and buttons.
//
// Usage: node first-look.mjs <app executable> <output folder>
// Env:   ANTHROPIC_API_KEY (optional) is passed to the app the way a user's shell would.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [exe, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const PORT = 9333;
// A brand-new user: empty home folder, so no settings, no Claude Code, no sign-in carried over.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-newuser-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache') };
// WHY the switch on the command line: release builds never open a debugging port by themselves
// (main.ts gates YOUCODED_DEVTOOLS_PORT to unpackaged builds); Chromium's own switch lets the walk-through
// look at the page from outside without changing the app.
const args = [`--remote-debugging-port=${PORT}`];
if (process.platform === 'linux') args.push('--no-sandbox');
const app = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
const log = fs.createWriteStream(path.join(out, 'app.log'));
app.stdout.pipe(log); app.stderr.pipe(log);
let exited = null; app.on('exit', (c) => { exited = c; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 60; i++) {
    if (exited !== null) throw new Error(`app quit at start (code ${exited})`);
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { await sleep(1000); }
  }
  throw new Error('no debugging port after 60s');
}
const browser = await connect();
// The main window: the first page that isn't a helper window (buddy, popups use query strings).
async function mainPage() {
  for (let i = 0; i < 30; i++) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    const p = pages.find((pg) => !/[?&](buddy|mode=)/.test(pg.url())) ?? pages[0];
    if (p) return p;
    await sleep(1000);
  }
  throw new Error('no window opened');
}
const page = await mainPage();

// Record a step whenever what's on screen changes; stop after 6 minutes or 90s with no change.
const steps = [];
let last = '', quietSince = Date.now();
const started = Date.now();
while (Date.now() - started < 6 * 60_000 && Date.now() - quietSince < 90_000 && exited === null) {
  const seen = await page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const text = (sel) => [...document.querySelectorAll(sel)].filter(vis).map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim()).filter(Boolean);
    return { headings: text('h1, h2, [role=heading]').slice(0, 6), buttons: text('button, [role=button], a[href]').slice(0, 25),
      inputs: [...document.querySelectorAll('input, textarea')].filter(vis).map((i) => i.type + ':' + (i.placeholder || i.getAttribute('aria-label') || '')) };
  }).catch((e) => ({ error: String(e) }));
  const key = JSON.stringify(seen);
  if (key !== last) {
    const n = String(steps.length).padStart(2, '0');
    await page.screenshot({ path: path.join(out, `${n}.png`) }).catch(() => {});
    steps.push({ at: Math.round((Date.now() - started) / 1000), ...seen });
    console.log(`[${n}] +${steps.at(-1).at}s`, JSON.stringify(seen));
    last = key; quietSince = Date.now();
  }
  await sleep(2000);
}
fs.writeFileSync(path.join(out, 'steps.json'), JSON.stringify(steps, null, 2));
console.log(`recorded ${steps.length} screens; app ${exited === null ? 'still running' : 'quit with ' + exited}`);
await browser.close().catch(() => {});
app.kill();
