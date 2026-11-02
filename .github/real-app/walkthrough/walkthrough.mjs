#!/usr/bin/env node
// Release walk-through: use the REAL packaged app the way a brand-new user does, and report each step as
// passed or failed. (plan: youcoded-dev docs/active/plans/2026-11-01-real-app-testing.md, Phase 3)
//
// Rules this follows (Destin, 2026-11-01):
//  - A step passes on an OUTCOME (a reply arrived, a file exists on disk), never on our own wording.
//  - It still has to find buttons the way a person does, by what they say. Every such word lives in WORDS
//    below, in one place, so a reworded button is a one-line update here — and a reword that hides a
//    button from users fails loudly, which is the point.
//
// Usage: node walkthrough.mjs <app executable> <output folder>
// Env:   WALKTHROUGH_KEY — the capped test key, typed into setup like a user pasting theirs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const WORDS = {
  payAsYouGo: 'Pay as you go',          // first-run choice card (first-run/SignInChoices.tsx)
  useApiKey: 'Use an API key',          // way in under it
  keyBox: 'API key',                    // the key field's accessible name (first-run/ApiKeySetup.tsx)
  verify: 'Verify & Continue',          // its submit button
  skipTour: 'Skip tour',                // the buddy's first-run tour (guide/GuideBubble.tsx)
  newSession: 'New session',            // welcome screen, form folded away
  startSession: 'Start session',        // welcome screen, form open
  messageBox: 'Message your assistant', // chat input placeholder (InputBar.tsx)
};

const [exe, out] = process.argv.slice(2);
const KEY = process.env.WALKTHROUGH_KEY;
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9333;

// A brand-new user: an empty home folder, so nothing carries over from any earlier run.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-newuser-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache') };
delete env.WALKTHROUGH_KEY; delete env.ANTHROPIC_API_KEY;   // the app must get the key only by the user typing it
// WHY: Electron picks its secure key storage from the desktop's name. A bare test machine has none, so the app
// (rightly) refuses to save keys. Present as GNOME, the most common Linux desktop, whose keyring the workflow runs.
if (process.platform === 'linux') env.XDG_CURRENT_DESKTOP = env.XDG_CURRENT_DESKTOP || 'GNOME';
// WHY the Chromium switch: release builds never open a debugging port themselves (main.ts gates
// YOUCODED_DEVTOOLS_PORT to unpackaged builds); this lets the walk-through see the page without changing the app.
// No --no-sandbox: the workflow sets the sandbox up the way the .deb installer does. (With the switch, the app's
// keychain helper — a second copy of the app that doesn't inherit it — crashed and no key could be saved.)
const args = [`--remote-debugging-port=${PORT}`];
const app = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
const log = fs.createWriteStream(path.join(out, 'app.log'));
app.stdout.pipe(log); app.stderr.pipe(log);
let exited = null; app.on('exit', (c) => { exited = c; });

// ---- the report --------------------------------------------------------------------------------------------
const results = [];
let page, browser;
async function shot(name) { await page?.screenshot({ path: path.join(out, `${String(results.length).padStart(2, '0')}-${name}.png`) }).catch(() => {}); }
async function snap(label) { await page?.screenshot({ path: path.join(out, `${label}.png`) }).catch(() => {}); }
async function step(name, what, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, what, ok: true, secs: Math.round((Date.now() - t) / 1000), detail: detail ?? '' });
    console.log(`PASS  ${what}${detail ? ` — ${detail}` : ''}`);
    await shot(name);
  } catch (e) {
    results.push({ name, what, ok: false, secs: Math.round((Date.now() - t) / 1000), detail: String(e?.message ?? e).split('\n')[0] });
    console.log(`FAIL  ${what} — ${results.at(-1).detail}`);
    await shot(name + '-FAILED');
    throw e;
  }
}
function finish() {
  const lines = results.map((r) => `${r.ok ? '✅' : '❌'} ${r.what} (${r.secs}s)${r.detail ? ` — ${r.detail}` : ''}`);
  const md = [`### Walk-through: ${results.every((r) => r.ok) ? 'everything tried worked' : 'something failed'}`, '', ...lines.map((l) => `- ${l}`)].join('\n');
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(out, 'report.md'), md + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}

// What a person sees right now: headings, buttons, fields. Used to record unknown screens.
async function seen() {
  return page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const text = (sel) => [...document.querySelectorAll(sel)].filter(vis).map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ')).filter(Boolean);
    return { headings: text('h1, h2, [role=heading]').slice(0, 6), buttons: text('button, [role=button]').slice(0, 30),
      fields: [...document.querySelectorAll('input, textarea, [contenteditable=true]')].filter(vis).map((i) => i.getAttribute('aria-label') || i.placeholder || i.tagName) };
  });
}
async function recordUntilQuiet(label, maxMs = 120_000, quietMs = 30_000) {
  const shots = []; let last = '', quiet = Date.now(); const t = Date.now();
  while (Date.now() - t < maxMs && Date.now() - quiet < quietMs && exited === null) {
    const s = await seen().catch((e) => ({ error: String(e) })); const k = JSON.stringify(s);
    if (k !== last) { shots.push(s); await page.screenshot({ path: path.join(out, `${label}-${String(shots.length).padStart(2, '0')}.png`) }).catch(() => {}); console.log(`      seen: ${k.slice(0, 600)}`); last = k; quiet = Date.now(); }
    await sleep(2000);
  }
  fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify(shots, null, 2));
}

// ---- the steps -----------------------------------------------------------------------------------------------
try {
  await step('open', 'The app opens and shows its first screen', async () => {
    for (let i = 0; i < 60 && !browser; i++) {
      if (exited !== null) throw new Error(`the app quit at start (code ${exited})`);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
      if (!browser) await sleep(1000);
    }
    if (!browser) throw new Error('the app never opened a window');
    for (let i = 0; i < 30 && !page; i++) {
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => !/[?&](buddy|mode=)/.test(p.url()));
      if (!page) await sleep(1000);
    }
    if (!page) throw new Error('no main window');
    // The page's own messages and errors, for diagnosing a failed step (blanked of keys before saving).
    const rlog = fs.createWriteStream(path.join(out, 'renderer.log'));
    page.on('console', (m) => rlog.write(`[${m.type()}] ${m.text()}\n`));
    page.on('pageerror', (e) => rlog.write(`[pageerror] ${e.message}\n`));
    await page.waitForSelector('h1, h2, button', { timeout: 60_000 });
    return (await seen()).headings[0] ?? '';
  });

  await step('sign-in-key', 'A new user signs in by pasting an API key', async () => {
    if (!KEY) throw new Error('no test key given to the walk-through');
    await page.getByRole('button', { name: WORDS.payAsYouGo }).click();
    await page.getByRole('button', { name: WORDS.useApiKey }).click();
    await page.getByLabel(WORDS.keyBox, { exact: true }).fill(KEY);
    await page.getByRole('button', { name: WORDS.verify }).click();
    // Outcome: setup moves past sign-in (the key field goes away) without showing an error.
    await page.getByLabel(WORDS.keyBox, { exact: true }).waitFor({ state: 'detached', timeout: 90_000 });
    return (await seen()).headings[0] ?? '';
  });

  await step('first-chat', 'A new user starts their first session with the default choices and gets a reply', async () => {
    // The tour may or may not be showing; a new user can skip it.
    await page.getByRole('button', { name: WORDS.skipTour }).click({ timeout: 10_000 }).catch(() => {});
    // The welcome screen shows either the session form or a single button that opens it.
    // WHY a settle loop: closing the tour animates the welcome screen, and a button grabbed mid-animation
    // is gone by the time it's clicked. Wait until one of the two stays put.
    const start = page.getByRole('button', { name: WORDS.startSession });
    const newSession = page.getByRole('button', { name: WORDS.newSession });
    await sleep(1500);
    for (let i = 0; i < 20; i++) {
      if (await start.isVisible().catch(() => false)) break;
      if (await newSession.isVisible().catch(() => false)) { await newSession.click({ timeout: 5_000 }).catch(() => {}); await sleep(1000); }
      else await sleep(750);
    }
    const model = await page.getByText(/ · /).first().innerText({ timeout: 10_000 }).catch(() => '?');
    await snap('first-chat-a-form');
    await start.click({ timeout: 15_000 });
    await sleep(3000); await snap('first-chat-b-after-start');
    console.log(`      seen after Start: ${JSON.stringify(await seen().catch(() => null)).slice(0, 700)}`);
    const box = page.getByPlaceholder(WORDS.messageBox);
    await box.waitFor({ timeout: 120_000 });
    // The answer (42) never appears in the question, so seeing it anywhere means a real reply arrived.
    await box.fill('What is six times seven? Answer with digits only.');
    await box.press('Enter');
    await page.waitForFunction(() => /\b42\b/.test(document.body.innerText), null, { timeout: 180_000 });
    return `default model shown: ${model.trim()}`;
  });

  // Not a pass/fail step yet: record what follows, to build the next steps from.
  await recordUntilQuiet('after-first-chat', 60_000, 20_000);
} catch {
  // The failed step is already in the report; record what the screen does next, to see why.
  await recordUntilQuiet('after-failure', 30_000, 15_000).catch(() => {});
  // DIAGNOSTIC ONLY (temporary, not a step): ask the app directly to start a Claude Code chat in the user's
  // home folder, and record whether it answers, refuses or never answers — to tell an app fault from a missed click.
  const diag = await page?.evaluate(async (cwd) => {
    const race = (p) => Promise.race([p.then((v) => ({ answered: v }), (e) => ({ refused: String(e?.message ?? e) })), new Promise((r) => setTimeout(() => r({ noAnswerIn: '45s' }), 45_000))]);
    return { create: await race(window.claude.session.create({ name: 'diag', cwd, provider: 'claude', skipPermissions: false })) };
  }, home).catch((e) => ({ error: String(e) }));
  // Is Claude Code installed for this new user at all? (The API-key route may never install it.)
  const { spawnSync } = await import('node:child_process');
  diag.claudeOnPath = spawnSync('bash', ['-lc', 'command -v claude || echo none'], { env, encoding: 'utf8' }).stdout.trim();
  diag.claudeInHome = ['.local/bin/claude', '.claude/local/claude'].filter((p) => fs.existsSync(path.join(home, p)));
  await sleep(20_000);
  diag.afterCreate = await seen().catch(() => null);
  await snap('diagnostic-after-create');
  fs.writeFileSync(path.join(out, 'diagnostic.json'), JSON.stringify(diag, null, 2));
  console.log(`      diagnostic: ${JSON.stringify(diag).slice(0, 600)}`);
}
finally {
  finish();
  // The app's own log, for diagnosing a failed step (the workflow blanks key-shaped text before saving).
  for (const f of ['.claude/desktop.log']) { try { fs.copyFileSync(path.join(home, f), path.join(out, path.basename(f))); } catch { /* not written yet */ } }
  await browser?.close().catch(() => {});
  app.kill();
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
