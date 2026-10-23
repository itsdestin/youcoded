const stableVersion = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Resolve one workflow's beta identity without changing releases or repository state. */
export async function resolveBetaVersion({ github, context, base = '' }) {
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: context.runId });
  // WHY: use the ORIGINAL run creation time, not now. Retrying an old build after
  // another release must reproduce its original version (and signing manifest).
  let latest;
  const official = [];
  for (let page = 1; ; page++) {
    const { data: releases } = await github.rest.repos.listReleases({ ...context.repo, per_page: 100, page });
    for (const release of releases) {
      const match = stableVersion.exec(release.tag_name);
      if (!match || release.draft || release.prerelease || !release.published_at || release.published_at > run.created_at) continue;
      const version = match.slice(1).map(Number);
      official.push({ ...release, version });
      if (!latest || compare(version, latest.version) > 0) latest = { ...release, version };
    }
    if (releases.length < 100) break;
  }
  if (!latest) throw new Error('No published official release exists before this build.');
  // WHY next MINOR, not next patch (Destin, 2026-10-22): patch numbers now belong to
  // bug-fix releases cut from a release/X.Y.x lane (1.3.2 → 1.3.3), while betas are
  // built from master and lead to the next feature release (1.4.0). A beta numbered
  // 1.3.3-beta.N would be "updated" to the 1.3.3 fix and silently lose its features.
  const next = [latest.version[0], latest.version[1] + 1, 0];
  const nextPrefix = `${next.join('.')}-beta`;
  const prefix = base.trim() || nextPrefix;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta$/.exec(prefix);
  if (!match) throw new Error('Beta prefix must be X.Y.Z-beta (without a build number).');
  if (compare(match.slice(1).map(Number), latest.version) <= 0) {
    throw new Error(`Beta prefix must sort above official release ${latest.version.join('.')}.`);
  }
  // WHY: reusing a future prefix after another official release would reset its
  // number and stamp two different builds with the same version. One release
  // cycle owns exactly one next-minor prefix, even for explicit input.
  if (prefix !== nextPrefix) throw new Error(`Use the next feature-release beta prefix ${nextPrefix}, or leave base blank.`);

  // WHY count from the FIRST release of the latest line (X.Y.0, or its earliest if
  // X.Y.0 was never published), not the latest release: a bug-fix release (1.3.3)
  // does not change the prefix (still 1.4.0-beta), so resetting the counter there
  // would build a second, different 1.4.0-beta.1. Only a new feature line resets it.
  const lineStart = official
    .filter((r) => r.version[0] === latest.version[0] && r.version[1] === latest.version[1])
    .reduce((a, b) => (b.published_at < a.published_at ? b : a));

  // WHY: GitHub cannot reset run_number. Subtract the last run before the
  // official release instead. Failed/cancelled attempts still reserve a number,
  // concurrent builds stay distinct, and reruns keep the same number. Do NOT
  // reset Android versionCode: that separate install counter must stay monotonic.
  const { data: history } = await github.rest.actions.listWorkflowRuns({
    ...context.repo, workflow_id: run.workflow_id, created: `<${lineStart.published_at}`, per_page: 1,
  });
  // WHY: deleting a boundary run shifts the baseline, so a rerun OR a queued
  // first attempt could take a version already resolved by a later run. Require
  // intact workflow history for EVERY resolution, never guess. Check after
  // reading the baseline so deletion between requests cannot silently change
  // the baseline we use. Artifact/log expiry is fine; do not delete run records.
  const { data: allRuns } = await github.rest.actions.listWorkflowRuns({
    ...context.repo, workflow_id: run.workflow_id, per_page: 1,
  });
  if (allRuns.total_count !== allRuns.workflow_runs[0]?.run_number) {
    throw new Error('Cannot safely number this beta: workflow history has been deleted.');
  }
  // WHY: a workflow created after the release legitimately has no preceding run.
  const baseline = history.workflow_runs[0]?.run_number ?? 0;
  const number = run.run_number - baseline;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid beta run baseline.');
  return `${prefix}.${number}`;
}
