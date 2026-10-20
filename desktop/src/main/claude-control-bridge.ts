import { EventEmitter } from 'node:events'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isClaudeControlRequest, type ClaudeControlRequest, type ClaudeControlResult, type ClaudeControlState } from '../shared/claude-control-types'
import { CLAUDE_CONTROL_PLUGIN_SOURCE } from './claude-control-plugin'
import type { ClaudeQueueTransport } from './claude-queue-transport'

interface Tombstone { fingerprint: string; result?: ClaudeControlResult; promise?: Promise<ClaudeControlResult> }
interface Operation {
  requestId: string
  request: ClaudeControlRequest
  incarnation: string
  turnId?: string
  phase: 'queued' | 'dispatched' | 'claimed'
  expired?: boolean
  timer?: ReturnType<typeof setTimeout>
  resolve?: (result: ClaudeControlResult) => void
  tombstone?: Tombstone
}
interface Session {
  id: string
  secret: string
  closed: boolean
  sealed: boolean
  everReady: boolean
  incarnation?: string
  retired: Set<string>
  seen: number
  state: ClaudeControlState
  sends: Map<string, Tombstone>
  operations: Map<string, Operation>
  poll?: { response: ServerResponse; timer: ReturnType<typeof setTimeout> }
}
interface Options { maxPending?: number; maxSendIds?: number; operationTimeoutMs?: number; leaseMs?: number; pollMs?: number }
const rejected = (message: string): ClaudeControlResult => ({ status: 'rejected', message })
const unknown = (message: string): ClaudeControlResult => ({ status: 'unknown', message })
const requiredCapabilities = ['send-text', 'stop', 'model', 'clear', 'compact']
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function bounded(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value) }

/** Electron-free, instance-local control transport. It never authorizes a retry after handoff. */
export class ClaudeControlBridge extends EventEmitter {
  private sessions = new Map<string, Session>()
  private secrets = new Map<string, Session>()
  private server?: Server
  private listening?: Promise<string>
  private deployment?: Promise<string>
  private closed = false
  private queueTransport?: ClaudeQueueTransport
  private queueInitializer?: () => Promise<void>
  setQueueInitializer(initialize: () => Promise<void>): void {
    if (this.queueInitializer || this.closed) throw new Error('Queue initializer already set or bridge closed')
    this.queueInitializer = initialize
  }
  private queueClears = new Map<string, { clearId: string; promise: Promise<ClaudeControlResult> }>()

  /** Task 3 owns binding/runtime wiring; queue protocol is opt-in and instance-local. */
  attachQueueTransport(transport: ClaudeQueueTransport): void {
    if (this.queueTransport || this.closed) throw new Error('Queue transport already attached or bridge closed')
    this.queueTransport = transport
  }
  private readonly maxPending: number
  private readonly maxSendIds: number
  private readonly operationTimeoutMs: number
  private readonly leaseMs: number
  private readonly pollMs: number

  constructor(private readonly deploymentRoot: string | (() => string), options: Options = {}) {
    super()
    this.maxPending = Math.min(64, Math.max(1, options.maxPending ?? 64))
    this.maxSendIds = Math.min(10000, Math.max(1, options.maxSendIds ?? 10000))
    this.operationTimeoutMs = options.operationTimeoutMs ?? 60000
    this.leaseMs = options.leaseMs ?? 90000
    this.pollMs = Math.min(25000, Math.max(1, options.pollMs ?? 25000))
  }

  async prepare(sessionId: string): Promise<{ args: string[]; env: Record<string, string> } | null> {
    if (this.closed || !bounded(sessionId)) return null
    const session = this.getSession(sessionId)
    if (session.closed) return null
    try {
      // Resolve the private journal only at first CLI preparation, after profile selection,
      // and finish restore before advertising queue capability in the native handshake.
      await this.queueInitializer?.()
      this.deployment ??= this.deploy()
      const directory = await this.deployment
      if (this.closed || session.closed) return null
      this.listening ??= this.listen()
      const url = await this.listening
      if (this.closed || session.closed) return null
      this.secrets.set(session.secret, session)
      return { args: ['--plugin-dir', directory], env: { YOUCODED_CC_CONTROL_URL: url, YOUCODED_CC_CONTROL_TOKEN: session.secret } }
    } catch {
      return null
    }
  }

  private getSession(sessionId: string): Session {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = { id: sessionId, secret: randomBytes(32).toString('hex'), closed: this.closed, sealed: false,
        everReady: false, retired: new Set(), seen: 0, state: {}, sends: new Map(), operations: new Map() }
      this.sessions.set(sessionId, session)
    }
    return session
  }

  private async deploy(): Promise<string> {
    const manifest = JSON.stringify({ name: 'youcoded-control-bridge', version: '1.0.0', description: 'Session-scoped YouCoded controls' })
    const hooks = JSON.stringify({ modules: ['./register.js'] })
    const hash = createHash('sha256').update(manifest).update(hooks).update(CLAUDE_CONTROL_PLUGIN_SOURCE).digest('hex')
    // WHY: Electron selects the isolated profile after constructing services; never capture production userData early.
    const deploymentRoot = typeof this.deploymentRoot === 'function' ? this.deploymentRoot() : this.deploymentRoot
    const parent = join(deploymentRoot, 'claude-control-plugins')
    const target = join(parent, hash)
    await mkdir(parent, { recursive: true })
    try {
      if (await readFile(join(target, 'hooks/register.js'), 'utf8') === CLAUDE_CONTROL_PLUGIN_SOURCE
        && await readFile(join(target, '.claude-plugin/plugin.json'), 'utf8') === manifest
        && await readFile(join(target, 'hooks/hooks.json'), 'utf8') === hooks) return target
      throw new Error('Immutable plugin content differs')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // WHY: publish a complete immutable directory atomically, never expose half a mod to the CLI.
    const staging = await mkdtemp(join(parent, '.staging-'))
    try {
      await mkdir(join(staging, '.claude-plugin'))
      await mkdir(join(staging, 'hooks'))
      await writeFile(join(staging, '.claude-plugin/plugin.json'), manifest)
      await writeFile(join(staging, 'hooks/register.js'), CLAUDE_CONTROL_PLUGIN_SOURCE)
      await writeFile(join(staging, 'hooks/hooks.json'), hooks)
      try { await rename(staging, target) } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        if (await readFile(join(target, 'hooks/register.js'), 'utf8') !== CLAUDE_CONTROL_PLUGIN_SOURCE
          || await readFile(join(target, '.claude-plugin/plugin.json'), 'utf8') !== manifest
          || await readFile(join(target, 'hooks/hooks.json'), 'utf8') !== hooks) throw error
      }
      return target
    } finally { await rm(staging, { recursive: true, force: true, maxRetries: 5 }) }
  }

  private listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => { void this.route(req, res).catch(() => this.reply(res, 400, { error: 'Invalid request' })) })
      this.server = server
      server.requestTimeout = 30000
      server.headersTimeout = 10000
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('No loopback address')); return }
        resolve(`http://127.0.0.1:${address.port}`)
      })
    })
  }

  isReady(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    return !!s && !s.closed && !s.sealed && !!s.incarnation && Date.now() - s.seen < this.leaseMs
  }

  executeQueueClear(sessionId: string, clearId: string): Promise<ClaudeControlResult> {
    const old = this.queueClears.get(sessionId)
    if (old?.clearId === clearId) return old.promise
    if (!this.queueTransport?.canExecuteClear(sessionId, clearId)) return Promise.resolve(rejected('Queued Clear is not safely authorized'))
    // One current Clear token per session; older tokens fail the journal's current-clear check
    // after replacement, so bounded dedup does not need a lifetime list or allow replay.
    const promise = this.execute(sessionId, { kind: 'command', command: 'clear' }, clearId)
    this.queueClears.set(sessionId, { clearId, promise })
    return promise
  }

  async execute(sessionId: string, request: ClaudeControlRequest, queueClearId?: string): Promise<ClaudeControlResult> {
    if (!bounded(sessionId) || !isClaudeControlRequest(request)) return rejected('Invalid control request')
    const s = this.getSession(sessionId)
    if (this.queueTransport && !this.queueTransport.canControl(sessionId)
      && !(request.kind === 'command' && request.command === 'clear' && queueClearId && this.queueTransport.canExecuteClear(sessionId, queueClearId))) return rejected('A queued delivery or composer quarantine must be resolved before this action')
    let tombstone: Tombstone | undefined
    if (s && request.kind === 'send-text') {
      const fingerprint = createHash('sha256').update(request.text).digest('hex')
      const old = s.sends.get(request.sendId)
      // WHY: readiness must never turn a previously attempted send into permission for PTY replay.
      if (old) return old.fingerprint !== fingerprint ? rejected('Send ID was already used for different text')
        : old.result ?? old.promise ?? unknown('Send outcome is not known')
      if (s.sends.size >= this.maxSendIds) return rejected('Send identity history is full; reopen the session')
      tombstone = { fingerprint }
      s.sends.set(request.sendId, tombstone)
    }
    if (!s || !this.isReady(sessionId)) {
      const result: ClaudeControlResult = s?.everReady ? unknown('Control connection is no longer ready; reopen the session') : { status: 'unavailable' }
      // WHY: the first unavailable grants legacy fallback; subsequent copies cannot safely grant it again.
      if (tombstone) tombstone.result = result.status === 'unavailable' ? unknown('Legacy fallback was already authorized for this send') : result
      return result
    }
    const requestId = randomUUID()
    // WHY: idle Stop is a no-op even when unstarted sends fill the mutation queue.
    if (request.kind === 'stop' && !s.state.turnId) return { status: 'accepted', requestId }
    const pendingStop = [...s.operations.values()].find(op => op.request.kind === 'stop')
    if (request.kind === 'stop' && pendingStop?.turnId === s.state.turnId) return unknown('Stop is already awaiting confirmation')
    // WHY: a full mutation queue must not prevent one addressed abort of the active turn.
    if (s.operations.size >= this.maxPending && !(request.kind === 'stop' && !pendingStop)) {
      const result = rejected('Control queue is full')
      if (tombstone) tombstone.result = result
      return result
    }
    const op: Operation = { requestId, request: { ...request }, incarnation: s.incarnation!, phase: 'queued', tombstone,
      ...(request.kind === 'stop' && s.state.turnId ? { turnId: s.state.turnId } : {}) }
    const promise = new Promise<ClaudeControlResult>(resolve => { op.resolve = resolve })
    if (tombstone) tombstone.promise = promise
    s.operations.set(requestId, op)
    // WHY: an accepted idle Stop has no target and must never end a host turn.
    if (op.turnId) this.emit('stop-targeted', sessionId, requestId, s.state.turnUserUuid)
    op.timer = setTimeout(() => {
      const dispatched = op.phase !== 'queued'
      op.expired = true
      // An expired unclaimed frame can never invoke or settle: retain its tombstone, not an active queue slot.
      this.settle(s, op, dispatched ? unknown('Control receipt timed out after handoff') : rejected('Control expired before handoff'), op.phase !== 'claimed')
    }, this.operationTimeoutMs)
    op.timer.unref?.()
    this.deliver(s)
    return promise
  }

  private settle(s: Session, op: Operation, result: ClaudeControlResult, remove = true, receipt = false): void {
    clearTimeout(op.timer)
    if (op.tombstone) { op.tombstone.result = result; delete op.tombstone.promise }
    const resolve = op.resolve
    delete op.resolve
    if (remove) s.operations.delete(op.requestId)
    resolve?.(result)
    // WHY: execute reports timeouts/refusals; settled is exclusively an actual (possibly late) mod receipt.
    if (receipt && !s.closed) this.emit('settled', s.id, op.request, result)
  }

  private reply(res: ServerResponse, code: number, value: unknown): void {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  private endPoll(s: Session, code: number, value: unknown): void {
    if (!s.poll) return
    const poll = s.poll
    delete s.poll
    clearTimeout(poll.timer)
    this.reply(poll.response, code, value)
  }

  private deliver(s: Session): void {
    if (!s.poll) return
    const queued = [...s.operations.values()].filter(op => op.phase === 'queued')
    const op = queued.find(op => op.request.kind === 'stop') ?? queued[0]
    if (!op) return
    op.phase = 'dispatched'
    this.endPoll(s, 200, { requestId: op.requestId, incarnation: op.incarnation, request: op.request, ...(op.turnId ? { turnId: op.turnId } : {}) })
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = this.server?.address()
    const host = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : ''
    if (req.headers.origin !== undefined || req.headers.host !== host || req.socket.remoteAddress !== '127.0.0.1') {
      this.reply(res, 403, {}); req.resume(); return
    }
    const auth = req.headers.authorization
    const s = auth?.startsWith('Bearer ') ? this.secrets.get(auth.slice(7)) : undefined
    if (!s || s.closed) { this.reply(res, 401, {}); req.resume(); return }
    if (req.method !== 'POST' || !['/hello', '/poll', '/claim', '/result', '/state', '/queue-offer', '/queue-poll', '/queue-event'].includes(req.url ?? '')) {
      this.reply(res, 404, {}); req.resume(); return
    }
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > 16384) { this.reply(res, 413, {}); req.resume(); return }
      chunks.push(Buffer.from(chunk))
    }
    if (s.closed) { this.reply(res, 410, {}); return }
    const b: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!object(b) || b.v !== 1 || !bounded(b.incarnation)) { this.reply(res, 400, {}); return }
    const allowed: Record<string, string[]> = { '/hello': ['capabilities'], '/poll': [], '/claim': ['requestId'], '/result': ['requestId', 'result'], '/state': ['state'], '/queue-offer': ['offer'], '/queue-poll': [], '/queue-event': ['event'] }
    if (Object.keys(b).some(key => !['v', 'incarnation', ...allowed[req.url!]].includes(key))) { this.reply(res, 400, {}); return }
    if (req.url === '/hello') {
      if (!Array.isArray(b.capabilities) || b.capabilities.length !== requiredCapabilities.length
        || !requiredCapabilities.every(c => (b.capabilities as unknown[]).includes(c))) { this.reply(res, 400, {}); return }
      if (s.sealed || s.retired.has(b.incarnation)) { this.reply(res, 409, {}); return }
      if (s.incarnation && s.incarnation !== b.incarnation) {
        s.retired.add(s.incarnation)
        if (s.retired.size >= 64) s.sealed = true
        const claimed = [...s.operations.values()].some(op => op.phase === 'claimed')
        // WHY: lease expiry cannot terminate code already inside a mods API. Never allow two writers.
        if (claimed) s.sealed = true
        this.endPoll(s, 409, {})
        for (const op of s.operations.values()) this.settle(s, op, op.phase === 'queued' ? rejected('Module reloaded before handoff') : unknown('Module reloaded after handoff'))
        if (s.sealed) { this.reply(res, 409, {}); return }
        s.state = {}
      }
      s.incarnation = b.incarnation
      s.everReady = true
      s.seen = Date.now()
      this.emit('native-ready', s.id, s.incarnation)
      this.reply(res, 200, { v: 1, incarnation: s.incarnation, ...(this.queueTransport ? { queueEnabled: true } : {}) }); return
    }
    if (s.sealed || s.incarnation !== b.incarnation) { this.reply(res, 409, {}); return }
    s.seen = Date.now()
    if (req.url === '/queue-offer' || req.url === '/queue-poll' || req.url === '/queue-event') {
      if (!this.queueTransport) { this.reply(res, 409, {}); return }
      // Same per-session auth, Host/Origin, strict envelope and incarnation validation as controls.
      // A held offer is bounded by its native/host deadline and cannot invoke arbitrary bridge actions.
      if (req.url === '/queue-offer') this.reply(res, 200, s.operations.size ? { released: true } : await this.queueTransport.offer(s.id, s.incarnation!, b.offer))
      else if (req.url === '/queue-poll') this.reply(res, 200, await this.queueTransport.poll(s.id, s.incarnation!))
      else { this.emit('queue-evidence', s.id, b.event); await this.queueTransport.event(s.id, s.incarnation!, b.event); this.reply(res, 200, {}) }
      return
    }
    if (req.url === '/poll') {
      if (s.poll) { this.reply(res, 409, {}); return }
      const timer = setTimeout(() => this.endPoll(s, 200, { idle: true, incarnation: s.incarnation }), this.pollMs)
      timer.unref?.()
      s.poll = { response: res, timer }
      res.on('close', () => { if (s.poll?.response === res) { clearTimeout(timer); delete s.poll } })
      this.deliver(s); return
    }
    if (req.url === '/state') {
      if (!object(b.state) || Object.keys(b.state).some(key => !['claudeSessionId', 'model', 'turnId', 'turnUserUuid'].includes(key))
        || Object.entries(b.state).some(([key, value]) => !(['turnId', 'turnUserUuid'].includes(key) && value === null) && !bounded(value))) { this.reply(res, 400, {}); return }
      // WHY: a turn observation without a UUID must not inherit the previous turn's opening row.
      s.state = { ...s.state, ...('turnId' in b.state ? { turnUserUuid: null } : {}), ...b.state }
      this.emit('state', s.id, { ...s.state })
      this.reply(res, 200, {}); return
    }
    const op = typeof b.requestId === 'string' ? s.operations.get(b.requestId) : undefined
    if (!op || op.incarnation !== b.incarnation) { this.reply(res, 409, {}); return }
    if (req.url === '/claim') {
      if (op.phase !== 'dispatched' || op.expired) { this.reply(res, 409, {}); return }
      if (op.request.kind === 'stop' && op.turnId !== s.state.turnId) {
        this.settle(s, op, rejected('Stop target is no longer active')); this.reply(res, 409, {}); return
      }
      op.phase = 'claimed'
      this.reply(res, 200, {}); return
    }
    if (op.phase !== 'claimed' || !object(b.result)) { this.reply(res, 409, {}); return }
    const r = b.result
    let result: ClaudeControlResult
    if (r.status === 'accepted' && Object.keys(r).every(key => ['status', 'model', 'claudeSessionId'].includes(key))
      && (r.model === undefined || bounded(r.model)) && (r.claudeSessionId === undefined || bounded(r.claudeSessionId))) {
      result = { status: 'accepted', requestId: op.requestId, ...(r.model ? { model: r.model as string } : {}), ...(r.claudeSessionId ? { claudeSessionId: r.claudeSessionId as string } : {}) }
    } else if ((r.status === 'rejected' || r.status === 'unknown') && Object.keys(r).every(key => ['status', 'message'].includes(key))
      && typeof r.message === 'string' && r.message.length > 0 && r.message.length <= 2048) {
      result = { status: r.status, message: r.message }
    } else { this.reply(res, 400, {}); return }
    this.settle(s, op, result, true, true)
    this.reply(res, 200, {})
  }

  closeSession(sessionId: string): void {
    this.queueClears.delete(sessionId)
    let s = this.sessions.get(sessionId)
    if (!s) {
      // WHY: remember cancellation even when an async prepare has not allocated anything yet.
      s = { id: sessionId, secret: '', closed: true, sealed: true, everReady: false, retired: new Set(), seen: 0, state: {}, sends: new Map(), operations: new Map() }
      this.sessions.set(sessionId, s)
      return
    }
    if (s.closed) return
    this.secrets.delete(s.secret)
    if (!this.closed) void this.queueTransport?.unbind(sessionId).catch(() => {})
    s.closed = true
    this.endPoll(s, 410, {})
    for (const op of s.operations.values()) this.settle(s, op, op.phase === 'queued' ? rejected('Session closed before handoff') : unknown('Session closed after handoff'))
    s.state = {}
  }

  async close(): Promise<void> {
    this.closed = true
    // Revoke every HTTP secret synchronously; storage/worker cleanup must never
    // leave a closing bridge accepting controls while it awaits a failed journal.
    for (const id of this.sessions.keys()) this.closeSession(id)
    await this.queueTransport?.close()
    await this.listening?.catch(() => {})
    if (this.server?.listening) {
      const server = this.server
      await new Promise<void>(resolve => {
        server.close(() => resolve())
        // WHY: a peer holding a partial body must not keep shutdown alive after every secret is revoked.
        server.closeAllConnections()
      })
    }
    await this.deployment?.catch(() => {})
  }
}
