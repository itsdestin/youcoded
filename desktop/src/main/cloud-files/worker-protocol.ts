import type { CloudAuthorization, CloudFile, CloudObservation } from '../../shared/cloud-file-types'

// WHY: wire strings have a byte ceiling BEFORE parsing. No unbounded object traversal,
// arbitrary error text, pathname fallback or shared owner identifiers cross this channel.
export const PATH_READ_MAX_BYTES = 50 * 1024 * 1024;
export const CLOUD_IO_LIMITS = Object.freeze({
  queuePerLane: 16, records: 64, requestBytes: 64 * 1024,
  readBytes: 8 * 1024 * 1024, responseBytes: 72 * 1024 * 1024,
})
export type CloudIoCommand =
  | { readonly kind: 'path-probe'; readonly path: string }
  | { readonly kind: 'path-read'; readonly path: string; readonly maxBytes: number; readonly allowDownload: boolean; readonly prefix?: boolean; readonly expectedSize?: number; readonly expectedMtime?: number }
  | { readonly kind: 'metadata'; readonly identities: readonly string[] }
  | { readonly kind: 'read'; readonly file: CloudFile; readonly authorization: CloudAuthorization; readonly maxBytes: number }
export type CloudIoResult =
  | { readonly kind: 'path-probe'; readonly path: string; readonly residency: 'local' | 'partial' | 'unknown' | 'absent'; readonly sizeBytes: number; readonly mtimeMs: number }
  | { readonly kind: 'path-ready'; readonly path: string; readonly base64: string; readonly sizeBytes: number; readonly mtimeMs: number }
  | { readonly kind: 'metadata'; readonly records: readonly { identity: string; observation: CloudObservation }[] }
  | { readonly kind: 'ready'; readonly identity: string; readonly base64: string }
  | { readonly kind: 'unsupported' | 'identity-changed' | 'absent' | 'error' | 'too-large' }
export type CloudIoRequest = { id: number; generation: number; command: CloudIoCommand }
export type CloudIoResponse = { id: number; generation: number; result: CloudIoResult }

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 }
function copyObservation(value: CloudObservation): CloudObservation {
  return value.kind === 'present' ? { kind: 'present', residency: value.residency } : { kind: value.kind }
}
function validBase64(value: string): boolean {
  // Avoid a repeated-group regex on megabyte payloads (regexp stack exhaustion).
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return value.length % 4 === 0 && !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding))
}
function observation(value: unknown): value is CloudObservation {
  return object(value) && (value.kind === 'absent' || value.kind === 'error' ||
    (value.kind === 'present' && typeof value.residency === 'string' && ['local', 'cloud', 'partial', 'unknown'].includes(value.residency)))
}
function validCommand(value: unknown): value is CloudIoCommand {
  if (!object(value)) return false
  if (value.kind === 'path-probe') return text(value.path)
  if (value.kind === 'path-read') return text(value.path) && positive(value.maxBytes) && value.maxBytes <= PATH_READ_MAX_BYTES && typeof value.allowDownload === 'boolean' &&
    (value.prefix === undefined || typeof value.prefix === 'boolean') &&
    (value.expectedSize === undefined || (typeof value.expectedSize === 'number' && Number.isFinite(value.expectedSize))) &&
    (value.expectedMtime === undefined || (typeof value.expectedMtime === 'number' && Number.isFinite(value.expectedMtime)))
  if (value.kind === 'metadata') return Array.isArray(value.identities) && value.identities.length > 0 &&
    value.identities.length <= CLOUD_IO_LIMITS.records && value.identities.every(text) && new Set(value.identities).size === value.identities.length
  if (value.kind !== 'read' || !object(value.file) || !text(value.file.identity) || !text(value.file.name) ||
    !observation(value.file.observation) || !positive(value.maxBytes) || value.maxBytes > CLOUD_IO_LIMITS.readBytes || !object(value.authorization)) return false
  const auth = value.authorization
  return auth.mode === 'no-recall' || (auth.mode === 'authorized' && text(auth.operationId) && auth.identity === value.file.identity)
}
function parse(wire: unknown, limit: number): Record<string, unknown> | undefined {
  if (typeof wire !== 'string' || wire.length > limit || Buffer.byteLength(wire) > limit) return
  try { const value: unknown = JSON.parse(wire); return object(value) ? value : undefined } catch { return }
}
export function decodeCloudRequest(wire: unknown): CloudIoRequest | undefined {
  const value = parse(wire, CLOUD_IO_LIMITS.requestBytes)
  if (!value || !positive(value.id) || !positive(value.generation) || !validCommand(value.command)) return
  return { id: value.id, generation: value.generation, command: value.command }
}
/** The input is trusted main-process data, never renderer payload. Serialization also
 * snapshots it so changing a queued request cannot expand its approved scope. */
export function encodeCloudRequest(request: CloudIoRequest): string | undefined {
  try {
    if (!validCommand(request.command)) return
    const input = request.command
    const command: CloudIoCommand = input.kind === 'path-probe' || input.kind === 'path-read' ? { ...input } : input.kind === 'metadata'
      ? { kind: 'metadata', identities: [...input.identities] }
      : { kind: 'read', file: { identity: input.file.identity, name: input.file.name, observation: copyObservation(input.file.observation) },
        authorization: input.authorization.mode === 'no-recall' ? { mode: 'no-recall' } : {
          mode: 'authorized', operationId: input.authorization.operationId, identity: input.authorization.identity,
        }, maxBytes: input.maxBytes }
    const wire = JSON.stringify({ id: request.id, generation: request.generation, command })
    return decodeCloudRequest(wire) ? wire : undefined
  } catch { return }
}
export function decodeCloudResponse(wire: unknown): CloudIoResponse | undefined {
  const value = parse(wire, CLOUD_IO_LIMITS.responseBytes)
  if (!value || !positive(value.id) || !positive(value.generation) || !object(value.result)) return
  const result = value.result
  if ((result.kind === 'path-probe' || result.kind === 'path-ready') && text(result.path) &&
      typeof result.sizeBytes === 'number' && Number.isFinite(result.sizeBytes) &&
      typeof result.mtimeMs === 'number' && Number.isFinite(result.mtimeMs)) {
    if (result.kind === 'path-probe' && ['local', 'partial', 'unknown', 'absent'].includes(String(result.residency)))
      return { id: value.id, generation: value.generation, result: { kind: 'path-probe', path: result.path, residency: result.residency as 'local' | 'partial' | 'unknown' | 'absent', sizeBytes: result.sizeBytes, mtimeMs: result.mtimeMs } }
    if (result.kind === 'path-ready' && typeof result.base64 === 'string' && result.base64.length <= Math.ceil(PATH_READ_MAX_BYTES / 3) * 4 && validBase64(result.base64))
      return { id: value.id, generation: value.generation, result: { kind: 'path-ready', path: result.path, base64: result.base64, sizeBytes: result.sizeBytes, mtimeMs: result.mtimeMs } }
    return
  }
  if (typeof result.kind === 'string' && ['unsupported', 'identity-changed', 'absent', 'error', 'too-large'].includes(result.kind)) {
    // Discard unexpected worker fields (including errors with paths).
    return { id: value.id, generation: value.generation, result: { kind: result.kind as 'unsupported' | 'identity-changed' | 'absent' | 'error' | 'too-large' } }
  }
  if (result.kind === 'ready' && text(result.identity) && typeof result.base64 === 'string' &&
    result.base64.length <= Math.ceil(CLOUD_IO_LIMITS.readBytes / 3) * 4 &&
    validBase64(result.base64)) {
    return { id: value.id, generation: value.generation, result: { kind: 'ready', identity: result.identity, base64: result.base64 } }
  }
  if (result.kind === 'metadata' && Array.isArray(result.records) && result.records.length <= CLOUD_IO_LIMITS.records &&
    result.records.every(r => object(r) && text(r.identity) && observation(r.observation))) {
    const records = result.records.map(r => ({ identity: r.identity as string, observation: copyObservation(r.observation as CloudObservation) }))
    if (new Set(records.map(r => r.identity)).size !== records.length) return
    return { id: value.id, generation: value.generation, result: { kind: 'metadata', records } }
  }
}
export function cloudResultMatches(command: CloudIoCommand, result: CloudIoResult): boolean {
  if (result.kind === 'path-probe') return command.kind === 'path-probe' && command.path === result.path
  if (result.kind === 'path-ready') return command.kind === 'path-read' && command.path === result.path && Buffer.byteLength(result.base64, 'base64') <= command.maxBytes
  if (result.kind === 'ready') return command.kind === 'read' && command.file.identity === result.identity &&
    Buffer.byteLength(result.base64, 'base64') <= command.maxBytes
  if (result.kind === 'metadata') return command.kind === 'metadata' && result.records.length === command.identities.length &&
    result.records.every(r => command.identities.includes(r.identity))
  return true
}
