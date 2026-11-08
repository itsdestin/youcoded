import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareAlpine, checkAlpineShipped, checkAlpineNodeLag, checkDesktopNode, checkElectron,
  checkGitForWindows, osvFinding, planIssues,
} from './security-watch.mjs';

const NOW = Date.parse('2026-11-05T00:00:00Z');

test('Alpine version ordering: numbers, release suffix, pre-releases', () => {
  assert.equal(compareAlpine('24.18.1-r0', '24.22.1-r0'), -1);
  assert.equal(compareAlpine('1.2.6-r3', '1.2.6-r2'), 1);
  assert.equal(compareAlpine('20261020-r0', '20260909-r0'), 1);
  assert.equal(compareAlpine('2.4-r0', '2.4_rc1-r0'), 1);
  assert.equal(compareAlpine('8.22.0-r0', '8.22.0-r0'), 0);
});

test('phone rebuild: fixes newer than what shipped are reported once per source package', () => {
  const shipped = [
    { name: 'nodejs', origin: 'nodejs', version: '24.18.1-r0' },
    { name: 'nodejs-libs', origin: 'nodejs', version: '24.18.1-r0' },
    { name: 'bash', origin: 'bash', version: '5.3.9-r1' },
  ];
  const secdb = { packages: [
    { pkg: { name: 'nodejs', secfixes: { '24.17.0-r0': ['CVE-OLD'], '24.22.1-r0': ['CVE-A', 'CVE-B'] } } },
    { pkg: { name: 'bash', secfixes: { '5.0-r0': ['CVE-ANCIENT'] } } },
  ] };
  const [f] = checkAlpineShipped({ release: 'v1.3.3', shipped, secdb, branch: 'v3.24' });
  assert.equal(f.key, 'android-alpine-rebuild');
  assert.equal(f.severity, 'high'); // Node is the backend: any Node fix is urgent
  assert.match(f.title, /2 known flaw/);
  assert.doesNotMatch(f.body, /CVE-OLD|CVE-ANCIENT|nodejs-libs/);
});

test('phone rebuild: nothing newer means no finding', () => {
  const out = checkAlpineShipped({ release: 'v1', shipped: [{ name: 'bash', origin: 'bash', version: '5.3.9-r1' }],
    secdb: { packages: [{ pkg: { name: 'bash', secfixes: { '5.0-r0': ['X'] } } }] }, branch: 'v3.24' });
  assert.deepEqual(out, []);
});

const nodeIndex = [
  { version: 'v24.22.2', date: '2026-10-27', security: false },
  { version: 'v24.22.1', date: '2026-10-20', security: true },
  { version: 'v22.23.4', date: '2026-10-20', security: true },
  { version: 'v22.23.3', date: '2026-10-01', security: false },
];

test("phone Node: flags Alpine lagging behind Node's own security release", () => {
  assert.equal(checkAlpineNodeLag({ alpineNode: '24.18.1-r0', nodeIndex, branch: 'v3.24' })[0].key, 'android-node-waiting-on-alpine');
  assert.deepEqual(checkAlpineNodeLag({ alpineNode: '24.22.1-r1', nodeIndex, branch: 'v3.24' }), []);
});

test('desktop Node pin: newer security release and approaching end of life', () => {
  const eol = [{ cycle: '22', eol: '2026-12-01' }];
  const out = checkDesktopNode({ pinned: 'v22.23.3', nodeIndex, nodeEol: eol, now: NOW });
  assert.deepEqual(out.map((f) => f.key), ['desktop-node-security-release', 'desktop-node-eol']);
  assert.deepEqual(checkDesktopNode({ pinned: 'v22.23.4', nodeIndex, nodeEol: [{ cycle: '22', eol: '2027-04-30' }], now: NOW }), []);
});

test('Electron: newer same-major release notes naming CVEs are a finding; other majors are not', () => {
  const releases = [
    { tag_name: 'v44.10.2', prerelease: false, body: 'Security: backported fix for CVE-2026-90001.' },
    { tag_name: 'v45.0.0', prerelease: false, body: 'CVE-2026-90002' },
    { tag_name: 'v44.9.0', prerelease: false, body: 'CVE-2026-1' },
  ];
  const out = checkElectron({ shipped: '44.10.0', osvVulns: [], releases, electronEol: [], now: NOW });
  assert.equal(out.length, 1);
  assert.match(out[0].body, /CVE-2026-90001/);
  assert.doesNotMatch(out[0].body, /90002|CVE-2026-1\b/);
});

test('Git for Windows: only newer releases mentioning CVEs count', () => {
  const releases = [{ tag_name: 'v2.57.0.windows.1', body: 'fixes CVE-2026-5' }, { tag_name: 'v2.55.0.windows.1', body: 'CVE-2026-4' }];
  assert.match(checkGitForWindows({ pinned: '2.56.0', releases })[0].body, /CVE-2026-5/);
  assert.deepEqual(checkGitForWindows({ pinned: '2.57.0', releases }), []);
});

test('OSV: alias groups count once and the worst severity wins', () => {
  const f = osvFinding('k', 'thing', [
    { id: 'GHSA-1', aliases: ['CVE-1'], database_specific: { severity: 'LOW' } },
    { id: 'GO-1', aliases: ['GHSA-1', 'CVE-1'] },
    { id: 'GHSA-2', database_specific: { severity: 'HIGH' } },
  ], 'bump');
  assert.match(f.title, /2 published/);
  assert.equal(f.severity, 'high');
});

test('issues: create new, update changed, close resolved, leave unchanged alone', () => {
  const findings = [
    { key: 'a', severity: 'high', title: 'A', body: 'new' },
    { key: 'b', severity: 'low', title: 'B', body: 'changed' },
  ];
  const [aBody] = planIssues([findings[0]], []).create.map((c) => c.body);
  const open = [
    { number: 2, title: 'B', body: '<!-- security-watch:b -->\nold' },
    { number: 3, title: 'C', body: '<!-- security-watch:c -->\nx' },
  ];
  const plan = planIssues(findings, open);
  assert.deepEqual(plan.create.map((c) => c.key), ['a']);
  assert.deepEqual(plan.update.map((u) => u.number), [2]);
  assert.deepEqual(plan.close, [3]);
  assert.deepEqual(planIssues([findings[0]], [{ number: 9, title: 'A', body: aBody }]), { create: [], update: [], close: [] });
});
