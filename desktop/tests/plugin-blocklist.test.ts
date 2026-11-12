// Plugin off-switch (security runbook §5; UI approved 2026-11-05).
//
// WHY these tests: the off-switch is how a plugin found to be unsafe gets stopped on everyone's
// computer. The failures that matter are silent ones — a hook or connected tool that keeps
// running after "turned off", a network outage that quietly switches a bad plugin back on, or a
// cleanup that deletes something the person wrote themselves.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const env = vi.hoisted(() => { process.env.YOUCODED_BLOCKLIST_URL = 'https://blocklist.test/list'; return {}; });
void env;
const reg = vi.hoisted(() => ({ root: '', register: vi.fn(), unregister: vi.fn() }));
vi.mock('../src/main/claude-code-registry', async (orig) => ({
  ...(await orig<typeof import('../src/main/claude-code-registry')>()),
  pluginInstallDir: (id: string) => path.join(reg.root, 'plugins', id),
  registerPluginInstall: reg.register,
  unregisterPluginInstall: reg.unregister,
}));
const hooks = vi.hoisted(() => ({ removePluginHooks: vi.fn(async () => 0), reconcileHooks: vi.fn(async () => ({})) }));
vi.mock('../src/main/hook-reconciler', async (orig) => ({ ...(await orig<object>()), ...hooks }));
const mcp = vi.hoisted(() => ({ removePluginMcpServers: vi.fn(async () => []), reconcileMcp: vi.fn(async () => ({})) }));
vi.mock('../src/main/mcp-reconciler', async (orig) => ({ ...(await orig<object>()), ...mcp }));
vi.mock('../src/main/plugin-installer', async (orig) => ({ ...(await orig<object>()), uninstallPlugin: vi.fn(async () => true) }));
vi.mock('../src/main/logger', () => ({ log: vi.fn() }));

import { parseBlocklist, fetchBlocklist } from '../src/main/plugin-blocklist';
import { removePluginHooksInto } from '../src/main/hook-reconciler';
import { removeManifestEntries } from '../src/main/mcp-reconciler';
import { LocalSkillProvider } from '../src/main/skill-provider';

const answer = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);
const offline = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;

describe('reading the list', () => {
  it('refuses a garbled reply instead of reading it as "nothing is blocked"', () => {
    expect(parseBlocklist(null)).toBeNull();
    expect(parseBlocklist({ blocked: 'tab-tidy' })).toBeNull();
    expect(parseBlocklist({})).toBeNull();
  });
  it('trims ids, skips bad rows and bounds the reason', () => {
    const list = parseBlocklist({ blocked: [{ id: ' tab-tidy ' }, { id: '' }, { id: 7 }, null, { id: 'x', reason: 'r'.repeat(900) }] })!;
    expect([...list.keys()]).toEqual(['tab-tidy', 'x']);
    expect(list.get('x')!.reason!.length).toBe(500);
  });
});

describe('fetching the list', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocklist-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

  it('keeps the last list when the server cannot be reached, so nothing switches back on', async () => {
    const file = path.join(dir, 'blocked.json');
    await fetchBlocklist('u', file, answer({ blocked: [{ id: 'tab-tidy' }] }) as unknown as typeof fetch);
    const later = await fetchBlocklist('u', file, offline);
    expect(later.fresh).toBe(false);
    expect([...later.list.keys()]).toEqual(['tab-tidy']);
    const garbled = await fetchBlocklist('u', file, answer({ nope: true }) as unknown as typeof fetch);
    expect([...garbled.list.keys()]).toEqual(['tab-tidy']);
  });
  it('a real, well-formed answer can shorten the list', async () => {
    const file = path.join(dir, 'blocked.json');
    await fetchBlocklist('u', file, answer({ blocked: [{ id: 'tab-tidy' }] }) as unknown as typeof fetch);
    const cleared = await fetchBlocklist('u', file, answer({ blocked: [] }) as unknown as typeof fetch);
    expect(cleared.list.size).toBe(0);
  });
});

describe('removing one plugin\'s hooks', () => {
  it('removes the hooks it declared or whose script is inside it, and keeps the person\'s own', () => {
    const dir = '/home/u/.claude/plugins/marketplaces/youcoded/plugins/tab-tidy';
    const settings = { hooks: {
      PreToolUse: [
        { matcher: '', hooks: [
          { type: 'command' as const, command: `bash ${dir}/hooks/guard.sh` },
          { type: 'command' as const, command: 'bash /home/u/my-own-hook.sh' },
        ] },
        { matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'curl -s https://evil.example/x' }] },
      ],
      Stop: [{ hooks: [{ type: 'command' as const, command: `node ${dir}/hooks/done.js` }] }],
    } };
    const manifest = { hooks: { PreToolUse: [{ command: 'curl -s https://evil.example/x', matcher: 'Bash' }] } };
    expect(removePluginHooksInto(settings, dir, manifest)).toBe(3);
    expect(settings.hooks).toEqual({ PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'bash /home/u/my-own-hook.sh' }] }] });
  });
});

describe('removing one plugin\'s connected tools', () => {
  it('removes entries exactly as written for it, and keeps edited or unrelated ones', () => {
    const root = '/p/tab-tidy';
    const servers: Record<string, unknown> = {
      tidy: { type: 'stdio', command: `${root}/bin/server`, args: ['--x'] },
      remote: { type: 'http', url: 'https://evil.example/mcp' },
      edited: { type: 'stdio', command: 'my-own-wrapper' },
      mine: { type: 'stdio', command: 'something-else' },
    };
    const removed = removeManifestEntries(servers, { pluginRoot: root, entries: [
      { name: 'tidy', command: '{{plugin_root}}/bin/server', args: ['--x'], auto: true },
      { name: 'remote', type: 'http', url: 'https://evil.example/mcp', auto: true },
      { name: 'edited', command: '{{plugin_root}}/bin/other', auto: true },
    ] as never });
    expect(removed.sort()).toEqual(['remote', 'tidy']);
    expect(Object.keys(servers).sort()).toEqual(['edited', 'mine']);
  });
});

describe('LocalSkillProvider off-switch', () => {
  let home: string; let origHome: typeof os.homedir; let p: LocalSkillProvider;
  let packages: Record<string, { installPath: string; version: string; turnedOff?: boolean; components: unknown[] }>;
  const pluginDir = () => path.join(reg.root, 'plugins', 'tab-tidy');
  const heldDir = () => path.join(home, '.claude', 'youcoded-turned-off-plugins', 'tab-tidy');

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.YOUCODED_PROFILE;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'offswitch-home-'));
    reg.root = home;
    origHome = os.homedir; (os as { homedir: () => string }).homedir = () => home;
    fs.mkdirSync(pluginDir(), { recursive: true });
    fs.writeFileSync(path.join(pluginDir(), 'plugin.json'), '{}');
    packages = { 'tab-tidy': { installPath: pluginDir(), version: '1.0.0', components: [] } };
    p = new LocalSkillProvider();
    vi.spyOn(p.configStore, 'getInstalledPlugins').mockImplementation(() => packages);
    vi.spyOn(p.configStore, 'setPackageTurnedOff').mockImplementation((id: string, off: boolean) => { packages[id].turnedOff = off || undefined; });
  });
  afterEach(() => { (os as { homedir: () => string }).homedir = origHome; fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }); });

  it('turns a listed plugin off: hooks and tools removed first, unhooked, folder held aside', async () => {
    const r = await p.enforceBlocklist(answer({ blocked: [{ id: 'tab-tidy' }] }) as unknown as typeof fetch);
    expect(r).toEqual({ turnedOff: ['tab-tidy'], turnedOn: [] });
    expect(hooks.removePluginHooks).toHaveBeenCalledWith(pluginDir());
    expect(mcp.removePluginMcpServers).toHaveBeenCalledWith(pluginDir());
    expect(reg.unregister).toHaveBeenCalledWith('tab-tidy');
    expect(fs.existsSync(pluginDir())).toBe(false);
    expect(fs.existsSync(path.join(heldDir(), 'plugin.json'))).toBe(true);
    expect(packages['tab-tidy'].turnedOff).toBe(true);
    // A second check is quiet (nothing new to report) but still keeps it unhooked.
    const again = await p.enforceBlocklist(offline);
    expect(again.turnedOff).toEqual([]);
    expect(reg.unregister).toHaveBeenCalledTimes(2);
  });

  it('puts the plugin back, as it was, once it is taken off the list', async () => {
    await p.enforceBlocklist(answer({ blocked: [{ id: 'tab-tidy' }] }) as unknown as typeof fetch);
    const r = await p.enforceBlocklist(answer({ blocked: [] }) as unknown as typeof fetch);
    expect(r).toEqual({ turnedOff: [], turnedOn: ['tab-tidy'] });
    expect(fs.existsSync(path.join(pluginDir(), 'plugin.json'))).toBe(true);
    expect(reg.register).toHaveBeenCalledWith({ id: 'tab-tidy', installPath: pluginDir(), version: '1.0.0' });
    expect(packages['tab-tidy'].turnedOff).toBeUndefined();
  });

  it('refuses install and update, hides it from the store, and marks it in the Library', async () => {
    await p.enforceBlocklist(answer({ blocked: [{ id: 'tab-tidy' }] }) as unknown as typeof fetch);
    expect(await p.install('tab-tidy')).toEqual({ status: 'failed', error: 'This plugin was turned off because it was found to be unsafe.' });
    expect((await p.update('tab-tidy')).ok).toBe(false);
    vi.spyOn(p as unknown as { fetchIndex: () => Promise<unknown> }, 'fetchIndex').mockResolvedValue([
      { id: 'tab-tidy', displayName: 'Tab Tidy', description: '', type: 'plugin' },
      { id: 'other', displayName: 'Other', description: '', type: 'plugin' },
    ]);
    expect((await p.listMarketplace()).map((e) => e.id)).toEqual(['other']);
    const card = (await p.getInstalled()).find((s) => s.id === 'tab-tidy');
    expect(card?.blocked).toEqual({});
  });

  it('a dev copy shows the list but never changes the real install', async () => {
    process.env.YOUCODED_PROFILE = 'dev';
    const r = await p.enforceBlocklist(answer({ blocked: [{ id: 'tab-tidy' }] }) as unknown as typeof fetch);
    expect(r.turnedOff).toEqual([]);
    expect(reg.unregister).not.toHaveBeenCalled();
    expect(fs.existsSync(pluginDir())).toBe(true);
    delete process.env.YOUCODED_PROFILE;
  });
});
