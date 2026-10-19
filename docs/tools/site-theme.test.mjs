import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const site = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const theme = JSON.parse(readFileSync(new URL('../../desktop/src/renderer/themes/builtin/youcoded.json', import.meta.url), 'utf8'));
const themesSource = site.match(/var THEMES = (\{[^\n]+\});/);
assert.ok(themesSource, 'the website theme table is present');
const themes = vm.runInNewContext(`(${themesSource[1]})`);

test('website default uses the actual lavender YouCoded Light theme, not the legacy grey Light', () => {
  const actual = themes.youcoded;
  assert.ok(actual, 'YouCoded Light has a website palette');
  for (const [siteKey, token] of Object.entries({ canvas: 'canvas', panel: 'panel', accent: 'accent', onAccent: 'on-accent', fg: 'fg', fg2: 'fg-2', dim: 'fg-dim', muted: 'fg-muted', edge: 'edge' })) {
    assert.equal(actual[siteKey], theme.tokens[token], siteKey);
  }
  assert.equal(actual.font, theme.font.family);
  assert.equal(actual.blur, theme.background['panels-blur']);
  assert.equal(actual.opacity, theme.background['panels-opacity']);
  assert.match(site, /var currentTheme = 'youcoded';/);
  assert.match(site, /applyTheme\("youcoded"\);/);
  assert.match(site, /theme: 'youcoded',\s+at: 2080/);
  assert.match(site, /applyTheme\('youcoded'\);/);
});

test('phone embed hides the current caption-button cluster after the tooltip migration', () => {
  const phoneCss = site.match(/var PHONE_EMBED_CSS = '([^']+)';/);
  assert.ok(phoneCss);
  const header = readFileSync(new URL('../../desktop/src/renderer/components/HeaderBar.tsx', import.meta.url), 'utf8');
  assert.match(header, /className="caption-buttons /);
  assert.match(phoneCss[1], /\.caption-buttons/);
});

test('default poster, wallpaper and mascot are generated assets for YouCoded Light', () => {
  const posterList = site.match(/var POSTER_THEMES = (\[[^\n]+\]);/);
  assert.ok(posterList);
  const posters = vm.runInNewContext(posterList[1]);
  assert.equal(posters[0], 'youcoded');
  assert.match(site, /embed-desktop-youcoded\.webp/);
  assert.match(site, /data-theme="youcoded"[^>]+data-idle/);
  assert.match(site, /aria-label="Use the YouCoded Light look"/);
  const defaultChip = site.match(/<button class="mascot" data-theme="youcoded"[\s\S]*?style="--a:([^\"]+)"/);
  assert.ok(defaultChip);
  assert.equal(defaultChip[1], theme.tokens.accent);
  const generator = readFileSync(new URL('./gen-hero-mascots.py', import.meta.url), 'utf8');
  const picker = generator.match(/\('youcoded',\s*'YouCoded Light',\s*'([^']+)'/);
  assert.ok(picker);
  assert.equal(picker[1], theme.tokens.accent);
  assert.ok(themes.youcoded.wall);
  readFileSync(fileURLToPath(new URL(`../${themes.youcoded.wall}`, import.meta.url)));
});
