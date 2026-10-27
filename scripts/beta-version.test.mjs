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

test('first beta after 1.3.1 is 1.4.0-beta.1 (the next feature release), not lifetime run 109', async () => {
  const f = fixture();
  assert.equal(await f.resolve(), '1.4.0-beta.1');
  assert.equal(f.calls[0].created, '<2026-10-18T03:10:04Z');
  assert.equal(f.calls[0].workflow_id, 123);
});

test('subsequent runs increase within the same release cycle, including failed attempts', async () => {
  assert.equal(await fixture({ runNumber: 111 }).resolve(), '1.4.0-beta.3');
});

test('the first beta after feature release 1.4.0 resets to 1 again', async () => {
  assert.equal(await fixture({ runNumber: 120, baseline: 119, releases: [release('1.4.0')] }).resolve(), '1.5.0-beta.1');
});

test('a bug-fix release does not restart the count: it is counted from the line\'s first release', async () => {
  // 1.3.1 opened the line; 1.3.2 is a fix from the release lane. Betas stay on
  // 1.4.0-beta and keep counting from 1.3.1, so no second 1.4.0-beta.1 is built.
  const releases = [release('1.3.2', '2026-10-25T00:00:00Z'), release('1.3.1')];
  const f = fixture({ releases, createdAt: '2026-10-26T00:00:00Z', runNumber: 115 });
  assert.equal(await f.resolve(), '1.4.0-beta.7');
  assert.equal(f.calls[0].created, '<2026-10-18T03:10:04Z');
});

test('the line starts at its EARLIEST published release, whatever order the API lists them in', async () => {
  const releases = [release('1.3.0', '2026-09-20T00:00:00Z'), release('1.3.2', '2026-10-25T00:00:00Z'), release('1.3.1')];
  const f = fixture({ releases, createdAt: '2026-10-26T00:00:00Z' });
  await f.resolve();
  assert.equal(f.calls[0].created, '<2026-09-20T00:00:00Z');
});

test('an older line does not count as the start of the latest one', async () => {
  const releases = [release('1.2.4', '2026-01-01T00:00:00Z'), release('1.3.1')];
  const f = fixture({ releases });
  assert.equal(await f.resolve(), '1.4.0-beta.1');
  assert.equal(f.calls[0].created, '<2026-10-18T03:10:04Z');
});

test('a rerun keeps its original version even after another official release is published', async () => {
  const releases = [release('1.4.0', '2026-10-19T00:00:00Z'), release('1.3.1')];
  assert.equal(await fixture({ releases, runAttempt: 2 }).resolve(), '1.4.0-beta.1');
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
  const releases = [{ ...release('1.4.0'), draft: true }, { ...release('1.4.0-beta.7'), prerelease: true }, release('1.3.1')];
  assert.equal(await fixture({ releases }).resolve(), '1.4.0-beta.1');
});

test('release selection uses numeric versions, not API order', async () => {
  assert.equal(await fixture({ releases: [release('1.3.9'), release('1.3.10')] }).resolve(), '1.4.0-beta.1');
});

test('an explicit prefix must match the next feature release so a later reset cannot reuse the same beta name', async () => {
  assert.equal(await fixture({ base: '1.4.0-beta' }).resolve(), '1.4.0-beta.1');
  // The old next-patch line now belongs to bug-fix releases.
  await assert.rejects(fixture({ base: '1.3.2-beta' }).resolve(), /next feature-release/);
  await assert.rejects(fixture({ releases: [release('1.4.0')], base: '1.4.0-beta' }).resolve(), /above.*1\.4\.0/);
  await assert.rejects(fixture({ base: '2.0.0-beta' }).resolve(), /next feature-release/);
  await assert.rejects(fixture({ base: '1.3.1-beta' }).resolve(), /above.*1\.3\.1/);
  await assert.rejects(fixture({ base: '1.3.2-beta.99' }).resolve(), /prefix/);
});

test('a workflow introduced after the release counts from its own first run', async () => {
  assert.equal(await fixture({ runNumber: 1, baseline: null }).resolve(), '1.4.0-beta.1');
  assert.equal(await fixture({ runNumber: 2, baseline: null }).resolve(), '1.4.0-beta.2');
});

test('missing history fails instead of guessing a number', async () => {
  await assert.rejects(fixture({ baseline: null, totalRuns: 1 }).resolve(), /history.*deleted/);
  await assert.rejects(fixture({ baseline: 109 }).resolve(), /baseline/);
});

test('finds the official release beyond a full page of prereleases', async () => {
  const betas = Array.from({ length: 100 }, (_, n) => ({ ...release(`1.3.2-beta.${n + 1}`), prerelease: true }));
  assert.equal(await fixture({ releasePages: [betas, [release('1.3.1')]] }).resolve(), '1.4.0-beta.1');
});

test('GitHub API failures stop the build rather than falling back to lifetime numbering', async () => {
  const github = { rest: { actions: { getWorkflowRun: async () => { throw new Error('API unavailable'); } } } };
  await assert.rejects(resolveBetaVersion({ github, context: { repo: {}, runId: 1 } }), /API unavailable/);
});

test('missing official release fails instead of inventing a version', async () => {
  await assert.rejects(fixture({ releases: [] }).resolve(), /official release/);
});
