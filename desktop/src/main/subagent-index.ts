/**
 * Correlates subagent JSONL files to their parent Agent tool_use.
 *
 * Each session has its own instance. Tracks:
 *   - A FIFO queue of parent Agent tool_uses (description + subagent_type)
 *     recorded as the parent JSONL streams in, consumed as subagent files
 *     appear and call bindSubagent().
 *   - Resolved bindings (agentId -> parentToolUseId) for lookup during
 *     per-line event stamping.
 *   - A pending buffer for subagent events that arrived before their
 *     parent Agent tool_use was parsed (rare but possible — subagent JSONL
 *     can hit disk before the parent JSONL flush). Entries age out after
 *     30 seconds.
 *
 * Pure logic, no I/O. Timing is injected via `nowMs` so tests can drive
 * the clock deterministically.
 */

const PENDING_TTL_MS = 30_000;

interface ParentRecord {
  toolUseId: string;
  description: string;
  subagentType: string;
}

interface PendingEntry {
  description: string;
  agentType: string;
  events: unknown[];
  firstSeenAt: number;
}

export interface SubagentMeta {
  description: string;
  agentType: string;
}

export interface FlushResult {
  parentToolUseId: string;
  events: unknown[];
}

export interface SubagentIndexOptions {
  nowMs?: () => number;
}

export class SubagentIndex {
  private unmatchedParents: ParentRecord[] = [];
  private bindings = new Map<string, string>();
  private pending = new Map<string, PendingEntry>();
  private nowMs: () => number;

  constructor(opts: SubagentIndexOptions = {}) {
    this.nowMs = opts.nowMs ?? Date.now;
  }

  recordParentAgentToolUse(toolUseId: string, description: string, subagentType: string): void {
    this.unmatchedParents.push({ toolUseId, description, subagentType });
  }

  bindSubagent(agentId: string, meta: SubagentMeta): string | null {
    const i = this.unmatchedParents.findIndex(
      p => p.description === meta.description && p.subagentType === meta.agentType,
    );
    if (i < 0) return null;
    // splice removes the parent so it can't be bound to a second subagent
    // (FIFO collision fallback: subsequent subagents with the same meta
    // pick the next-oldest unmatched parent).
    const [parent] = this.unmatchedParents.splice(i, 1);
    this.bindings.set(agentId, parent.toolUseId);
    return parent.toolUseId;
  }

  lookup(agentId: string): string | null {
    return this.bindings.get(agentId) ?? null;
  }

  unbind(agentId: string): void {
    this.bindings.delete(agentId);
  }

  /**
   * Subagent event arrived before its parent Agent tool_use was parsed —
   * buffer it. Subsequent events for the same agentId append to the buffer.
   */
  bufferPendingEvent(agentId: string, meta: SubagentMeta, event: unknown): void {
    const existing = this.pending.get(agentId);
    if (existing) {
      // meta is stable per agentId (sourced from the same .meta.json), so we
      // only capture it on the first call. Re-reads of meta after buffering
      // don't affect correlation.
      existing.events.push(event);
      return;
    }
    this.pending.set(agentId, {
      description: meta.description,
      agentType: meta.agentType,
      events: [event],
      firstSeenAt: this.nowMs(),
    });
  }

  /**
   * If `agentId` has buffered events and a matching parent is now available,
   * bind + flush. Caller is responsible for re-emitting the returned events
   * through the normal stamping path.
   */
  tryFlushPending(agentId: string): FlushResult | null {
    const entry = this.pending.get(agentId);
    if (!entry) return null;
    const parentToolUseId = this.bindSubagent(agentId, {
      description: entry.description,
      agentType: entry.agentType,
    });
    // Parent Agent tool_use not yet recorded — leave buffered, caller may retry later.
    if (!parentToolUseId) return null;
    this.pending.delete(agentId);
    return { parentToolUseId, events: entry.events };
  }

  /** Drop pending entries older than 30s. Caller invokes periodically. */
  pruneExpired(): void {
    const cutoff = this.nowMs() - PENDING_TTL_MS;
    // Deleting from a Map during for...of iteration is well-defined per
    // the ECMAScript spec (already-visited keys are skipped on delete).
    // NOTE: Kotlin's MutableMap does NOT allow this — the Kotlin mirror in
    // Task 10 needs a separate keys snapshot before deleting.
    for (const [agentId, entry] of this.pending) {
      if (entry.firstSeenAt < cutoff) this.pending.delete(agentId);
    }
  }
}
