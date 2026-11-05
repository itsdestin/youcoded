#!/usr/bin/env node
// Daily "is anything YouCoded ships known to be vulnerable?" check.
//
// WHY this exists: GitHub's Dependabot only sees packages listed in package-lock.json / Gradle
// files. It is blind to the big pieces YouCoded bundles some other way:
//   - the phone app's Alpine Linux programs (Node.js, git, bash, musl...), picked at build time
//   - Electron's built-in Chrome (its security fixes ship as Electron patch releases, rarely as CVEs)
//   - the Node.js, GitHub CLI and Git for Windows versions the desktop installer downloads
//   - the Claude Code version the phone app bundles
// Each check below compares what we SHIP against a public security source and returns findings.
// main() turns findings into GitHub issues labelled `security-watch` (one per problem, updated in
// place, closed automatically once the problem is gone) and pings Destin's phone for High/Critical.
//
// Every check is independent: a source being down produces a "check could not run" finding rather
// than silently passing, because a watcher that quietly stops watching is worse than none.

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LABEL = 'security-watch';
const DAY = 86_400_000;

// ---------- version helpers ----------

// Alpine versions look like 24.18.1-r0, 20260909-r0, 1.2.6-r2, 2.4_rc1-r0. This is an approximate
// comparator (numbers compared numerically, the -rN release last). Good enough to say "newer";
// WHY not exact apk semantics: an occasional wrong order only causes a spurious or missed
// "rebuild" note that the issue text tells a human to double-check, never a silent ship.
export function compareAlpine(a, b) {
  const split = (v) => {
    const [main, rel = 'r0'] = v.split('-r').length > 1 ? [v.slice(0, v.lastIndexOf('-r')), v.slice(v.lastIndexOf('-r') + 2)] : [v];
    return { parts: main.split(/[._]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p)), rel: Number(rel) || 0 };
  };
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const p = x.parts[i], q = y.parts[i];
    if (p === undefined) return typeof q === 'string' ? 1 : -1; // 2.4 > 2.4_rc1, 2.4 < 2.4.1
    if (q === undefined) return typeof p === 'string' ? -1 : 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    return String(p) < String(q) ? -1 : 1;
  }
  return x.rel === y.rel ? 0 : x.rel < y.rel ? -1 : 1;
}

export function compareSemver(a, b) {
  const pa = a.replace(/^v/, '').split(/[.-]/).map(Number), pb = b.replace(/^v/, '').split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
}

const major = (v) => v.replace(/^v/, '').split('.')[0];

// ---------- the checks (pure: data in, findings out) ----------
// A finding: { key, severity: 'critical'|'high'|'medium'|'low', title, body }

// Phone app: every Alpine package the last release shipped vs Alpine's security database.
// secdb lists, per package, which version fixed which CVEs. A fix in a version NEWER than what we
// shipped means the phone app needs a rebuild to pick it up.
export function checkAlpineShipped({ release, shipped, secdb, branch }) {
  const fixesByPkg = new Map(secdb.packages.map((p) => [p.pkg.name, p.pkg.secfixes || {}]));
  const pending = [];
  for (const pkg of shipped) {
    const secfixes = fixesByPkg.get(pkg.origin) || fixesByPkg.get(pkg.name);
    if (!secfixes) continue;
    const cves = Object.entries(secfixes)
      .filter(([ver]) => /^\d/.test(ver) && compareAlpine(ver, pkg.version) > 0)
      .flatMap(([ver, ids]) => ids.map((id) => `${id} (fixed in ${ver})`));
    if (cves.length) pending.push({ pkg, cves });
  }
  // WHY group by origin: Alpine splits one source into several packages (nodejs, nodejs-libs,
  // nodejs-dev) that share one set of fixes; listing each would triple-count the same flaws.
  const byOrigin = new Map();
  for (const p of pending) {
    const o = p.pkg.origin || p.pkg.name;
    if (!byOrigin.has(o)) byOrigin.set(o, { pkg: { ...p.pkg, name: o }, cves: p.cves });
  }
  const unique = [...byOrigin.values()];
  if (!unique.length) return [];
  const total = new Set(unique.flatMap((p) => p.cves.map((c) => c.split(' ')[0]))).size;
  return [{
    key: 'android-alpine-rebuild',
    severity: unique.some((p) => p.pkg.name === 'nodejs') || total >= 5 ? 'high' : 'medium',
    title: `Phone app needs a rebuild: Alpine fixed ${total} known flaw(s) in its bundled programs`,
    body: [
      `The phone app's last release (${release}) bundles Alpine ${branch} programs. Alpine has since published fixed versions.`,
      `**What to do:** rebuild and release the Android app. The build picks up Alpine's newest versions automatically; no code change is needed unless a test fails.`,
      '',
      ...unique.map(({ pkg, cves }) => `- **${pkg.name}** ${pkg.version} → ${cves.length} fix(es): ${cves.slice(0, 12).join(', ')}${cves.length > 12 ? ', …' : ''}`),
      '',
      '_Version ordering is approximate; double-check a surprising entry against https://security.alpinelinux.org._',
    ].join('\n'),
  }];
}

// Phone app's Node.js: Alpine sometimes lags behind Node's own security releases. If Alpine's newest
// nodejs is still older than Node's newest SECURITY release of that line, a rebuild cannot help yet.
export function checkAlpineNodeLag({ alpineNode, nodeIndex, branch }) {
  const ver = alpineNode.split('-r')[0];
  const line = nodeIndex.filter((r) => major(r.version) === major(ver) && r.security);
  const newestSec = line.sort((a, b) => compareSemver(b.version, a.version))[0];
  if (!newestSec || compareSemver(ver, newestSec.version) >= 0) return [];
  return [{
    key: 'android-node-waiting-on-alpine',
    severity: 'high',
    title: `Phone app's Node.js: Alpine has not yet shipped Node's ${newestSec.version} security release`,
    body: `Alpine ${branch} offers nodejs ${alpineNode}; Node published security release ${newestSec.version} on ${newestSec.date}.\n\n**Nothing to rebuild yet.** This issue closes itself once Alpine catches up; then the "Phone app needs a rebuild" issue opens. If it stays open for weeks, consider getting Node for the phone from elsewhere.`,
  }];
}

// Desktop installer's pinned Node.js: has Node published a newer SECURITY release of the same line,
// or is the line near end of life?
export function checkDesktopNode({ pinned, nodeIndex, nodeEol, now }) {
  const out = [];
  const newer = nodeIndex.filter((r) => major(r.version) === major(pinned) && r.security && compareSemver(r.version, pinned) > 0);
  if (newer.length) {
    const newest = newer.sort((a, b) => compareSemver(b.version, a.version))[0];
    out.push({
      key: 'desktop-node-security-release',
      severity: 'high',
      title: `Desktop installer's Node.js ${pinned} is behind security release ${newest.version}`,
      body: `New installs download Node ${pinned} (\`desktop/src/main/prerequisite-installer.ts\`, NODE_VERSION). Node published security release(s): ${newer.map((r) => `${r.version} (${r.date})`).join(', ')}.\n\n**What to do:** bump NODE_VERSION and its SHA-256 values from https://nodejs.org/dist/${newest.version}/SHASUMS256.txt.`,
    });
  }
  out.push(...eolFinding('desktop-node-eol', `Node.js ${major(pinned)} (desktop installer)`, nodeEol, major(pinned), now));
  return out;
}

// Electron: Chrome security fixes arrive as Electron patch releases whose notes say
// "Security: backported fix for CVE-…". Also flag OSV advisories and an approaching end of support.
export function checkElectron({ shipped, osvVulns, releases, electronEol, now }) {
  const out = [];
  if (osvVulns.length) out.push(osvFinding('electron-advisory', `Electron ${shipped}`, osvVulns, 'Bump electron in desktop/package.json.'));
  const newerWithCves = releases
    .filter((r) => !r.prerelease && major(r.tag_name) === major(shipped) && compareSemver(r.tag_name, shipped) > 0)
    .map((r) => ({ tag: r.tag_name, cves: [...new Set((r.body || '').match(/CVE-\d{4}-\d+/g) || [])] }))
    .filter((r) => r.cves.length);
  if (newerWithCves.length) {
    out.push({
      key: 'electron-chromium-fixes',
      severity: 'high',
      title: `Electron ${shipped} is missing Chrome security fixes from newer ${major(shipped)}.x releases`,
      body: `The desktop app ships Electron ${shipped}. Newer releases in the same line carry security fixes:\n\n${newerWithCves.map((r) => `- ${r.tag}: ${r.cves.join(', ')}`).join('\n')}\n\n**What to do:** merge Dependabot's Electron bump (or bump \`electron\` in desktop/package.json), then release.`,
    });
  }
  out.push(...eolFinding('electron-eol', `Electron ${major(shipped)}`, electronEol, major(shipped), now));
  return out;
}

// Git for Windows (desktop installer pin): newer release notes that mention CVEs.
export function checkGitForWindows({ pinned, releases }) {
  const newer = releases
    .filter((r) => !r.prerelease && compareSemver(r.tag_name.replace(/\.windows\..*/, ''), pinned) > 0)
    .map((r) => ({ tag: r.tag_name, cves: [...new Set((r.body || '').match(/CVE-\d{4}-\d+/g) || [])] }))
    .filter((r) => r.cves.length);
  if (!newer.length) return [];
  return [{
    key: 'desktop-git-for-windows',
    severity: 'high',
    title: `Desktop installer's Git for Windows ${pinned} is behind security fixes`,
    body: `New Windows installs download Git for Windows ${pinned} (PORTABLE_GIT in prerequisite-installer.ts). Newer releases fix:\n\n${newer.map((r) => `- ${r.tag}: ${r.cves.join(', ')}`).join('\n')}\n\n**What to do:** bump PORTABLE_GIT (version, tag, both SHA-256s from the same release).`,
  }];
}

// A package checked against OSV (Google's open vulnerability database), e.g. Claude Code, gh.
export function osvFinding(key, what, allVulns, fix) {
  // WHY: OSV returns one flaw under several IDs (a GHSA and a GO-/npm id that alias each other).
  // Keep the first of each alias group so "3 advisories" is not reported as 6.
  const seen = new Set();
  const vulns = allVulns.filter((v) => {
    const ids = [v.id, ...(v.aliases || [])];
    if (ids.some((id) => seen.has(id))) return false;
    ids.forEach((id) => seen.add(id));
    return true;
  });
  const sev = vulns.map(severityOf).sort((a, b) => RANK[b] - RANK[a])[0] || 'medium';
  return {
    key, severity: sev,
    title: `${what} has ${vulns.length} published security advisor${vulns.length === 1 ? 'y' : 'ies'}`,
    body: `${vulns.map((v) => `- **${v.id}** (${severityOf(v)}): ${v.summary || '(no summary)'}`).join('\n')}\n\n**What to do:** ${fix}`,
  };
}

const RANK = { low: 0, medium: 1, high: 2, critical: 3 };
export function severityOf(vuln) {
  const s = String(vuln.database_specific?.severity || '').toLowerCase();
  if (s in RANK) return s;
  if (s === 'moderate') return 'medium';
  return 'medium'; // WHY: unknown severity is treated as worth a look, not ignored
}

function eolFinding(key, what, eolCycles, cycle, now) {
  const row = eolCycles.find((r) => String(r.cycle) === String(cycle));
  if (!row || typeof row.eol !== 'string') return [];
  const days = Math.floor((Date.parse(row.eol) - now) / DAY);
  if (days > 45) return [];
  return [{
    key, severity: days <= 0 ? 'high' : 'medium',
    title: days <= 0 ? `${what} no longer gets security fixes (ended ${row.eol})` : `${what} stops getting security fixes in ${days} days (${row.eol})`,
    body: `After ${row.eol}, newly found holes in ${what} will not be fixed. **What to do:** plan the move to a supported version.`,
  }];
}

// ---------- gathering (network) ----------

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function osv(name, ecosystem, version) {
  const j = await getJson('https://api.osv.dev/v1/query', { method: 'POST', body: JSON.stringify({ package: { name, ecosystem }, version }) });
  return j.vulns || [];
}

function gh(path) {
  return getJson(`https://api.github.com/${path}`, { headers: { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
}

// The phone app lists every bundled Alpine package in assets/legal/runtime-components.json.
// Read it from the newest release's APK (≈190 MB; a few seconds on a GitHub runner).
function shippedAndroidPackages(repo) {
  const dir = mkdtempSync(join(tmpdir(), 'secwatch-'));
  try {
    const tag = execFileSync('gh', ['release', 'view', '-R', repo, '--json', 'tagName', '-q', '.tagName'], { encoding: 'utf8' }).trim();
    execFileSync('gh', ['release', 'download', tag, '-R', repo, '-p', '*.apk', '-D', dir], { stdio: 'ignore' });
    const apk = execFileSync('sh', ['-c', `ls "${dir}"/*.apk | head -1`], { encoding: 'utf8' }).trim();
    const json = execFileSync('unzip', ['-p', apk, 'assets/legal/runtime-components.json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
    return { release: tag, packages: JSON.parse(json).packages };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function alpineIndexVersion(branch, name) {
  const idx = execFileSync('sh', ['-c', `curl -fsSL https://dl-cdn.alpinelinux.org/alpine/${branch}/main/aarch64/APKINDEX.tar.gz | tar xzO APKINDEX`], { encoding: 'utf8', maxBuffer: 256 << 20 });
  const block = idx.split('\n\n').find((b) => b.split('\n').includes(`P:${name}`));
  return block?.split('\n').find((l) => l.startsWith('V:'))?.slice(2);
}

async function readPins(root) {
  const pins = Object.fromEntries((await readFile(join(root, 'app/runtime/pins.env'), 'utf8'))
    .split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
  const prereq = await readFile(join(root, 'desktop/src/main/prerequisite-installer.ts'), 'utf8');
  const lock = JSON.parse(await readFile(join(root, 'desktop/package-lock.json'), 'utf8'));
  return {
    alpineBranch: pins.ALPINE_BRANCH,
    claudeCode: pins.CLAUDE_CODE_VERSION,
    desktopNode: prereq.match(/const NODE_VERSION = '([^']+)'/)?.[1],
    gh: prereq.match(/const GH_VERSION = '([^']+)'/)?.[1],
    portableGit: prereq.match(/PORTABLE_GIT = \{\s*version: '([^']+)'/)?.[1],
    electron: lock.packages['node_modules/electron'].version,
  };
}

export async function gather(root, repo, now = Date.now()) {
  const pins = await readPins(root);
  const findings = [];
  // WHY each check is wrapped: one flaky source must not hide the others, and must itself be seen.
  const run = async (name, fn) => {
    try { findings.push(...(await fn())); } catch (err) {
      findings.push({ key: `check-failed-${name}`, severity: 'low', title: `Security watch: the "${name}" check could not run`, body: `Error: \`${String(err.message || err).slice(0, 500)}\`\n\nUntil this is fixed, problems in this area go unnoticed. It closes itself when the check runs again.` });
    }
  };
  let nodeIndex, nodeEol;
  await run('node-sources', async () => {
    nodeIndex = await getJson('https://nodejs.org/dist/index.json');
    nodeEol = await getJson('https://endoflife.date/api/nodejs.json');
    return [];
  });
  await run('android-alpine', async () => {
    const { release, packages } = shippedAndroidPackages(repo);
    const secdb = await getJson(`https://secdb.alpinelinux.org/${pins.alpineBranch}/main.json`);
    const community = await getJson(`https://secdb.alpinelinux.org/${pins.alpineBranch}/community.json`).catch(() => ({ packages: [] }));
    return checkAlpineShipped({ release, shipped: packages, secdb: { packages: [...secdb.packages, ...community.packages] }, branch: pins.alpineBranch });
  });
  if (nodeIndex) {
    await run('android-node', async () => checkAlpineNodeLag({ alpineNode: alpineIndexVersion(pins.alpineBranch, 'nodejs'), nodeIndex, branch: pins.alpineBranch }));
    await run('desktop-node', async () => checkDesktopNode({ pinned: pins.desktopNode, nodeIndex, nodeEol, now }));
  }
  await run('electron', async () => checkElectron({
    shipped: pins.electron,
    osvVulns: await osv('electron', 'npm', pins.electron),
    releases: await gh('repos/electron/electron/releases?per_page=60'),
    electronEol: await getJson('https://endoflife.date/api/electron.json'),
    now,
  }));
  await run('claude-code', async () => {
    const v = await osv('@anthropic-ai/claude-code', 'npm', pins.claudeCode);
    return v.length ? [osvFinding('android-claude-code', `Claude Code ${pins.claudeCode} (bundled in the phone app)`, v, 'Bump CLAUDE_CODE_VERSION in app/runtime/pins.env, test on a phone, release.')] : [];
  });
  await run('gh-cli', async () => {
    const v = await osv('github.com/cli/cli/v2', 'Go', `v${pins.gh}`);
    return v.length ? [osvFinding('desktop-gh-cli', `GitHub CLI ${pins.gh} (desktop installer)`, v, 'Bump GH_VERSION and its checksums in prerequisite-installer.ts.')] : [];
  });
  await run('git-for-windows', async () => checkGitForWindows({ pinned: pins.portableGit, releases: await gh('repos/git-for-windows/git/releases?per_page=30') }));
  return findings;
}

// ---------- reporting (GitHub issues + phone ping) ----------

const marker = (key) => `<!-- security-watch:${key} -->`;

export function planIssues(findings, openIssues) {
  const byKey = new Map(openIssues.map((i) => [i.body?.match(/<!-- security-watch:([\w-]+) -->/)?.[1], i]));
  const plan = { create: [], update: [], close: [] };
  for (const f of findings) {
    const body = `${marker(f.key)}\n**Severity:** ${f.severity}\n\n${f.body}\n\n---\n_Opened and kept up to date by the daily security watch (scripts/security-watch.mjs). It closes itself once the problem is gone._`;
    const existing = byKey.get(f.key);
    if (!existing) plan.create.push({ ...f, body });
    else if (existing.body !== body || existing.title !== f.title) plan.update.push({ number: existing.number, ...f, body });
  }
  const live = new Set(findings.map((f) => f.key));
  for (const [key, issue] of byKey) if (key && !live.has(key)) plan.close.push(issue.number);
  return plan;
}

async function ghWrite(method, path, body) {
  const res = await fetch(`https://api.github.com/${path}`, { method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function notifyPhone(newUrgent, repo) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic || !newUrgent.length) return;
  // WHY vague text: anyone who learns the topic name can read it, so no details of the hole go here.
  await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers: { Title: 'YouCoded security alert', Priority: 'high', Tags: 'warning', Click: `https://github.com/${repo}/issues?q=is%3Aopen+label%3A${LABEL}` },
    body: `${newUrgent.length} new urgent security item(s). Tap to open GitHub.`,
  });
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY || 'itsdestin/youcoded';
  const root = process.env.REPO_ROOT || process.cwd();
  const dryRun = process.argv.includes('--dry-run');
  const findings = await gather(root, repo);
  for (const f of findings) console.log(`[${f.severity}] ${f.title}`);
  if (!findings.length) console.log('No known problems in what YouCoded bundles.');
  if (dryRun) return;
  const open = await gh(`repos/${repo}/issues?state=open&labels=${LABEL}&per_page=100`);
  const plan = planIssues(findings, open);
  for (const f of plan.create) await ghWrite('POST', `repos/${repo}/issues`, { title: f.title, body: f.body, labels: [LABEL, `severity:${f.severity}`] });
  for (const f of plan.update) await ghWrite('PATCH', `repos/${repo}/issues/${f.number}`, { title: f.title, body: f.body, labels: [LABEL, `severity:${f.severity}`] });
  for (const n of plan.close) {
    await ghWrite('POST', `repos/${repo}/issues/${n}/comments`, { body: 'The daily security watch no longer finds this problem. Closing.' });
    await ghWrite('PATCH', `repos/${repo}/issues/${n}`, { state: 'closed', state_reason: 'completed' });
  }
  await notifyPhone(plan.create.filter((f) => f.severity === 'high' || f.severity === 'critical'), repo);
  console.log(`issues: ${plan.create.length} opened, ${plan.update.length} updated, ${plan.close.length} closed`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
