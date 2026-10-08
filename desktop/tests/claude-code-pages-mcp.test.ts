// The page-data MCP server (claude-code-pages-mcp.ts), run as the real node process Claude Code would spawn.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deployClaudeCodePagesMcp, PAGES_MCP_READ_TOOLS } from '../src/main/claude-code-pages-mcp';

let base: string;
let personal: string;
let proc: ChildProcessWithoutNullStreams | null = null;

function page(root: string, slug: string, name: string, data?: unknown) {
  mkdirSync(path.join(root, slug), { recursive: true });
  writeFileSync(path.join(root, slug, 'page.json'), JSON.stringify({ name, description: `${name} page` }));
  if (data !== undefined) writeFileSync(path.join(root, slug, 'data.json'), JSON.stringify({ savedAt: '2026-10-01T00:00:00Z', data }));
}
const dataOf = (root: string, slug: string) => JSON.parse(readFileSync(path.join(root, slug, 'data.json'), 'utf8')).data;

function start(roots: string[]) {
  const dep = deployClaudeCodePagesMcp(path.join(base, 'userData'), process.execPath, roots)!;
  const cfg = JSON.parse(readFileSync(dep.configPath, 'utf8')).mcpServers['youcoded-pages'];
  proc = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env } });
  let buf = '';
  const waiting = new Map<number, (v: any) => void>();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let n = 0;
  const rpc = (method: string, params?: unknown) => new Promise<any>((resolve) => {
    const id = ++n; waiting.set(id, resolve);
    proc!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name: string, args: unknown = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { text: r.result.content[0].text as string, isError: r.result.isError as boolean };
  };
  return { dep, rpc, call };
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'pages-mcp-'));
  personal = path.join(base, 'Personal', 'Pages');
  mkdirSync(personal, { recursive: true });
});
afterEach(() => {
  proc?.kill(); proc = null;
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
});

describe('the page-data tools', () => {
  it('offers three tools, of which only the two that read are pre-approved', async () => {
    const { rpc, dep } = start([personal]);
    const list = await rpc('tools/list');
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['ListPages', 'ReadPageData', 'UpdatePageData']);
    expect(dep.allowedTools).toEqual(PAGES_MCP_READ_TOOLS);
    expect(dep.allowedTools.some((t) => t.endsWith('UpdatePageData'))).toBe(false);
  });

  it('lists personal and project pages with what each one keeps', async () => {
    const project = path.join(base, 'proj', 'Pages');
    page(personal, 'money', 'Money', { accounts: [], bills: [] });
    page(project, 'tasks', 'Tasks');
    const { call } = start([personal, project]);
    const r = await call('ListPages');
    expect(r.text).toContain('Money (id: money)');
    expect(r.text).toContain('saved data: accounts, bills');
    expect(r.text).toContain('Tasks (id: project:tasks)');
  });

  it('reads one page, or one part of it, with pictures summarised', async () => {
    page(personal, 'money', 'Money', { institutions: { Chase: { logo: 'data:image/png;base64,' + 'A'.repeat(2000) } }, accounts: [{ id: 'm1', balance: 5 }] });
    const { call } = start([personal]);
    const all = await call('ReadPageData', { page: 'Money' });
    expect(all.text).toContain('characters, not shown');
    const one = await call('ReadPageData', { page: 'money', path: ['accounts', { id: 'm1' }, 'balance'] });
    expect(one.text).toBe('5');
  });

  it('shows the page\'s own data guide when reading, so an empty list still has a shape to follow', async () => {
    page(personal, 'money', 'Money', { bills: [] });
    const pj = path.join(personal, 'money', 'page.json');
    writeFileSync(pj, JSON.stringify({ name: 'Money', dataHelp: ['bills: { id, provider, amount, due }', 'Amounts are numbers.'] }));
    const { call } = start([personal]);
    expect((await call('ListPages')).text).toContain('has a data guide');
    const r = await call('ReadPageData', { page: 'money' });
    expect(r.text).toContain('bills: { id, provider, amount, due }\nAmounts are numbers.');
    expect(r.text).toContain('"bills": []');
  });

  it('sets, appends and removes, writing the envelope the app reads', async () => {
    page(personal, 'money', 'Money', { accounts: [{ id: 'm1', balance: 22410 }], bills: [{ id: 'b1' }, { id: 'b2' }] });
    const { call } = start([personal]);
    const r = await call('UpdatePageData', { page: 'money', changes: [
      { op: 'set', path: ['accounts', { id: 'm1' }, 'balance'], value: 22100 },
      { op: 'append', path: ['bills'], value: { id: 'b3' } },
      { op: 'remove', path: ['bills', { id: 'b1' }] },
      { op: 'set', path: ['settings', 'warnPct'], value: 25 },
    ] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('accounts[id="m1"].balance: 22410 -> 22100');
    expect(dataOf(personal, 'money')).toEqual({ accounts: [{ id: 'm1', balance: 22100 }], bills: [{ id: 'b2' }, { id: 'b3' }], settings: { warnPct: 25 } });
    const env = JSON.parse(readFileSync(path.join(personal, 'money', 'data.json'), 'utf8'));
    expect(typeof env.savedAt).toBe('string');
    // No lock or temp file left behind.
    expect(readdirSync(path.join(personal, 'money')).sort()).toEqual(['data.json', 'page.json']);
  });

  it('a change that cannot apply leaves the page exactly as it was', async () => {
    page(personal, 'money', 'Money', { accounts: [{ id: 'm1', balance: 1 }] });
    const { call } = start([personal]);
    const r = await call('UpdatePageData', { page: 'money', changes: [
      { op: 'set', path: ['accounts', { id: 'm1' }, 'balance'], value: 2 },
      { op: 'set', path: ['accounts', { id: 'nope' }, 'balance'], value: 3 },
    ] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Nothing was changed');
    expect(dataOf(personal, 'money')).toEqual({ accounts: [{ id: 'm1', balance: 1 }] });
  });

  it('refuses a page it cannot find, and anything over 1 MB', async () => {
    page(personal, 'money', 'Money', {});
    const { call } = start([personal]);
    expect((await call('UpdatePageData', { page: '../../etc', changes: [{ op: 'set', path: ['x'], value: 1 }] })).isError).toBe(true);
    const big = await call('UpdatePageData', { page: 'money', changes: [{ op: 'set', path: ['blob'], value: 'x'.repeat(1_100_000) }] });
    expect(big.text).toContain('more than 1 MB');
  });
});
