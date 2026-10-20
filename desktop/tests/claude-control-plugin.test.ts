import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_CONTROL_PLUGIN_SOURCE } from '../src/main/claude-control-plugin'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
function harness(operations: Record<string, unknown>[]) {
  const hooks = new Map<string, Function>()
  const timers: (() => unknown)[] = []
  let autoTimers = false
  const results: any[] = []
  const claims: string[] = []
  const submitted: string[] = []
  const commands: any[] = []
  const aborted: string[] = []
  const hold = deferred<any>()
  const waitingPoll = deferred<void>()
  const $ = {
    env: { get: vi.fn(async (key: string) => key === 'YOUCODED_CC_CONTROL_URL' ? 'http://127.0.0.1:1234' : 'secret') },
    clock: { now: async () => 123, after: (_ms: number, fn: () => unknown) => { if (autoTimers) queueMicrotask(() => { void fn() }); else timers.push(fn); return { cancel() {} } }, sleep: () => hold.promise },
    session: { id: async () => 'cc-id', model: async () => 'opus' },
    http: { fetch: vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body)
      let value: any = {}
      if (url.endsWith('/hello')) value = { incarnation: body.incarnation }
      if (url.endsWith('/poll')) {
        if (!operations.length) { waitingPoll.resolve(); return hold.promise }
        value = { ...operations.shift(), incarnation: body.incarnation }
      }
      if (url.endsWith('/claim')) claims.push(body.requestId)
      if (url.endsWith('/result')) results.push(body)
      return { ok: true, status: 200, text: JSON.stringify(value), headers: {} }
    }) },
    prompt: { submit: vi.fn(async ({ text }: any) => { submitted.push(text); return { text } }) },
    command: { run: vi.fn(async (args: any) => { commands.push(args); return { text: 'done' } }) },
    turn: { abort: vi.fn(async ({ turnId }: any) => { aborted.push(turnId); return {} }) },
  }
  const register = new Function(CLAUDE_CONTROL_PLUGIN_SOURCE.replace('export function register', 'function register') + '\nreturn register')()
  register((event: string, fn: Function) => { const previous = hooks.get(event); hooks.set(event, previous ? ($: any, e: any, next: any) => fn($, e, (v: any) => previous($, v, next)) : fn); return { catch() {} } })
  const event = async (name: string, e = {}) => hooks.get(name)!($, e, async (value: any) => value)
  const start = async () => {
    await event('session.start')
    autoTimers = true
    for (const timer of timers.splice(0)) await timer()
  }
  return { $, hooks, timers, results, claims, submitted, commands, aborted, start, event, waitingPoll, hold, manualTimers: () => { autoTimers = false } }
}
const op = (requestId: string, request: any, extra = {}) => ({ requestId, request, ...extra })

describe('standalone Claude control mod', () => {
  it('executes text and the three commands through the exact API with a fresh claim for each', async () => {
    const h = harness([
      op('1', { kind: 'send-text', text: 'hello', sendId: 'one' }),
      ...['model', 'clear', 'compact'].map((command, i) => op(String(i + 2), { kind: 'command', command, args: command === 'model' ? 'opus' : '' })),
    ])
    await h.start()
    await vi.waitFor(() => expect(h.results).toHaveLength(4))
    expect(h.submitted).toEqual(['hello'])
    expect(h.$.prompt.submit).toHaveBeenCalledWith({ text: 'hello', asUser: true })
    expect(h.commands.map(c => c.command)).toEqual(['model', 'clear', 'compact'])
    expect(h.claims).toEqual(['1', '2', '3', '4'])
    expect(h.results.every(r => r.result.status === 'accepted')).toBe(true)
    expect(h.results[0].result).toMatchObject({ model: 'opus', claudeSessionId: 'cc-id' })
  })
  it.each(['clear', 'resume'])('keeps controls alive when session.end means %s rather than process exit', async (reason) => {
    const h = harness([op('clear', { kind: 'command', command: 'clear' }), op('after', { kind: 'send-text', text: 'after boundary', sendId: 'after' })])
    h.$.command.run.mockImplementationOnce(async () => { await h.event('session.end', { reason }); return { text: '' } })
    await h.start()
    await vi.waitFor(() => expect(h.submitted).toEqual(['after boundary']))
    expect(h.results.find(r => r.requestId === 'clear').result.status).toBe('accepted')
  })

  it('serializes mutation operations but keeps polling and addressed Stop independent', async () => {
    const h = harness([
      op('1', { kind: 'send-text', text: 'first', sendId: 'one' }),
      op('2', { kind: 'command', command: 'clear' }),
      op('3', { kind: 'stop' }, { turnId: 'active' }),
    ])
    const effect = deferred<any>()
    h.$.prompt.submit.mockImplementationOnce(() => effect.promise)
    await h.event('turn.start', { turnId: 'active' })
    await h.start()
    await vi.waitFor(() => expect(h.aborted).toEqual(['active']))
    expect(h.commands).toEqual([])
    expect(h.claims).toEqual(['1', '3'])
    effect.resolve({ text: 'first' })
    await vi.waitFor(() => expect(h.results).toHaveLength(3))
    expect(h.commands[0].command).toBe('clear')
  })
  it('distinguishes explicit drops from an effect-then-throw and does not stop a newer turn', async () => {
    const h = harness([
      op('1', { kind: 'send-text', text: 'drop', sendId: 'one' }),
      op('2', { kind: 'send-text', text: 'throw', sendId: 'two' }),
      op('3', { kind: 'stop' }, { turnId: 'old' }),
    ])
    h.$.prompt.submit.mockResolvedValueOnce({ drop: 'blocked' } as any)
    h.$.prompt.submit.mockRejectedValueOnce(new Error('effect may have happened'))
    await h.event('turn.start', { turnId: 'new' })
    await h.start()
    await vi.waitFor(() => expect(h.results).toHaveLength(3))
    expect(h.results.find(r => r.requestId === '1').result).toMatchObject({ status: 'rejected', message: 'blocked' })
    expect(h.results.find(r => r.requestId === '2').result.status).toBe('unknown')
    expect(h.aborted).toEqual([])
  })
  it('never invokes an operation when its authenticated claim fails', async () => {
    const h = harness([op('1', { kind: 'send-text', text: 'hello', sendId: 'one' })])
    const original = h.$.http.fetch.getMockImplementation()!
    h.$.http.fetch.mockImplementation(async (url, init) => url.endsWith('/claim')
      ? { ok: false, status: 409, text: '{}', headers: {} } : original(url, init))
    await h.start()
    await h.waitingPoll.promise
    // Settle the serial task using its positive completion signal, not elapsed time.
    await vi.waitFor(() => expect(h.results).toHaveLength(1))
    expect(h.submitted).toEqual([])
  })
  it('binds a turn to its exact opening transcript UUID, never a previous prompt or child row', async () => {
    const h = harness([])
    await h.start()
    h.manualTimers()
    await h.event('session.append', { door: 'prompt', uuid: 'user-one', message: { type: 'user' } })
    await h.event('session.append', { door: 'prompt', agentId: 'child', uuid: 'child-user', message: { type: 'user' } })
    await h.event('turn.start', { turnId: 'main', text: 'hello' })
    for (const timer of h.timers.splice(0)) await timer()
    const posts = () => h.$.http.fetch.mock.calls.filter(([url]) => url.endsWith('/state')).map(([, init]) => JSON.parse(init.body).state)
    expect(posts().at(-1)).toMatchObject({ turnId: 'main', turnUserUuid: 'user-one' })
    await h.event('turn.complete', { turnId: 'main' })
    await h.event('turn.start', { turnId: 'continuation', text: '' })
    for (const timer of h.timers.splice(0)) await timer()
    expect(posts().at(-1)).toMatchObject({ turnId: 'continuation', turnUserUuid: null })
  })
  it('observes only main-agent turns and never awaits network state in model hooks', async () => {
    const h = harness([])
    await h.start()
    await vi.waitFor(() => expect(h.$.http.fetch.mock.calls.some(([url]) => url.endsWith('/state'))).toBe(true))
    h.$.http.fetch.mockClear()
    h.manualTimers()
    await h.event('turn.start', { agentId: 'child', turnId: 'child' })
    expect(h.timers).toHaveLength(0)
    await h.event('turn.start', { turnId: 'main' })
    expect(h.timers).toHaveLength(1)
    await h.timers.shift()!()
    const statePosts = h.$.http.fetch.mock.calls.filter(([url]) => url.endsWith('/state'))
    expect(JSON.parse(statePosts[0][1].body).state.turnId).toBe('main')
    await h.event('turn.complete', { agentId: 'child', turnId: 'child' })
    expect(h.timers).toHaveLength(0)
  })
})
