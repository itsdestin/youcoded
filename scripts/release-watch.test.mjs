import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTampering } from './release-watch.mjs';

// WHY: this alarm is the only fast warning of a poisoned release; a rule that stopped matching
// would look exactly like a quiet hour.
const now = Date.parse('2026-11-05T12:00:00Z');
const iso = (hoursAgo) => new Date(now - hoursAgo * 3600_000).toISOString();
const bot = { login: 'github-actions[bot]' };
const release = (over = {}) => ({
  tag_name: 'v1.3.4', draft: false, author: bot, created_at: iso(1), published_at: iso(1),
  assets: [{ name: 'YouCoded.exe', uploader: bot, created_at: iso(1), updated_at: iso(1) }], ...over,
});

test('a normal workflow release is quiet', () => {
  assert.deepEqual(findTampering([release()], now), []);
});

test('a release published by a person is flagged', () => {
  const kinds = findTampering([release({ author: { login: 'someone' } })], now).map((f) => f.kind);
  assert.ok(kinds.includes('release-by-person'));
});

test('a file uploaded by a person into a workflow release is flagged', () => {
  const r = release({ assets: [{ name: 'latest.yml', uploader: { login: 'someone' }, created_at: iso(0.5), updated_at: iso(0.5) }] });
  assert.deepEqual(findTampering([r], now).map((f) => f.kind), ['asset-by-person']);
});

test('a file swapped into an old release is flagged even when the bot did it', () => {
  const r = release({ created_at: iso(200), published_at: iso(200),
    assets: [{ name: 'YouCoded.exe', uploader: bot, created_at: iso(200), updated_at: iso(0.2) }] });
  assert.deepEqual(findTampering([r], now).map((f) => f.kind), ['asset-swapped']);
});

test('old hand-made releases and drafts do not alarm every hour', () => {
  const old = release({ author: { login: 'itsdestin' }, created_at: iso(500), published_at: iso(500),
    assets: [{ name: 'a.apk', uploader: { login: 'itsdestin' }, created_at: iso(500), updated_at: iso(500) }] });
  const draft = release({ draft: true, author: { login: 'someone' } });
  assert.deepEqual(findTampering([old, draft], now), []);
});
