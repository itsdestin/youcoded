// engine:run-in-terminal asks for Node before it opens a terminal, on both doors. When Node cannot be installed the
// person sees the reason where the button is (EngineCard / UpdatePanel show the thrown sentence), on the computer and on a phone.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TABLE_ERROR_FLAG } from '../src/shared/backend-contract';

// nodeRefusal is the one place that turns "Node could not be installed" into a sentence (prerequisite-installer.ts); here it
// answers as it would when the install failed, so what is pinned is what the entry does with it.
const node = vi.hoisted(() => ({ result: { success: true } as { success: boolean; error?: string } }));
vi.mock('../src/main/prerequisite-installer', async (importActual) => ({
  ...(await importActual<typeof import('../src/main/prerequisite-installer')>()),
  nodeRefusal: vi.fn(async (purpose: string) => (node.result.success ? null : `Node.js is needed ${purpose} and couldn't be installed: ${node.result.error}`)),
}));
import { findChannel, serveRemoteChannel } from '../src/main/ipc/channel-table';
import { bindSessionOps } from '../src/main/ipc/session';

const make = () => {
  const createSession = vi.fn((opts: any) => ({ id: 'shell-1', ...opts }));
  bindSessionOps({ sessionManager: { listSessions: () => [], getSession: () => undefined, createSession }, windowRegistry: null } as any);
  return createSession;
};
afterEach(() => { bindSessionOps(null); node.result = { success: true }; });

describe('engine:run-in-terminal when Node cannot be installed', () => {
  it('the computer\'s window gets the reason as a rejection and no terminal opens', async () => {
    const createSession = make();
    node.result = { success: false, error: 'offline' };
    const ctx: any = { door: 'desktop', runtime: null, broadcast: () => {}, windowId: 1 };
    await expect(Promise.resolve().then(() => findChannel('engine:run-in-terminal')!.handler({ command: 'echo hi' }, ctx)))
      .rejects.toThrow("Node.js is needed to open a terminal and couldn't be installed: offline");
    expect(createSession).not.toHaveBeenCalled();
  });
  it('a phone gets the same sentence as a failed answer its page turns into the same error, and no terminal opens', async () => {
    const createSession = make();
    node.result = { success: false, error: 'offline' };
    const ctx: any = { door: 'remote', runtime: null, broadcast: () => {}, clientId: 'p' };
    expect(await serveRemoteChannel(findChannel('engine:run-in-terminal')!, { command: 'echo hi' }, ctx)).toEqual({
      reply: true, payload: { ok: false, error: "Node.js is needed to open a terminal and couldn't be installed: offline", [TABLE_ERROR_FLAG]: true },
    });
    expect(createSession).not.toHaveBeenCalled();
  });
  it('with Node present (or installed) the terminal opens on both doors', async () => {
    const createSession = make();
    const ctx: any = { door: 'remote', runtime: null, broadcast: () => {}, clientId: 'p' };
    expect(await serveRemoteChannel(findChannel('engine:run-in-terminal')!, { command: 'echo hi' }, ctx)).toEqual({ reply: true, payload: { sessionId: 'shell-1' } });
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});
