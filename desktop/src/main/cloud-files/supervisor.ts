import type { CloudOwner } from '../../shared/cloud-file-types'
import {
  CLOUD_IO_LIMITS, cloudResultMatches, decodeCloudRequest, decodeCloudResponse, encodeCloudRequest,
  type CloudIoCommand, type CloudIoResult,
} from './worker-protocol'

export interface CloudWorkerEvents { message(wire: unknown): void; exit(): void; error(): void }
export interface CloudWorkerHandle { send(wire: string): void; kill(): void }
/** Factory must own a newly created process, install callbacks synchronously, and
 * throw only if no process was created. No global process lookup/killing. */
export type CloudWorkerFactory = (events: CloudWorkerEvents) => CloudWorkerHandle
export interface CloudIoClock { after(ms: number, callback: () => void): () => void }
type Lane = 'preview' | 'purposeful'
type Job = { id: number; owner: CloudOwner; command: CloudIoCommand;
  resolve(result: CloudIoResult): void; reject(error: Error): void; clearTimer(): void }
type Slot = { generation: number; handle?: CloudWorkerHandle; job?: Job; retiring: boolean; exited: boolean }
type LaneState = { slot?: Slot; queue: Job[]; broken: boolean }
const realClock: CloudIoClock = { after(ms, callback) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) } }

/** Private transport, NOT an authorization service or an implementation of no-recall.
 * One fixed slot per lane: previews cannot occupy purposeful capacity, including
 * while retiring. A deadline releases the caller, NOT an OS cancellation guarantee.
 * There are no retries, caches, external listeners or path-bearing status/error text.
 */
export class CloudFileSupervisor {
  private readonly lanes: Record<Lane, LaneState> = {
    preview: { queue: [], broken: false }, purposeful: { queue: [], broken: false },
  }
  private serial = 0
  private generation = 0
  private closed = false
  constructor(private readonly factory: CloudWorkerFactory, private readonly clock: CloudIoClock = realClock) {}

  submit(owner: CloudOwner, lane: Lane, command: CloudIoCommand, deadlineMs = 10_000): {
    id: number; done: Promise<CloudIoResult>; cancel(): void
  } {
    const id = ++this.serial
    let resolve!: Job['resolve']; let reject!: Job['reject']
    const done = new Promise<CloudIoResult>((yes, no) => { resolve = yes; reject = no })
    const state = this.lanes[lane]
    const refusal = this.closed ? 'shutdown' : !state || state.broken || state.slot?.retiring ? 'unavailable'
      : state.slot?.job && state.queue.length >= CLOUD_IO_LIMITS.queuePerLane ? 'busy' : undefined
    // WHY: validate/snapshot before retaining queued input, and never trust an object
    // mutated after submit. Generation is assigned again when actually dispatched.
    const wire = refusal ? undefined : encodeCloudRequest({ id, generation: 1, command })
    if (refusal || !wire || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000) {
      reject(new Error(refusal ?? 'invalid-payload'))
      return { id, done, cancel() {} }
    }
    const job: Job = { id, owner, command: decodeCloudRequest(wire)!.command, resolve, reject, clearTimer() {} }
    state.queue.push(job)
    job.clearTimer = this.clock.after(deadlineMs, () => this.cancelJob(state, job, 'deadline'))
    this.drain(state)
    return { id, done, cancel: () => this.cancelJob(state, job, 'canceled') }
  }

  /** Aggregate only: safe to inspect without knowing any other owner's filenames. */
  snapshot() {
    const values = Object.values(this.lanes)
    const status = (s: LaneState) => this.closed || s.broken || s.slot?.retiring ? 'unavailable' : s.slot?.job ? 'busy' : 'available'
    return { closed: this.closed, workers: values.filter(s => s.slot).length,
      retiring: values.filter(s => s.slot?.retiring).length,
      active: values.filter(s => s.slot?.job).length, queued: values.reduce((n, s) => n + s.queue.length, 0),
      lanes: { preview: status(this.lanes.preview), purposeful: status(this.lanes.purposeful) } }
  }

  cancelOwner(owner: CloudOwner): void {
    for (const state of Object.values(this.lanes)) {
      // Remove unsent entries first so a synchronous exit cannot dispatch one.
      for (const job of [...state.queue]) if (job.owner === owner) this.cancelJob(state, job, 'canceled')
      if (state.slot?.job?.owner === owner) this.cancelJob(state, state.slot.job, 'canceled')
    }
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    for (const state of Object.values(this.lanes)) {
      this.failQueue(state, 'shutdown')
      if (state.slot) this.retire(state, state.slot, 'shutdown')
    }
  }

  private fail(job: Job, code: string): void { job.clearTimer(); job.reject(new Error(code)) }
  private failQueue(state: LaneState, code: string): void {
    const jobs = state.queue.splice(0)
    for (const job of jobs) this.fail(job, code)
  }
  private cancelJob(state: LaneState, job: Job, code: string): void {
    const index = state.queue.indexOf(job)
    if (index >= 0) { state.queue.splice(index, 1); this.fail(job, code) }
    else if (state.slot?.job === job) this.retire(state, state.slot, code)
  }
  private retire(state: LaneState, slot: Slot, code: string): void {
    if (slot.retiring || slot.exited) return
    slot.retiring = true
    const job = slot.job; slot.job = undefined
    if (job) this.fail(job, code)
    this.failQueue(state, 'unavailable')
    // WHY: kill can fail or leave a kernel-blocked process alive. Only EXIT frees
    // this slot. Never spawn replacement capacity based on a kill return value.
    try { slot.handle?.kill() } catch { /* still counted as retiring */ }
  }

  private drain(state: LaneState): void {
    if (this.closed || state.broken || state.slot?.retiring || state.slot?.job || !state.queue.length) return
    let slot = state.slot
    if (!slot) {
      slot = { generation: ++this.generation, retiring: false, exited: false }
      state.slot = slot
      const owned = slot
      // WHY: even fake/synchronous transports can emit from send/factory/kill.
      // Deferring callbacks prevents reentrancy before ownership is established;
      // all handlers are synchronous and contain errors, so none float promises.
      const event = (callback: () => void) => queueMicrotask(() => {
        if (state.slot !== owned || owned.exited) return
        try { callback() } catch { this.retire(state, owned, 'worker-error') }
      })
      try {
        slot.handle = this.factory({
          message: wire => event(() => this.receive(state, owned, wire)),
          exit: () => event(() => {
            owned.exited = true
            const job = owned.job; owned.job = undefined; state.slot = undefined
            if (job) this.fail(job, 'worker-exited')
            this.drain(state)
          }),
          error: () => event(() => this.retire(state, owned, 'worker-error')),
        })
      } catch {
        state.slot = undefined; state.broken = true
        this.failQueue(state, 'spawn-failed')
        return
      }
    }
    const job = state.queue.shift()!
    slot.job = job
    const wire = encodeCloudRequest({ id: job.id, generation: slot.generation, command: job.command })
    // A later generation may add digits to a request at the exact wire ceiling.
    if (!wire) { slot.job = undefined; this.fail(job, 'invalid-payload'); this.drain(state); return }
    try { slot.handle!.send(wire) } catch { this.retire(state, slot, 'send-failed') }
  }

  private receive(state: LaneState, slot: Slot, wire: unknown): void {
    if (slot.retiring || !slot.job) return
    const response = decodeCloudResponse(wire)
    if (!response) { this.retire(state, slot, 'invalid-payload'); return }
    const job = slot.job
    if (response.id !== job.id || response.generation !== slot.generation) return
    if (!cloudResultMatches(job.command, response.result)) { this.retire(state, slot, 'invalid-payload'); return }
    slot.job = undefined
    job.clearTimer(); job.resolve(response.result)
    this.drain(state)
  }
}
