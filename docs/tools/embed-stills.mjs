// Shoots the landing page's demo stills -- the picture in the demo window until the live app has
// loaded behind it -- from the BUILT embed (docs/site), one per theme the page can wear, at the demo
// box's own shape. Same job as the workspace's scripts/ui-review/embed-posters.mjs, made
// self-contained (Chrome + a few DevTools calls, no workspace imports) so the site-deploy workflow
// can run it on every release: the still must be the very app the visitor then gets.
//
// usage: node docs/tools/embed-stills.mjs <youcoded/docs>   (needs index.html and a built site/index.html)
// Writes docs/media/embed-<layout>-<theme>.webp. Writes NOTHING if any still fails to prove the app painted.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, normalize } from 'node:path';

const DOCS = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(join(DOCS, 'index.html')) || !existsSync(join(DOCS, 'site', 'index.html'))) {
  console.error('usage: node embed-stills.mjs <youcoded/docs>  (needs index.html and a built site/index.html)');
  process.exit(2);
}
// setEmbedPoster() uses the phone still at <=760px and the desktop one above; measured at a common size of each.
const LAYOUTS = [{ name: 'desktop', page: [1440, 900] }, { name: 'phone', page: [390, 844] }];
const SCALE = 2;
const READY_MAX = 30000;
const SETTLE = 1500;      // entrance animations and moving backgrounds come to rest
const CHROME = process.env.CHROME_BIN || 'google-chrome-stable';

// ── a static server for docs/, on a free port ────────────────────────────────
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.jsonl': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.webm': 'video/webm', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  let file = join(DOCS, p);
  if (!file.startsWith(DOCS)) { res.writeHead(403); return res.end(); }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ── Chrome, driven over its DevTools socket (Node 22's built-in WebSocket) ───
const profile = mkdtempSync(join(tmpdir(), 'embed-stills-profile-'));
const staging = mkdtempSync(join(tmpdir(), 'embed-stills-out-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const cleanup = () => {
  try { chrome.kill(); } catch { /* best effort */ }
  server.close();
  for (const d of [profile, staging]) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('exit', cleanup);
const browserUrl = await new Promise((res, rej) => {
  let err = '';
  chrome.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) res(m[1]); });
  chrome.on('exit', (c) => rej(new Error(`chrome exited (${c}): ${err.slice(-400)}`)));
});

async function socket(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; waiting.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
  return { ws, send };
}
const browser = await socket(browserUrl);

// WHY a private context per tab: the app saves its look in localStorage, so a shared profile let
// each theme's still inherit the previous theme's saved appearance (every still came out lavender).
async function newTab() {
  const { browserContextId } = await browser.send('Target.createBrowserContext');
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { ws, send } = await socket(browserUrl.replace(/\/devtools\/browser\/.*/, `/devtools/page/${targetId}`));
  // WHY: without Page.enable a pre-load script (the theme we ask for) never runs on navigation.
  await send('Runtime.enable'); await send('Page.enable');
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const png = async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  const close = async () => { ws.close(); await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {}); };
  return { send, evaluate, png, close };
}

const waitUntil = async (tab, expr, what) => {
  for (const t0 = Date.now(); Date.now() - t0 < READY_MAX;) {
    // WHY await: PAINTED is an async check, and `!!promise` is always true -- the still was
    // taken before the theme had loaded (every one came out in the default look).
    if (await tab.evaluate(`(async () => !!(await (${expr})))()`).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// The app has painted, in the theme we asked for, with its wallpaper decoded -- the same bar the
// page's whenEmbedPainted() holds the live swap to, plus the seeded conversation the still must show.
const PAINTED = (theme) => `(async () => {
  if (localStorage.getItem('youcoded-theme') !== ${JSON.stringify(theme)}) return false;
  if (!document.querySelector('.input-bar-container')) return false;
  if (document.body.innerText.trim().length < 200) return false;
  if (document.fonts.status !== 'loaded') return false;
  const bg = document.getElementById('theme-bg');
  const m = bg && /url\\("?([^")]+)"?\\)/.exec(getComputedStyle(bg).backgroundImage);
  if (m) { const im = new Image(); im.src = m[1]; try { await im.decode(); } catch { return false; } }
  return true;
})()`;

let failed = 0;
const written = [];
for (const layout of LAYOUTS) {
  const [pw, ph] = layout.page;
  const page = await newTab();
  await page.send('Emulation.setDeviceMetricsOverride', { width: pw, height: ph, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url: `${ORIGIN}/index.html` });
  await waitUntil(page, `document.readyState === 'complete' && typeof POSTER_THEMES !== 'undefined' && document.querySelector('.embed-stage')`, 'the landing page');
  const info = await page.evaluate(`(() => {
    const r = document.querySelector('.embed-stage').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), themes: POSTER_THEMES,
             src: new URL(document.querySelector('.embed-iframe').dataset.src, location.href).href,
             css: ${layout.name === 'phone' ? 'PHONE_EMBED_CSS' : "''"} };
  })()`);
  await page.close();
  console.log(`[embed-stills] ${layout.name}: box ${info.w}x${info.h} at a ${pw}x${ph} page; themes ${info.themes.join(', ')}`);

  for (const theme of info.themes) {
    const name = `embed-${layout.name}-${theme}`;
    const t = await newTab();
    try {
      await t.send('Emulation.setDeviceMetricsOverride', { width: info.w, height: info.h, deviceScaleFactor: SCALE, mobile: false });
      await t.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('youcoded-theme',${JSON.stringify(theme)});}catch{}` });
      await t.send('Page.navigate', { url: info.src });
      await waitUntil(t, `document.readyState === 'complete'`, 'the embed to load');
      // The page injects this into the phone embed on load (stripEmbedChrome); the still does the same.
      if (info.css) await t.evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(info.css)}; document.head.appendChild(s); })()`);
      await waitUntil(t, PAINTED(theme), `${theme} to paint`);
      await new Promise((r) => setTimeout(r, SETTLE));
      const png = join(staging, `${name}.png`);
      writeFileSync(png, await t.png());
      const conv = spawnSync('convert', [png, '-quality', '82', join(staging, `${name}.webp`)], { encoding: 'utf8' });
      if (conv.status !== 0) throw new Error(`convert: ${conv.stderr.trim()}`);
      written.push(name);
      console.log(`ok   ${name} (${info.w * SCALE}x${info.h * SCALE})`);
    } catch (e) {
      failed += 1;
      console.log(`MISS ${name}: ${e.message}`);
    } finally { await t.close(); }
  }
}

if (failed) {
  console.error(`[embed-stills] ${failed} still(s) did not prove the app had painted -- wrote nothing; the previous stills are untouched.`);
  process.exit(1);
}
for (const name of written) copyFileSync(join(staging, `${name}.webp`), join(DOCS, 'media', `${name}.webp`));
console.log(`[embed-stills] wrote ${written.length} stills to ${join(DOCS, 'media')}`);
process.exit(0);
