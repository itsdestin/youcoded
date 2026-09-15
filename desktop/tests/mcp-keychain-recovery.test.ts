import { describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../src/main/harness/mcp/mcp-registry';
import { McpManager, type McpConnectionLike } from '../src/main/harness/mcp/mcp-manager';
import { projectToClaudeJson } from '../src/main/mcp-reconciler';

function setup() {
  let unlocked = false;
  const protectedServer = { id: 'protected', label: 'Protected', enabled: true, transport: { type: 'stdio' as const, command: 'protected-command' }, origin: { kind: 'user' as const }, envRefs: { TOKEN: { secretRef: 'secret' } } };
  const freeServer = { id: 'free', label: 'Free', enabled: true, transport: { type: 'stdio' as const, command: 'free-command' }, origin: { kind: 'user' as const } };
  const registry = new McpRegistry({ readJson: () => ({ servers: [protectedServer, freeServer] }), mutateJson: async () => {} }, {
    get: async () => { if (!unlocked) throw new Error('Secure key storage is currently unavailable. Unlock your system keychain, then retry.'); return 'private-token'; },
    set: async () => 'secret', delete: async () => {}, has: () => true,
  });
  const factory = vi.fn(() => {
    const conn: McpConnectionLike = {
      get state() { return 'ready' as const; }, lastError: null, connect: async () => {}, close: async () => {},
      listTools: () => [], callTool: async () => ({ text: 'ok', isError: false }),
    };
    return conn;
  });
  return { registry, factory, manager: new McpManager({ registry, connectionFactory: factory }), unlock: () => { unlocked = true; } };
}

describe('MCP keychain recovery', () => {
  it('isolates credential failures per server without claiming missing setup', async () => {
    const h = setup();
    const servers = await h.registry.resolveAllEnabled();
    expect(servers).toHaveLength(2);
    expect(servers[0].missingSecrets).toEqual([]);
    expect(servers[0].credentialError).toContain('Secure key storage is currently unavailable');
    expect(servers[0].env).toBeUndefined();
    expect(servers[1].credentialError).toBeUndefined();
    h.unlock();
    expect((await h.registry.resolve('protected'))?.env).toEqual({ TOKEN: 'private-token' });
  });

  it('connects independent servers and retries a credential-error placeholder after unlock', async () => {
    const h = setup();
    const first = await h.manager.acquire('one');
    expect(first.servers.map((s) => s.id)).toEqual(['free']);
    expect(h.factory).toHaveBeenCalledTimes(1);
    expect(h.manager.status().find((s) => s.id === 'protected')).toMatchObject({ state: 'error', error: expect.stringContaining('Secure key storage') });
    h.unlock();
    const second = await h.manager.acquire('two');
    expect(second.servers.map((s) => s.id)).toEqual(['protected', 'free']);
    expect(h.factory).toHaveBeenCalledTimes(2);
    await first.release();
    await second.release();
  });

  it('never projects incomplete credentials and preserves ownership of a previously working entry', async () => {
    const h = setup();
    const servers = await h.registry.resolveAllEnabled();
    const previous = { mcpServers: { protected: { command: 'prior', env: { TOKEN: 'prior-token' } } }, _youcodedOwnedMcpServers: ['protected'] };
    const out = projectToClaudeJson(previous, servers).claudeJson;
    expect(out.mcpServers?.protected).toEqual(previous.mcpServers.protected);
    expect(out._youcodedOwnedMcpServers).toEqual(['protected', 'free']);
    const fresh = projectToClaudeJson({}, servers).claudeJson;
    expect(fresh.mcpServers?.protected).toBeUndefined();
    expect(fresh.mcpServers?.free).toBeDefined();
    h.unlock();
    const recovered = projectToClaudeJson(out, await h.registry.resolveAllEnabled());
    expect(recovered.skippedCollisions).toEqual([]);
    expect(recovered.claudeJson.mcpServers?.protected).toMatchObject({ env: { TOKEN: 'private-token' } });
  });
});
