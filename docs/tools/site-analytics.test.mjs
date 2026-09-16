import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { createAnalytics, metadata, eligible, installerTarget } from '../site-analytics.mjs';

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function rig(fetcher) {
  let time = 1000000, id = 0;
  const timers = new Map(), calls = [];
  const clock = { now: () => time, setTimeout: (fn, delay) => { timers.set(++id, { fn, at: time + delay }); return id; }, clearTimeout: id => timers.delete(id) };
  const client = createAnalytics({ fetch: (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return fetcher?.(calls.length, options) ?? Promise.resolve({ status: 200, json: async () => url.endsWith('/start') ? ({ version: 1, capability: 'opaque', attribution: {} }) : ({ ok: true }) }); }, crypto: webcrypto, clock, href: 'https://youcoded.ai/?utm_source=post&utm_campaign=launch&secret=hide', referrer: 'https://Example.com/private?q=hide' });
  async function tick(ms) {
    const end = time + ms;
    await settle();
    while (true) { const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; time = next[1].at; timers.delete(next[0]); next[1].fn(); await settle(); }
    time = end; await settle();
  }
  return { client, calls, tick, timers };
}

test('canonical top-level root only', () => {
  assert.equal(eligible({ location: new URL('https://youcoded.ai/?utm_source=x'), top: 1, self: 1 }), true);
  for (const href of ['http://youcoded.ai/', 'https://youcoded.ai/demo', 'http://localhost/', 'https://itsdestin.github.io/youcoded/']) assert.equal(eligible({ location: new URL(href), top: 1, self: 1 }), false);
  assert.equal(eligible({ location: new URL('https://youcoded.ai/'), top: 1, self: 2 }), false);
});
test('labels and referrer suppress arbitrary metadata', () => {
  assert.deepEqual(metadata('https://youcoded.ai/?utm_source=%20Post%20&utm_campaign=A%2F%23%3F&email=secret', 'https://EXAMPLE.com/path?private'), { source: 'Post', campaign: 'A/#?', referrerDomain: 'example.com' });
  for (const query of ['utm_source=a', 'utm_source=a&utm_source=b&utm_campaign=c', 'utm_source=%00&utm_campaign=c', 'utm_source=(untagged)&utm_campaign=c', `utm_source=${'x'.repeat(161)}&utm_campaign=c`, 'utm_source=%7F&utm_campaign=c']) assert.equal(metadata('https://youcoded.ai/?' + query, '').source, null);
  for (const ref of ['https://youcoded.ai/x', 'https://localhost/x', 'http://127.0.0.1/x', 'https://user:pass@example.com/x', 'https://example.com:8443/x']) assert.equal(metadata('https://youcoded.ai/', ref).referrerDomain, '');
});
test('start is minimal, nonce independent per page, coalesced cumulative update', async () => {
  const a = rig(), b = rig(); await a.tick(0); await b.tick(0);
  assert.match(a.calls[0].body.nonce, /^[a-f0-9]{32}$/); assert.notEqual(a.calls[0].body.nonce, b.calls[0].body.nonce);
  assert.equal(a.calls[0].body.createdAt, 1000); assert.equal(a.calls[0].body.version, 1);
  assert.equal(a.calls[0].options.credentials, 'omit'); assert.equal(a.calls[0].options.referrerPolicy, 'no-referrer'); assert.equal(a.calls[0].options.keepalive, true);
  a.client.instructions(); a.client.download('Windows'); a.client.download('macOS'); await a.tick(249); assert.equal(a.calls.length, 1); await a.tick(1);
  assert.deepEqual(a.calls[1].body, { version: 1, capability: 'opaque', instructions: true, downloads: { Windows: 1, macOS: 1, Linux: 0, Android: 0 } });
  await a.tick(60000); assert.equal(a.calls.length, 2); assert.equal(JSON.stringify(a.calls).includes('secret'), false);
});
test('timeout includes response JSON; retry same payload, late ACK ignored, newer state retained', async () => {
  let late;
  const r = rig(n => n === 1 ? Promise.resolve({ status: 200, json: () => new Promise(resolve => { late = resolve; }) }) : undefined);
  await r.tick(0); r.client.download('Linux'); await r.tick(8000); assert.equal(r.calls[0].options.signal.aborted, true);
  await r.tick(500); assert.deepEqual(r.calls[1].body, r.calls[0].body);
  late({ version: 1, capability: 'wrong-late', attribution: {} }); await r.tick(250);
  assert.equal(r.calls[2].body.capability, 'opaque'); assert.equal(r.calls[2].body.downloads.Linux, 1);
});
test('never settling transport releases slot and abandons start after two retries', async () => {
  const r = rig(() => new Promise(() => {})); await r.tick(60000); assert.equal(r.calls.length, 3); r.client.download('Windows'); await r.tick(60000); assert.equal(r.calls.length, 3);
});
test('terminal statuses stop immediately', async () => {
  for (const status of [403, 404, 410, 429]) { const r = rig(() => Promise.resolve({ status })); await r.tick(0); r.client.download('Windows'); await r.tick(60000); assert.equal(r.calls.length, 1); }
});
test('click cap and invalid targets', async () => {
  const r = rig(); await r.tick(0); for (let i = 0; i < 120; i++) r.client.download(i % 2 ? 'Linux' : 'Android'); r.client.download('iOS'); r.client.download('__proto__'); await r.tick(250);
  assert.equal(Object.values(r.calls[1].body.downloads).reduce((a, b) => a + b), 100);
});
test('stop cancels pending work and cannot restart measurement', async () => {
  const r = rig(() => new Promise(() => {})); await r.tick(0); r.client.stop(); assert.equal(r.calls[0].options.signal.aborted, true);
  r.client.download('Linux'); r.client.flush(); await r.tick(60000); assert.equal(r.calls.length, 1);
});
test('update retry exhaustion preserves newer state and total attempts stop at 128', async () => {
  const r = rig(n => n === 1 ? undefined : Promise.reject(Error('lost acknowledgement')));
  await r.tick(0);
  r.client.download('Windows'); await r.tick(250); r.client.download('Android');
  await r.tick(1750);
  assert.deepEqual(r.calls[1].body, r.calls[2].body); assert.deepEqual(r.calls[2].body, r.calls[3].body);
  assert.equal(r.calls[4].body.downloads.Android, 1);
  for (let i = 0; i < 99; i++) { r.client.download('Linux'); await r.tick(2000); }
  await r.tick(60000); assert.equal(r.calls.length, 128);
});
test('synchronous fetch throws are caught and stop remains the only shutdown control', async () => {
  const r = rig(() => { throw Error('transport'); }); await r.tick(60000); assert.equal(r.calls.length, 3);
  assert.deepEqual(Object.keys(r.client).sort(), ['download', 'flush', 'instructions', 'stop']);
});
test('website analytics never reads or writes browser storage', () => {
  const client = readFileSync(new URL('../site-analytics.mjs', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../site-analytics-ui.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(client + ui, /\b(?:localStorage|sessionStorage|indexedDB|StorageEvent|addEventListener\(['"]storage['"])/);
  assert.doesNotMatch(client, /\b(?:createPreference|STORAGE_KEY|preference)\b/);
});
test('installer variants and real hook static guard', () => {
  const url = 'https://github.com/itsdestin/youcoded/releases/download/v1/YouCoded.dmg';
  assert.equal(installerTarget('dl-macos-arm64', url), 'macOS'); assert.equal(installerTarget('dl-linux-deb', url.replace('.dmg', '.deb')), 'Linux');
  assert.equal(installerTarget('dl-ios', url), null); assert.equal(installerTarget('dl-windows', 'https://github.com/itsdestin/youcoded/releases'), null);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /site-analytics-ui\.mjs/); assert.match(html, /siteAnalyticsSignal\('instructions'\)/); assert.match(html, /downloadKeyFor\(openPlatformKey\), href: downloadBtn\.href/); assert.match(html, /addEventListener\('auxclick'/);
});
