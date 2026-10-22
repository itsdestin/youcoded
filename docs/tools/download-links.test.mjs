// The download buttons' release lookup (docs/index.html): official releases only, and each
// button takes the newest official release that carries its file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../desktop/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf("(function() {\n  var CACHE_KEY = 'youcoded-latest-release';");
const end = html.indexOf('})();', start) + 5;
assert.ok(start > 0 && end > start, 'exercise the actual release lookup script');
const script = html.slice(start, end);

const asset = (tag, name) => ({ name, size: 1, browser_download_url: `https://github.com/itsdestin/youcoded/releases/download/${tag}/${name}` });
const full = (v, prerelease = false) => ({
  tag_name: `v${v}`, draft: false, prerelease,
  assets: [`YouCoded-Installer-${v}.exe`, `YouCoded-Installer-${v}-arm64.dmg`, `YouCoded-Installer-${v}-x64.dmg`,
    `YouCoded-${v}.AppImage`, `YouCoded-${v}.apk`].map((n) => asset(`v${v}`, n)),
});

async function links(releases) {
  const dom = new JSDOM(html, { url: 'https://youcoded.ai/', runScripts: 'outside-only' });
  const w = dom.window;
  w.fetch = async () => ({ ok: true, json: async () => releases });
  w.eval(script);
  // The lookup resolves on the fetch's promise chain; one macrotask is enough for it to settle.
  await new Promise((r) => setTimeout(r, 0));
  const href = (id) => w.document.querySelector(`[data-dl="${id}"]`).href.split('/').pop();
  try { return { windows: href('dl-windows'), android: href('dl-android') }; } finally { w.close(); }
}

test('a newer pre-release is never offered', async () => {
  assert.deepEqual(await links([full('1.4.0-beta.1', true), full('1.3.2')]), {
    windows: 'YouCoded-Installer-1.3.2.exe', android: 'YouCoded-1.3.2.apk',
  });
});

test('a release still uploading leaves each button on the newest official release that has its file', async () => {
  const halfway = { tag_name: 'v1.3.3', draft: false, prerelease: false, assets: [asset('v1.3.3', 'YouCoded-1.3.3.apk')] };
  assert.deepEqual(await links([halfway, full('1.3.2')]), {
    windows: 'YouCoded-Installer-1.3.2.exe', android: 'YouCoded-1.3.3.apk',
  });
});
