import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../desktop/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('// --- Install-tips modal ---');
const end = html.indexOf('// Hero word cycler', start);
assert.ok(start > 0 && end > start, 'exercise the actual download modal script');
const script = html.slice(start, end);

function modal(platform, version = '1.3.2') {
  const dom = new JSDOM(html, { url: 'https://youcoded.ai/', runScripts: 'outside-only' });
  const w = dom.window;
  const base = `https://github.com/itsdestin/youcoded/releases/download/v${version}/YouCoded-Installer-${version}`;
  w.__youcodedReleaseAssets = {
    'dl-windows': { url: `${base}.exe` },
    'dl-macos-arm64': { url: `${base}-arm64.dmg` },
    'dl-macos-intel': { url: `${base}-x64.dmg` },
    'dl-android': { url: `https://github.com/itsdestin/youcoded/releases/download/v${version}/YouCoded-${version}.apk` },
  };
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.eval(script);
  w.document.querySelector(`[data-dl="${platform}"]`).click();
  return {
    dom, w, body: w.document.getElementById('install-modal-body'),
    button: w.document.getElementById('install-modal-download-btn'),
  };
}

test('Windows gives installation steps without personal signing callouts', () => {
  const r = modal('dl-windows');
  try {
    assert.doesNotMatch(r.body.textContent, /Destin|signed by|publisher/i);
    assert.equal(r.body.querySelector('.install-modal-intro'), null);
    assert.match(r.body.textContent, /If.*SmartScreen/i);
    assert.doesNotMatch(r.body.textContent, /isn't signed|only.*first time|remembers your choice|Don't click/i);
    assert.match(r.button.href, /\.exe$/);
  } finally { r.dom.window.close(); }
});

test('Mac signed releases have three short installation steps on both chips', () => {
  for (const version of ['1.3.2', '1.3.3', '1.4.0', '2.0.0']) {
    const r = modal('dl-macos', version);
    try {
      assert.doesNotMatch(r.body.textContent, /Destin|signed by|Notarized by/);
      assert.equal(r.body.querySelector('.install-modal-note'), null);
      assert.doesNotMatch(r.body.textContent, /Open Anyway|cannot check|\$99/);
      assert.equal(r.body.querySelector('.install-modal-section ol').children.length, 3);
      assert.match(r.button.href, /arm64\.dmg$/);
      const intel = r.body.querySelector('input[value="dl-macos-intel"]');
      intel.checked = true;
      intel.dispatchEvent(new r.w.Event('change', { bubbles: true }));
      assert.match(r.button.href, /x64\.dmg$/);
      assert.doesNotMatch(r.body.textContent, /Open Anyway/);
      assert.match(r.body.textContent, /About This Mac/);
    } finally { r.dom.window.close(); }
  }
});

test('Mac current public and older releases retain a concise conditional warning', () => {
  for (const version of ['1.3.1', '1.3.0', '1.2.4']) {
    const r = modal('dl-macos', version);
    try {
      assert.match(r.body.textContent, /older.*not.*Apple.signed/i);
      assert.match(r.body.textContent, /If.*blocks.*Privacy.*Security.*Open Anyway/i);
      assert.doesNotMatch(r.body.textContent, /Notarized by Apple/);
    } finally { r.dom.window.close(); }
  }
});

test('prerelease filenames make no unverified signing promise', () => {
  for (const version of ['1.3.1-beta.87', '1.3.2-beta.3', '1.3.2-beta.30', '2.0.0-beta.1']) {
    const r = modal('dl-macos', version);
    try {
      assert.doesNotMatch(r.body.textContent, /Notarized by Apple|older release is not/);
      assert.match(r.button.href, /beta/);
    } finally { r.dom.window.close(); }
  }
});

test('unknown Mac downloads do not claim signed status and fall back to releases', () => {
  const r = modal('dl-macos');
  try {
    r.w.__youcodedReleaseAssets = {};
    r.w.document.querySelector('[data-dl="dl-macos"]').click();
    assert.doesNotMatch(r.body.textContent, /Notarized by Apple|Open Anyway/);
    assert.equal(r.button.href, 'https://github.com/itsdestin/youcoded/releases');
  } finally { r.dom.window.close(); }
});

test('Android reflects the shipped rebuild without telling users to bypass security scans', () => {
  const r = modal('dl-android', '1.3.1');
  try {
    assert.doesNotMatch(r.body.textContent, /major revision|behind the desktop|rebuilt version|400|600|package tier|Install anyway|Claude Code runtime/i);
    assert.match(r.body.textContent, /Android 9\+.*ARM64/);
    assert.match(r.body.textContent, /main phone profile.*work profile.*Secure Folder/);
    assert.match(r.body.textContent, /Files.*Downloads/);
    assert.match(r.body.textContent, /warning.*Settings/);
    assert.match(r.body.textContent, /Allow from this source.*Chrome.*Files.*not.*YouCoded/i);
    assert.match(r.body.textContent, /Back.*APK.*Install/);
    assert.match(r.body.textContent, /search.*Install unknown apps/i);
    assert.match(r.body.textContent, /turn.*permission.*off.*after/i);
    assert.match(r.body.textContent, /Play Protect.*scan/i);
    assert.match(r.button.href, /\.apk$/);
  } finally { r.dom.window.close(); }
});

test('shared first-launch guidance is provider-first and GitHub is optional', () => {
  for (const platform of ['dl-windows', 'dl-macos', 'dl-android']) {
    const r = modal(platform);
    try {
      const after = r.body.querySelector('details');
      assert.match(after.textContent, /Choose how to connect your AI.*setup prompts/i);
      if (platform === 'dl-android') assert.doesNotMatch(after.textContent, /local model/i);
      assert.match(after.textContent, /GitHub.*optional|optional.*GitHub/i);
      assert.doesNotMatch(after.textContent, /Settings.*Model Providers|Sign in with GitHub\./);
    } finally { r.dom.window.close(); }
  }
});
