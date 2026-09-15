import { decodeCloudRequest, type CloudIoResponse, type CloudIoCommand, type CloudIoResult } from './worker-protocol'
import fs from 'node:fs/promises'
import { createWindowsMetadataProbe } from './windows-metadata'

const probe = createWindowsMetadataProbe({ isOwnedWorker: () => !!(process as unknown as { parentPort?: unknown }).parentPort })

// WHY: pathname preflight is a pragmatic protection, NOT the stable-identity/no-recall
// T0 capability. Recheck immediately before opening, bound reads on the handle, and
// keep every potentially blocking Windows query in this disposable owned process.
async function pathCommand(command: CloudIoCommand): Promise<CloudIoResult> {
  if (command.kind !== 'path-probe' && command.kind !== 'path-read') return { kind: 'unsupported' }
  const observation = probe.probe(command.path)
  const residency = observation.kind === 'not-found' ? 'absent' : observation.residency
  let sizeBytes = -1; let mtimeMs = -1
  if (observation.kind === 'observed') {
    const st = await fs.stat(command.path)
    if (!st.isFile() && command.kind === 'path-read') return { kind: 'error' }
    sizeBytes = st.size; mtimeMs = st.mtimeMs
  }
  if (command.kind === 'path-probe') return { kind: 'path-probe', path: command.path, residency, sizeBytes, mtimeMs }
  if (residency === 'absent') return { kind: 'absent' }
  if (!command.allowDownload && residency !== 'local') return { kind: 'unsupported' }
  if (command.expectedSize !== undefined && (sizeBytes !== command.expectedSize || mtimeMs !== command.expectedMtime)) return { kind: 'identity-changed' }
  if (!command.prefix && sizeBytes > command.maxBytes) return { kind: 'too-large' }
  const handle = await fs.open(command.path, 'r')
  try {
    const st = await handle.stat()
    if (!st.isFile() || (!command.prefix && st.size > command.maxBytes)) return { kind: 'too-large' }
    if (command.expectedSize !== undefined && (st.size !== command.expectedSize || st.mtimeMs !== command.expectedMtime)) return { kind: 'identity-changed' }
    // Prefix reads never touch the rest of a large text file merely to preview it.
    const buffer = Buffer.alloc(Math.min(command.prefix ? command.maxBytes : command.maxBytes + 1, st.size + 1))
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used)
      if (!bytesRead) break
      used += bytesRead
    }
    if (used > command.maxBytes) return { kind: 'too-large' }
    if (used > st.size) return { kind: 'identity-changed' }
    return { kind: 'path-ready', path: command.path, base64: buffer.subarray(0, used).toString('base64'), sizeBytes: st.size, mtimeMs: st.mtimeMs }
  } finally { await handle.close() }
}

type ParentPort = {
  on(event: 'message', callback: (event: { data: unknown }) => void): void
  postMessage(wire: string): void
}

/** Stable-identity commands still fail closed. Path commands explicitly carry the
 * weaker preflight contract; they must not masquerade as a T0 adapter. */
export function runCloudWorker(port: ParentPort): void {
  port.on('message', event => {
    const request = decodeCloudRequest(event.data)
    if (!request) return
    if (request.command.kind !== 'path-probe' && request.command.kind !== 'path-read') {
      try { port.postMessage(JSON.stringify({ id: request.id, generation: request.generation, result: { kind: 'unsupported' } })) } catch { /* closed parent */ }
      return
    }
    void pathCommand(request.command).catch((): CloudIoResult => ({ kind: 'error' })).then(result => {
      const response: CloudIoResponse = { id: request.id, generation: request.generation, result }
      try { port.postMessage(JSON.stringify(response)) } catch { /* parent closed; no retry */ }
    })
  })
}

// Like voice-worker: importing under tests does not launch or attach to anything.
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort
if (parentPort) runCloudWorker(parentPort)
