// Same-website guard for link-following downloads (review deck round 3, Q-7). Fake website = injected fetch; no internet.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
import http from 'node:http';
import { guardDownload, MAX_HOPS } from '../src/main/harness/download-guard';
import { sameSiteDownloadCommand } from '../src/shared/download-host';
import { decidePermission, decideChainParts } from '../src/main/harness/permission-engine';
import { DESTRUCTIVE_DENY_LIST, rulesForMode, type NativePermissionMode, type PermissionRule } from '../src/shared/permission-types';
import { HarnessSession } from '../src/main/harness/harness-session';
import { textChunks, toolCallChunk, finishChunk, stream, scriptedModel } from './helpers/scripted-model';
import { makeOpts, fakeTool } from './helpers/harness-fakes';
import type { AskDecision } from '../src/main/harness/permission-broker';

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

// The guard wired into the REAL session loop: a link-following download allowed by a "downloads from <site> only"
// rule (saved earlier, or by this very answer) is walked first and runs rewritten; every other approval runs as typed.
const GITHUB_RULE: PermissionRule = { tool: 'Bash', pattern: 'curl github.com', action: 'allow', match: 'download-host' };

/** A fake website: each address answers with a redirect to the next one, or 200. Records what was requested. */
function fakeWeb(redirects: Record<string, string>) {
  const requested: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    requested.push(url);
    const to = redirects[url];
    return { status: to ? 302 : 200, headers: { get: (h: string) => (h.toLowerCase() === 'location' ? to ?? null : null) }, body: null };
  });
  vi.stubGlobal('fetch', fetchImpl);
  return { requested };
}


async function runInSession(command: string, opts: { mode?: NativePermissionMode; remembered?: PermissionRule[]; answer?: AskDecision } = {}) {
  const bash = fakeTool('Bash', { schema: z.object({ command: z.string() }), permissionSubject: (a: any) => a.command });
  const rules = [...(opts.remembered ?? [])];
  const decide = async (name: string, subject: string | undefined) => decidePermission(name, subject, {
    presetRules: [], modeRules: rulesForMode(opts.mode ?? 'ask'), denyList: DESTRUCTIVE_DENY_LIST, rememberedRules: rules,
  });
  const askUser = vi.fn(async (): Promise<AskDecision> => opts.answer ?? { behavior: 'allow' });
  const model = scriptedModel([
    stream(toolCallChunk('c0', 'Bash', { command }), finishChunk('tool-calls')),
    stream(...textChunks('b', 'ok'), finishChunk('stop')),
  ]);
  const session = new HarnessSession(makeOpts({ tools: [bash], decide, askUser }), async () => model as any);
  const saved: PermissionRule[] = [];
  session.on('remember-rule', (r: PermissionRule) => { saved.push(r); rules.push(r); });
  await session.send('go');
  return { ran: (bash as any).calls.map((a: any) => a.command) as string[], asked: askUser.mock.calls.length, saved };
}

describe('the session runs remembered one-website downloads through the same-website guard', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('a saved rule + same-website links: walked first, then run with link-following off at the final address', async () => {
    const web = fakeWeb({ 'https://github.com/a/b/x.zip': 'https://github.com/a/b/final.zip' });
    const r = await runInSession('curl -sL -o x.zip https://github.com/a/b/x.zip', { remembered: [GITHUB_RULE] });
    expect(r.asked).toBe(0);
    expect(web.requested).toEqual(['https://github.com/a/b/x.zip', 'https://github.com/a/b/final.zip']);
    expect(r.ran).toEqual(["curl -s -o x.zip 'https://github.com/a/b/final.zip'"]);
  });

  it('a link to another website stops the download: the command never runs and the other site is never asked', async () => {
    const web = fakeWeb({ 'https://github.com/a/b/x.zip': 'https://objects.githubusercontent.com/blob' });
    const r = await runInSession('curl -sL -o x.zip https://github.com/a/b/x.zip', { remembered: [GITHUB_RULE] });
    expect(r.ran).toEqual([]);
    expect(web.requested).toEqual(['https://github.com/a/b/x.zip']);
  });

  it('choosing "this website only" on the card guards the very first run too', async () => {
    const web = fakeWeb({ 'https://github.com/x': 'https://evil.example.org/x' });
    const r = await runInSession('curl -L -o x https://github.com/x', { answer: { behavior: 'allow', always: true, grantScope: 'wide' } as AskDecision });
    expect(r.saved).toEqual([GITHUB_RULE]);
    expect(web.requested).toEqual(['https://github.com/x']);
    expect(r.ran).toEqual([]);
  });

  it('a plain Yes runs the command exactly as typed, with no walk', async () => {
    const web = fakeWeb({});
    const r = await runInSession('curl -L -o x https://github.com/x');
    expect(r.asked).toBe(1);
    expect(web.requested).toEqual([]);
    expect(r.ran).toEqual(['curl -L -o x https://github.com/x']);
  });

  it('a download that does not follow links runs as typed under the rule, with no walk', async () => {
    const web = fakeWeb({});
    const r = await runInSession('curl -o x https://github.com/x', { remembered: [GITHUB_RULE] });
    expect(r.asked).toBe(0);
    expect(web.requested).toEqual([]);
    expect(r.ran).toEqual(['curl -o x https://github.com/x']);
  });

  it('Full auto runs a link-following download as typed (the guard belongs to the one-website rule only)', async () => {
    const web = fakeWeb({});
    const r = await runInSession('curl -L -o x https://github.com/x', { mode: 'full-auto' });
    expect(web.requested).toEqual([]);
    expect(r.ran).toEqual(['curl -L -o x https://github.com/x']);
  });
});
