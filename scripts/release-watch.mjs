#!/usr/bin/env node
// Release tamper alarm (security apparatus layer 3, 2026-11). Runs hourly from
// .github/workflows/release-watch.yml.
//
// WHY: the worst attack on YouCoded is a stolen GitHub login or token used to publish a
// poisoned installer or update. Every real release is created and uploaded by the release
// workflow (author/uploader "github-actions[bot]"), so anything else in the release list is
// either Destin uploading by hand or an intruder. Either way he should hear about it within the
// hour, so the alert says "if this wasn't you, check now". It also catches a file swapped in an
// already-published release (an asset changed long after its release went out).
//
// Looks only at the last LOOKBACK hours (overlapping the hourly run, so nothing falls between
// runs). An event can therefore alert twice; that is better than once too few.
//
// Alerts carry no names or numbers (the ntfy channel is readable by whoever knows its name);
// the details go to the run log, which only the repo's owners can read.

const BOT = 'github-actions[bot]';
const LOOKBACK_HOURS = 2;
// An asset re-uploaded this long after its release was published counts as a swap.
const SWAP_GRACE_HOURS = 6;

const HOUR = 3600_000;

export function findTampering(releases, now = Date.now()) {
  const since = now - LOOKBACK_HOURS * HOUR;
  const recent = (iso) => iso && Date.parse(iso) >= since;
  const out = [];
  for (const r of releases) {
    if (r.draft) continue; // drafts are invisible to users and the updater
    const tag = r.tag_name;
    if (r.author?.login !== BOT && (recent(r.created_at) || recent(r.published_at))) {
      out.push({ kind: 'release-by-person', detail: `${tag} was published by ${r.author?.login ?? 'unknown'}, not the release workflow` });
    }
    const published = Date.parse(r.published_at ?? r.created_at);
    for (const a of r.assets ?? []) {
      if (a.uploader?.login !== BOT && (recent(a.created_at) || recent(a.updated_at))) {
        out.push({ kind: 'asset-by-person', detail: `${tag}/${a.name} was uploaded by ${a.uploader?.login ?? 'unknown'}` });
      }
      const changed = Date.parse(a.updated_at ?? a.created_at);
      if (recent(a.updated_at) && changed - published > SWAP_GRACE_HOURS * HOUR) {
        out.push({ kind: 'asset-swapped', detail: `${tag}/${a.name} changed ${Math.round((changed - published) / HOUR)}h after the release was published` });
      }
    }
  }
  return out;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? 'itsdestin/youcoded';
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  // WHY fail loudly: a check that cannot read the releases must not look like a quiet hour.
  if (!res.ok) throw new Error(`could not list releases: HTTP ${res.status}`);
  const findings = findTampering(await res.json());
  for (const f of findings) console.log(`::warning::${f.kind}: ${f.detail}`);
  if (!findings.length) { console.log('No unexpected release changes in the last hours.'); return; }
  const topic = process.env.NTFY_TOPIC;
  if (!topic) { console.log('NTFY_TOPIC not set; findings are only in this log.'); return; }
  const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: { Title: 'YouCoded security', Priority: 'urgent', Tags: 'rotating_light' },
    body: "A YouCoded app release changed outside the normal release process. If this wasn't you, check now.",
  });
  if (!r.ok) throw new Error(`ntfy answered ${r.status}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
