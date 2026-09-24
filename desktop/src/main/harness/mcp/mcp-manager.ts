// MCP connection manager (spec: native MCP phase 1, Task 4). Sits between the
// registry (Task 2, WHICH servers exist) and the single-server client (Task 3,
// HOW to talk to one) — its whole job is POOLING: one live connection per
// server, shared and refcounted across every session that wants it. Two chat
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

export class McpManager {
  private readonly registry: McpRegistryLike;
  private readonly connectionFactory: McpConnectionFactory;
  // serverId -> pooled entry. Absence means "never touched yet" — NOT the
  // same as a connected-but-errored server, which stays present (see acquire).
  private pool = new Map<string, PooledEntry>();
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
   * `allowIds` (project-plugin-controls T2, design §3 "Enforcement"): an
   * optional per-session allowlist of server ids, applied to
   * `registry.resolveAllEnabled()` BEFORE this method ever touches
   * `ensureConnected` — so a server the caller excluded is never connected,
   * spawned, or added to the shared pool for this lease at all (not merely
   * hidden from the returned list, the way a broken server is). `undefined`
   * (every caller before this task, and any session outside a project) keeps
   * today's behaviour exactly: every enabled server is eligible.
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
  async acquire(sessionId: string, allowIds?: Set<string>): Promise<McpLease> {
    const leaseId = `${sessionId}#${++this.leaseSeq}`;
    try {
      let servers = await this.registry.resolveAllEnabled();
      // Filter BEFORE anything below ever sees an excluded server — never a
      // post-hoc drop from the ready list, which is how a broken server is
      // handled (that one still gets pooled/logged; this one must not exist
      // for this lease at all). See this method's own "allowIds" doc above.
      if (allowIds) servers = servers.filter((s) => allowIds.has(s.id));
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
            label: entry.server.label,
            tools: entry.conn.listTools(),
            call: (tool, args, signal) => entry.conn.callTool(tool, args, signal),
          });
        } else {
          // Fix (Finding 5): status()/lastError have always been correct —
          // nothing has ever LOGGED them. A developer with a typo'd command
          // got no tool, no error dialog, and (until now) no log line either:
          // the exact silent failure this whole design exists to prevent, and
          // the reason the dogfood checklist's "confirm the server drops and
          // is reported" step could never actually pass. One line per
          // excluded server, naming it and its real (never reworded) error.
          log('WARN', 'McpManager', 'MCP server excluded from this session — not ready', {
            sessionId, serverId: entry.server.id, state: entry.conn.state, error: entry.conn.lastError,
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
  // Except for a credential-error placeholder whose secrets now resolve (below),
  // WHY no retry: if `entry` already exists — even in `error` or
  // `needs-setup` state — it is returned as-is; connect() is never retried
  // while the entry stays pooled (i.e. while any holder remains). This is
  // deliberate, not an oversight: retry/backoff was out of scope for this
  // manager. The user-visible effect is that fixing a broken server's config
  // has no effect until every current holder releases (or the app
  // restarts) — see status(), which surfaces the real lastError so this
  // isn't silent.
  private ensureConnected(server: ResolvedMcpServer, leaseId: string): PooledEntry {
    let entry = this.pool.get(server.id);
    let recoveredHolders: Set<string> | undefined;
    if (entry?.server.credentialError && !server.credentialError) {
      // WHY: this entry was a resource-free error placeholder, never a live
      // connection. Retry after wallet recovery without discarding older leases.
      recoveredHolders = entry.holders;
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
        : this.connectionFactory(server);
      entry = { server, conn, holders: recoveredHolders ?? new Set() };
      this.pool.set(server.id, entry);
      if (!credentialFailure) {
        entry.connecting = conn.connect().finally(() => {
          entry!.connecting = undefined;
        });
      }
    }
    entry.holders.add(leaseId);
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
    for (const [id, entry] of [...this.pool.entries()]) {
      if (!entry.holders.delete(leaseId)) continue;
      if (entry.holders.size > 0) continue;
      // Remove from the pool BEFORE awaiting close(): an acquire() that lands
      // during the await must build a fresh entry rather than hand out this
      // one, which is already on its way down.
      this.pool.delete(id);
      // Unguarded close() would throw out of this loop and strand every
      // remaining entry this lease still holds. The connection is being
      // discarded either way, so a close() failure isn't actionable for the
      // caller — log the REAL error rather than swallow it
      // (error-message-standards.md), matching McpConnection.close()'s own
      // best-effort teardown policy.
      try {
        await entry.conn.close();
      } catch (err) {
        log('ERROR', 'McpManager', 'closing a released MCP connection failed', {
          serverId: id, error: String(err),
        });
      }
    }
  }

  /**
   * The raw enabled-server list (T2, project-plugin-controls) — for a caller
   * that needs to know WHAT exists (id + origin) before deciding an
   * `allowIds` set to pass to acquire(), without holding its own reference to
   * the registry this manager already wraps. Never connects/spawns anything
   * (same as acquire()'s own pass 1 registration, this only calls through to
   * `registry.resolveAllEnabled()`) — NativeSessionHost's availability
   * resolution is the one caller, and it deliberately runs BEFORE acquire(),
   * so this and acquire()'s own resolveAllEnabled() call do resolve the
   * registry twice per session create. That duplication is the accepted cost
   * of the design's given `acquire(sessionId, allowIds?)` contract (§3): the
   * allowlist must already be known before acquire() ever runs, and acquire()
   * itself must independently re-derive "every enabled server" so an
   * `allowIds`-less caller keeps getting exactly today's behaviour.
   */
  async listEnabled(): Promise<ResolvedMcpServer[]> {
    return this.registry.resolveAllEnabled();
  }

  /** App-quit teardown: close every pooled connection regardless of
   *  refcount. A leaked MCP subprocess would otherwise outlive the app. */
  async destroyAll(): Promise<void> {
    const entries = [...this.pool.values()];
    this.pool.clear();
    for (const entry of entries) {
      await entry.conn.close();
    }
  }

  /** Every server this manager has ever touched, including ones that failed
   *  to connect — their REAL error (McpConnection.lastError, never reworded)
   *  so a session picker can show why a server is unavailable. */
  status(): Array<{ id: string; state: string; error: string | null }> {
    return [...this.pool.values()].map((entry) => ({
      id: entry.server.id,
      state: entry.conn.state,
      error: entry.conn.lastError,
    }));
  }
}
