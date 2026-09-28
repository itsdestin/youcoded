// MCP connection manager (spec: native MCP phase 1, Task 4). Sits between the
// registry (Task 2, WHICH servers exist) and the single-server client (Task 3,
// HOW to talk to one) — its whole job is POOLING: one live connection per
// effective server configuration, shared and refcounted across sessions. Two chat
// sessions both using the Gmail server must share one subprocess, not spawn
// two. Task 5 turns the tools acquire() hands back into app tools; Task 6
// attaches them to a session.
import type { ResolvedMcpServer } from './types';
import type { McpToolDef } from './mcp-client';
import { log } from '../../logger';

// Structural subsets of McpRegistry/createConnection's real shapes — same
// seam convention as NativeHomeLike/SecretsLike/ClientFactory elsewhere in
// this folder. Tests inject fakes; the real registry/mcp-client module both
// satisfy these without this file importing their concrete classes.
export interface McpRegistryLike {
  resolveAllEnabled(): Promise<ResolvedMcpServer[]>;
}

// The exact McpConnection surface this file pools: state/lastError for
// status(), connect()/close() for lifecycle, listTools()/callTool() for the
// ReadyServer this file hands back. connect() is documented (mcp-client.ts)
// to NEVER throw — every failure lands in state/lastError instead — which is
// what lets one broken server be recorded without ever rejecting acquire().
export interface McpConnectionLike {
  readonly state: 'idle' | 'ready' | 'error' | 'needs-setup';
  readonly lastError: string | null;
  connect(): Promise<void>;
  listTools(): McpToolDef[];
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

export type McpConnectionFactory = (server: ResolvedMcpServer) => McpConnectionLike;

export type ReadyServer = {
  id: string;
  label: string;
  tools: McpToolDef[];
  call(tool: string, args: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
};

/**
 * What acquire() hands back: the servers that came up ready, plus the ONLY way
 * to give the hold back. release() lives on this object rather than being a
 * `release(sessionId)` method on the manager, and that is the whole fix for the
 * resumed-session bug (ROADMAP, 2026-07-31).
 *
 * The old shape keyed holders by sessionId. A RESUMED session reuses its id, so
 * the outgoing generation's release(id) and the incoming generation's
 * acquire(id) were indistinguishable in the pool's holder Set — one session id,
 * two generations, and `Set.add` of an already-present member is a no-op that
 * leaves no trace. Every guard that used to live here (holderTouch sequence
 * numbers, activeAcquireTokens, inflightAcquires, deferred re-release) existed
 * to reconstruct, after the fact, which generation a hold belonged to. None of
 * them could actually succeed, because the information had already been thrown
 * away at the moment two generations were written to the same key.
 *
 * A lease id is minted per acquire() call and never reused, so the two
 * generations occupy two distinct holder entries and cannot be confused. That
 * also closes the leak windows those guards were protecting: release() is only
 * reachable through an object that acquire() returns, so it cannot possibly run
 * before acquire() has finished registering holders. The race is not handled
 * better — it is unrepresentable.
 */
export interface McpLease {
  /** Servers that connected successfully. A broken server is pooled and logged
   *  but omitted here — one bad server never denies a session its working ones. */
  readonly servers: ReadyServer[];
  /** Give this lease's hold back. Idempotent: calling twice is a no-op, not a
   *  double-decrement, so a teardown path that fires on two routes is safe. */
  release(): Promise<void>;
}

// One pooled server: its connection (may still be idle/connecting/errored)
// plus WHO currently holds it. holders empties → close(); holders refills
// (a later acquire) → the entry is already gone from the map, so a fresh
// connect() happens, same as first touch. This mirrors the refcounting the
// brief specifies rather than a simple boolean, so two overlapping sessions
// never race each other into a double-connect (see connecting below) or a
// premature close.
interface PooledEntry {
  server: ResolvedMcpServer;
  /** Private in-memory comparison only: includes resolved credentials, NEVER log it. */
  configKey: string;
  closing?: Promise<void>;
  conn: McpConnectionLike;
  /** LEASE ids (see McpLease), not session ids. One acquire() call = one id,
   *  never reused, so two generations of a resumed session hold two separate
   *  entries here instead of colliding on one. */
  holders: Set<string>;
  // In-flight connect() promise, set the FIRST time any session touches this
  // server and cleared once it settles. A second concurrent acquire() for
  // the same not-yet-connected server awaits THIS instead of calling
  // connect() again — the seam that makes "one broken/slow server, two
  // simultaneous acquire()s" connect once, not twice. See McpManager.acquire.
  connecting?: Promise<void>;
}

// WHY: only connection-effective values belong in the key. Credentials are
// compared in process memory, never hashed into an identifier, persisted or logged.
// Sort record keys so registry object ordering and label edits cannot reconnect.
function effectiveConfig(server: ResolvedMcpServer): string {
  const sorted = (record?: Record<string, string>) => Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const t = server.transport;
  return JSON.stringify({ transport: t.type === 'stdio'
    ? ['stdio', t.command, t.args ?? [], t.cwd ?? null]
    : ['http', t.url],
    env: sorted(server.env), headers: sorted(server.headers),
    missing: [...server.missingSecrets].sort(), credentialError: server.credentialError ?? null });
}

export class McpManager {
  private readonly registry: McpRegistryLike;
  private readonly connectionFactory: McpConnectionFactory;
  // serverId -> CURRENT pooled entry. Retired generations remain in entries
  // until their holders release; an errored current entry stays reportable.
  private pool = new Map<string, PooledEntry>();
  /** Retired entries stay alive until THEIR holders release, even if ID reused. */
  private entries = new Set<PooledEntry>();
  /** Exact entries held by a lease, including retired generations. */
  private leaseEntries = new Map<string, PooledEntry[]>();
  // Monotonic, process-lifetime counter behind every lease id. Its ONLY job is
  // uniqueness — no ordering is read off it — so wraparound/overflow concerns
  // don't apply at any realistic session count.
  private leaseSeq = 0;

  constructor(deps: { registry: McpRegistryLike; connectionFactory: McpConnectionFactory }) {
    this.registry = deps.registry;
    this.connectionFactory = deps.connectionFactory;
  }

  /**
   * Take a lease on every enabled server, connecting any server this is the
   * FIRST holder for, and return the ones that came up `ready`. A server that
   * fails to connect (or needs setup) is still pooled — so status() can report
   * its real error and a later acquire() doesn't reconnect it every time — but
   * it is EXCLUDED from the lease's `servers`: one broken server must never
   * deny a session its working ones.
   *
   * `sessionId` is used ONLY to label the lease id and the log line below. It
   * is deliberately not the holder key — see McpLease for why that distinction
   * is the whole point.
   *
   * WHY THERE IS NO RACE MACHINERY HERE ANY MORE. The previous version carried
   * three cooperating mechanisms (an in-flight registration map, a touch
   * sequence number, a set of live acquire tokens) to defend a single leak
   * shape: "a release() arrives while acquire() is still in flight, finds no
   * holder yet to remove, no-ops — then acquire() registers a holder that
   * nothing will ever remove." Every one of those windows required release()
   * to be callable before acquire() had finished. It no longer is: release()
   * only exists as a method on the object acquire() returns, so a caller
   * cannot hold a reference to it until every holder has been registered. The
   * one exception — a throw partway through, where no lease ever reaches the
   * caller — is handled by this method's own catch, which is sequential with
   * the rest of the call and cannot overlap it.
   *
   * The two-pass split is KEPT, for its second, independent reason: pass 1
   * touches every server before yielding, so all of them start connecting at
   * once. Without it a hung server blocks every server behind it from even
   * beginning to spawn.
   */
  async acquire(sessionId: string): Promise<McpLease> {
    const leaseId = `${sessionId}#${++this.leaseSeq}`;
    try {
      const servers = await this.registry.resolveAllEnabled();
      // Pass 1 — registration. ensureConnected() is synchronous (see its own
      // comment), so this maps over every server without yielding, which is
      // what makes every connect() start concurrently rather than in series.
      const entries = servers.map((server) => this.ensureConnected(server, leaseId));

      // Pass 2 — wait for each connect() and collect the ones that made it.
      const ready: ReadyServer[] = [];
      for (const entry of entries) {
        if (entry.connecting) await entry.connecting;
        if (entry.conn.state === 'ready') {
          ready.push({
            id: entry.server.id,
            label: servers.find(s => s.id === entry.server.id)?.label ?? entry.server.label,
            tools: entry.conn.listTools(),
            call: (tool, args, signal) => entry.conn.callTool(tool, args, signal),
          });
        } else {
          // WHY: status() retains the real diagnostic, but a provider error
          // may echo resolved credentials. Log only the ID/state, never the
          // effective config or a possibly secret-bearing provider error.
          log('WARN', 'McpManager', 'MCP server excluded from this session — not ready', {
            sessionId, serverId: entry.server.id, state: entry.conn.state,
          });
        }
      }

      let released = false;
      return {
        servers: ready,
        release: async () => {
          // Idempotent by design, not by accident: a session torn down on two
          // routes (an error path AND the normal destroy()) must not
          // decrement the refcount twice and close a server another session
          // is still using.
          if (released) return;
          released = true;
          await this.releaseLease(leaseId);
        },
      };
    } catch (err) {
      // No lease ever reaches the caller on this path, so nobody else can
      // ever release what pass 1 may already have registered. Clean up our
      // own holders, then rethrow the ORIGINAL error unchanged (never guess
      // or replace a cause — error-message-standards.md).
      await this.releaseLease(leaseId);
      throw err;
    }
  }

  // Looks up (or creates) the pooled entry for `server` and adds `leaseId`
  // to its holder set, all SYNCHRONOUSLY (no `await` anywhere in this
  // method) — connecting it if this is the first-ever touch. Staying
  // synchronous is what lets acquire()'s pass 1 touch every server in one
  // uninterrupted sweep, so all of them start connecting at once instead of
  // queueing behind each other. It is also the concurrency-safety seam for
  // the double-connect race: two acquire() calls racing on the same server
  // both reach this method, both see the SAME entry.connecting promise (the
  // entry + its promise are installed synchronously, before acquire() ever
  // awaits), so only one connect() ever runs no matter how many sessions ask
  // at once.
  //
  // WHY no retry for unchanged settings: an error/needs-setup entry stays
  // pooled until its holders release. A changed effective configuration gets
  // a fresh generation immediately, without disturbing those older holders;
  // retrying an unchanged broken connection on each acquire remains out of scope.
  private ensureConnected(server: ResolvedMcpServer, leaseId: string): PooledEntry {
    const key = effectiveConfig(server);
    let entry = this.pool.get(server.id);
    if (entry && entry.configKey !== key) {
      // WHY: old leases retain their exact connection. Never move holders into
      // the replacement (even an error placeholder): release of OLD must not
      // close NEW, and A→B→A must not resurrect the retired A connection.
      this.pool.delete(server.id);
      entry = undefined;
    }
    if (!entry) {
      // Fix (Finding 6): a server synced from another device without its
      // secret ciphertext (`missingSecrets`, populated by
      // McpRegistry.resolveEntry) must NEVER reach connect() — doing so hands
      // a stdio server a spawned process missing a required env var (or an
      // http server a request missing a required header), and whatever
      // opaque auth error the server itself emits reaches the user instead of
      // a message naming the actual missing secret. mcp-reconciler.ts's
      // projectToClaudeJson already skips these for Claude Code's OWN
      // config (`missingSecrets.length > 0` → not projected); this pool must
      // hold the SAME line for native sessions. Build a synthetic
      // 'needs-setup' connection instead of ever touching connectionFactory —
      // McpConnection already HAS a 'needs-setup' state (used for the OAuth
      // case in mcp-client.ts); this reuses that same state value rather than
      // inventing a parallel one, so acquire()'s ready-check and status()
      // both treat it exactly like any other not-ready server.
      // Snapshot before connectionFactory: a mutable registry object must not
      // change the settings that an already-acquired connection actually uses.
      const snapshot: ResolvedMcpServer = { ...server, transport: server.transport.type === 'stdio'
        ? { ...server.transport, args: server.transport.args?.slice() } : { ...server.transport },
        env: server.env ? { ...server.env } : undefined,
        headers: server.headers ? { ...server.headers } : undefined,
        missingSecrets: [...server.missingSecrets] };
      const credentialFailure = server.credentialError || (server.missingSecrets.length > 0
        ? `${server.label} needs setup — missing secret(s): ${server.missingSecrets.join(', ')}.` : null);
      const conn: McpConnectionLike = credentialFailure
        ? {
            state: server.credentialError ? 'error' : 'needs-setup',
            lastError: credentialFailure,
            // Never actually invoked (no retry while pooled — see this
            // method's own "WHY no retry" note above) but kept as a real
            // no-op so this object satisfies McpConnectionLike structurally.
            connect: async () => {},
            listTools: () => [],
            callTool: async () => ({
              text: credentialFailure,
              isError: true,
            }),
            close: async () => {},
          }
        : this.connectionFactory(snapshot);
      entry = { server: snapshot, configKey: key, conn, holders: new Set() };
      this.pool.set(server.id, entry);
      this.entries.add(entry);
      if (!credentialFailure) {
        entry.connecting = conn.connect().finally(() => {
          entry!.connecting = undefined;
        });
      }
    }
    entry.holders.add(leaseId);
    const held = this.leaseEntries.get(leaseId) ?? [];
    held.push(entry);
    this.leaseEntries.set(leaseId, held);
    return entry;
  }

  /**
   * Drop ONE lease's hold on every server it holds. A server whose holder set
   * empties as a result is closed and removed from the pool (a later acquire()
   * reconnects it fresh). A lease that holds nothing is a no-op, never a throw.
   *
   * Private, and reached only through the object acquire() returned. That is
   * what makes this method as short as it is: a lease id is unique per
   * acquire() call and can never be re-registered, so "did somebody re-take
   * this exact hold while I was running?" — the question the previous
   * sessionId-keyed version needed three separate mechanisms to answer, and
   * still answered wrongly for a resumed session — cannot be asked. Two
   * generations of one resumed session are two lease ids, and each release
   * touches only its own.
   *
   * `holders.delete()` returning false IS the "this lease didn't hold this
   * server" check; no separate `has()` is needed.
   */
  private async releaseLease(leaseId: string): Promise<void> {
    const held = this.leaseEntries.get(leaseId) ?? [];
    this.leaseEntries.delete(leaseId);
    for (const entry of held) {
      if (!entry.holders.delete(leaseId) || entry.holders.size > 0) continue;
      // WHY: only delete an ID when this EXACT generation is still current.
      // Remove before awaiting close so an acquire during teardown connects anew.
      if (this.pool.get(entry.server.id) === entry) this.pool.delete(entry.server.id);
      try {
        // WHY: keep the generation discoverable to destroyAll until close
        // settles; removing it before this await let app teardown return while
        // an older released transport was still closing.
        await this.closeEntry(entry);
      } catch (err) {
        log('ERROR', 'McpManager', 'closing a released MCP connection failed', {
          serverId: entry.server.id, errorType: err instanceof Error ? err.name : 'unknown',
        });
      } finally {
        this.entries.delete(entry);
      }
    }
  }

  private closeEntry(entry: PooledEntry): Promise<void> {
    // WHY: release and destroyAll may overlap; close exactly once and wait for
    // a pending connect before closing its transport. Never reuse while closing.
    if (!entry.closing) entry.closing = (async () => {
      if (entry.connecting) { try { await entry.connecting; } catch { /* close failed connect too */ } }
      await entry.conn.close();
    })();
    return entry.closing;
  }

  /** App-quit teardown: close current AND retired/closing generations. */
  async destroyAll(): Promise<void> {
    const entries = [...this.entries];
    this.pool.clear(); // no acquisition may reuse a closing connection
    this.leaseEntries.clear();
    // WHY: a second destroyAll must also await pending closes. Retain each
    // generation in entries until its close settles, even across concurrent
    // destroy/release calls. closeEntry ensures the transport closes only once.
    await Promise.all(entries.map(async entry => {
      try { await this.closeEntry(entry); }
      finally { this.entries.delete(entry); }
    }));
  }

  /** One current entry per server ID, including failed connections. Retired
   *  generations remain usable through leases but never duplicate status rows. */
  status(): Array<{ id: string; state: string; error: string | null }> {
    return [...this.pool.values()].map((entry) => ({
      id: entry.server.id,
      state: entry.conn.state,
      error: entry.conn.lastError,
    }));
  }
}
