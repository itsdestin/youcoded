import { isSendId } from './send-outcome-types'

export type ClaudeControlRequest =
  | { kind: 'send-text'; text: string; sendId: string }
  | { kind: 'stop' }
  | { kind: 'command'; command: 'model' | 'clear' | 'compact'; args?: string; notice?: 'model-switch' }

export type ClaudeControlResult =
  | { status: 'accepted'; requestId: string; model?: string; claudeSessionId?: string }
  | { status: 'unavailable' }
  | { status: 'rejected'; message: string }
  | { status: 'unknown'; message: string }

export interface ClaudeControlState {
  claudeSessionId?: string
  model?: string
  turnId?: string | null
  /** Exact opening prompt row from session.append, paired with turnId (not the host's latest user). */
  turnUserUuid?: string | null
}

/** WHY: IPC and HTTP input are untrusted even when the caller has TypeScript types. */
export function isClaudeControlRequest(value: unknown): value is ClaudeControlRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const keys = (allowed: string[]) => Object.keys(v).every(key => allowed.includes(key))
  const bounded = (text: unknown, max: number, empty = true) => typeof text === 'string' && text.length <= max && (empty || text.length > 0) && !text.includes('\0')
  switch (v.kind) {
    case 'send-text': return keys(['kind', 'text', 'sendId']) && bounded(v.text, 262144, false) && isSendId(v.sendId)
    case 'stop': return keys(['kind'])
    case 'command': return keys(['kind', 'command', 'args', 'notice']) && ['model', 'clear', 'compact'].includes(v.command as string)
      && (v.args === undefined || bounded(v.args, 8192)) && (v.notice === undefined || v.notice === 'model-switch')
    default: return false
  }
}
