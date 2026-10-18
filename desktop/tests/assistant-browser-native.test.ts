// A NATIVE session using the Browser end to end: the real turn driver, the real
// permission rules for the strictest mode ("ask"), the real Browser worker over
// the main process's client, and a real browser — only the model is scripted.
// Proves the Browser tools attach to a native session, never go through the
// session's own permission prompt, ask through the Browser's card instead, and
// hand a screenshot back to the model as a picture.
// Skipped (visibly) when no browser is installed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HarnessSession } from '../src/main/harness/harness-session';
import { decidePermission } from '../src/main/harness/permission-engine';
import { rulesForMode } from '../src/shared/permission-types';
import { discoverBrowsers, defaultDiscoveryEnv } from '../src/main/assistant-browser/browser-discovery';
import { createBrowserHost, type HostPort } from '../src/main/assistant-browser/browser-host';
import { BrowserClient, type WorkerHandle } from '../src/main/assistant-browser/browser-client';
import type { BrowserSessionState } from '../src/shared/browser-types';
import type { TranscriptEvent } from '../src/shared/types';
import type { MainToWorker, WorkerToMain } from '../src/main/assistant-browser/browser-protocol';
import { makeOpts, scriptModel } from './helpers/harness-fakes';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import { browserDiagnostics } from './helpers/assistant-browser-diagnostics';

const diagnostics = browserDiagnostics('assistant-browser-native');

const FOUND = await discoverBrowsers(defaultDiscoveryEnv(null));
const live = FOUND.length ? it : it.skip;

let server: http.Server;
let base = '';
let root = '';
let client: BrowserClient;
let host: ReturnType<typeof createBrowserHost>;
const cards: string[] = [];

beforeAll(async () => {
  if (!FOUND.length) return;
  await diagnostics.start(FOUND);
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url?.startsWith('/results')
      ? '<!doctype html><title>Results</title><p>Secret code: Wombat-7</p>'
      : '<!doctype html><title>Catalog</title><form role="search" action="/results"><input type="search" name="q" aria-label="Search"><button>Search</button></form>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-browser-native-'));
  const toWorker: Array<(e: { data: MainToWorker }) => void> = [];
  const toMain: Array<(m: WorkerToMain) => void> = [];
  const port: HostPort = { postMessage: (m) => { for (const f of toMain) f(structuredClone(m)); }, on: (_e, cb) => { toWorker.push(cb); } };
  const handle: WorkerHandle = {
    postMessage: (m) => { setImmediate(() => { for (const f of toWorker) f({ data: structuredClone(m) }); }); },
    on: ((ev: string, cb: any) => { if (ev === 'message') toMain.push(cb); }) as WorkerHandle['on'],
    kill: () => {},
  };
  host = createBrowserHost(port, root, { forceHeadless: true, discover: async () => FOUND, cliPath: '' });
  client = new BrowserClient({ fork: () => handle, log: diagnostics.log });
  diagnostics.client(client);
  // The person answers every Browser card "for this chat".
  client.on('state', (s: BrowserSessionState) => {
    if (s.prompt && !cards.includes(s.prompt.id)) {
      cards.push(s.prompt.id);
      void client.command({ cmd: 'answer', sessionId: s.sessionId, promptId: s.prompt.id, answer: 'allow_chat' });
    }
  });
}, 60_000);

afterAll(async () => {
  try {
    await host?.service.dispose();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  } finally { diagnostics.restore(); }
});

describe('a native session using the Browser', () => {
  live('opens a page, searches it and reads the answer — asking through the Browser\'s card, never the session\'s', async () => {
    const sessionAsks: string[] = [];
    const layers = { presetRules: [], modeRules: rulesForMode('ask'), denyList: [], rememberedRules: [] };
    const model = scriptModel([
      { toolCalls: [{ name: 'BrowserNavigate', input: { url: `${base}/` } }] },
      { toolCalls: [{ name: 'BrowserSnapshot', input: {} }] },
      // The outline gives the search box a ref; the scripted model uses the first one.
      { toolCalls: [{ name: 'BrowserAct', input: { action: 'type', ref: 'e3', element: 'Search', text: 'wombats', submit: true } }] },
      { toolCalls: [{ name: 'BrowserScreenshot', input: {} }] },
      { text: 'Done.' },
    ]);
    const session = new HarnessSession(makeOpts({
      sessionId: 'native-1',
      tools: [],
      mcpServers: [],
      profile: { ...CLOUD_DEFAULT, supportsVision: true },
      toolServices: { browser: { callTool: (sid: string, tool: string, args: unknown, opts: { signal?: AbortSignal; vision: boolean }) => client.callTool(sid, tool, args, opts) } },
      decide: async (tool: string, subject: string | undefined) => decidePermission(tool, subject, layers),
      askUser: async (req: { toolName?: string }) => { sessionAsks.push(req.toolName ?? String(req)); return { action: 'deny' } as any; },
    } as any), async () => model as any);
    const events: TranscriptEvent[] = [];
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    await session.send('find the code');

    const results = events.filter((e) => e.type === 'tool-result') as any[];
    const texts = results.map((r) => String(r.data?.toolResult ?? r.data?.result ?? JSON.stringify(r.data)));
    expect(results.map((r) => r.data?.isError ?? false), texts.join('\n')).toEqual([false, false, false, false]);
    expect(texts.join('\n')).toContain('Wombat-7');
    // The session's own permission prompt never fired for a Browser tool…
    expect(sessionAsks).toEqual([]);
    // …the Browser's cards did (home address, then click-and-type on the site).
    expect(cards.length).toBe(2);
    // The screenshot came back as a picture file.
    expect(JSON.stringify(results[3].data)).toMatch(/\.jpg/);
  }, 90_000);
});
