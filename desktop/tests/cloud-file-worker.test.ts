import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { runCloudWorker } from '../src/main/cloud-files/io-worker'
import { CLOUD_IO_LIMITS, cloudResultMatches, decodeCloudRequest, decodeCloudResponse, encodeCloudRequest, type CloudIoCommand } from '../src/main/cloud-files/worker-protocol'

const fork = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ utilityProcess: { fork } }))
import { spawnCloudIoWorker } from '../src/main/cloud-files/utility-worker'

describe('cloud utility worker boundary', () => {
  it('rejects malformed wire values without coercing objects or invoking their properties', () => {
    const malformed = { toString: null }
    expect(() => decodeCloudResponse(JSON.stringify({ id: 1, generation: 1, result: { kind: malformed } }))).not.toThrow()
    expect(decodeCloudResponse(JSON.stringify({ id: 1, generation: 1, result: { kind: malformed } }))).toBeUndefined()
    const wire = JSON.stringify({ id: 1, generation: 1, command: { kind: 'read', file: {
      identity: 'id', name: 'name', observation: { kind: 'present', residency: malformed },
    }, authorization: { mode: 'no-recall' }, maxBytes: 4 } })
    expect(() => decodeCloudRequest(wire)).not.toThrow()
    expect(decodeCloudRequest(wire)).toBeUndefined()
  })

  it('enforces exact identity and per-read byte ceilings, strips unrelated metadata fields', () => {
    const command: CloudIoCommand = { kind: 'read', file: { identity: 'id', name: 'name', observation: { kind: 'present', residency: 'local' } }, authorization: { mode: 'no-recall' }, maxBytes: 1 }
    expect(cloudResultMatches(command, { kind: 'ready', identity: 'id', base64: 'YQ==' })).toBe(true)
    expect(cloudResultMatches(command, { kind: 'ready', identity: 'id', base64: 'YWI=' })).toBe(false)
    expect(cloudResultMatches(command, { kind: 'ready', identity: 'foreign-owner', base64: 'YQ==' })).toBe(false)
    expect(cloudResultMatches({ kind: 'metadata', identities: ['id'] }, { kind: 'metadata', records: [{ identity: 'foreign-owner', observation: { kind: 'absent' } }] })).toBe(false)
    const result = decodeCloudResponse(JSON.stringify({ id: 1, generation: 1, result: { kind: 'metadata',
      records: [{ identity: 'id', observation: { kind: 'absent', secretPath: '/other-owner' } }] } }))
    expect(JSON.stringify(result)).not.toContain('other-owner')
    expect(decodeCloudResponse(JSON.stringify({ id: 1, generation: 1, result: { kind: 'ready', identity: 'id', base64: '===!' } }))).toBeUndefined()
    // A maximum-sized legal byte payload must not exhaust the regexp stack.
    const base64 = Buffer.alloc(CLOUD_IO_LIMITS.readBytes).toString('base64')
    expect(decodeCloudResponse(JSON.stringify({ id: 1, generation: 1, result: { kind: 'ready', identity: 'id', base64 } }))?.result.kind).toBe('ready')
  })
  it('fails closed for metadata and reads on unsupported platforms; never fabricates local success', () => {
    const replies: unknown[] = []
    let receive!: (event: { data: unknown }) => void
    runCloudWorker({ on(_event, callback) { receive = callback }, postMessage: wire => replies.push(wire) })
    const commands: CloudIoCommand[] = [
      { kind: 'metadata', identities: ['not-a-path-capability'] },
      { kind: 'read', file: { identity: 'id', name: '/must/not/open', observation: { kind: 'present', residency: 'local' } }, authorization: { mode: 'no-recall' }, maxBytes: 8 },
      { kind: 'read', file: { identity: 'id', name: '/must/not/open', observation: { kind: 'present', residency: 'cloud' } }, authorization: { mode: 'authorized', identity: 'id', operationId: 'approved' }, maxBytes: 8 },
    ]
    commands.forEach((command, i) => receive({ data: encodeCloudRequest({ id: i + 1, generation: 2, command }) }))
    expect(replies.map(decodeCloudResponse)).toEqual(commands.map((_, i) => ({ id: i + 1, generation: 2, result: { kind: 'unsupported' } })))
    receive({ data: 'x'.repeat(CLOUD_IO_LIMITS.requestBytes + 1) })
    receive({ data: '{}' })
    expect(replies).toHaveLength(3)
  })

  it('contains reply transport errors inside the worker listener', () => {
    let receive!: (event: { data: unknown }) => void
    runCloudWorker({ on(_event, callback) { receive = callback }, postMessage() { throw new Error('closed port') } })
    expect(() => receive({ data: encodeCloudRequest({ id: 1, generation: 1, command: { kind: 'metadata', identities: ['id'] } }) })).not.toThrow()
  })

  it('launches only the packaged private utility worker; drops stdout/stderr, binds error/exit/message', () => {
    const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })
    fork.mockReturnValue(child)
    const events = { message: vi.fn(), exit: vi.fn(), error: vi.fn() }
    const handle = spawnCloudIoWorker(events)
    expect(fork).toHaveBeenCalledWith(expect.stringMatching(/[/\\]cloud-files[/\\]io-worker\.js$/), [], { serviceName: 'youcoded-cloud-io', stdio: 'ignore' })
    handle.send('bounded'); expect(child.postMessage).toHaveBeenCalledWith('bounded')
    child.emit('message', 'reply'); child.emit('error', new Error('/private')); child.emit('exit', 1)
    expect(events.message).toHaveBeenCalledWith('reply')
    expect(events.error).toHaveBeenCalledWith()
    expect(events.exit).toHaveBeenCalledWith()
    handle.kill(); expect(child.kill).toHaveBeenCalledTimes(1)
  })
})
