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
  modelMenu: 'Model',                   // the session form's model menu (model/ModelPicker.tsx aria-label)
  modelSearch: 'Search all models',     // its search box
  keySource: 'Anthropic',               // the source shown beside models of the app's own assistant (first-run.ts NATIVE_KEY_LABEL)
  approve: /^(Yes|Allow)\b/,           // a permission card's approve button
  addTags: 'Add tags',                  // status bar chip (tags/SessionTagsChip.tsx)
  renameDialog: 'Rename session',       // SessionRenameDialog.tsx
  save: 'Save',
  tagBox: 'Search or create a tag',     // tags/SessionDetails.tsx
  addNote: 'Add a note',
  noteBox: 'Note',
  resume: 'Resume session',             // welcome screen (App.tsx)
  resumeSearch: 'Search sessions',      // ResumeBrowser.tsx
  resumeOpen: /^(Resume|Open)\b/,      // a preview's open button, if the list shows one
  resumeOffered: /^Resume \d+$/,        // the "Welcome back" panel after a restart (its Resume N button)
  detailsChip: /walkthrough-tag|Add tags|tag/i, // the status-bar chip that opens the chat's details once it has a tag
  sessionMenu: 'Walkthrough taco list', // the header's session pill, by the chat's own name
  resumeMenuItem: 'Resume',             // the All sessions menu's entry into the Resume list (SessionStrip.tsx)
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
const log = fs.createWriteStream(path.join(out, 'app.log'));
let app, exited = null;
// Start the app as this user (same home folder every time, so a restart keeps what they did).
function launch() {
  exited = null;
  app = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.pipe(log, { end: false }); app.stderr.pipe(log, { end: false });
  app.on('exit', (c) => { exited = c ?? 'signal'; });
}
launch();

// ---- the report --------------------------------------------------------------------------------------------
const results = [];
let page, browser;
async function shot(name) { await page?.screenshot({ path: path.join(out, `${String(results.length).padStart(2, '0')}-${name}.png`) }).catch(() => {}); }
async function snap(label) { await page?.screenshot({ path: path.join(out, `${label}.png`) }).catch(() => {}); }
async function step(name, what, fn, { critical = true } = {}) {
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
    if (critical) throw e;
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

// Attach to the app's main window and keep its own console messages for diagnosis.
async function connect() {
  browser = null; page = null;
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
  const rlog = fs.createWriteStream(path.join(out, 'renderer.log'), { flags: 'a' });
  page.on('console', (m) => rlog.write(`[${m.type()}] ${m.text()}\n`));
  page.on('pageerror', (e) => rlog.write(`[pageerror] ${e.message}\n`));
}
// Quit the app the way a user would (closing it), then open it again as the same user.
async function restart() {
  await browser?.close().catch(() => {});
  app.kill('SIGTERM');
  for (let i = 0; i < 30 && exited === null; i++) await sleep(500);
  if (exited === null) { app.kill('SIGKILL'); await sleep(1000); }
  launch();
  await connect();
  await page.waitForSelector('h1, h2, button', { timeout: 60_000 });
}

// ---- the steps -----------------------------------------------------------------------------------------------
try {
  await step('open', 'The app opens and shows its first screen', async () => {
    await connect();
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

  // The welcome screen shows either the session form or a single button that opens it. WHY a settle loop:
  // closing the tour animates the screen, and a button grabbed mid-animation is gone by the time it's clicked.
  async function openSessionForm() {
    const start = page.getByRole('button', { name: WORDS.startSession });
    const fold = page.getByRole('button', { name: WORDS.newSession });
    await sleep(1500);
    for (let i = 0; i < 20; i++) {
      if (await start.isVisible().catch(() => false)) return start;
      if (await fold.isVisible().catch(() => false)) { await fold.click({ timeout: 5_000 }).catch(() => {}); await sleep(1000); }
      else await sleep(750);
    }
    throw new Error('the session form never appeared');
  }
  // Ask, and pass only when the answer (which never appears in the question) shows up.
  async function askAndExpect(question, answer, timeout = 180_000) {
    const box = page.getByPlaceholder(WORDS.messageBox);
    await box.waitFor({ timeout: 60_000 });
    await box.fill(question);
    await box.press('Enter');
    await page.waitForFunction((a) => new RegExp(a).test(document.body.innerText), answer.source, { timeout });
  }

  // KNOWN FAILURE until the first-run fix lands (plan, Phase 3 findings): after an API-key sign-in the form
  // defaults to Claude Code, which that route never installs, and Start silently does nothing. Not critical, so
  // the walk-through records it and carries on.
  await step('first-chat-default', 'A new user starts their first session with the default choices and gets a reply', async () => {
    await page.getByRole('button', { name: WORDS.skipTour }).click({ timeout: 10_000 }).catch(() => {});
    const start = await openSessionForm();
    const model = await page.getByRole('button', { name: WORDS.modelMenu, exact: true }).innerText().catch(() => '?');
    await start.click({ timeout: 15_000 });
    await page.getByPlaceholder(WORDS.messageBox).waitFor({ timeout: 60_000 })
      .catch(() => { throw new Error(`no chat opened after Start (default model shown: ${model.trim()})`); });
    await askAndExpect('What is six times seven? Answer with digits only.', /\b42\b/);
    return `default model: ${model.trim()}`;
  }, { critical: false });

  await step('first-chat-assistant', "A new user chats with the app's own assistant and gets a reply", async () => {
    if (!(await page.getByPlaceholder(WORDS.messageBox).isVisible().catch(() => false))) {
      const start = await openSessionForm();
      await page.getByRole('button', { name: WORDS.modelMenu, exact: true }).click();
      await page.getByPlaceholder(WORDS.modelSearch).fill('haiku');
      // The app's own assistant lists models under the key's service ("Anthropic"); Claude Code's under its own name.
      const row = page.getByRole('button', { name: /haiku/i }).filter({ hasText: WORDS.keySource }).and(page.locator(':not([disabled])')).first();
      await row.click({ timeout: 15_000 });
      await start.click({ timeout: 15_000 });
    }
    await askAndExpect('What is six times seven? Answer with digits only.', /\b42\b/);
  });

  await step('save-file', 'The assistant saves a file the user asked for, and it is really on disk', async () => {
    const file = path.join(home, 'walkthrough-check.txt');
    const box = page.getByPlaceholder(WORDS.messageBox);
    await box.fill('Create a file named walkthrough-check.txt in the current folder containing only the word mango.');
    await box.press('Enter');
    // A permission card may ask first; a user would approve it. Pass only when the file exists with the word.
    for (const t = Date.now(); Date.now() - t < 180_000; await sleep(2000)) {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('mango')) return 'file found on disk';
      const yes = page.getByRole('button', { name: WORDS.approve }).first();
      if (await yes.isVisible().catch(() => false)) await yes.click().catch(() => {});
    }
    throw new Error('no walkthrough-check.txt with "mango" appeared in the project folder within 3 minutes');
  });

  const NAME = 'Walkthrough taco list';
  const TAG = 'walkthrough-tag';
  const NOTE = 'remember the limes';
  await step('organize', 'The user renames the chat, adds a tag and writes a note', async () => {
    await page.getByRole('button', { name: WORDS.addTags }).click();
    // Rename: the name at the top of the details popup opens the rename box.
    await page.getByRole('button', { name: /^Rename / }).click();
    const rename = page.getByRole('dialog', { name: WORDS.renameDialog });
    await rename.getByRole('textbox').fill(NAME);
    await rename.getByRole('button', { name: WORDS.save }).click();
    await rename.waitFor({ state: 'detached', timeout: 15_000 });
    // Tag: type a new one and create it.
    const tagBox = page.getByLabel(WORDS.tagBox);
    await tagBox.fill(TAG);
    await tagBox.press('Enter');
    // Note: open the note box, type, and leave it (it saves on leaving).
    await page.getByRole('button', { name: WORDS.addNote }).click();
    const note = page.getByLabel(WORDS.noteBox, { exact: true });
    await note.fill(NOTE);
    await note.blur();
    await page.keyboard.press('Escape');
    await sleep(1500);
  });

  await step('restart-keeps', 'After closing and reopening the app, the chat is offered back with its name and tag', async () => {
    await restart();
    await page.getByRole('button', { name: WORDS.skipTour }).click({ timeout: 5_000 }).catch(() => {});
    // The app offers the chat back on its own ("Welcome back"); otherwise the user opens the Resume list.
    const offered = page.getByRole('button', { name: WORDS.resumeOffered }).first();
    if (!(await offered.isVisible({ timeout: 15_000 }).catch(() => false))) {
      await page.getByRole('button', { name: WORDS.resume }).click({ timeout: 30_000 });
    }
    await page.getByText(NAME).first().waitFor({ timeout: 30_000 });
    await page.getByText(TAG).first().waitFor({ timeout: 10_000 });
  });

  await step('resume', 'Resuming the chat shows its earlier messages and it still answers', async () => {
    const offered = page.getByRole('button', { name: WORDS.resumeOffered }).first();
    if (await offered.isVisible().catch(() => false)) await offered.click();
    else {
      await page.getByText(NAME).first().click();
      await page.getByRole('button', { name: WORDS.resumeOpen }).first().click({ timeout: 5_000 }).catch(() => {});
    }
    await page.getByText('walkthrough-check.txt').first().waitFor({ timeout: 60_000 });
    await askAndExpect('What is seven times eight? Answer with digits only.', /\b56\b/);
  });

  await step('note-kept', "The chat's note is still there after the restart", async () => {
    await page.getByRole('button', { name: WORDS.detailsChip }).first().click();
    await page.getByText(NOTE).first().waitFor({ timeout: 10_000 });
    await page.keyboard.press('Escape');
  }, { critical: false });

  await step('search', 'Searching past chats finds this one by a word in its name', async () => {
    // The arrow beside the chat's name opens "All sessions". WHY by position: that button has no name of its own
    // until hovered (its tooltip names it only then), so neither a screen reader nor this script can find it by name.
    await page.getByRole('button', { name: WORDS.sessionMenu }).first().locator('xpath=following::button[1]').click();
    await page.getByRole('button', { name: WORDS.resumeMenuItem, exact: true }).first().click({ timeout: 10_000 });
    const search = page.getByPlaceholder(WORDS.resumeSearch).first();
    // The chat's name also sits in the header behind the list, so count it: header + list row when found,
    // header alone when filtered out. (The list isn't marked as a dialog, so it can't be scoped by role.)
    const shown = () => page.getByText(NAME).evaluateAll((els) => els.filter((e) => e.getClientRects().length).length);
    const before = await shown();
    await search.fill('zzzz-no-such-chat');
    await page.waitForFunction(async () => true);
    for (let i = 0; i < 20 && (await shown()) >= before; i++) await sleep(500);
    if ((await shown()) >= before) throw new Error('a search for nonsense still listed the chat');
    await search.fill('taco');
    for (let i = 0; i < 20 && (await shown()) < before; i++) await sleep(500);
    if ((await shown()) < before) throw new Error('searching "taco" did not list the chat');
    await page.keyboard.press('Escape');
  }, { critical: false });
} catch {
  // A critical step failed (already in the report); record what the screen does next, to see why.
  await recordUntilQuiet('after-failure', 30_000, 15_000).catch(() => {});
}
finally {
  finish();
  // The app's own log, for diagnosing a failed step (the workflow blanks key-shaped text before saving).
  for (const f of ['.claude/desktop.log']) { try { fs.copyFileSync(path.join(home, f), path.join(out, path.basename(f))); } catch { /* not written yet */ } }
  await browser?.close().catch(() => {});
  app.kill();
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
