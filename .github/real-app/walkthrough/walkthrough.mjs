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
import http from 'node:http';
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
  send: 'Send message',                 // its send button (InputBar.tsx aria-label)
  attach: /^Attach/,
  browseSkills: 'Browse skills',        // compass in the message bar (InputBar.tsx)
  openMarketplace: 'Open marketplace',  // in the skills drawer (CommandDrawer.tsx)
  marketSearch: 'Search the marketplace',
  install: /^Install\b/,               // a listing's install button
  applyTheme: /^(Apply|Use)( theme)?\b/, // an installed theme's apply button                    // the paperclip (InputBar.tsx)
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
  edit: 'Edit',                         // the file viewer's Edit button
  filesButton: 'Session files',         // header button (HeaderBar.tsx aria-label)
  filesSearch: 'Search files',
  fileListToggle: /^(Show|Hide) list$/, // the drawer's list button (SessionDrawer.tsx)          // the Files panel's search box
  projects: 'Open projects',            // header button
  backToChat: /Back to chat/,           // Projects' way back (header)
  tipGotIt: 'Got it',                   // the buddy's tip bubble
  closeDialog: 'Close session',         // CloseSessionPrompt.tsx: its title and its confirm button
};

const [exe, out] = process.argv.slice(2);
const KEY = process.env.WALKTHROUGH_KEY;
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9333;
const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');

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
// --inspect opens the app's main process to the walk-through too, used ONLY to answer the computer's own
// "choose a file" window (a native dialog no page tool can click) with the file a user would pick.
const INSPECT = 9339;
const args = [`--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`];
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
    results.push({ name, what, ok: false, secs: Math.round((Date.now() - t) / 1000), detail: (() => { const m = String(e?.message ?? e); const w = m.match(/waiting for (.*)/); return m.split('\n')[0] + (w ? ` — waiting for ${w[1].slice(0, 160)}` : ''); })() });
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

// Answer the next "choose a file" window(s) with these files, as a person picking them would.
async function answerFilePicker(paths) {
  const list = await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json();
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  const expression = `(() => { const { dialog } = process.mainModule.require('electron');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ${JSON.stringify(paths)} }); return 'ok'; })()`;
  const reply = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } })); });
  ws.close();
  if (reply?.result?.result?.value !== 'ok') throw new Error(`could not answer the file chooser: ${JSON.stringify(reply).slice(0, 200)}`);
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
    // POSSIBLE FINDING (2026-11-02): once, Enter right after a new chat opened left the message sitting in the
    // box with no sign why (the chat wasn't ready yet). Retry the send button until the box empties, and note
    // in the report how long a user would have had to wait.
    const t0 = Date.now();
    for (let i = 0; i < 30 && (await box.inputValue().catch(() => '')).trim(); i++) {
      await sleep(2000);
      if ((await box.inputValue().catch(() => '')).trim()) await page.getByRole('button', { name: WORDS.send }).click().catch(() => {});
    }
    if ((await box.inputValue().catch(() => '')).trim()) throw new Error('the message never left the box (Enter and Send did nothing for 60s)');
    const waited = Math.round((Date.now() - t0) / 1000);
    await page.waitForFunction((a) => new RegExp(a).test(document.body.innerText), answer.source, { timeout });
    return waited > 3 ? `the first send was ignored; it went through after ${waited}s` : '';
  }

  // Open a file through the Files panel (the header's 📄 button). WHY not the chat: the assistant only sometimes
  // turns a file name in its reply into a clickable chip, so the panel is the dependable way in.
  // Passes only once the real viewer is up (its Edit button shows) — a preview inside the chat doesn't count.
  async function openFromFilesPanel(name) {
    const panelSearch = page.getByPlaceholder(WORDS.filesSearch);
    if (!(await panelSearch.isVisible().catch(() => false))) await page.getByRole('button', { name: WORDS.filesButton }).click();
    await panelSearch.waitFor({ timeout: 15_000 });
    // The panel's row reads "<TYPE> <name> created · <when>"; the chat's own mentions never say "created ·".
    await page.getByRole('button', { name: new RegExp(`${name.replace('.', '\\.')}.*created`) }).first().click({ timeout: 15_000 });
    await page.getByRole('button', { name: WORDS.edit, exact: true }).first().waitFor({ state: 'attached', timeout: 30_000 });
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
    return await askAndExpect('What is six times seven? Answer with digits only.', /\b42\b/);
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

  await step('open-file', 'Opening the file from the Files panel shows it in the file viewer', async () => {
    await page.getByRole('button', { name: WORDS.tipGotIt }).click({ timeout: 2_000 }).catch(() => {});
    await openFromFilesPanel('walkthrough-check.txt');
    await page.getByText('mango', { exact: true }).first().waitFor({ timeout: 30_000 });
  }, { critical: false });

  await step('edit-file', 'The user edits the file in the viewer, saves, and the change is on disk', async () => {
    const file = path.join(home, 'walkthrough-check.txt');
    // FINDING (2026-11-02): the floating Edit button stays hidden while the file list is open beside the file
    // (SessionDrawer.tsx: opacity-0 unless !showList), so a user must close the list first — as this does.
    if (await page.getByPlaceholder(WORDS.filesSearch).isVisible().catch(() => false)) {
      await page.getByRole('button', { name: WORDS.fileListToggle }).first().click();
      await sleep(500);
    }
    await page.getByRole('button', { name: WORDS.edit, exact: true }).filter({ visible: true }).first().click();
    // Click into the file's text, as a person would (whatever kind of editing box the viewer uses).
    await page.getByText('mango', { exact: true }).last().click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('mango papaya');
    const save = page.getByRole('button', { name: WORDS.save, exact: true }).filter({ visible: true }).first();
    if (await save.isVisible().catch(() => false)) await save.click(); else await page.keyboard.press('ControlOrMeta+S');
    for (let i = 0; i < 30; i++) { if (fs.readFileSync(file, 'utf8').includes('papaya')) return 'saved to disk'; await sleep(500); }
    throw new Error('the edit never reached the file on disk');
  }, { critical: false });

  await step('attach-file', 'The user attaches a file to a message and the assistant reads it', async () => {
    const file = path.join(home, 'walkthrough-attach.txt');
    fs.writeFileSync(file, 'The secret fruit is kumquat.\n');
    await answerFilePicker([file]);
    await page.getByRole('button', { name: WORDS.attach }).click();
    await page.getByText('walkthrough-attach.txt').first().waitFor({ timeout: 15_000 });
    // The answer is only in the attached file, never in the question.
    return await askAndExpect('What is the secret fruit in the attached file? Answer with one word.', /kumquat/i);
  }, { critical: false });

  await step('browser', "The assistant opens a web page in its own browser and reports what's on it", async () => {
    // WHY a page served by this script: the word on it is made up just now, so the assistant can only answer by
    // really visiting — and the server sees the visit. It's on this computer, so the app asks once whether the
    // assistant may open a local address; a user would allow it.
    const secret = `plum${Math.floor(1000 + Math.random() * 9000)}`;
    let visited = '';
    const server = http.createServer((req, res) => {
      visited = String(req.headers['user-agent'] || 'unknown');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Walk-through page</title><h1>The code word is ${secret}</h1>`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    try {
      const box = page.getByPlaceholder(WORDS.messageBox);
      await box.fill(`Use your web browser to open ${url} and tell me the code word written on that page.`);
      await box.press('Enter');
      for (const t = Date.now(); Date.now() - t < 240_000; await sleep(2000)) {
        if (visited && new RegExp(secret).test(await page.locator('body').innerText().catch(() => ''))) {
          return `page visited by ${/Chrome\/[\d.]+/.exec(visited)?.[0] ?? visited}`;
        }
        const yes = page.getByRole('button', { name: WORDS.approve }).first();
        if (await yes.isVisible().catch(() => false)) await yes.click().catch(() => {});
      }
      throw new Error(visited ? 'the browser visited the page but the code word never appeared in the chat'
        : 'the assistant\'s browser never visited the page within 4 minutes');
    } finally { server.close(); }
  }, { critical: false });

  async function openMarketplace() {
    await page.getByRole('button', { name: WORDS.browseSkills }).click();
    await page.getByRole('button', { name: WORDS.openMarketplace }).click({ timeout: 10_000 });
    await page.getByRole('textbox', { name: WORDS.marketSearch }).waitFor({ timeout: 30_000 });
  }

  await step('install-skill', 'The user installs a skill from the marketplace and it is really installed', async () => {
    await openMarketplace();
    await page.getByRole('textbox', { name: WORDS.marketSearch }).fill('civic report');
    await page.getByText('Civic Report', { exact: true }).first().click({ timeout: 30_000 });
    // WHY filter by the item's name, not .last(): the app's tip bubbles are dialogs too, and one opening after the
    // details popup became "the last dialog" (run 41431239539).
    await page.getByRole('dialog').filter({ hasText: 'Civic Report' }).getByRole('button', { name: WORDS.install }).first().click({ timeout: 15_000 });
    // Outcome: the plugin is on disk where Claude Code and the app look for it (ClaudeCodeRegistry).
    const dir = path.join(home, '.claude/plugins/marketplaces/youcoded/plugins/civic-report');
    for (let i = 0; i < 60 && !fs.existsSync(dir); i++) await sleep(1000);
    if (!fs.existsSync(dir)) throw new Error('no civic-report folder appeared in the plugins folder within 60s');
    await page.keyboard.press('Escape');
  }, { critical: false });

  await step('install-theme', 'The user installs a theme from the marketplace, applies it, and the app switches to it', async () => {
    await page.keyboard.press('Escape');
    if (!(await page.getByRole('textbox', { name: WORDS.marketSearch }).isVisible().catch(() => false))) await openMarketplace();
    await page.getByRole('textbox', { name: WORDS.marketSearch }).fill('golden sunbreak');
    await page.getByText('Golden Sunbreak', { exact: true }).first().click({ timeout: 30_000 });
    const details = page.getByRole('dialog').filter({ hasText: 'Golden Sunbreak' });
    await details.getByRole('button', { name: WORDS.install }).first().click({ timeout: 15_000 });
    const manifest = path.join(home, '.claude/wecoded-themes/golden-sunbreak/manifest.json');
    for (let i = 0; i < 60 && !fs.existsSync(manifest); i++) await sleep(1000);
    if (!fs.existsSync(manifest)) throw new Error('the theme was not saved to the themes folder within 60s');
    await details.getByRole('button', { name: WORDS.applyTheme }).first().click({ timeout: 30_000 });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'golden-sunbreak', null, { timeout: 15_000 });
    await snap('theme-applied');
  }, { critical: false });

  // Back to the chat, by the marketplace's own way out. FINDING (2026-11-02): with no chat open there is no way
  // into the skills marketplace at all — it's reached only from the compass in a chat's message bar (Settings has
  // no entry), which is why these steps run before the chat is closed.
  for (let i = 0; i < 3 && !(await page.getByPlaceholder(WORDS.messageBox).isVisible().catch(() => false)); i++) {
    await page.getByRole('button', { name: WORDS.backToChat }).first().click({ timeout: 3_000 }).catch(() => page.keyboard.press('Escape'));
    await sleep(800);
  }

  await step('close-chat', 'The user closes the chat', async () => {
    // "All sessions" (the arrow beside the chat's name), then the chat row's close ✕. WHY by position: neither
    // button has a name of its own until hovered (their tooltips name them only then), so a screen reader can't
    // find them by name either — worth fixing in the app.
    await page.getByRole('button', { name: NAME, exact: true }).first().locator('xpath=following::button[1]').click();
    // In the menu row: name, rename pencil, then the ✕ — which shows only while the row is hovered.
    await page.getByRole('button', { name: NAME, exact: true }).last().hover();
    await page.getByRole('button', { name: `Rename ${NAME}` }).last().locator('xpath=following::button[1]').click({ timeout: 10_000 });
    // FINDING (2026-11-02): the buddy's tip bubble sits on top of this prompt's "Close session" button, so a
    // user must dismiss the tip first — as this does.
    await page.getByRole('button', { name: WORDS.tipGotIt }).click({ timeout: 3_000 }).catch(() => {});
    const confirm = page.getByRole('dialog', { name: WORDS.closeDialog });
    // Its ✕ is also named "Close session"; the confirm button is the one that SHOWS the words.
    await confirm.getByRole('button', { name: WORDS.closeDialog }).filter({ hasText: WORDS.closeDialog }).click({ timeout: 10_000 });
    await page.getByRole('button', { name: WORDS.resume }).waitFor({ timeout: 30_000 });
  }, { critical: false });

  await step('search', 'Searching past chats finds this one by a word in its name, and not by nonsense', async () => {
    await page.getByRole('button', { name: WORDS.resume }).click({ timeout: 10_000 });
    const search = page.getByPlaceholder(WORDS.resumeSearch).first();
    await page.getByText(NAME).first().waitFor({ timeout: 30_000 });
    await search.fill('zzzz-no-such-chat');
    await page.getByText(NAME).first().waitFor({ state: 'hidden', timeout: 15_000 });
    await search.fill('taco');
    await page.getByText(NAME).first().waitFor({ timeout: 15_000 });
    await page.keyboard.press('Escape');
  }, { critical: false });
  await step('open-spreadsheet', "The user opens their own spreadsheet from Projects and sees its cells and the formula's total", async () => {
    for (const f of ['walkthrough-groceries.xlsx', 'walkthrough-letter.docx']) fs.copyFileSync(path.join(FIXTURES, f), path.join(home, f));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: WORDS.projects }).click();
    await page.getByText('walkthrough-groceries.xlsx').first().click({ timeout: 30_000 });
    await page.getByText('tortillas', { exact: true }).first().waitFor({ timeout: 30_000 });
    // 12 + 3 + 6: the sheet stores a SUM formula, so 21 showing means formulas are worked out, not just text.
    await page.getByText('21', { exact: true }).first().waitFor({ timeout: 10_000 });
  }, { critical: false });

  await step('open-word', 'The user opens their own Word document from Projects and sees its text', async () => {
    await page.keyboard.press('Escape');
    if (!(await page.getByText('walkthrough-letter.docx').first().isVisible().catch(() => false))) {
      await page.getByRole('button', { name: WORDS.projects }).click();
    }
    await page.getByText('walkthrough-letter.docx').first().click({ timeout: 30_000 });
    await page.getByText(/about pineapples/).first().waitFor({ timeout: 60_000 });
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
