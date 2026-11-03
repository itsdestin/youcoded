// Same-website guard for link-following downloads (review deck round 3, Q-7). Fake website = injected fetch; no internet.
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
import http from 'node:http';
import { guardDownload, MAX_HOPS } from '../src/main/harness/download-guard';
import { sameSiteDownloadCommand } from '../src/shared/download-host';
import { decidePermission, decideChainParts } from '../src/main/harness/permission-engine';
import { DESTRUCTIVE_DENY_LIST, rulesForMode, type PermissionRule } from '../src/shared/permission-types';

type Hop = { status: number; location?: string };
// A fake website: url -> answer. Records every address asked, so "never fetched the other site" can be proven.
function site(map: Record<string, Hop>) {
  const asked: string[] = [];
  const fetchImpl = async (url: string) => {
    asked.push(url);
    const h = map[url] ?? { status: 200 };
    return { status: h.status, headers: { get: (n: string) => (n.toLowerCase() === 'location' ? h.location ?? null : null) }, body: { cancel: () => {} } };
  };
  return { asked, fetchImpl };
}
const run = (cmd: string, map: Record<string, Hop>, host = 'github.com') => { const s = site(map); return guardDownload(cmd, host, { fetchImpl: s.fetchImpl }).then((r) => ({ r, asked: s.asked })); };

describe('guardDownload', () => {
  it('a redirect to another website stops the download and never asks that website', async () => {
    const { r, asked } = await run('curl -sSL https://github.com/a/b.zip -o b.zip', { 'https://github.com/a/b.zip': { status: 302, location: 'https://objects.githubusercontent.com/x' } });
    expect(r).toEqual({ kind: 'stopped', message: expect.stringContaining('redirected to objects.githubusercontent.com, a different website than the one allowed (github.com). Ask before downloading from objects.githubusercontent.com.') });
    expect(asked).toEqual(['https://github.com/a/b.zip']);
  });
  it('a redirect that stays on the same website continues, then runs with links switched off', async () => {
    const { r } = await run('curl -sSL https://github.com/a -o b.zip', { 'https://github.com/a': { status: 301, location: '/b' }, 'https://github.com/b': { status: 302, location: 'https://github.com/c?x=1' } });
    expect(r).toEqual({ kind: 'run', command: "curl -sS 'https://github.com/c?x=1' -o b.zip" });
  });
  it('relative and protocol-relative locations are resolved before they are judged', async () => {
    const a = await run('curl -L https://github.com/a', { 'https://github.com/a': { status: 302, location: '//evil.example.org/x' } });
    expect(a.r.kind).toBe('stopped');
    expect(a.asked).toEqual(['https://github.com/a']);
    const b = await run('curl -L https://github.com/dir/a', { 'https://github.com/dir/a': { status: 302, location: '../z' } });
    expect(b.r).toEqual({ kind: 'run', command: "curl 'https://github.com/z'" });
  });
  it('https to http on the same website stops', async () => {
    const { r } = await run('curl -L https://github.com/a', { 'https://github.com/a': { status: 302, location: 'http://github.com/a' } });
    expect(r).toMatchObject({ kind: 'stopped', message: expect.stringContaining('secure (https) to a plain (http)') });
  });
  it('http to https on the same website is fine', async () => {
    const { r } = await run('curl -L http://github.com/a', { 'http://github.com/a': { status: 301, location: 'https://github.com/a' } });
    expect(r).toEqual({ kind: 'run', command: "curl 'https://github.com/a'" });
  });
  it.each([
    'https://user:pw@github.com/x', 'https://github.com:8443/x', 'https://github.com@evil.example.org/x', 'https://evil.example.org\\@github.com/x',
    'ftp://github.com/x', 'file:///etc/passwd', 'https://GITHUB.com.evil.example.org/x', 'https://github.com./x',
  ])('an odd or hostile Location stops: %s', async (loc) => {
    const { r, asked } = await run('curl -L https://github.com/a', { 'https://github.com/a': { status: 302, location: loc } });
    expect(r.kind).toBe('stopped');
    expect(asked).toEqual(['https://github.com/a']);
  });
  it('too many hops stops', async () => {
    const map: Record<string, Hop> = {};
    for (let i = 0; i < 30; i++) map[`https://github.com/${i}`] = { status: 302, location: `/${i + 1}` };
    const { r } = await run('curl -L https://github.com/0', map);
    expect(r).toMatchObject({ kind: 'stopped', message: expect.stringContaining(`more than ${MAX_HOPS} times`) });
  });
  it('exactly MAX_HOPS hops is still allowed', async () => {
    const map: Record<string, Hop> = {};
    for (let i = 0; i < MAX_HOPS; i++) map[`https://github.com/${i}`] = { status: 302, location: `/${i + 1}` };
    const { r } = await run('curl -L https://github.com/0', map);
    expect(r.kind).toBe('run');
  });
  it('a command with --location-trusted is never guarded into running', async () => {
    const { r, asked } = await run('curl --location-trusted https://github.com/a', {});
    expect(r.kind).toBe('stopped');
    expect(asked).toEqual([]);
  });
  it('a mismatch between the rule website and the command stops without any request', async () => {
    const { r, asked } = await run('curl -L https://gitlab.com/a', {}, 'github.com');
    expect(r.kind).toBe('stopped');
    expect(asked).toEqual([]);
  });
  it('wget gains --max-redirect=0 and -I uses HEAD', async () => {
    const { r } = await run('wget -q -O out.zip https://github.com/a', { 'https://github.com/a': { status: 302, location: '/b' } });
    expect(r).toEqual({ kind: 'run', command: "wget --max-redirect=0 -q -O out.zip 'https://github.com/b'" });
  });
  it('a network error does not skip the guard: the command still runs with links off', async () => {
    const r = await guardDownload('curl -L https://github.com/a', 'github.com', { fetchImpl: async () => { throw new Error('offline'); } });
    expect(r).toEqual({ kind: 'run', command: "curl 'https://github.com/a'" });
  });
});

describe('the rewritten command can not follow links (real curl, local server)', () => {
  it('curl without -L stops at a redirect instead of fetching the other address', async () => {
    const hits: string[] = [];
    const srv = http.createServer((req, res) => { hits.push(req.url!); if (req.url === '/a') { res.writeHead(302, { Location: '/b' }); res.end(); } else res.end('B'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      // The strict parser refuses IP addresses, so here we only prove curl's own behaviour for the shape the guard emits.
      // WHY async: a sync exec would block the event loop the test server runs on, and curl would wait forever.
      const out = (await execFileP('curl', ['-sS', `http://127.0.0.1:${port}/a`])).stdout;
      expect(out).toBe('');
      expect(hits).toEqual(['/a']);
    } finally { srv.close(); }
  });
});

describe('sameSiteDownloadCommand', () => {
  it.each([
    ['curl -sSL https://github.com/a', "curl -sS 'https://github.com/z'"],
    ['curl -L https://github.com/a', "curl 'https://github.com/z'"],
    ['curl --location -O https://github.com/a', "curl -O 'https://github.com/z'"],
    ['curl -fLs https://github.com/a', "curl -fs 'https://github.com/z'"],
  ])('%s', (c, want) => { expect(sameSiteDownloadCommand(c, 'https://github.com/z')).toBe(want); });
  it('refuses a final address on another website, and commands that do not follow links', () => {
    expect(sameSiteDownloadCommand('curl -L https://github.com/a', 'https://evil.example.org/z')).toBeNull();
    expect(sameSiteDownloadCommand('curl https://github.com/a', 'https://github.com/z')).toBeNull();
  });
});

describe('only a download-host rule asks for the guard', () => {
  const rule: PermissionRule = { tool: 'Bash', pattern: 'curl github.com', action: 'allow', match: 'download-host' };
  const layers = (rem: PermissionRule[], mode: 'ask' | 'full-auto' = 'ask') => ({ presetRules: [], modeRules: rulesForMode(mode), denyList: DESTRUCTIVE_DENY_LIST, rememberedRules: rem });
  it('a link-following download allowed by the rule carries the guard', () => {
    expect(decidePermission('Bash', 'curl -sSL https://github.com/a', layers([rule]))).toEqual({ action: 'allow', denyListed: false, downloadGuard: { host: 'github.com' } });
  });
  it('a download that does not follow links carries none', () => {
    expect(decidePermission('Bash', 'curl -sS https://github.com/a', layers([rule])).downloadGuard).toBeUndefined();
  });
  it('an exact grant for the same command runs as typed (no guard)', () => {
    const exact: PermissionRule = { tool: 'Bash', pattern: 'curl -sSL https://github.com/a', action: 'allow', match: 'exact' };
    const d = decidePermission('Bash', 'curl -sSL https://github.com/a', layers([rule, exact]));
    expect(d.action).toBe('allow');
    expect(d.downloadGuard).toBeUndefined();
  });
  it('without the rule it asks (no guard, no allow)', () => {
    expect(decidePermission('Bash', 'curl -sSL https://github.com/a', layers([]))).toEqual({ action: 'ask', denyListed: false });
  });
  it('PowerShell never matches the rule', () => {
    expect(decidePermission('Bash', 'curl -sSL https://github.com/a', layers([rule]), { powershell: true }).action).toBe('ask');
  });
  it('a joined-up line is never allowed through the rule (the guard cannot wrap one part)', () => {
    expect(decideChainParts([{ text: 'curl -sSL https://github.com/a', context: {} }], layers([rule]))).toBeNull();
    expect(decideChainParts([{ text: 'curl -sS https://github.com/a', context: {} }], layers([rule]))).toMatchObject({ action: 'allow' });
  });
});
