import type {
  CloudAdapter, CloudFile, CloudOperationState, CloudOwner, CloudPurpose,
  CloudSnapshot, CloudSubscription, CloudCompletion, CloudContent,
} from '../../shared/cloud-file-types'
import { decideCloudRead } from './policy'

type Subscriber = {
  name: string
  purpose: CloudPurpose
  generation: number
  notify: (snapshot: CloudSnapshot) => void
  resolve: (snapshot: CloudCompletion) => void
  operation: Operation
}
type Operation = {
  id: string
  owner: CloudOwner
  purpose: CloudPurpose
  files: readonly CloudFile[]
  key: string
  state: CloudOperationState
  subscribers: Map<string, Subscriber>
  activated: boolean
  content: Map<string, CloudContent>
  byteLength: number
}
type Limits = { maxOperations?: number; maxFiles?: number; maxSubscribers?: number; maxBytesPerFile?: number; maxOperationBytes?: number }

/**
 * Owner-local, ephemeral coordinator. Call only from trusted main-process code.
 * Requests carry metadata observations made separately by the adapter; those
 * observations select policy, while consume enforces safety at the actual read.
 * Exact substantive sets deduplicate, retaining each subscriber's own purpose.
 * Passive work never joins substantive work. Overlap/subset reuse is deliberately
 * NOT implemented: a different set is a separate prompt, never a union grant.
 * No physical driver cancellation is attempted or promised.
 */
export class CloudFileOperations {
  private readonly pending = new Map<string, Operation>()
  // WHY: delivery interest outlives authority just long enough to fence reentrant terminal callbacks.
  private readonly interests = new Map<CloudOwner, Map<string, Subscriber>>()
  private readonly tearingDown = new Set<CloudOwner>()
  private serial = 0
  private generation = 0
  private readonly limits: Required<Limits>

  constructor(private readonly adapter: CloudAdapter, limits: Limits = {}) {
    this.limits = { maxOperations: 128, maxFiles: 64, maxSubscribers: 32,
      maxBytesPerFile: 8 * 1024 * 1024, maxOperationBytes: 16 * 1024 * 1024, ...limits }
    for (const [key, value] of Object.entries(this.limits)) {
      const ceiling = key === 'maxBytesPerFile' || key === 'maxOperationBytes' ? 64 * 1024 * 1024 : 4096
      if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error('Invalid capacity')
    }
  }

  get size(): number { return this.pending.size }

  request(owner: CloudOwner, purpose: CloudPurpose, input: readonly CloudFile[], subscriber: string,
    notify: (snapshot: CloudSnapshot) => void): CloudSubscription {
    if (this.tearingDown.has(owner)) throw new Error('Cloud owner is closing')
    if (!input.length || input.length > this.limits.maxFiles || subscriber.length > 4096) throw new Error('Cloud capacity exceeded')
    // WHY: neither the caller nor a snapshot consumer can expand the named scope after approval.
    const files = Object.freeze(input.map(f => {
      if (!f.identity || !f.name || f.identity.length > 4096 || f.name.length > 4096) throw new Error('Invalid file identity/name')
      return Object.freeze({ identity: f.identity, name: f.name, observation: Object.freeze({ ...f.observation }) })
    }))
    if (new Set(files.map(f => f.identity)).size !== files.length) throw new Error('Duplicate file identity')
    const key = JSON.stringify(files.map(f => [f.identity, f.name]).sort((a, b) => a[0].localeCompare(b[0])))
    const lane = (p: CloudPurpose): string => ['file', 'instructions', 'context'].includes(p) ? 'substantive' : p
    let operation = [...this.pending.values()].find(o => o.owner === owner && lane(o.purpose) === lane(purpose) && o.key === key)
    if (!operation && this.pending.size >= this.limits.maxOperations) throw new Error('Cloud capacity exceeded')
    if (operation && !operation.subscribers.has(subscriber) && operation.subscribers.size >= this.limits.maxSubscribers) {
      throw new Error('Cloud capacity exceeded')
    }
    const previous = this.interests.get(owner)?.get(subscriber)
    if (!operation) {
      operation = { id: `cloud-${++this.serial}`, owner, purpose, files, key,
        state: 'awaiting-consent', subscribers: new Map(), activated: false, content: new Map(), byteLength: 0 }
      this.pending.set(operation.id, operation)
    }
    let resolve!: (snapshot: CloudCompletion) => void
    const done = new Promise<CloudCompletion>(yes => { resolve = yes })
    const sub: Subscriber = { name: subscriber, purpose, generation: ++this.generation, notify, resolve, operation }
    operation.subscribers.set(subscriber, sub)
    const ownerInterests = this.interests.get(owner) ?? new Map<string, Subscriber>()
    ownerInterests.set(subscriber, sub)
    this.interests.set(owner, ownerInterests)
    const handle = Object.freeze({ id: operation.id, generation: sub.generation, done })
    // WHY: register BEFORE notifying the superseded listener. A nested request is newer
    // than this one and must resolve/supersede it rather than being overwritten by it.
    if (previous) this.detach(previous.operation, previous, previous.operation.state === 'awaiting-consent' ? 'denied' : 'abandoned')
    if (!this.current(sub) || this.pending.get(operation.id) !== operation) return handle
    if (operation.activated) this.deliver(sub, this.view(operation, sub))
    else this.activate(operation)
    return handle
  }

  private activate(operation: Operation): void {
    operation.activated = true
    const decisions = operation.files.map(f => decideCloudRead(operation.purpose, f.observation, this.adapter.noRecall))
    const refusal = decisions.find(d => d === 'error' || d === 'absent' || d === 'unsupported')
    if (refusal === 'error' || refusal === 'absent' || refusal === 'unsupported') this.finish(operation, refusal)
    else if (decisions.includes('skip')) this.finish(operation, 'skipped')
    else if (decisions.includes('consent')) this.publish(operation)
    else this.start(operation, false)
  }

  snapshot(owner: CloudOwner, id: string): CloudSnapshot | undefined {
    const operation = this.owned(owner, id)
    return operation && this.view(operation)
  }

  respond(owner: CloudOwner, id: string, approve: boolean): boolean {
    if (this.tearingDown.has(owner)) return false
    const operation = this.owned(owner, id)
    if (!operation || operation.state !== 'awaiting-consent') return false
    if (approve) this.start(operation, true)
    else this.finish(operation, 'denied')
    return true
  }

  dismiss(owner: CloudOwner, id: string, subscriber: string, generation: number): boolean {
    const sub = this.interests.get(owner)?.get(subscriber)
    if (!sub || sub.operation.id !== id || sub.generation !== generation) return false
    this.detach(sub.operation, sub, sub.operation.state === 'awaiting-consent' ? 'denied' : 'abandoned')
    return true
  }

  teardown(owner: CloudOwner): void {
    if (this.tearingDown.has(owner)) return
    this.tearingDown.add(owner)
    try {
      for (const operation of [...this.pending.values()]) {
        if (operation.owner === owner) this.finish(operation, 'abandoned')
      }
      for (const sub of [...(this.interests.get(owner)?.values() ?? [])]) this.detach(sub.operation, sub, 'abandoned')
    } finally { this.tearingDown.delete(owner) }
  }

  private current(sub: Subscriber): boolean {
    return this.interests.get(sub.operation.owner)?.get(sub.name) === sub
  }

  private unregister(sub: Subscriber): void {
    if (!this.current(sub)) return
    const owner = sub.operation.owner
    const interests = this.interests.get(owner)!
    interests.delete(sub.name)
    if (!interests.size) this.interests.delete(owner)
  }

  private owned(owner: CloudOwner, id: string): Operation | undefined {
    const operation = this.pending.get(id)
    return operation?.owner === owner ? operation : undefined
  }

  private view(operation: Operation, subscriber?: Subscriber, state = operation.state): CloudSnapshot {
    return Object.freeze({ id: operation.id, purpose: subscriber?.purpose ?? operation.purpose, files: operation.files, state,
      subscriber: subscriber?.name, generation: subscriber?.generation,
      openEligible: !!subscriber && state === 'ready' && subscriber.purpose === 'file',
      continueEligible: !!subscriber && state === 'ready' && subscriber.purpose === 'instructions' })
  }

  private deliver(sub: Subscriber, snapshot: CloudSnapshot): void {
    // WHY: one broken/detached UI listener must not strand another subscriber's work or authority.
    try { void Promise.resolve(sub.notify(snapshot)).catch(() => {}) } catch { /* delivery does not control authorization */ }
  }

  private publish(operation: Operation): void {
    for (const sub of [...operation.subscribers.values()]) {
      if (this.pending.get(operation.id) !== operation || !this.current(sub)) continue
      this.deliver(sub, this.view(operation, sub))
    }
  }

  private detach(operation: Operation, sub: Subscriber, state: 'denied' | 'abandoned'): void {
    if (operation.subscribers.get(sub.name) === sub) operation.subscribers.delete(sub.name)
    this.unregister(sub)
    const snapshot = this.view(operation, sub, state)
    // WHY: revoke the last dismissed prompt BEFORE callbacks can submit a stale approval.
    if (!operation.subscribers.size && operation.state === 'awaiting-consent') this.finish(operation, 'denied')
    sub.resolve(snapshot)
    this.deliver(sub, snapshot)
  }

  private finish(operation: Operation, state: CloudOperationState): void {
    if (this.pending.get(operation.id) !== operation) return
    // WHY: erase authority BEFORE notifying; reentrant requests must create fresh operations.
    this.pending.delete(operation.id)
    operation.state = state
    for (const sub of [...operation.subscribers.values()]) {
      if (!this.current(sub)) continue
      // WHY: revoke authority first, but retain other subscribers' interest until
      // their own delivery. Earlier callbacks may dismiss, replace, or tear them down.
      operation.subscribers.delete(sub.name)
      this.unregister(sub)
      const snapshot = this.view(operation, sub)
      const completion: CloudCompletion = state === 'ready'
        ? Object.freeze({ ...snapshot, content: Object.freeze(operation.files.map(file => {
          const content = operation.content.get(file.identity)!
          return Object.freeze({ identity: content.identity, bytes: new Uint8Array(content.bytes) })
        })) })
        : snapshot
      sub.resolve(completion)
      this.deliver(sub, snapshot)
    }
    operation.subscribers.clear()
    operation.content.clear()
    operation.byteLength = 0
  }

  private start(operation: Operation, approved: boolean): void {
    operation.state = 'requesting'
    this.publish(operation)
    let remaining = operation.files.length
    for (const file of operation.files) {
      if (this.pending.get(operation.id) !== operation) break
      const decision = decideCloudRead(operation.purpose, file.observation, this.adapter.noRecall)
      const authorization = decision === 'consent' && approved
        ? Object.freeze({ mode: 'authorized' as const, operationId: operation.id, identity: file.identity })
        : Object.freeze({ mode: 'no-recall' as const })
      // WHY: metadata is not a lock. Only the adapter can consume the exact identity safely;
      // unsupported/changed results are terminal and NEVER retry through ordinary file APIs.
      try {
        void this.adapter.consume(file, authorization, () => {
          if (this.pending.get(operation.id) !== operation || authorization.mode !== 'authorized') return
          operation.state = 'downloading'
          this.publish(operation)
        }, Math.min(this.limits.maxBytesPerFile, this.limits.maxOperationBytes)).then(result => {
          if (this.pending.get(operation.id) !== operation) return
          if (result.kind !== 'ready') {
            this.finish(operation, result.kind === 'identity-changed' ? 'reapproval-required' : result.kind)
          } else if (result.identity !== file.identity) this.finish(operation, 'reapproval-required')
          else if (!(result.bytes instanceof Uint8Array)) this.finish(operation, 'error')
          else if (result.bytes.byteLength > this.limits.maxBytesPerFile
            || operation.byteLength + result.bytes.byteLength > this.limits.maxOperationBytes) this.finish(operation, 'too-large')
          else {
            // WHY: own the adapter's bytes once, then copy only at each permitted completion;
            // status events never duplicate payloads and consumers cannot mutate each other.
            operation.content.set(file.identity, { identity: file.identity, bytes: new Uint8Array(result.bytes) })
            operation.byteLength += result.bytes.byteLength
            if (--remaining === 0) this.finish(operation, 'ready')
          }
        }).catch(() => { this.finish(operation, 'error') })
      } catch { this.finish(operation, 'error') }
    }
  }
}
