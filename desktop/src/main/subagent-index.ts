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

/** WHY (2026-09-16, per-session-maps investigation): a parent Agent tool_use
 *  whose subagent JSONL never materialises (the subagent errored before
 *  writing, or ran in a mode that writes none) used to sit in the FIFO for the
 *  life of the session — the `pending` map next door ages out after 30 s, but
 *  parents never did. A parent is only ever matched by a subagent that starts
 *  right after it, so a queue this deep means the oldest entries are dead; the
 *  cap is a count rather than a TTL because timing is injected only for the
 *  pending side and a long-running parent turn should not expire its own
 *  Task before the subagent's first line lands. */
const MAX_UNMATCHED_PARENTS = 256;

interface ParentRecord {
  toolUseId: string;
  description: string;
  subagentType: string;
}

interface PendingEntry {
  description: string;
  agentType: string;
  toolUseId?: string;
  events: unknown[];
  firstSeenAt: number;
}

export interface SubagentMeta {
  description: string;
  agentType: string;
  /** The parent Agent tool_use this helper was started by, when Claude Code
   *  records it in the .meta.json (every helper measured on 2026-09-24 did).
   *  Exact — preferred over description matching, see bindSubagent. */
  toolUseId?: string;
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
    // Oldest first: FIFO order is the matching contract, so the entry least
    // likely to still find its subagent is always at the front.
    if (this.unmatchedParents.length > MAX_UNMATCHED_PARENTS) this.unmatchedParents.shift();
  }

  bindSubagent(agentId: string, meta: SubagentMeta): string | null {
    // WHY exact id first (2026-09-24, "the app sucks at keeping track of
    // subagents"): description matching failed two ways on real transcripts.
    // An Agent call that omits subagent_type records '' here while its meta
    // says 'general-purpose', so it never bound and the card showed no
    // activity at all (30 of 1,139 recent calls). And two helpers sharing a
    // description could land on each other's cards. When the meta names its
    // parent, that is the answer — and a nested helper (started by another
    // helper, so its parent tool_use is not in this queue) correctly binds to
    // nothing instead of borrowing a same-named top-level card.
    const i = meta.toolUseId
      ? this.unmatchedParents.findIndex(p => p.toolUseId === meta.toolUseId)
      : this.unmatchedParents.findIndex(
        p => p.description === meta.description
          && (p.subagentType || 'general-purpose') === meta.agentType,
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
      ...(meta.toolUseId ? { toolUseId: meta.toolUseId } : {}),
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
      toolUseId: entry.toolUseId,
    });
    // Parent Agent tool_use not yet recorded — leave buffered, caller may retry later.
    if (!parentToolUseId) return null;
    this.pending.delete(agentId);
    return { parentToolUseId, events: entry.events };
  }

  /** Is anything buffered and waiting for its parent? SubagentWatcher keeps
   *  its prune timer only while this is true (simplification audit W8). */
  hasPending(): boolean {
    return this.pending.size > 0;
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
