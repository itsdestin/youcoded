import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { ClaudeControlBridge } from '../src/main/claude-control-bridge'
import { isClaudeControlRequest } from '../src/shared/claude-control-types'

const send = (sendId = 'one', text = 'hello') => ({ kind: 'send-text' as const, text, sendId })
let root: string
let bridge: ClaudeControlBridge
let env: Record<string, string>
async function post(route: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return fetch(env.YOUCODED_CC_CONTROL_URL + '/' + route, { method: 'POST', headers: {
    authorization: 'Bearer ' + env.YOUCODED_CC_CONTROL_TOKEN, 'content-type': 'application/json', ...headers,
  }, body: JSON.stringify(body) })
}
const lease = (incarnation = 'first') => ({ v: 1, incarnation })
async function hello(incarnation = 'first') {
  return post('hello', { ...lease(incarnation), capabilities: ['send-text', 'stop', 'model', 'clear', 'compact'] })
}
async function take() { return (await post('poll', lease())).json() }
async function claim(op: { requestId: string }) { return post('claim', { ...lease(), requestId: op.requestId }) }
async function finish(op: { requestId: string }, result: unknown = { status: 'accepted' }) {
  return post('result', { ...lease(), requestId: op.requestId, result })
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'control-'))
  bridge = new ClaudeControlBridge(root)
  env = (await bridge.prepare('app-session'))!.env
})
afterEach(async () => {
  vi.useRealTimers()
  await bridge.close()
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('ClaudeControlBridge', () => {
  it('authenticates queue routes with the same Host/Origin/incarnation envelope before any delegate runs', async () => {
    const transport = { offer: vi.fn(async () => ({ released: true })), poll: vi.fn(async () => ({ kind: 'idle' })), event: vi.fn(async () => {}), close: vi.fn(async () => {}), unbind: vi.fn(async () => {}), canControl: () => false, canExecuteClear: () => false };
    bridge.attachQueueTransport(transport as any);
    expect(await (await hello()).json()).toMatchObject({ queueEnabled: true });
    expect((await post('queue-offer', { ...lease(), offer: {} }, { origin: 'https://untrusted.example' })).status).toBe(403);
    expect((await post('queue-offer', { ...lease('stale'), offer: {} })).status).toBe(409);
    expect((await post('queue-offer', { ...lease(), offer: {}, extra: 'not allowed' })).status).toBe(400);
    expect(transport.offer).not.toHaveBeenCalled();
    expect((await post('queue-offer', { ...lease(), offer: { marker: 'valid authenticated envelope' } })).status).toBe(200);
    expect(transport.offer).toHaveBeenCalledWith('app-session', 'first', { marker: 'valid authenticated envelope' });
    expect(await bridge.execute('app-session', send())).toMatchObject({ status: 'rejected' });
    expect(await bridge.executeQueueClear('app-session', 'not-authorized')).toMatchObject({ status: 'rejected' });
  });
  it('deduplicates the current durable Clear authorization instead of clearing twice after a lost reply', async () => {
    const transport = { close: async () => {}, unbind: async () => {}, canControl: () => false, canExecuteClear: (_id: string, clearId: string) => clearId === 'current-clear' };
    bridge.attachQueueTransport(transport as any); await hello();
    const first = bridge.executeQueueClear('app-session', 'current-clear');
    const duplicate = bridge.executeQueueClear('app-session', 'current-clear'); expect(duplicate).toBe(first);
    const op = await take(); expect(op.request).toEqual({ kind: 'command', command: 'clear' }); await claim(op); await finish(op);
    expect(await first).toMatchObject({ status: 'accepted' });
    expect(await bridge.executeQueueClear('app-session', 'current-clear')).toEqual(await first);
    expect(await bridge.executeQueueClear('app-session', 'obsolete')).toMatchObject({ status: 'rejected' });
  });
  it('announces the actual addressed Stop identity, never an accepted idle no-op', async () => {
    await hello();
    const targeted = vi.fn();
    bridge.on('stop-targeted', targeted);
    expect((await bridge.execute('app-session', { kind: 'stop' })).status).toBe('accepted');
    expect(targeted).not.toHaveBeenCalled();
    await post('state', { ...lease(), state: { turnId: 'turn-one', turnUserUuid: 'user-one' } });
    const pending = bridge.execute('app-session', { kind: 'stop' });
    const op = await take();
    expect(targeted).toHaveBeenCalledExactlyOnceWith('app-session', op.requestId, 'user-one');
    await claim(op);
    await finish(op);
    expect((await pending).status).toBe('accepted');
  });
  it('never carries a previous opening UUID into a turn observation without one', async () => {
    await hello();
    expect((await post('state', { ...lease(), state: { turnId: 'old', turnUserUuid: 'old-user' } })).status).toBe(200);
    expect((await post('state', { ...lease(), state: { turnId: 'new' } })).status).toBe(200);
    const targeted = vi.fn();
    bridge.on('stop-targeted', targeted);
    const pending = bridge.execute('app-session', { kind: 'stop' });
    const op = await take();
    expect(targeted).toHaveBeenCalledExactlyOnceWith('app-session', op.requestId, null);
    await claim(op); await finish(op); await pending;
    expect((await post('state', { ...lease(), state: { turnId: null, turnUserUuid: null } })).status).toBe(200);
  });
  it('strictly validates request fields and bounds', () => {
    expect(isClaudeControlRequest(send())).toBe(true)
    for (const request of [null, {}, { kind: 'stop', text: 'x' }, send('', 'x'), send('id', ''),
      send('id', 'x'.repeat(262145)), send('bad\nID'), send('x'.repeat(81)), send('non-ascii-é'), send('slash/id'), { kind: 'command', command: 'bash' },
      { kind: 'command', command: 'model', notice: 'anything' }, { ...send(), extra: 1 }]) {
      expect(isClaudeControlRequest(request)).toBe(false)
    }
  })
  it('stages an immutable standalone plugin without exposing its secret in args', async () => {
    const prepared = (await bridge.prepare('app-session'))!
    expect(prepared.args[0]).toBe('--plugin-dir')
    const manifest = JSON.parse(await readFile(join(prepared.args[1], '.claude-plugin/plugin.json'), 'utf8'))
    expect(manifest.name).toBe('youcoded-control-bridge')
    expect(JSON.parse(await readFile(join(prepared.args[1], 'hooks/hooks.json'), 'utf8'))).toEqual({ modules: ['./register.js'] })
    expect(await readFile(join(prepared.args[1], 'hooks/register.js'), 'utf8')).toContain('export function register')
    expect(prepared.args.join(' ')).not.toContain(env.YOUCODED_CC_CONTROL_TOKEN)
    expect(prepared.env).toEqual(env)
    const another = (await bridge.prepare('another'))!
    expect(another.args).toEqual(prepared.args)
    expect(another.env.YOUCODED_CC_CONTROL_TOKEN).not.toBe(env.YOUCODED_CC_CONTROL_TOKEN)
  })
  it('resolves a deployment root provider only when staging begins after profile selection', async () => {
    await bridge.close()
    let selectedRoot = join(root, 'initial-profile')
    const deploymentRoot = vi.fn(() => selectedRoot)
    bridge = new ClaudeControlBridge(deploymentRoot)
    expect(deploymentRoot).not.toHaveBeenCalled()
    expect(bridge.isReady('lazy-session')).toBe(false)
    expect(await bridge.execute('lazy-session', { kind: 'stop' })).toEqual({ status: 'unavailable' })
    expect(deploymentRoot).not.toHaveBeenCalled()
    selectedRoot = join(root, 'selected-profile')
    const prepared = await bridge.prepare('lazy-session')
    expect(prepared).not.toBeNull()
    expect(prepared!.args[1].startsWith(join(selectedRoot, 'claude-control-plugins'))).toBe(true)
    expect(deploymentRoot).toHaveBeenCalledTimes(1)
    expect((await bridge.prepare('another-lazy-session'))!.args).toEqual(prepared!.args)
    expect(deploymentRoot).toHaveBeenCalledTimes(1)
  })
  it('does not resolve a deployment root provider when preparation is cancelled before staging', async () => {
    const deploymentRoot = vi.fn(() => root)
    const cancelled = new ClaudeControlBridge(deploymentRoot)
    cancelled.closeSession('cancelled')
    expect(await cancelled.prepare('cancelled')).toBeNull()
    await cancelled.close()
    expect(await cancelled.prepare('after-close')).toBeNull()
    expect(deploymentRoot).not.toHaveBeenCalled()
  })
  it('returns null on asynchronous deployment failure and cannot resurrect after close', async () => {
    const file = join(root, 'file')
    await writeFile(file, 'not a directory')
    const broken = new ClaudeControlBridge(file)
    expect(await broken.prepare('x')).toBeNull()
    await broken.close()
    const closing = new ClaudeControlBridge(join(root, 'closing'))
    const pending = closing.prepare('x')
    closing.closeSession('x')
    expect(await pending).toBeNull()
    await closing.close()
    expect(await closing.prepare('x')).toBeNull()
  })
  it('rejects missing auth, browser Origin, unexpected Host, bad protocol and oversize bodies', async () => {
    expect((await post('hello', {}, { authorization: '' })).status).toBe(401)
    expect((await post('hello', {}, { origin: 'http://localhost' })).status).toBe(403)
    const url = new URL(env.YOUCODED_CC_CONTROL_URL)
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(url + '/hello', { method: 'POST', headers: { host: 'evil.example', authorization: 'Bearer ' + env.YOUCODED_CC_CONTROL_TOKEN } }, res => { res.resume(); resolve(res.statusCode!) })
      req.on('error', reject); req.end('{}')
    })
    expect(status).toBe(403)
    expect((await post('hello', { ...lease(), v: 2 })).status).toBe(400)
    expect((await post('hello', { ...lease(), capabilities: [] })).status).toBe(400)
    expect((await post('hello', { padding: 'x'.repeat(300000) })).status).toBe(413)
    expect(bridge.isReady('app-session')).toBe(false)
  })
  it('only permits fallback before the first valid handshake', async () => {
    expect(await bridge.execute('app-session', send())).toEqual({ status: 'unavailable' })
    expect((await hello()).status).toBe(200)
    expect(bridge.isReady('app-session')).toBe(true)
    bridge.closeSession('app-session')
    expect(await bridge.execute('app-session', send('new'))).toMatchObject({ status: 'unknown' })
    expect((await post('hello', lease())).status).toBe(401)
  })
  it('never directly dispatches or grants fallback twice for a send previously marked unavailable', async () => {
    expect(await bridge.execute('app-session', send())).toEqual({ status: 'unavailable' })
    expect(await bridge.execute('app-session', send())).toMatchObject({ status: 'unknown' })
    await hello()
    expect(await bridge.execute('app-session', send())).toMatchObject({ status: 'unknown' })
    expect(await bridge.execute('app-session', send('one', 'different'))).toMatchObject({ status: 'rejected' })
  })
  it('retains fallback identity even if execute races ahead of prepare', async () => {
    expect(await bridge.execute('not-prepared', send())).toEqual({ status: 'unavailable' })
    expect(await bridge.execute('not-prepared', send())).toMatchObject({ status: 'unknown' })
    expect(await bridge.prepare('not-prepared')).not.toBeNull()
  })
  it('never reactivates a retired incarnation through a stale hello', async () => {
    await hello()
    await hello('second')
    expect((await hello()).status).toBe(409)
    expect((await post('state', { ...lease(), state: { turnId: 'old' } })).status).toBe(409)
  })
  it('never grants a late claim after an operation timed out before invocation', async () => {
    await hello()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = bridge.execute('app-session', send())
    const op = await take()
    await vi.advanceTimersByTimeAsync(60001)
    expect(await pending).toMatchObject({ status: 'unknown' })
    expect((await claim(op)).status).toBe(409)
  })
  it('frees an expired unclaimed handoff without forgetting its unknown send outcome', async () => {
    await bridge.close()
    bridge = new ClaudeControlBridge(root, { maxPending: 1 })
    env = (await bridge.prepare('app-session'))!.env
    await hello()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const old = bridge.execute('app-session', send('old'))
    const lost = await take()
    await vi.advanceTimersByTimeAsync(60001)
    expect(await old).toMatchObject({ status: 'unknown' })
    expect((await claim(lost)).status).toBe(409)
    const fresh = bridge.execute('app-session', send('fresh'))
    const active = (bridge as unknown as { sessions: Map<string, { operations: Map<string, { request: any }> }> }).sessions.get('app-session')!.operations
    expect([...active.values()].some(op => op.request.sendId === 'fresh')).toBe(true)
    const next = await take(); expect(next.request.sendId).toBe('fresh')
    await claim(next); await finish(next)
    expect(await fresh).toMatchObject({ status: 'accepted' })
    expect(await bridge.execute('app-session', send('old'))).toMatchObject({ status: 'unknown' })
  })

  it('reserves one addressed Stop even when pending mutations fill the queue', async () => {
    await bridge.close()
    bridge = new ClaudeControlBridge(root, { maxPending: 1 })
    env = (await bridge.prepare('app-session'))!.env
    await hello(); await post('state', { ...lease(), state: { turnId: 'active' } })
    const mutation = bridge.execute('app-session', send('queued'))
    const stop = bridge.execute('app-session', { kind: 'stop' })
    expect(await bridge.execute('app-session', { kind: 'stop' })).toMatchObject({ status: 'unknown' })
    const first = await take(); expect(first.request.kind).toBe('stop')
    await claim(first); await finish(first)
    expect(await stop).toMatchObject({ status: 'accepted' })
    const second = await take(); await claim(second); await finish(second)
    expect(await mutation).toMatchObject({ status: 'accepted' })
  })

  it('claims once, settles and deduplicates before checking readiness', async () => {
    await hello()
    const settled = vi.fn(); bridge.on('settled', settled)
    const pending = bridge.execute('app-session', send())
    const duplicate = bridge.execute('app-session', send())
    const op = await take()
    expect(op.request).toEqual(send())
    expect((await claim(op)).status).toBe(200)
    expect((await claim(op)).status).toBe(409)
    await finish(op, { status: 'accepted', model: 'opus', claudeSessionId: 'cc' })
    expect(await pending).toEqual({ status: 'accepted', requestId: op.requestId, model: 'opus', claudeSessionId: 'cc' })
    expect(await duplicate).toEqual(await pending)
    expect(settled).toHaveBeenCalledTimes(1)
    bridge.closeSession('app-session')
    expect(await bridge.execute('app-session', send())).toEqual(await pending)
    expect(await bridge.execute('app-session', send('one', 'different'))).toMatchObject({ status: 'rejected' })
  })
  it('rejects unclaimed results and fences old state, polls and results after takeover', async () => {
    await hello()
    const pending = bridge.execute('app-session', send())
    const op = await take()
    expect((await finish(op)).status).toBe(409)
    await hello('second')
    expect(await pending).toMatchObject({ status: 'unknown' })
    expect((await post('poll', lease())).status).toBe(409)
    expect((await post('state', { ...lease(), state: { turnId: 'stale' } })).status).toBe(409)
    expect((await finish(op)).status).toBe(409)
  })
  it('seals a session rather than activate a second writer while claimed work is unresolved', async () => {
    await hello()
    const pending = bridge.execute('app-session', send())
    const op = await take(); await claim(op)
    expect((await hello('second')).status).toBe(409)
    expect(await pending).toMatchObject({ status: 'unknown' })
    expect((await hello()).status).toBe(409)
    expect(await bridge.execute('app-session', send('new'))).toMatchObject({ status: 'unknown' })
  })
  it('distinguishes timeout before handoff from uncertainty after handoff and accepts late receipts', async () => {
    await hello()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const settled = vi.fn(); bridge.on('settled', settled)
    const queued = bridge.execute('app-session', send('queued'))
    await vi.advanceTimersByTimeAsync(60001)
    expect(await queued).toMatchObject({ status: 'rejected' })
    const handed = bridge.execute('app-session', send())
    const op = await take(); await claim(op)
    await vi.advanceTimersByTimeAsync(60001)
    expect(await handed).toMatchObject({ status: 'unknown' })
    expect(await bridge.execute('app-session', send())).toMatchObject({ status: 'unknown' })
    expect(settled).not.toHaveBeenCalled()
    await finish(op)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(await bridge.execute('app-session', send())).toMatchObject({ status: 'accepted' })
  })
  it('bounds queues and retains send identity even on overflow and at the tombstone cap', async () => {
    await bridge.close()
    bridge = new ClaudeControlBridge(root, { maxPending: 1, maxSendIds: 2 })
    env = (await bridge.prepare('app-session'))!.env
    await hello()
    const first = bridge.execute('app-session', send('one'))
    expect(await bridge.execute('app-session', { kind: 'stop' })).toMatchObject({ status: 'accepted' })
    expect(await bridge.execute('app-session', send('two'))).toMatchObject({ status: 'rejected' })
    expect(await bridge.execute('app-session', send('three'))).toMatchObject({ status: 'rejected' })
    const op = await take(); await claim(op); await finish(op)
    await first
    expect(await bridge.execute('app-session', send('two'))).toMatchObject({ status: 'rejected' })
    expect(await bridge.execute('app-session', send('one'))).toMatchObject({ status: 'accepted' })
  })
  it('preserves all ten thousand send identities without evicting the oldest', async () => {
    for (let i = 0; i < 10000; i++) {
      expect(await bridge.execute('app-session', send(String(i)))).toEqual({ status: 'unavailable' })
    }
    expect(await bridge.execute('app-session', send('10000'))).toMatchObject({ status: 'rejected' })
    expect(await bridge.execute('app-session', send('0'))).toMatchObject({ status: 'unknown' })
    expect(await bridge.execute('app-session', send('0', 'changed'))).toMatchObject({ status: 'rejected' })
  })
  it('does not forget outcomes or permit fallback after a connection lease expires', async () => {
    await hello()
    const pending = bridge.execute('app-session', send())
    const op = await take(); await claim(op); await finish(op)
    await pending
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 90001)
    expect(bridge.isReady('app-session')).toBe(false)
    expect(await bridge.execute('app-session', send())).toMatchObject({ status: 'accepted' })
    expect(await bridge.execute('app-session', send('new'))).toMatchObject({ status: 'unknown' })
    expect(await bridge.execute('app-session', { kind: 'command', command: 'clear' })).toMatchObject({ status: 'unknown' })
  })
  it('holds an idle poll below the thirty second ceiling without fast polling', async () => {
    await hello()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    let responded = false
    const poll = post('poll', lease()).then(response => { responded = true; return response })
    const internals = bridge as unknown as { sessions: Map<string, { poll?: unknown }> }
    await vi.waitFor(() => expect(internals.sessions.get('app-session')?.poll).toBeDefined())
    expect(scheduled).toHaveBeenCalledWith(expect.any(Function), 25000)
    scheduled.mockRestore()
    expect(responded).toBe(false)
    await vi.advanceTimersByTimeAsync(25000)
    expect(await (await poll).json()).toMatchObject({ idle: true, incarnation: 'first' })
  })
  it('binds Stop to the observed turn, keeps idle Stop a no-op, and ignores agent state', async () => {
    await hello()
    const state = vi.fn(); bridge.on('state', state)
    expect((await post('state', { ...lease(), agentId: 'child', state: { turnId: 'child' } })).status).toBe(400)
    const pendingSend = bridge.execute('app-session', send())
    expect(await bridge.execute('app-session', { kind: 'stop' })).toMatchObject({ status: 'accepted' })
    await post('state', { ...lease(), state: { claudeSessionId: 'cc', model: 'opus', turnId: 'turn-one' } })
    const stop = bridge.execute('app-session', { kind: 'stop' })
    const op = await take()
    expect(op.request.kind).toBe('stop')
    expect(op.turnId).toBe('turn-one')
    await post('state', { ...lease(), state: { turnId: 'turn-two' } })
    expect((await claim(op)).status).toBe(409)
    expect(await stop).toMatchObject({ status: 'rejected' })
    const sendOp = await take(); await claim(sendOp); await finish(sendOp)
    expect(await pendingSend).toMatchObject({ status: 'accepted' })
    expect(state).toHaveBeenCalled()
  })
  it('tears down even an authenticated peer that never finishes its request body', async () => {
    const internals = bridge as unknown as { server: import('node:http').Server }
    const received = new Promise<void>(resolve => internals.server.once('request', () => resolve()))
    const req = httpRequest(env.YOUCODED_CC_CONTROL_URL + '/hello', { method: 'POST', headers: {
      authorization: 'Bearer ' + env.YOUCODED_CC_CONTROL_TOKEN, 'content-length': '1000',
    } })
    const disconnected = new Promise<void>(resolve => { req.on('error', () => resolve()); req.on('close', () => resolve()) })
    req.write('{')
    await received
    await bridge.close()
    await disconnected
    expect(bridge.isReady('app-session')).toBe(false)
  })
  it('closes held polls and resolves pending work without late resurrection', async () => {
    await hello()
    const pending = bridge.execute('app-session', send())
    const op = await take(); await claim(op)
    const poll = post('poll', lease())
    const internals = bridge as unknown as { sessions: Map<string, { poll?: unknown }> }
    await vi.waitFor(() => expect(internals.sessions.get('app-session')?.poll).toBeDefined())
    bridge.closeSession('app-session')
    expect(await pending).toMatchObject({ status: 'unknown' })
    expect([401, 410]).toContain((await poll).status)
    expect((await finish(op)).status).toBe(401)
    expect(await bridge.execute('app-session', send())).toMatchObject({ status: 'unknown' })
  })
})
