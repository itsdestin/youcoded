// The Browser's worker (browser-host.ts) driven through the main process's
// BrowserClient over an in-memory message channel — the same messages the real
// utilityProcess carries — against a REAL Chromium-family browser.
// Covers: tool calls + the ask round trip, live pictures, show/hide restarts,
// clearing sign-ins, and My Chrome against a separately started Chrome.
// Skipped (visibly) when no browser is installed.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { discoverBrowsers, defaultDiscoveryEnv } from '../src/main/assistant-browser/browser-discovery';
import { createBrowserHost, type HostPort } from '../src/main/assistant-browser/browser-host';
import { BrowserClient, type WorkerHandle } from '../src/main/assistant-browser/browser-client';
import type { BrowserSessionState } from '../src/shared/browser-types';
import type { MainToWorker, WorkerToMain } from '../src/main/assistant-browser/browser-protocol';

const FOUND = await discoverBrowsers(defaultDiscoveryEnv(null));
const live = FOUND.length ? it : it.skip;
if (!FOUND.length) console.warn('assistant-browser-host: no Chromium-family browser installed — skipped');

let server: http.Server;
let base = '';
let root = '';
let client: BrowserClient;
let host: ReturnType<typeof createBrowserHost>;
const states = new Map<string, BrowserSessionState>();
let frames = 0;

function channel(): { port: HostPort; handle: WorkerHandle } {
  const toWorker: Array<(e: { data: MainToWorker }) => void> = [];
  const toMain: Array<(m: WorkerToMain) => void> = [];
  const exits: Array<(c: number) => void> = [];
  return {
    // structuredClone mimics the process boundary: nothing shared by reference.
    port: { postMessage: (m) => { for (const f of toMain) f(structuredClone(m)); }, on: (_ev, cb) => { toWorker.push(cb); } },
    handle: {
      postMessage: (m) => { setImmediate(() => { for (const f of toWorker) f({ data: structuredClone(m) }); }); },
      on: ((ev: string, cb: any) => { if (ev === 'message') toMain.push(cb); else exits.push(cb); }) as WorkerHandle['on'],
      kill: () => { for (const f of exits) f(0); },
    },
  };
}

/** Answer the next card of `kind` for a conversation, as the person would. */
function answerNext(sessionId: string, kind: string, answer: 'allow_chat' | 'once' | 'no' | 'done') {
  const onState = (s: BrowserSessionState) => {
    if (s.sessionId === sessionId && s.prompt?.kind === kind) {
      client.off('state', onState);
      void client.command({ cmd: 'answer', sessionId, promptId: s.prompt.id, answer });
    }
  };
  client.on('state', onState);
}

beforeAll(async () => {
  if (!FOUND.length) return;
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Page ${req.url}</title><h1>Hello from ${req.url}</h1><a href="/two">two</a>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-browser-host-'));
  const ch = channel();
  host = createBrowserHost(ch.port, root, { forceHeadless: true, discover: async () => FOUND, cliPath: '' });
  client = new BrowserClient({ fork: () => ch.handle });
  client.on('state', (s: BrowserSessionState) => states.set(s.sessionId, s));
  client.on('frame', () => { frames++; });
}, 60_000);

afterAll(async () => {
  await host?.service.dispose();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('Browser worker, through the main process\'s client', () => {
  live('runs a tool, raising the card through state and taking the answer back', async () => {
    answerNext('c1', 'local', 'allow_chat');
    const r = await client.callTool('c1', 'BrowserNavigate', { url: `${base}/one` }, { vision: true });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Hello from /one');
    expect(states.get('c1')).toMatchObject({ run: 'running', used: true, busy: false });
    expect(states.get('c1')?.tabs[0].url).toBe(`${base}/one`);
  }, 60_000);

  live('streams live pictures only while watched, acknowledged one at a time', async () => {
    await client.command({ cmd: 'watch', sessionId: 'c1' });
    await vi.waitFor(() => expect(frames).toBeGreaterThan(0));
    const seen = frames;
    // Without an ack the worker holds the next picture back.
    await client.callTool('c1', 'BrowserNavigate', { url: `${base}/two` }, { vision: true });
    expect(frames - seen).toBeLessThanOrEqual(1);
    await client.command({ cmd: 'ack', sessionId: 'c1' });
    await client.command({ cmd: 'unwatch', sessionId: 'c1' });
    const after = frames;
    await client.callTool('c1', 'BrowserNavigate', { url: `${base}/three` }, { vision: true });
    expect(frames).toBe(after);
  }, 60_000);

  live('showing the window restarts the browser and reopens the conversation\'s pages', async () => {
    await client.command({ cmd: 'set-show-window', show: true });
    const r = await client.callTool('c1', 'BrowserSnapshot', {}, { vision: true });
    expect(r.text).toContain('Hello from /three');
    expect(r.text).toContain('The browser restarted');
    await client.command({ cmd: 'set-show-window', show: false });
  }, 90_000);

  live('clearing sign-ins stops the browser and empties its saved data', async () => {
    const info = await client.command<{ running: boolean }>({ cmd: 'clear-signins' });
    expect(info.running).toBe(false);
    expect(fs.existsSync(path.join(root, 'profile'))).toBe(false);
  }, 60_000);

  live('a conversation that ends closes its tabs, never another\'s', async () => {
    answerNext('c2', 'local', 'allow_chat');
    await client.callTool('c2', 'BrowserNavigate', { url: `${base}/c2` }, { vision: true });
    answerNext('c3', 'local', 'allow_chat');
    await client.callTool('c3', 'BrowserNavigate', { url: `${base}/c3` }, { vision: true });
    await client.command({ cmd: 'close-session', sessionId: 'c2', forget: true });
    expect((await client.command<BrowserSessionState>({ cmd: 'state', sessionId: 'c3' })).tabs).toHaveLength(1);
    expect((await client.command<BrowserSessionState>({ cmd: 'state', sessionId: 'c2' })).tabs).toHaveLength(0);
  }, 60_000);
});

describe('My Chrome (Experimental), against a separately started Chrome', () => {
  let chrome: ChildProcess | null = null;
  let chromeDir = '';

  afterAll(async () => {
    delete process.env.YOUCODED_MY_CHROME_DIR;
    // WHY wait for the exit (CI, 2026-10-15: ENOTEMPTY): a killed Chrome keeps
    // writing into its folder for a moment, so removing it at once raced it.
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise((resolve) => chrome!.once('exit', resolve));
      chrome.kill('SIGKILL');
      await exited;
    }
    if (chromeDir) fs.rmSync(chromeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  live('opens its own tab in the person\'s Chrome after asking, leaves theirs alone, and never closes their browser', async () => {
    // A stand-in for the person's Chrome: its own profile folder with remote
    // debugging on, which writes DevToolsActivePort exactly like the real switch.
    chromeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-my-chrome-'));
    chrome = spawn(FOUND[0].executablePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${chromeDir}`, '--no-first-run', `${base}/theirs`], { stdio: 'ignore' });
    await vi.waitFor(() => expect(fs.existsSync(path.join(chromeDir, 'DevToolsActivePort'))).toBe(true), { timeout: 15_000 });
    process.env.YOUCODED_MY_CHROME_DIR = chromeDir;
    expect(await client.command<{ ok: boolean }>({ cmd: 'check-my-chrome' })).toMatchObject({ ok: true });

    await client.command({ cmd: 'update-settings', patch: { useMyChrome: true } });
    // Every new site asks in My Chrome (it carries the person's sign-ins), and
    // a home address asks too.
    answerNext('m1', 'local', 'allow_chat');
    const r = await client.callTool('m1', 'BrowserNavigate', { url: `${base}/ours` }, { vision: true });
    expect(r.text).toContain('Hello from /ours');
    expect(states.get('m1')).toMatchObject({ myChrome: true, browserLabel: 'My Chrome' });
    // The person's own tab is invisible to the tools.
    const tabs = await client.callTool('m1', 'BrowserTabs', { action: 'list' }, { vision: true });
    expect(tabs.text).not.toContain('/theirs');
    // Stop closes only the assistant's tab and disconnects; their Chrome keeps running.
    await client.command({ cmd: 'stop' });
    expect(chrome.exitCode).toBeNull();
    const pages = await (await fetch(`http://127.0.0.1:${fs.readFileSync(path.join(chromeDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]}/json/list`)).json() as Array<{ url: string }>;
    expect(pages.map((p) => p.url)).toContain(`${base}/theirs`);
    expect(pages.map((p) => p.url)).not.toContain(`${base}/ours`);
    await client.command({ cmd: 'update-settings', patch: { useMyChrome: false } });
  }, 90_000);

  live('says plainly when Chrome is not reachable, and never falls back silently', async () => {
    process.env.YOUCODED_MY_CHROME_DIR = path.join(os.tmpdir(), 'yc-no-such-chrome');
    await client.command({ cmd: 'update-settings', patch: { useMyChrome: true } });
    answerNext('m2', 'site', 'allow_chat');
    const r = await client.callTool('m2', 'BrowserNavigate', { url: 'https://example.com' }, { vision: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Chrome isn't open, or its remote-debugging switch is off/);
    // No silent fallback to the assistant's own browser.
    expect(states.get('m2')).toMatchObject({ run: 'error', tabs: [] });
    expect(host.service.isRunning()).toBe(false);
    const check = await client.command<{ ok: boolean; message: string }>({ cmd: 'check-my-chrome' });
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/chrome:\/\/inspect\/#remote-debugging/);
    await client.command({ cmd: 'update-settings', patch: { useMyChrome: false } });
  }, 60_000);
});
