import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, rename, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';

export type RequestPurpose = 'chat' | 'specialist' | 'title' | 'summary' | 'unknown';
interface Scope { sessionId: string; purpose: RequestPurpose; logicalStepId: string }
interface Context extends Scope { diagnostics?: ChatGptRequestDiagnostics; attemptId?: string }
const contexts = new AsyncLocalStorage<Context>();
export function withChatGptRequest<T>(sessionId: string, purpose: RequestPurpose, work: () => T): T {
  // WHY: async-local scopes keep concurrent summaries/children off the chat baseline.
  return contexts.run({ sessionId, purpose, logicalStepId: randomUUID() }, work);
}
export function bindChatGptRequest<T>(diagnostics: ChatGptRequestDiagnostics, sessionId: string, work: (context: Context) => T, purpose: RequestPurpose = 'unknown'): T {
  const context: Context = { sessionId, purpose, logicalStepId: randomUUID(), ...contexts.getStore(), diagnostics };
  return contexts.run(context, () => work(context));
}
export function currentChatGptRequest(): Context | undefined { return contexts.getStore(); }

type Outcome = 'success' | 'failed' | 'aborted' | 'expired';
type Change = 'baseline' | 'identical' | 'append' | 'edit' | 'remove';
const COMPONENTS = ['instructions', 'tools', 'model', 'settings', 'cacheKey'] as const;
type Components = Record<typeof COMPONENTS[number], string>;
interface Lane { items: Buffer; components: Components; attemptId: string; sequence: number; successful?: { id: string; sequence: number }; bytes: number; touched: number }
export interface DiagnosticRecord {
  version: 1; sessionId: string; laneId: string; logicalStepId: string; attemptId: string;
  resendParentId: string | null; dispatchSequence: number; baselineAttemptId: string | null;
  lastSuccessfulAttemptId: string | null; timestamp: number; durationMs: number;
  model: string; purpose: RequestPurpose; outcome: Outcome; inputItems: number;
  stablePrefixItems: number; firstDifferingItem: number | null; change: Change;
  changed: Record<typeof COMPONENTS[number], boolean>;
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
  cacheDetailPresent: boolean; dropped: number; evicted: number; expired: number; writeFailures: number;
}
const count = (n: unknown): number | null => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
const object = (x: unknown): Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
const MEMORY = 8 * 1024 * 1024;
const FILE_BYTES = 5 * 1024 * 1024;

// WHY: re-stringifying parsed objects erases whitespace/number spelling. Compare
// exact serialized values, not a canonical approximation of the outgoing bytes.
function serializedValues(text: string, array = false): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  let i = 1;
  const space = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const endValue = () => {
    let depth = 0;
    let quoted = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) break;
    }
  };
  while (i < text.length - 1) {
    space();
    if (text[i] === ']' || text[i] === '}') break;
    let key = String(entries.length);
    if (!array) {
      const start = i++;
      while (i < text.length) { if (text[i] === '\\') i += 2; else if (text[i++] === '"') break; }
      key = JSON.parse(text.slice(start, i));
      space(); i++; space();
    }
    const start = i;
    endValue();
    entries.push([key, text.slice(start, i).trimEnd()]);
    if (text[i] === ',') i++;
    else break;
  }
  return entries;
}

export class ChatGptRequestDiagnostics {
  private readonly key = randomBytes(32);
  private readonly lanes = new Map<string, Lane>();
  private readonly unfinished = new Map<string, DiagnosticRecord>();
  private readonly queue: DiagnosticRecord[] = [];
  private sequence = 0;
  private bytes = 0;
  private dropped = 0;
  private evicted = 0;
  private expired = 0;
  private writeFailures = 0;
  private reportedCounters = '';
  private draining?: Promise<void>;
  private scheduled = false;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private readonly now: () => number;
  constructor(private readonly options: { directory: string; now?: () => number; write?: (row: DiagnosticRecord) => Promise<void> }) {
    this.now = options.now ?? Date.now;
  }
  private hash(value: string): string { return createHmac('sha256', this.key).update(value).digest('hex'); }
  private counters() { return { dropped: this.dropped, evicted: this.evicted, expired: this.expired, writeFailures: this.writeFailures }; }
  stats() { return { ...this.counters(), unfinished: this.unfinished.size, fingerprintBytes: this.bytes, queued: this.queue.length, lanes: this.lanes.size }; }
  private forget(laneId: string) {
    const lane = this.lanes.get(laneId);
    if (lane) { this.bytes -= lane.bytes; this.lanes.delete(laneId); this.evicted++; }
  }
  dispatch(scope: Scope, body: unknown, resendParentId: string | null = null): string | undefined {
    // WHY: bodies exist only on this synchronous stack; queues and retained state are reduced metadata.
    let laneId: string | undefined;
    try {
      const now = this.now();
      for (const [id, row] of this.unfinished) if (now - row.timestamp >= 600_000) {
        this.expired++;
        this.finish(id, 'expired');
        this.forget(row.laneId);
      }
      const sessionId = this.hash(scope.sessionId);
      laneId = this.hash(`${sessionId}:${scope.purpose}`);
      if (this.unfinished.size >= 256 || typeof body !== 'string') { this.dropped++; this.forget(laneId); this.schedule(); return undefined; }
      const parsed = object(JSON.parse(body));
      if (!Array.isArray(parsed.input)) { this.dropped++; this.forget(laneId); this.schedule(); return undefined; }
      // Buffer storage makes the fingerprint-byte limit exact rather than guessing JS string overhead.
      const size = parsed.input.length * 32 + 1024;
      if (size > MEMORY) { this.dropped++; this.forget(laneId); this.schedule(); return undefined; }
      while (this.bytes + size > MEMORY) {
        const active = new Set([...this.unfinished.values()].map(row => row.laneId));
        const inactive = [...this.lanes].filter(([id]) => !active.has(id)).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!inactive) { this.dropped++; this.forget(laneId); this.schedule(); return undefined; }
        this.forget(inactive[0]);
      }
      const serialized = Object.fromEntries(serializedValues(body.trim()));
      const items = Buffer.alloc(parsed.input.length * 32);
      serializedValues(serialized.input, true).forEach(([, item], index) => Buffer.from(this.hash(item), 'hex').copy(items, index * 32));
      const { input: _input, instructions, tools, model: serializedModel, prompt_cache_key: cacheKey, ...settings } = serialized;
      const model = parsed.model;
      const values = { instructions, tools, model: serializedModel, settings: JSON.stringify(settings), cacheKey };
      const components = Object.fromEntries(COMPONENTS.map(k => [k, this.hash(values[k] ?? 'undefined')])) as Components;
      const previous = this.lanes.get(laneId);
      let prefix = 0;
      if (previous) while (prefix * 32 < Math.min(items.length, previous.items.length) && items.subarray(prefix * 32, prefix * 32 + 32).equals(previous.items.subarray(prefix * 32, prefix * 32 + 32))) prefix++;
      const length = items.length / 32;
      const oldLength = previous ? previous.items.length / 32 : 0;
      const change: Change = !previous ? 'baseline' : prefix === length && length === oldLength ? 'identical' : prefix === oldLength && length > oldLength ? 'append' : prefix === length && length < oldLength ? 'remove' : 'edit';
      const attemptId = randomUUID();
      const sequence = ++this.sequence;
      const row: DiagnosticRecord = {
        version: 1, sessionId, laneId, logicalStepId: this.hash(scope.logicalStepId), attemptId, resendParentId,
        dispatchSequence: sequence, baselineAttemptId: previous?.attemptId ?? null, lastSuccessfulAttemptId: previous?.successful?.id ?? null,
        timestamp: now, durationMs: 0,
        // Model IDs are bounded grammar, never an arbitrary provider/body string.
        model: typeof model === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(model) ? model : 'unknown',
        purpose: scope.purpose, outcome: 'failed', inputItems: length, stablePrefixItems: prefix,
        firstDifferingItem: previous && change !== 'identical' ? prefix : null, change,
        changed: Object.fromEntries(COMPONENTS.map(k => [k, !!previous && previous.components[k] !== components[k]])) as DiagnosticRecord['changed'],
        inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheDetailPresent: false, ...this.counters(),
      };
      this.bytes -= previous?.bytes ?? 0;
      this.bytes += size;
      this.lanes.set(laneId, { items, components, attemptId, sequence, successful: previous?.successful, bytes: size, touched: sequence });
      this.unfinished.set(attemptId, row);
      this.armExpiry();
      return attemptId;
    } catch { this.dropped++; if (laneId) this.forget(laneId); this.schedule(); return undefined; }
  }
  finish(attemptId: string | undefined, outcome: Outcome, rawUsage?: unknown): void {
    try {
      if (!attemptId) return;
      const row = this.unfinished.get(attemptId);
      if (!row) return;
      this.unfinished.delete(attemptId);
      if (!this.unfinished.size && this.expiryTimer) { clearTimeout(this.expiryTimer); this.expiryTimer = undefined; }
      const usage = object(rawUsage);
      const details = object(usage.input_tokens_details);
      row.inputTokens = count(usage.input_tokens);
      row.outputTokens = count(usage.output_tokens);
      row.cacheDetailPresent = Object.hasOwn(details, 'cached_tokens');
      const cached = count(details.cached_tokens);
      row.cachedInputTokens = cached !== null && row.inputTokens !== null && cached <= row.inputTokens ? cached : null;
      row.outcome = outcome;
      row.durationMs = Math.max(0, this.now() - row.timestamp);
      const lane = this.lanes.get(row.laneId);
      if (outcome === 'success' && lane && row.dispatchSequence > (lane.successful?.sequence ?? 0)) lane.successful = { id: attemptId, sequence: row.dispatchSequence };
      if (this.queue.length < 1000) this.queue.push(row); else this.dropped++;
      this.schedule();
    } catch { this.dropped++; }
  }
  observeRaw(attemptId: string | undefined, raw: unknown): void {
    try {
      const event = object(raw);
      if (event.type === 'response.completed') this.finish(attemptId, 'success', object(event.response).usage);
      else if (event.type === 'response.failed' || event.type === 'error') this.finish(attemptId, 'failed', object(event.response).usage);
      else if (event.type === 'response.incomplete') this.finish(attemptId, 'failed', object(event.response).usage);
    } catch { this.dropped++; }
  }
  private armExpiry() {
    if (this.expiryTimer || !this.unfinished.size) return;
    // WHY: an abandoned final request must expire even if no later send arrives.
    const oldest = this.unfinished.values().next().value!;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      for (const [id, row] of this.unfinished) if (this.now() - row.timestamp >= 600_000) {
        this.expired++; this.finish(id, 'expired'); this.forget(row.laneId);
      }
      this.armExpiry();
    }, Math.max(1, oldest.timestamp + 600_000 - this.now()));
    this.expiryTimer.unref();
  }
  private schedule() {
    if (this.scheduled || this.draining) return;
    this.scheduled = true;
    // WHY: neither serialization nor filesystem latency belongs in the token delivery path.
    setImmediate(() => { this.scheduled = false; void this.flush(); }).unref();
  }
  async flush(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.queue.length) {
        const row = this.queue.shift()!;
        Object.assign(row, this.counters());
        try { if (this.options.write) await this.options.write(row); else await this.write(row); }
        catch { this.writeFailures++; }
        this.reportedCounters = JSON.stringify(this.counters());
      }
      // WHY: loss with no completed observation still needs visible coverage evidence.
      const counters = this.counters();
      const serializedCounters = JSON.stringify(counters);
      if (serializedCounters !== this.reportedCounters && Object.values(counters).some(Boolean) && !this.options.write) {
        this.reportedCounters = serializedCounters;
        try { await this.write({ version: 1, kind: 'loss', timestamp: this.now(), ...counters }); }
        catch { this.writeFailures++; this.reportedCounters = JSON.stringify(this.counters()); }
      }
    })();
    try { await this.draining; } finally {
      this.draining = undefined;
      // WHY: producers can enqueue after the coroutine exits but before this
      // await continuation releases ownership. Their schedule() saw a live drain.
      const counters = this.counters();
      if (this.queue.length || (!this.options.write && Object.values(counters).some(Boolean) && JSON.stringify(counters) !== this.reportedCounters)) this.schedule();
    }
  }
  private async write(row: DiagnosticRecord | { version: 1; kind: 'loss'; timestamp: number; dropped: number; evicted: number; expired: number; writeFailures: number }) {
    const dir = this.options.directory;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const file = join(dir, 'requests.jsonl');
    const line = JSON.stringify(row) + '\n';
    const bytes = Buffer.byteLength(line);
    if (bytes > FILE_BYTES) { this.dropped++; return; }
    const existing = await stat(file).catch(() => null);
    if (existing && existing.size + bytes > FILE_BYTES) await rename(file, join(dir, 'requests.previous.jsonl'));
    const handle = await open(file, 'a', 0o600);
    try { await handle.chmod(0o600); await handle.writeFile(line); } finally { await handle.close(); }
  }
}
