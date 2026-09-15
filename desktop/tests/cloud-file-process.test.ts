import { expect, it } from 'vitest'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import * as path from 'node:path'
import { CloudFileSupervisor } from '../src/main/cloud-files/supervisor'

it('a finite synchronously blocked child leaves parent heartbeat and purposeful work responsive', async () => {
  // Plain Node validates the process isolation principle, NOT Electron startup or
  // Windows driver cancellation. Only this fixture PID may be signaled in cleanup.
  const child = fork(path.join(__dirname, 'fixtures/cloud-io-block.cjs'), [], { execArgv: [], stdio: ['pipe', 'ignore', 'ignore', 'ipc'] })
  const exited = once(child, 'exit')
  let finish = false
  let releaseAcknowledged = false
  let beats = 0
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let blocking!: () => void
  const started = new Promise<void>(resolve => { blocking = resolve })
  child.on('message', message => {
    if (message === 'blocking') blocking()
    if (message === 'released') releaseAcknowledged = true
    if (message === 'finished') finish = true
  })
  let count = 0
  const supervisor = new CloudFileSupervisor(events => {
    if (++count === 1) {
      child.once('exit', () => events.exit())
      child.once('error', () => events.error())
      return { send: wire => { child.send(wire) }, kill: () => { child.kill() } }
    }
    return { send(wire) {
      const request = JSON.parse(wire)
      events.message(JSON.stringify({ id: request.id, generation: request.generation, result: { kind: 'unsupported' } }))
    }, kill() { events.exit() } }
  })
  try {
    const hung = supervisor.submit(Symbol(), 'preview', { kind: 'metadata', identities: ['fake'] }, 10_000)
    const rejected = expect(hung.done).rejects.toThrow('worker-exited')
    await started
    let beat!: () => void
    const heartbeating = new Promise<void>(resolve => { beat = resolve })
    heartbeat = setInterval(() => { beats++; beat() }, 5)
    const other = supervisor.submit(Symbol(), 'purposeful', { kind: 'metadata', identities: ['unrelated'] }, 10_000)
    await expect(other.done).resolves.toEqual({ kind: 'unsupported' })
    await heartbeating
    // WHY: release only after observing responsiveness, never race a fixed blocking window.
    expect(finish).toBe(false)
    child.stdin!.end('release')
    await exited
    await rejected
    expect(finish).toBe(true)
    expect(releaseAcknowledged).toBe(true)
    expect(beats).toBeGreaterThan(0)
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    supervisor.shutdown()
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  }
})
