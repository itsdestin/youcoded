// Shapes for the MCP server registry (~/.youcoded/mcp.json). See mcp-registry.ts
// for the store itself — this file is just the wire/domain types so later
// tasks (client, connection manager, tool adapter, Claude Code projection) can
// import them without pulling in the store's implementation.

/**
 * How to reach an MCP server. 'stdio' spawns a local child process; 'http'
 * speaks to a remote server over Streamable HTTP. Discriminated on `type` so
 * later tasks (the single-server client, Task 3) can switch on it exhaustively.
 */
export type McpTransport =
  | { type: 'stdio'; command: string; args?: string[]; cwd?: string }
  | { type: 'http'; url: string };

/**
 * One configured MCP server, as persisted in ~/.youcoded/mcp.json. This file
 * is SYNCED across the user's devices, so it must never hold secret plaintext
 * — envRefs/headerRefs are pointers into the machine-bound SecretsStore
 * instead (see mcp-registry.ts header comment).
 */
export interface McpServerEntry {
  /** Sanitized (sanitizeServerId), unique, used verbatim in the tool name
   *  `mcp__{server}__{tool}` — must not contain '__'. */
  id: string;
  /** Human-readable display name shown in the UI. */
  label: string;
  /** Whether this server should be connected to / exposed as tools. */
  enabled: boolean;
  /** How to reach the server. */
  transport: McpTransport;
  /** Env var name -> secretRef, for stdio servers that need secret env vars
   *  (e.g. an API token) injected into the spawned process. */
  envRefs?: Record<string, string>;
  /** HTTP header name -> secretRef, for http servers that need a secret
   *  header (e.g. Authorization) injected into requests. */
  headerRefs?: Record<string, string>;
  /** Where this entry came from: a user-added server, one bundled with a
   *  marketplace plugin, or one adopted from an existing Claude Code config
   *  (Task 7 projects the other direction; `plugin` names the owning plugin
   *  for the 'marketplace' case). */
  origin: { kind: 'user' | 'marketplace' | 'adopted'; plugin?: string };
}

/**
 * An McpServerEntry with its secretRefs decrypted back into usable values.
 * `missingSecrets` lists any envRefs/headerRefs key whose secretRef didn't
 * resolve (e.g. a registry entry synced to a device without the matching
 * SecretsStore ciphertext) — an EXPECTED "needs setup" state, never a thrown
 * error.
 */
export type ResolvedMcpServer = McpServerEntry & {
  /** Decrypted envRefs, keyed the same as envRefs. Missing entries are
   *  omitted (not present as undefined values) — see missingSecrets. */
  env?: Record<string, string>;
  /** Decrypted headerRefs, keyed the same as headerRefs. */
  headers?: Record<string, string>;
  /** Names (the envRefs/headerRefs keys) of any secret that failed to
   *  resolve. Empty array means every secret resolved. */
  missingSecrets: string[];
  /** Saved credentials exist but could not be read. Retryable, not needs-setup;
   *  never connect or project partial env/headers while this is present. */
  credentialError?: string;
};
