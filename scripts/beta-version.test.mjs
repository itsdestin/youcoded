import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBetaVersion } from './beta-version.mjs';

const release = (version, published_at = '2026-10-18T03:10:04Z') => ({
  tag_name: `v${version}`, published_at, draft: false, prerelease: false,
});

function fixture({ runNumber = 109, runAttempt = 1, latestRunNumber = runNumber, totalRuns = latestRunNumber, baseline = 108, releases = [release('1.3.1')], releasePages, createdAt = '2026-10-18T04:00:00Z', base = '' } = {}) {
  const calls = [];
  const github = { rest: {
    actions: {
      getWorkflowRun: async () => ({ data: { run_number: runNumber, run_attempt: runAttempt, workflow_id: 123, created_at: createdAt } }),
      listWorkflowRuns: async (params) => {
        calls.push(params);
        if (!params.created) return { data: { total_count: totalRuns, workflow_runs: [{ run_number: latestRunNumber }] } };
        return { data: { workflow_runs: baseline === null ? [] : [{ run_number: baseline }] } };
      },
    },
    repos: { listReleases: async ({ page }) => ({ data: releasePages ? releasePages[page - 1] ?? [] : page === 1 ? releases : [] }) },
  } };
  return { calls, resolve: () => resolveBetaVersion({ github, context: { repo: { owner: 'owner', repo: 'repo' }, runId: 456 }, base }) };
}

test('first beta after 1.3.1 is 1.3.2-beta.1, not lifetime run 109', async () => {
  const f = fixture();
  assert.equal(await f.resolve(), '1.3.2-beta.1');
  assert.equal(f.calls[0].created, '<2026-10-18T03:10:04Z');
  assert.equal(f.calls[0].workflow_id, 123);
});

test('subsequent runs increase within the same release cycle, including failed attempts', async () => {
  assert.equal(await fixture({ runNumber: 111 }).resolve(), '1.3.2-beta.3');
});

test('the first beta after 1.3.2 resets to 1 again', async () => {
  assert.equal(await fixture({ runNumber: 120, baseline: 119, releases: [release('1.3.2')] }).resolve(), '1.3.3-beta.1');
});

test('a rerun keeps its original version even after another official release is published', async () => {
  const releases = [release('1.3.2', '2026-10-19T00:00:00Z'), release('1.3.1')];
  assert.equal(await fixture({ releases, runAttempt: 2 }).resolve(), '1.3.2-beta.1');
});

test('a rerun refuses deleted history rather than reusing a later beta version', async () => {
  // Run 109 was beta.1 and 110 beta.2 with baseline108. Deleting run108
  // exposes baseline107: blindly rerunning109 would now collide with beta.2.
  await assert.rejects(fixture({ runAttempt: 2, baseline: 107, latestRunNumber: 110, totalRuns: 109 }).resolve(), /history.*deleted/);
  await assert.rejects(fixture({ runAttempt: 2, baseline: null, latestRunNumber: 110, totalRuns: 2 }).resolve(), /history.*deleted/);
});

test('a queued first attempt refuses deleted history instead of colliding with a newer run', async () => {
  // Run110 can resolve beta2 before queued109 starts. Deleting boundary108
  // would let queued109 also resolve beta2, despite being a first attempt.
  await assert.rejects(fixture({ baseline: 107, latestRunNumber: 110, totalRuns: 109 }).resolve(), /history.*deleted/);
});

test('drafts and prereleases do not reset the counter', async () => {
  const releases = [{ ...release('1.3.2'), draft: true }, { ...release('1.3.2-beta.7'), prerelease: true }, release('1.3.1')];
  assert.equal(await fixture({ releases }).resolve(), '1.3.2-beta.1');
});

test('release selection uses numeric versions, not API order', async () => {
  assert.equal(await fixture({ releases: [release('1.3.9'), release('1.3.10')] }).resolve(), '1.3.11-beta.1');
});

test('an explicit prefix must match the next patch so a later reset cannot reuse the same beta name', async () => {
  assert.equal(await fixture({ base: '1.3.2-beta' }).resolve(), '1.3.2-beta.1');
  await assert.rejects(fixture({ base: '1.4.0-beta' }).resolve(), /next patch/);
  await assert.rejects(fixture({ releases: [release('1.3.2')], base: '1.4.0-beta' }).resolve(), /next patch/);
  await assert.rejects(fixture({ base: '1.3.1-beta' }).resolve(), /above.*1\.3\.1/);
  await assert.rejects(fixture({ base: '1.3.2-beta.99' }).resolve(), /prefix/);
});

test('a workflow introduced after the release counts from its own first run', async () => {
  assert.equal(await fixture({ runNumber: 1, baseline: null }).resolve(), '1.3.2-beta.1');
  assert.equal(await fixture({ runNumber: 2, baseline: null }).resolve(), '1.3.2-beta.2');
});

test('missing history fails instead of guessing a number', async () => {
  await assert.rejects(fixture({ baseline: null, totalRuns: 1 }).resolve(), /history.*deleted/);
  await assert.rejects(fixture({ baseline: 109 }).resolve(), /baseline/);
});

test('finds the official release beyond a full page of prereleases', async () => {
  const betas = Array.from({ length: 100 }, (_, n) => ({ ...release(`1.3.2-beta.${n + 1}`), prerelease: true }));
  assert.equal(await fixture({ releasePages: [betas, [release('1.3.1')]] }).resolve(), '1.3.2-beta.1');
});

test('GitHub API failures stop the build rather than falling back to lifetime numbering', async () => {
  const github = { rest: { actions: { getWorkflowRun: async () => { throw new Error('API unavailable'); } } } };
  await assert.rejects(resolveBetaVersion({ github, context: { repo: {}, runId: 1 } }), /API unavailable/);
});

test('missing official release fails instead of inventing a version', async () => {
  await assert.rejects(fixture({ releases: [] }).resolve(), /official release/);
});
