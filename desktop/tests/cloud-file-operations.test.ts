import { describe, expect, it, vi } from 'vitest'
import { CloudFileOperations } from '../src/main/cloud-files/operations'
import type { CloudAdapter, CloudFile, CloudReadResult, CloudSnapshot, CloudPurpose } from '../src/shared/cloud-file-types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const file = (identity = 'a', residency: 'local' | 'cloud' | 'partial' | 'unknown' = 'cloud'): CloudFile => ({
  identity, name: `${identity}.md`, observation: { kind: 'present', residency },
})
function rig(limits = {}) {
  const calls: { file: CloudFile; mode: string; acknowledge: () => void; result: ReturnType<typeof deferred<CloudReadResult>> }[] = []
  const adapter: CloudAdapter = {
    noRecall: true,
    observe: vi.fn(async () => ({ kind: 'present', residency: 'cloud' } as const)),
    consume: vi.fn((f, authorization, acknowledge) => {
      const result = deferred<CloudReadResult>()
      calls.push({ file: f, mode: authorization.mode, acknowledge, result })
      return result.promise
    }),
  }
  const ops = new CloudFileOperations(adapter, limits)
  const owner = Symbol('trusted owner')
  const events: CloudSnapshot[] = []
  const start = (files = [file()], subscriber = 'popup', purpose: CloudPurpose = 'file', who = owner) =>
    ops.request(who, purpose, files, subscriber, s => events.push(s))
  return { ops, owner, events, calls, adapter, start }
}

describe('review regressions', () => {
  it('delivers bounded protected bytes once per subscriber, never in status events', async () => {
    const r = rig({ maxBytesPerFile: 4, maxOperationBytes: 6 })
    const a = r.start(); const b = r.start([file()], 'other')
    r.ops.respond(r.owner, a.id, true)
    expect(r.adapter.consume).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(Function), 4)
    const bytes = new Uint8Array([1, 2])
    r.calls[0].result.resolve({ kind: 'ready', identity: 'a', bytes })
    const first = await a.done; bytes[0] = 9
    const second = await b.done
    expect(first.content?.[0].identity).toBe('a')
    expect(first.content?.[0].bytes).toEqual(new Uint8Array([1, 2]))
    first.content![0].bytes[0] = 7
    expect(second.content?.[0].bytes).toEqual(new Uint8Array([1, 2]))
    expect(r.events.every(s => !('content' in s))).toBe(true)
    expect(r.calls).toHaveLength(1)
  })
  it('delivers every batch identity in named order and keeps owners separate', async () => {
    const r = rig(); const ownerB = Symbol('second owner')
    const first = r.start([file('a'), file('b')])
    const second = r.start([file('a'), file('b')], 'popup', 'file', ownerB)
    r.ops.respond(r.owner, first.id, true)
    r.calls[1].result.resolve({ kind: 'ready', identity: 'b', bytes: new Uint8Array([2]) })
    r.calls[0].result.resolve({ kind: 'ready', identity: 'a', bytes: new Uint8Array([1]) })
    const result = await first.done
    expect(result.content?.map(c => c.identity)).toEqual(['a', 'b'])
    result.content![0].bytes[0] = 99
    expect(r.ops.snapshot(ownerB, second.id)?.state).toBe('awaiting-consent')
    r.ops.respond(ownerB, second.id, false)
    expect((await second.done).content).toBeUndefined()
    expect(r.calls).toHaveLength(2)
  })
  it.each(['oversize', 'wrong-identity', 'batch-limit'] as const)('rejects payload %s without delivering partial content', async mode => {
    const r = rig({ maxBytesPerFile: 3, maxOperationBytes: 3 })
    const h = r.start(mode === 'batch-limit' ? [file('a'), file('b')] : [file()])
    r.ops.respond(r.owner, h.id, true)
    r.calls[0].result.resolve({ kind: 'ready', identity: mode === 'wrong-identity' ? 'b' : 'a', bytes: new Uint8Array(mode === 'oversize' ? 4 : 2) })
    if (mode === 'batch-limit') r.calls[1].result.resolve({ kind: 'ready', identity: 'b', bytes: new Uint8Array(2) })
    const result = await h.done
    expect(result.state).toBe(mode === 'wrong-identity' ? 'reapproval-required' : 'too-large')
    expect(result.content).toBeUndefined()
  })
  it.each(['a', 'b'])('nested replacement selecting %s wins without orphaning either done', async identity => {
    const r = rig(); let nested: ReturnType<typeof r.start> | undefined
    r.ops.request(r.owner, 'file', [file()], 'popup', s => {
      if (s.state === 'denied') nested = r.start([file(identity)])
    })
    const outer = r.start()
    expect(nested).toBeDefined()
    expect(r.ops.dismiss(r.owner, nested!.id, 'popup', nested!.generation)).toBe(true)
    expect((await nested!.done).state).toBe('denied')
    expect((await outer.done).openEligible).toBe(false)
    expect(r.calls).toHaveLength(0)
  })
  it.each(['teardown', 'dismiss', 'new-selection'] as const)('terminal callback %s suppresses later ready delivery', async action => {
    const r = rig(); let second: ReturnType<typeof r.start>
    const first = r.ops.request(r.owner, 'file', [file()], 'first', s => {
      if (s.state !== 'ready') return
      if (action === 'teardown') r.ops.teardown(r.owner)
      else if (action === 'dismiss') r.ops.dismiss(r.owner, second.id, 'second', second.generation)
      else r.start([file('b')], 'second')
    })
    second = r.start([file()], 'second')
    r.ops.respond(r.owner, first.id, true)
    r.calls[0].result.resolve({ kind: 'ready', identity: 'a', bytes: new Uint8Array([3]) })
    await first.done
    const result = await second.done
    expect(result.openEligible).toBe(false)
    expect(result.content).toBeUndefined()
    expect(r.events.some(e => e.subscriber === 'second' && e.state === 'ready')).toBe(false)
  })
  it('owner teardown cannot authorize another pending operation from a callback', () => {
    const r = rig(); let second: ReturnType<typeof r.start>
    r.ops.request(r.owner, 'file', [file()], 'first', s => {
      if (s.state === 'abandoned') r.ops.respond(r.owner, second.id, true)
    })
    second = r.start([file('b')], 'second')
    r.ops.teardown(r.owner)
    expect(r.calls).toHaveLength(0)
  })
  it('observes async listener rejection, including a void-typed listener', async () => {
    const r = rig(); const rejected = Promise.reject(new Error('listener failure'))
    const caught = vi.spyOn(rejected, 'then')
    // Hold a test-side catch so RED proves the missing handler without poisoning the runner.
    void rejected.catch(() => {})
    caught.mockClear()
    const notify: (snapshot: CloudSnapshot) => void = async () => { await rejected }
    // A directly returned promise also lets us assert the coordinator attached its handler.
    r.ops.request(r.owner, 'file', [file()], 'direct', () => rejected)
    expect(caught).toHaveBeenCalled()
    r.ops.request(r.owner, 'file', [file()], 'async', notify)
    r.ops.teardown(r.owner)
    await rejected.catch(() => {})
  })
})

describe('ephemeral cloud operations', () => {
  for (const purpose of ['preview', 'description', 'count', 'search', 'optional-discovery'] as const) {
    for (const residency of ['cloud', 'partial', 'unknown'] as const) {
      it(`${purpose} ${residency}: no prompt or data call`, async () => {
        const r = rig(); const h = r.start([file('a', residency)], 'passive', purpose)
        expect((await h.done).state).toBe('skipped')
        expect(r.calls).toHaveLength(0)
        expect(r.events.some(e => e.state === 'awaiting-consent')).toBe(false)
      })
    }
  }
  for (const purpose of ['preview', 'description', 'count', 'search', 'optional-discovery'] as const) {
    it(`${purpose}: safe local consumption never prompts or reports downloading`, async () => {
      const r = rig(); const h = r.start([file('a', 'local')], 'passive', purpose)
      expect(r.calls[0].mode).toBe('no-recall')
      r.calls[0].acknowledge()
      expect(r.events.at(-1)?.state).toBe('requesting')
      r.calls[0].result.resolve({ kind: 'ready', identity: 'a', bytes: new Uint8Array() })
      expect((await h.done).openEligible).toBe(false)
      expect(r.events.some(e => e.state === 'awaiting-consent')).toBe(false)
    })
  }
  it('passive work cannot join an authorized substantive download', async () => {
    const r = rig(); const h = r.start(); r.ops.respond(r.owner, h.id, true)
    const preview = r.start([file()], 'preview', 'preview')
    expect((await preview.done).state).toBe('skipped')
    expect(r.calls).toHaveLength(1)
  })
  it('fake capability checks identity and no-recall at consumption, independently of metadata', async () => {
    let currentIdentity = 'a'
    let local = false
    const dataRead = vi.fn()
    const adapter: CloudAdapter = {
      noRecall: true,
      observe: async () => ({ kind: 'present', residency: local ? 'local' : 'cloud' }),
      consume: async (f, authorization, acknowledge) => {
        // Model an atomic capability, not a check followed by a pathname read.
        if (currentIdentity !== f.identity) return { kind: 'identity-changed' }
        if (authorization.mode === 'no-recall' && !local) return { kind: 'unsupported' }
        if (authorization.mode === 'authorized') {
          expect(authorization.identity).toBe(f.identity)
          acknowledge()
        }
        dataRead(currentIdentity)
        return { kind: 'ready', identity: 'a', bytes: new Uint8Array() }
      },
    }
    const ops = new CloudFileOperations(adapter); const owner = Symbol('owner')
    const observed = { ...file(), observation: await adapter.observe('a') }
    const h = ops.request(owner, 'file', [observed], 'popup', () => {})
    currentIdentity = 'replacement'
    ops.respond(owner, h.id, true)
    expect((await h.done).state).toBe('reapproval-required')
    expect(dataRead).not.toHaveBeenCalled()
    currentIdentity = 'a'; local = true
    const wasLocal = { ...file(), observation: await adapter.observe('a') }
    local = false
    expect((await ops.request(owner, 'file', [wasLocal], 'popup', () => {}).done).state).toBe('unsupported')
    expect(dataRead).not.toHaveBeenCalled()
    const approved = ops.request(owner, 'file', [observed], 'popup', () => {})
    ops.respond(owner, approved.id, true)
    expect((await approved.done).state).toBe('ready')
    expect(dataRead).toHaveBeenCalledExactlyOnceWith('a')
  })
  it('denial and consent dismissal make no data call', async () => {
    const r = rig(); const h = r.start()
    expect(r.ops.respond(r.owner, h.id, false)).toBe(true)
    expect((await h.done).state).toBe('denied')
    const next = r.start(); r.ops.dismiss(r.owner, next.id, 'popup', next.generation)
    expect((await next.done).state).toBe('denied')
    expect(r.calls).toHaveLength(0)
    expect(r.ops.respond(r.owner, next.id, true)).toBe(false)
  })
  it('dismissal revokes the last prompt before notifying its subscriber', () => {
    const r = rig()
    const h = r.ops.request(r.owner, 'file', [file()], 'popup', snapshot => {
      if (snapshot.state === 'denied') r.ops.respond(r.owner, snapshot.id, true)
    })
    r.ops.dismiss(r.owner, h.id, 'popup', h.generation)
    expect(r.calls).toHaveLength(0)
    expect(r.ops.size).toBe(0)
  })
  it('exact approval, acknowledgement, duplicate response and terminal authority', async () => {
    const r = rig(); const h = r.start()
    expect(r.calls).toHaveLength(0)
    expect(r.ops.respond(r.owner, h.id, true)).toBe(true)
    expect(r.calls[0].mode).toBe('authorized')
    expect(r.events.at(-1)?.state).toBe('requesting')
    expect(r.ops.respond(r.owner, h.id, true)).toBe(false)
    r.calls[0].acknowledge()
    expect(r.events.at(-1)?.state).toBe('downloading')
    r.calls[0].result.resolve({ kind: 'ready', identity: 'a', bytes: new Uint8Array() })
    expect((await h.done).state).toBe('ready')
    expect(r.ops.size).toBe(0)
    expect(r.ops.respond(r.owner, h.id, true)).toBe(false)
    const next = r.start()
    expect(next.id).not.toBe(h.id)
    expect(r.events.at(-1)?.state).toBe('awaiting-consent')
    expect(r.calls).toHaveLength(1)
  })
  it('deduplicates same owner exact set; subscribers dismiss independently', async () => {
    const r = rig(); const h = r.start(); const other = r.start([file()], 'other')
    expect(other.id).toBe(h.id)
    r.ops.dismiss(r.owner, h.id, 'popup', h.generation)
    expect((await h.done).state).toBe('denied')
    expect(r.ops.respond(r.owner, other.id, true)).toBe(true)
    expect(r.calls).toHaveLength(1)
    r.calls[0].result.resolve({ kind: 'ready', identity: 'a', bytes: new Uint8Array() })
    expect((await other.done).openEligible).toBe(true)
  })
  it('never shares prompt, details, or authority across owners', async () => {
    const r = rig(); const h = r.start(); const foreign = Symbol('trusted owner')
    const other = r.start([file()], 'popup', 'file', foreign)
    expect(other.id).not.toBe(h.id)
    expect(r.ops.snapshot(foreign, h.id)).toBeUndefined()
    expect(r.ops.respond(foreign, h.id, true)).toBe(false)
    r.ops.respond(r.owner, h.id, true)
    expect(r.calls).toHaveLength(1)
    expect(r.ops.snapshot(foreign, other.id)?.state).toBe('awaiting-consent')
    r.ops.teardown(r.owner)
    expect(r.ops.respond(foreign, other.id, true)).toBe(true)
    r.calls[1].result.resolve({ kind: 'ready', identity: 'a', bytes: new Uint8Array() })
    expect((await other.done).state).toBe('ready')
  })
  it('batches exact names; extra file makes a separate prompt, never an unsafe union', () => {
    const r = rig(); const h = r.start([file('a'), file('b')])
    expect(r.ops.snapshot(r.owner, h.id)?.files.map(f => f.identity)).toEqual(['a', 'b'])
    r.ops.respond(r.owner, h.id, true)
    const extra = r.start([file('b'), file('c')], 'new')
    expect(extra.id).not.toBe(h.id)
    expect(r.ops.snapshot(r.owner, extra.id)?.state).toBe('awaiting-consent')
    expect(r.calls.map(c => c.file.identity)).not.toContain('c')
  })
  it('waiting dismissal suppresses opening; explicit re-click uses current generation', async () => {
    const r = rig(); const h = r.start(); r.ops.respond(r.owner, h.id, true)
    r.ops.dismiss(r.owner, h.id, 'popup', h.generation)
    expect((await h.done).openEligible).toBe(false)
    const again = r.start()
    expect(again.id).toBe(h.id)
    expect(again.generation).not.toBe(h.generation)
    expect(r.ops.dismiss(r.owner, h.id, 'popup', h.generation)).toBe(false)
    r.calls[0].result.resolve({ kind: 'ready', identity: 'a', bytes: new Uint8Array() })
    expect((await again.done).openEligible).toBe(true)
    expect(r.calls).toHaveLength(1)
  })
  it('dismiss-complete never opens and instructions continue independently', async () => {
    const r = rig(); const h = r.start(); const instruction = r.start([file()], 'conversation', 'instructions')
    expect(instruction.id).toBe(h.id)
    r.ops.respond(r.owner, h.id, true)
    expect(r.calls).toHaveLength(1)
    r.ops.dismiss(r.owner, h.id, 'popup', h.generation)
    r.calls.forEach(c => c.result.resolve({ kind: 'ready', identity: 'a', bytes: new Uint8Array() }))
    expect((await h.done).openEligible).toBe(false)
    expect((await instruction.done).continueEligible).toBe(true)
    expect(r.events.filter(e => e.state === 'ready' && e.openEligible)).toHaveLength(0)
  })
  it('a newer selection fences the previous view even without a dismissal', async () => {
    const r = rig(); const h = r.start(); r.ops.respond(r.owner, h.id, true)
    r.start([file('b')]); r.calls[0].result.resolve({ kind: 'ready', identity: 'a', bytes: new Uint8Array() })
    expect((await h.done).openEligible).toBe(false)
  })
  it('owner teardown drops authority and ignores late acknowledgement/results', async () => {
    const r = rig(); const h = r.start(); r.ops.respond(r.owner, h.id, true)
    r.ops.teardown(r.owner); const count = r.events.length
    expect((await h.done).state).toBe('abandoned')
    r.calls[0].acknowledge(); r.calls[0].result.resolve({ kind: 'ready', identity: 'a', bytes: new Uint8Array() })
    await r.calls[0].result.promise
    expect(r.events).toHaveLength(count)
    expect(r.ops.size).toBe(0)
  })
  it.each(['unsupported', 'identity-changed', 'absent', 'error'] as const)('adapter %s is explicit, no fallback', async kind => {
    const r = rig(); const h = r.start(); r.ops.respond(r.owner, h.id, true)
    r.calls[0].result.resolve({ kind })
    expect((await h.done).state).toBe(kind === 'identity-changed' ? 'reapproval-required' : kind)
    expect(r.ops.size).toBe(0)
    expect(r.calls).toHaveLength(1)
  })
  it('local content uses only the identity-checked no-recall capability', async () => {
    const r = rig(); const h = r.start([file('a', 'local')])
    expect(r.calls[0].mode).toBe('no-recall')
    expect(r.calls[0].file.identity).toBe('a')
    r.calls[0].result.resolve({ kind: 'ready', identity: 'a', bytes: new Uint8Array() }); expect((await h.done).state).toBe('ready')
  })
  it('local unsupported and metadata errors do not call consume', async () => {
    const r = rig(); r.adapter.noRecall = false
    expect((await r.start([file('a', 'local')]).done).state).toBe('unsupported')
    for (const kind of ['absent', 'error'] as const) {
      expect((await r.start([{ ...file(), observation: { kind } }]).done).state).toBe(kind)
    }
    expect(r.calls).toHaveLength(0)
  })
  it('adapter rejection terminates and erases authority', async () => {
    const r = rig(); const h = r.start(); r.ops.respond(r.owner, h.id, true)
    r.calls[0].result.reject(new Error('failure'))
    expect((await h.done).state).toBe('error'); expect(r.ops.size).toBe(0)
  })
  it('copies and freezes caller-visible scope', () => {
    const r = rig(); const f = file(); const files = [f]; const h = r.start(files)
    files.push(file('extra')); (f as { identity: string }).identity = 'changed'
    const snapshot = r.ops.snapshot(r.owner, h.id)!
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.files)).toBe(true)
    expect(Object.isFrozen(snapshot.files[0])).toBe(true)
    expect(Object.isFrozen(snapshot.files[0].observation)).toBe(true)
    r.ops.respond(r.owner, h.id, true)
    expect(r.calls.map(c => c.file.identity)).toEqual(['a'])
  })
  it('repeated clicks on the same awaiting prompt retain its operation id', () => {
    const r = rig(); const h = r.start(); const again = r.start()
    expect(again.id).toBe(h.id)
    expect(again.generation).not.toBe(h.generation)
    expect(r.ops.respond(r.owner, h.id, true)).toBe(true)
    expect(r.calls).toHaveLength(1)
  })
  it('bounds pending operations, scope and subscribers without evicting authority', () => {
    const r = rig({ maxOperations: 1, maxFiles: 2, maxSubscribers: 1 })
    const h = r.start()
    expect(() => r.start([file('b')])).toThrow('capacity')
    expect(() => r.start([file()], 'other')).toThrow('capacity')
    expect(() => r.start([file('a'), file('b'), file('c')])).toThrow('capacity')
    expect(r.ops.snapshot(r.owner, h.id)?.state).toBe('awaiting-consent')
  })
})
