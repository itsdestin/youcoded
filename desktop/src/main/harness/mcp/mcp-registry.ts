// MCP server registry (spec: native MCP phase 1, Task 2). Persists WHICH MCP
// servers are configured to ~/.youcoded/mcp.json — a file SYNCED across the
// user's devices. Secret plaintext (API tokens, auth headers) must never
// enter it: only a `secretRef` pointer does. The plaintext lives ONLY in
// SecretsStore (safeStorage, userData, machine-bound) — same split as
// search-providers.json/SearchKeyStore, same NativeHome locking. A
// machine-bound ciphertext synced to a second device is unrecoverable there,
// which is exactly why the split exists: the registry entry still syncs and
// shows up, just as "needs setup" (see resolve()'s missingSecrets), instead of
// silently carrying a ciphertext that can never be decrypted off-box.
import type { McpTransport, McpServerEntry, ResolvedMcpServer } from './types';

export type { McpTransport, McpServerEntry, ResolvedMcpServer };

// Structural interfaces so tests inject fakes and the real classes satisfy
// them without importing them here — copied from search-key-store.ts rather
// than imported (same convention). List ONLY the methods this store calls.
export interface NativeHomeLike {
  readJson(rel: string): unknown | null;
  mutateJson(rel: string, mutate: (current: unknown | null) => unknown): Promise<void>;
}

export interface SecretsLike {
  set(plaintext: string, existingRef?: string): Promise<string>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
  has(ref: string | undefined): boolean;
}

const FILE = 'mcp.json';

// '__' is the tool-name separator (mcp__{server}__{tool}); a server id
// containing it would make the tool name ambiguous to parse. Collapse it
// along with every other unsafe character.
export function sanitizeServerId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Defense at the write boundary, not just the sanitizer: sanitizeServerId is a
// helper callers SHOULD run on a raw label, but upsert() is the one place that
// actually persists an id, so it's the backstop that keeps a hand-built or
// unsanitized id from ever reaching disk and making `mcp__{server}__{tool}`
// ambiguous to parse later (Task 5).
function assertSafeServerId(id: string): void {
  if (!id || id.includes('__')) {
    throw new Error(
      `Invalid MCP server id "${id}" — ids cannot be empty or contain "__" (reserved as the mcp__{server}__{tool} separator).`
    );
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// On-disk wire shape for a secret pointer: named the same as SearchKeyStore's
// per-backend `{ secretRef }` — a glance at the raw JSON (or a future
// migration script) can tell "this is a pointer, not a value" without
// cross-referencing the schema. envRefs/headerRefs hold one of these per
// name instead of a bare ref string.
type WireRefs = Record<string, { secretRef?: unknown } | undefined>;

function wrapRefs(refs: Record<string, string> | undefined): WireRefs | undefined {
  if (!refs) return undefined;
  const out: WireRefs = {};
  for (const [name, ref] of Object.entries(refs)) out[name] = { secretRef: ref };
  return out;
}

// Guards on `typeof === 'string'` so a hand-edited non-string secretRef never
// reaches SecretsStore (mirrors SearchKeyStore.refFor). Returns undefined
// (not {}) when there's nothing valid to report, so a spread of the result
// never adds a stray empty envRefs/headerRefs key.
function unwrapRefs(raw: unknown): Record<string, string> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(raw)) {
    const ref = isPlainObject(v) ? v.secretRef : undefined;
    if (typeof ref === 'string') out[name] = ref;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Wrong-shape tolerance: a garbage/corrupt file, or a hand-edited entry
// missing even an id, reads as "not here" rather than throwing — same policy
// as NativeHome.readJson treating corrupt JSON as absent.
//
// Fix pass (2026-07-31, Findings 3 + 4): this is the READ boundary every
// production consumer (list()/resolve()/resolveAllEnabled(), and therefore
// McpManager.acquire() and mcp-reconciler's projection) actually goes
// through — assertSafeServerId only ever guarded upsert(), which has ZERO
// production callers (phase 1 is hand-edit-only), so a hand-written
// mcp.json was reaching every reader with NEITHER guard applied. Two fixes,
// both at this one boundary:
//
// 1. Id safety (Finding 4): reject (read as absent) an id that's empty or
//    contains "__" — the SAME reserved separator assertSafeServerId already
//    protects on the write side. Left unguarded here, server `a` with tool
//    `b__c` and server `a__b` with tool `c` both produce the tool name
//    `mcp__a__b__c` — a remembered "always allow" for one silently
//    auto-approves the other, and ensureConnected's pool key collision hands
//    the second entry the FIRST's connection while double-counting its
//    budget cost. A rejected entry is a no-op, never a throw — a malformed
//    hand-edit is a user mistake, not a crash.
// 2. No-plaintext-secrets (Finding 3): build the returned entry from KNOWN
//    fields only, instead of spreading `raw` wholesale. `resolveEntry` (below)
//    spreads THIS function's return value, so a hand-written `env`/`headers`
//    key sitting in raw JSON used to survive verbatim into
//    `ResolvedMcpServer.env`/`.headers` and reach both `buildTransport`
//    (mcp-client.ts) and `buildRegistryServerConfig` (mcp-reconciler.ts) —
//    the ONLY way (upsert() has no caller) to configure a secret-bearing
//    server today, and it worked completely silently, defeating the one
//    invariant the whole envRefs/headerRefs split exists to protect: a
//    synced `~/.youcoded/mcp.json` never carries secret plaintext. Listing
//    only the known fields means an extra `env`/`headers` key is simply
//    dropped here — inert by construction, not merely "not the intended
//    path" (see docs/native-runtime.md — phase 1 cannot configure a
//    secret-bearing server at all; that is a documented limitation, not an
//    oversight).
function fromStored(raw: unknown): McpServerEntry | null {
  if (!isPlainObject(raw) || typeof raw.id !== 'string') return null;
  if (raw.id.length === 0 || raw.id.includes('__')) return null;
  return {
    id: raw.id,
    label: raw.label as McpServerEntry['label'],
    enabled: raw.enabled as McpServerEntry['enabled'],
    transport: raw.transport as McpServerEntry['transport'],
    origin: raw.origin as McpServerEntry['origin'],
    envRefs: unwrapRefs(raw.envRefs),
    headerRefs: unwrapRefs(raw.headerRefs),
  };
}

function toStored(entry: McpServerEntry): unknown {
  return {
    ...entry,
    envRefs: wrapRefs(entry.envRefs),
    headerRefs: wrapRefs(entry.headerRefs),
  };
}

type McpFile = { servers?: unknown };

export class McpRegistry {
  constructor(private home: NativeHomeLike, private secrets: SecretsLike) {}

  /**
   * All configured servers (enabled or not), with envRefs/headerRefs still as
   * unresolved secretRef pointers — synchronous, mirrors NativeHome.readJson.
   * A garbage `servers` field (wrong type, or individual entries missing an
   * id) reads as if it were empty rather than throwing.
   */
  list(): McpServerEntry[] {
    const data = this.home.readJson(FILE) as McpFile | null;
    const servers = data?.servers;
    if (!Array.isArray(servers)) return [];
    const out: McpServerEntry[] = [];
    // Fix pass (Finding 4): dedupe by id, keeping the FIRST occurrence. A
    // duplicate id reaching resolveAllEnabled() would make ensureConnected
    // (mcp-manager.ts) hand the SECOND entry the FIRST's pooled connection —
    // its own transport silently ignored while its budget cost is still
    // counted twice in syncMcpTools. A hand-edited mcp.json is the only way
    // this can happen (no write path produces duplicates); reading only the
    // first is a no-op fix, never a throw.
    const seen = new Set<string>();
    for (const raw of servers) {
      const entry = fromStored(raw);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
    return out;
  }

  /** One server with its secrets decrypted, or null if no such id is registered. */
  async resolve(id: string): Promise<ResolvedMcpServer | null> {
    const entry = this.list().find((s) => s.id === id);
    return entry ? this.resolveEntry(entry) : null;
  }

  /** Every enabled server, resolved. Used by later tasks to open connections
   *  at startup — disabled servers are skipped so a broken/removed server
   *  entry that's merely toggled off doesn't surface as a connection error. */
  async resolveAllEnabled(): Promise<ResolvedMcpServer[]> {
    const enabled = this.list().filter((s) => s.enabled);
    return Promise.all(enabled.map((s) => this.resolveEntry(s)));
  }

  private async resolveEntry(entry: McpServerEntry): Promise<ResolvedMcpServer> {
    const missingSecrets: string[] = [];
    try {
      const env = await this.decryptRefs(entry.envRefs, missingSecrets);
      const headers = await this.decryptRefs(entry.headerRefs, missingSecrets);
      return {
        ...entry,
        ...(env !== undefined ? { env } : {}),
        ...(headers !== undefined ? { headers } : {}),
        missingSecrets,
      };
    } catch (error) {
      // WHY: one locked/unreadable key must not reject every enabled server.
      // Discard partially decrypted maps; a later resolve retries this server.
      return {
        ...entry, missingSecrets,
        credentialError: error instanceof Error ? error.message : 'Could not read saved MCP credentials. Retry.',
      };
    }
  }

  // Decrypts each ref, collecting any name whose ref no longer resolves into
  // `missing` instead of throwing — a synced entry on a device without the
  // matching SecretsStore ciphertext is expected ("needs setup"), not an
  // error. The failed name is simply omitted from the returned map.
  private async decryptRefs(
    refs: Record<string, string> | undefined,
    missing: string[]
  ): Promise<Record<string, string> | undefined> {
    if (!refs) return undefined;
    const out: Record<string, string> = {};
    for (const [name, ref] of Object.entries(refs)) {
      const value = await this.secrets.get(ref);
      if (value === null) {
        missing.push(name);
        continue;
      }
      out[name] = value;
    }
    return out;
  }

  /**
   * Insert or update a server. Same id → in-place update (used to edit a
   * server's label/transport/enabled state, or rotate its secrets) — the
   * list stays the same length and the stored entry is replaced wholesale.
   *
   * `secrets` is a flat name → plaintext map for whichever fields this
   * transport uses: stdio servers route it into envRefs (spawned-process env
   * vars), http servers into headerRefs (request headers). Each value is
   * encrypted via SecretsStore BEFORE the registry file is touched — same
   * encrypt-then-store ordering as SearchKeyStore.setKey, so no code path can
   * accidentally serialize plaintext. Rotation reuses the existing ref for a
   * name that's already set (secrets.set's existingRef param), so re-saving a
   * server's token overwrites the same ciphertext entry rather than orphaning
   * the old one.
   *
   * Fields not present in `entry` (envRefs/headerRefs omitted entirely) keep
   * whatever was already stored for that id — an upsert that only changes
   * `label`, say, doesn't need to know or resend the server's existing refs.
   */
  async upsert(entry: McpServerEntry, secrets?: Record<string, string>): Promise<void> {
    assertSafeServerId(entry.id);

    const existing = this.list().find((s) => s.id === entry.id);
    let envRefs = entry.envRefs !== undefined ? { ...entry.envRefs } : existing?.envRefs ? { ...existing.envRefs } : undefined;
    let headerRefs = entry.headerRefs !== undefined ? { ...entry.headerRefs } : existing?.headerRefs ? { ...existing.headerRefs } : undefined;

    if (secrets) {
      const isHttp = entry.transport.type === 'http';
      for (const [name, plaintext] of Object.entries(secrets)) {
        const existingRef = isHttp ? headerRefs?.[name] : envRefs?.[name];
        const ref = await this.secrets.set(plaintext, existingRef);
        if (isHttp) headerRefs = { ...headerRefs, [name]: ref };
        else envRefs = { ...envRefs, [name]: ref };
      }
    }

    const finalEntry: McpServerEntry = {
      ...entry,
      ...(envRefs !== undefined ? { envRefs } : {}),
      ...(headerRefs !== undefined ? { headerRefs } : {}),
    };

    await this.home.mutateJson(FILE, (cur) => {
      // Wrong-shape tolerance: a null/garbage current file falls back to an
      // empty list — the write heals the shape while preserving every OTHER
      // server already stored.
      const data = (cur as McpFile | null) ?? {};
      const list = Array.isArray(data.servers) ? data.servers.filter((s) => fromStored(s) !== null) : [];
      const idx = list.findIndex((s) => (fromStored(s) as McpServerEntry).id === finalEntry.id);
      const stored = toStored(finalEntry);
      if (idx >= 0) list[idx] = stored;
      else list.push(stored);
      return { servers: list };
    });
  }

  /**
   * Remove a server. Deletes its secret ciphertext FIRST, then drops the
   * registry entry — same ordering as SearchKeyStore.removeKey: a crash
   * between the two steps leaves a dangling secretRef pointer (harmless,
   * resolve() just reports it missing) rather than an orphaned, undeletable
   * ciphertext blob with no pointer left to find it by.
   */
  async remove(id: string): Promise<void> {
    const entry = this.list().find((s) => s.id === id);
    if (entry) {
      const refs = [...Object.values(entry.envRefs ?? {}), ...Object.values(entry.headerRefs ?? {})];
      for (const ref of refs) await this.secrets.delete(ref);
    }
    await this.home.mutateJson(FILE, (cur) => {
      const data = (cur as McpFile | null) ?? {};
      const list = Array.isArray(data.servers) ? data.servers : [];
      return { servers: list.filter((s) => (fromStored(s)?.id ?? null) !== id) };
    });
  }
}
