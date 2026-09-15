import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudFileSupervisor, type CloudWorkerEvents, type CloudWorkerHandle } from '../src/main/cloud-files/supervisor'
import { CLOUD_IO_LIMITS, type CloudIoCommand } from '../src/main/cloud-files/worker-protocol'

const command: CloudIoCommand = { kind: 'metadata', identities: ['private-file'] }
function rig() {
  const workers: Array<{ events: CloudWorkerEvents; sent: string[]; kill: ReturnType<typeof vi.fn> }> = []
  const factory = vi.fn((events: CloudWorkerEvents): CloudWorkerHandle => {
    const worker = { events, sent: [] as string[], kill: vi.fn() }
    workers.push(worker)
    return { send: message => { worker.sent.push(message) }, kill: worker.kill }
  })
  const supervisor = new CloudFileSupervisor(factory)
  const owner = Symbol('owner')
  const request = (lane: 'preview' | 'purposeful' = 'preview', cmd = command) => supervisor.submit(owner, lane, cmd, 100)
  const reply = (index: number, sent = 0) => {
    const envelope = JSON.parse(workers[index].sent[sent])
    workers[index].events.message(JSON.stringify({ id: envelope.id, generation: envelope.generation, result: { kind: 'unsupported' } }))
  }
  return { supervisor, owner, workers, factory, request, reply }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
afterEach(() => { vi.useRealTimers() })

describe('bounded isolated cloud I/O', () => {
  it('uses the injected clock for queued deadlines without sending or killing active work', async () => {
    const callbacks: Array<() => void> = []
    const clears: ReturnType<typeof vi.fn>[] = []
    const send = vi.fn(); const kill = vi.fn()
    const supervisor = new CloudFileSupervisor(() => ({ send, kill }), { after(_ms, cb) {
      callbacks.push(cb); const clear = vi.fn(); clears.push(clear); return clear
    } })
    const active = supervisor.submit(Symbol(), 'preview', command)
    const activeSettled = Promise.allSettled([active.done])
    const queued = supervisor.submit(Symbol(), 'preview', command)
    const deadline = expect(queued.done).rejects.toThrow('deadline')
    callbacks[1]()
    await deadline
    expect(send).toHaveBeenCalledTimes(1)
    expect(kill).not.toHaveBeenCalled()
    expect(supervisor.snapshot().queued).toBe(0)
    expect(clears[1]).toHaveBeenCalledOnce()
    supervisor.shutdown(); await activeSettled
  })

  it('ignores a previous task response on a reused worker and keeps owners separate', async () => {
    const r = rig(); const first = r.request()
    r.reply(0); await first.done
    const second = r.supervisor.submit(Symbol('other-owner'), 'preview', command)
    r.reply(0, 0); await flush()
    expect(r.supervisor.snapshot().active).toBe(1)
    r.supervisor.cancelOwner(r.owner)
    expect(r.supervisor.snapshot().active).toBe(1)
    r.reply(0, 1)
    await expect(second.done).resolves.toEqual({ kind: 'unsupported' })
    expect(r.factory).toHaveBeenCalledOnce()
    r.supervisor.shutdown()
  })
  it('reserves purposeful capacity while a preview hangs; deadline is not an exit', async () => {
    vi.useFakeTimers()
    const r = rig()
    const hung = r.request(); const failed = expect(hung.done).rejects.toThrow('deadline')
    const other = r.request('purposeful')
    r.reply(1)
    await expect(other.done).resolves.toEqual({ kind: 'unsupported' })
    await vi.advanceTimersByTimeAsync(100)
    await failed
    expect(r.workers[0].kill).toHaveBeenCalledTimes(1)
    expect(r.supervisor.snapshot().lanes.preview).toBe('unavailable')
    expect(r.supervisor.snapshot().workers).toBe(2)
    r.supervisor.shutdown()
  })

  it('never exceeds two workers even when kill never exits; no automatic retries', async () => {
    vi.useFakeTimers()
    const r = rig()
    const a = r.request(); const b = r.request('purposeful')
    const settled = Promise.allSettled([a.done, b.done])
    await vi.advanceTimersByTimeAsync(100)
    await settled
    for (let i = 0; i < 20; i++) await expect(r.request().done).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(100_000)
    expect(r.factory).toHaveBeenCalledTimes(2)
    expect(r.supervisor.snapshot().retiring).toBe(2)
    r.supervisor.shutdown()
    expect(r.workers[0].kill).toHaveBeenCalledTimes(1)
  })

  it('bounds each queue and removes canceled queued entries before send', async () => {
    const r = rig()
    const active = r.request()
    const queued = Array.from({ length: CLOUD_IO_LIMITS.queuePerLane }, () => r.request())
    const all = Promise.allSettled([active.done, ...queued.map(q => q.done)])
    await expect(r.request().done).rejects.toThrow('busy')
    queued[0].cancel()
    r.reply(0)
    await flush()
    expect(r.workers[0].sent).toHaveLength(2)
    expect(JSON.parse(r.workers[0].sent[1]).id).not.toBe(queued[0].id)
    r.supervisor.shutdown()
    await all
  })

  it('ignores late timeout/exit/generation/task responses and only rejects the exiting worker job', async () => {
    vi.useFakeTimers()
    const r = rig()
    const a = r.request(); const settled = Promise.allSettled([a.done])
    await vi.advanceTimersByTimeAsync(100); await settled
    r.reply(0)
    r.workers[0].events.exit()
    await flush()
    const b = r.request(); const c = r.request('purposeful')
    const bFailure = expect(b.done).rejects.toThrow('worker-exited')
    r.reply(0)
    const old = JSON.parse(r.workers[0].sent[0])
    r.workers[1].events.message(JSON.stringify({ ...old, result: { kind: 'unsupported' } }))
    await flush()
    expect(r.supervisor.snapshot().active).toBe(2)
    r.workers[1].events.exit()
    await bFailure
    r.reply(2)
    await expect(c.done).resolves.toEqual({ kind: 'unsupported' })
    r.supervisor.shutdown()
  })

  it('shutdown settles active and queued promises, prevents respawn and hides paths/owners', async () => {
    const r = rig()
    const jobs = [r.request(), r.request(), r.request('purposeful')]
    const settled = Promise.allSettled(jobs.map(j => j.done))
    expect(JSON.stringify(r.supervisor.snapshot())).not.toContain('private-file')
    r.supervisor.cancelOwner(Symbol('foreign'))
    expect(r.supervisor.snapshot().active).toBe(2)
    r.supervisor.shutdown()
    expect((await settled).every(x => x.status === 'rejected')).toBe(true)
    r.workers[0].events.exit(); await flush()
    await expect(r.request().done).rejects.toThrow('shutdown')
    expect(r.factory).toHaveBeenCalledTimes(2)
  })

  it('isolates send/spawn throws and asynchronous worker errors without retrying', async () => {
    const spawn = vi.fn(() => { throw new Error('/secret/spawn') })
    const supervisor = new CloudFileSupervisor(spawn)
    await expect(supervisor.submit(Symbol(), 'preview', command).done).rejects.toThrow('spawn-failed')
    await expect(supervisor.submit(Symbol(), 'preview', command).done).rejects.toThrow('unavailable')
    expect(spawn).toHaveBeenCalledTimes(1)
    supervisor.shutdown()
    const kill = vi.fn()
    const bad = new CloudFileSupervisor(() => ({ send() { throw new Error('/secret/send') }, kill }))
    await expect(bad.submit(Symbol(), 'preview', command).done).rejects.toThrow('send-failed')
    expect(kill).toHaveBeenCalledTimes(1)
    bad.shutdown()
    const r = rig(); const job = r.request()
    const rejected = expect(job.done).rejects.toThrow('worker-error')
    r.workers[0].events.error(); await rejected
    r.supervisor.shutdown()
  })

  it('bounds request bytes/records and response bytes/records, and copies queued commands', async () => {
    const r = rig()
    await expect(r.request('preview', { kind: 'metadata', identities: ['x'.repeat(CLOUD_IO_LIMITS.requestBytes)] }).done).rejects.toThrow('invalid-payload')
    await expect(r.request('preview', { kind: 'metadata', identities: Array(CLOUD_IO_LIMITS.records + 1).fill('x') }).done).rejects.toThrow('invalid-payload')
    expect(r.factory).not.toHaveBeenCalled()
    const a = r.request(); const failed = expect(a.done).rejects.toThrow('invalid-payload')
    r.workers[0].events.message('x'.repeat(CLOUD_IO_LIMITS.responseBytes + 1))
    await failed
    r.workers[0].events.exit(); await flush()
    const active = r.request(); const mutable = { kind: 'metadata' as const, identities: ['original'] }
    const queued = r.request('preview', mutable); mutable.identities[0] = 'replacement'
    const settled = Promise.allSettled([active.done, queued.done])
    r.reply(1); await flush()
    expect(JSON.parse(r.workers[1].sent[1]).command.identities).toEqual(['original'])
    const envelope = JSON.parse(r.workers[1].sent[1])
    r.workers[1].events.message(JSON.stringify({ id: envelope.id, generation: envelope.generation,
      result: { kind: 'metadata', records: Array(CLOUD_IO_LIMITS.records + 1).fill({ identity: 'original', observation: { kind: 'absent' } }) } }))
    await settled
    expect(r.supervisor.snapshot().retiring).toBe(1)
    r.supervisor.shutdown()
  })

  it('survives reentrant worker events, throwing kill and owner cancellation', async () => {
    const supervisor = new CloudFileSupervisor(events => ({
      send(message) { const m = JSON.parse(message); events.message(JSON.stringify({ id: m.id, generation: m.generation, result: { kind: 'unsupported' } })) },
      kill() { throw new Error('kill failed') },
    }))
    await expect(supervisor.submit(Symbol(), 'preview', command).done).resolves.toEqual({ kind: 'unsupported' })
    supervisor.shutdown()
    const r = rig(); const active = r.request(); const queued = r.request()
    const settled = Promise.allSettled([active.done, queued.done])
    r.supervisor.cancelOwner(r.owner)
    expect((await settled).every(x => x.status === 'rejected')).toBe(true)
    expect(r.workers[0].sent).toHaveLength(1)
    r.supervisor.shutdown()
  })
})
