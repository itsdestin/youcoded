// Card #143 b (review 2026-11-13): only a session the PERSON starts moves a folder up the list.
import { describe, it, expect, vi, afterEach } from 'vitest';

const stamp = vi.hoisted(() => vi.fn());
vi.mock('../src/main/folders-service', async (orig) => ({ ...(await orig() as object), noteFolderUsed: stamp }));
import { findChannel } from '../src/main/ipc/channel-table';
import { bindSessionOps } from '../src/main/ipc/session';

const ctx: any = { door: 'desktop', runtime: null, broadcast: () => {}, sender: { id: 3 } };
const create = (opts: any) => { bindSessionOps({ createSession: vi.fn(async () => ({ id: 'x' })) } as any); return findChannel('session:create')!.handler(opts, ctx); };
afterEach(() => { bindSessionOps(null); stamp.mockClear(); });

describe('which sessions stamp a folder as used', () => {
  it('a new session the person starts in a folder does', async () => {
    await create({ name: 'New Session', cwd: '/home/me/work', skipPermissions: false });
    expect(stamp).toHaveBeenCalledWith('/home/me/work');
  });
  it('a resumed conversation does not', async () => {
    await create({ name: 'x', cwd: '/home/me', resumeSessionId: 'abc' });
    expect(stamp).not.toHaveBeenCalled();
  });
  it('a session with no folder (a setup chat) does not', async () => {
    await create({ name: 'Set up X', cwd: '' });
    await create({ name: 'Set up X' });
    expect(stamp).not.toHaveBeenCalled();
  });
});
