import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { listInstalledPluginDirs } from './claude-code-registry';
import { NativeHome } from './native-home';
import { SecretsStore } from './providers/secrets-store';
import { McpRegistry, type ResolvedMcpServer } from './harness/mcp/mcp-registry';
import { log } from './logger';

/**
 * MCP Reconciler (decomposition v3 §9.3; native MCP phase 1, Task 7)
 *
 * Reconciles Claude Code's ~/.claude.json `mcpServers` section from TWO
 * sources:
 *
 *   1. Plugin manifests (~/.claude/plugins/ * /mcp-manifest.json) — the
 *      original, additive-only path. Only auto-registers `auto: true`
 *      entries, filtered by `platform`, expanding `{{plugin_root}}`. NEVER
 *      overwrites or removes an existing entry, owned or not — unchanged from
 *      before this task.
 *   2. The YouCoded MCP registry (~/.youcoded/mcp.json, via McpRegistry) —
 *      new in Task 7. See `projectToClaudeJson`'s header comment for the
 *      ownership rule that governs this source, INCLUDING the collision
 *      guard added in the fix pass: an id that already exists in mcpServers
 *      and that YouCoded did not previously own (hand-written by the user via
 *      `claude mcp add <id> ...`, or scanned from a plugin manifest) is never
 *      overwritten — it is skipped and reported, not silently replaced.
 *
 * Servers with `auto: false` (setup required, e.g., iMessages full-disk-access,
 * Todoist OAuth) are skipped — those need the user to act before they work,
 * and surfacing that belongs in the marketplace UI, not a silent reconciler.
 *
 * OPEN QUESTION (flagged in task-7-report.md, not resolved by this task): the
 * plan's Task 7 step 4 says the manifest scan "moves to feeding the registry".
 * That migration is deliberately NOT done here — see the report for why.
 */

const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

interface McpManifestEntry {
  name: string;
  description?: string;
  platform?: 'macos' | 'windows' | 'linux' | 'all';
  type?: 'stdio' | 'http';
  command?: string;
  command_windows?: string; // platform-specific override
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  auto?: boolean;
  setup_note?: string;
}

interface ClaudeJson {
  mcpServers?: Record<string, unknown>;
  /** Ids of mcpServers entries YouCoded currently owns (see
   *  projectToClaudeJson). A plain top-level key, deliberately NOT nested
   *  inside individual server entries — see the OWNER DECISION comment on
   *  projectToClaudeJson below. */
  _youcodedOwnedMcpServers?: string[];
  [k: string]: unknown;
}

// Guard for the write path against a hand-edited/corrupted ~/.claude.json
// where `mcpServers` is present but not an object (e.g. a string or number).
// Spreading a non-object with `{ ...value }` does NOT throw in JS — for a
// string it produces numeric-indexed keys ('0', '1', ...) that would then get
// written back into the real config as garbage entries. Treat anything that
// isn't a plain object the same as "absent".
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function currentPlatform(): 'macos' | 'windows' | 'linux' {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function platformMatches(declared: McpManifestEntry['platform']): boolean {
  if (!declared || declared === 'all') return true;
  return declared === currentPlatform();
}

function expandTokens(s: string, pluginRoot: string): string {
  return s.replace(/\{\{plugin_root\}\}/g, pluginRoot);
}

function readManifest(pluginDir: string): { entries: McpManifestEntry[]; pluginRoot: string } | null {
  const p = path.join(pluginDir, 'mcp-manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const entries: McpManifestEntry[] = Array.isArray(data) ? data : (data.servers ?? []);
    return { entries, pluginRoot: pluginDir };
  } catch {
    return null;
  }
}

function listManifests(): Array<{ entries: McpManifestEntry[]; pluginRoot: string }> {
  // See claude-code-registry.listInstalledPluginDirs() — walks top-level
  // toolkit clone AND the marketplace subtree so both install paths surface.
  const out: Array<{ entries: McpManifestEntry[]; pluginRoot: string }> = [];
  for (const pluginDir of listInstalledPluginDirs()) {
    const m = readManifest(pluginDir);
    if (m) out.push(m);
  }
  return out;
}

// Fix (Finding 2, 2026-07-31): "absent" and "present but unreadable" are NOT
// the same thing, and the old catch-all `catch { return {}; }` treated them
// identically. `~/.claude.json` is Destin's LIVE Claude Code config — 59
// top-level keys, project history, onboarding state — and the caller below
// (reconcileMcp) writes `projected` back out whenever `mcpServers`/ownership
// differ from what it read. With a non-empty registry, an unreadable file
// (corrupt JSON from a partial write, EACCES, a read racing an external
// writer) reading as `{}` makes EVERY key look "changed" — the file gets
// atomically REPLACED with a bare `{mcpServers, _youcodedOwnedMcpServers}`
// skeleton, irrecoverably losing everything else, on every launch and every
// plugin install. Returning `null` here (never a throw — this must not crash
// launch) signals "abort, don't write" to the caller instead. Takes an
// explicit path (rather than reading the module-level CLAUDE_JSON constant)
// so tests can exercise this exact absent-vs-unreadable distinction against a
// temp file — never the real file.
export function readClaudeJsonFrom(filePath: string): ClaudeJson | null {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    log('ERROR', 'mcp-reconciler', 'unable to read an existing ~/.claude.json — aborting MCP reconcile rather than risk overwriting it', {
      path: filePath, error: String(err),
    });
    return null;
  }
}

function readClaudeJson(): ClaudeJson | null {
  return readClaudeJsonFrom(CLAUDE_JSON);
}

function writeClaudeJsonAtomic(data: ClaudeJson): void {
  const tmp = `${CLAUDE_JSON}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, CLAUDE_JSON);
}

/** Convert a manifest entry to the shape Claude Code expects in .claude.json. */
function buildServerConfig(entry: McpManifestEntry, pluginRoot: string): Record<string, unknown> | null {
  if (entry.type === 'http') {
    if (!entry.url) return null;
    return { type: 'http', url: entry.url };
  }
  // stdio (default)
  const rawCommand = process.platform === 'win32' && entry.command_windows
    ? entry.command_windows
    : entry.command;
  if (!rawCommand) return null;
  const config: Record<string, unknown> = {
    type: 'stdio',
    command: expandTokens(rawCommand, pluginRoot),
  };
  if (entry.args) config.args = entry.args.map(a => expandTokens(a, pluginRoot));
  if (entry.env) config.env = entry.env;
  return config;
}

/** Convert one RESOLVED registry server (secrets already decrypted) into the
 *  shape Claude Code expects in ~/.claude.json's mcpServers section. Distinct
 *  from buildServerConfig above: that one reads a plugin MANIFEST entry, this
 *  one reads a registry entry — different source shapes, same destination. */
function buildRegistryServerConfig(server: ResolvedMcpServer): Record<string, unknown> {
  if (server.transport.type === 'http') {
    const config: Record<string, unknown> = { type: 'http', url: server.transport.url };
    if (server.headers && Object.keys(server.headers).length > 0) config.headers = server.headers;
    return config;
  }
  // stdio
  const config: Record<string, unknown> = { type: 'stdio', command: server.transport.command };
  if (server.transport.args) config.args = server.transport.args;
  if (server.transport.cwd) config.cwd = server.transport.cwd;
  if (server.env && Object.keys(server.env).length > 0) config.env = server.env;
  return config;
}

/**
 * Pure projection of the YouCoded MCP registry into Claude Code's
 * ~/.claude.json shape. Kept pure so every case is unit-testable without ever
 * touching a real config file — `reconcileMcp` below is the only impure
 * caller (reads the file, calls this, writes atomically).
 *
 * OWNERSHIP (2026-07-30, spec 2026-07-30-native-mcp-design §3.3 — owner
 * decision overriding the original plan's per-entry marker):
 * YouCoded manages exactly the entries it marked as its own, tracked in a
 * TOP-LEVEL `_youcodedOwnedMcpServers: string[]` key, NOT a per-entry flag.
 * Claude Code demonstrably tolerates arbitrary top-level keys (Destin's real
 * file carries 59) but whether it tolerates an unknown key INSIDE an
 * mcpServers entry is unverified — writing one there could silently break MCP
 * loading in his live sessions if that schema turns out to be strict, so
 * server entries stay schema-clean.
 *
 * An entry it does not own is never modified or removed. An owned entry that
 * has left the registry (disabled or deleted) IS removed — that is how
 * disabling a server in YouCoded turns it off for Claude Code too, which is
 * what "YouCoded owns it" has to mean. The owned-id list is rebuilt fresh on
 * every call from THIS run's registry, so it can never drift from reality.
 *
 * COLLISION GUARD (fix pass, 2026-07-31): "an entry it does not own is never
 * modified" has to hold on the WRITE side too, not just the prune side above.
 * `sanitizeServerId()` applies no namespace prefix, so a human-picked id like
 * `gmail` from `claude mcp add gmail ...` collides exactly with a YouCoded
 * registry entry labeled "Gmail". Before writing a registry server's config,
 * check whether its id already exists in `mcpServers` AND is absent from
 * `previouslyOwned` — that combination means "something else put this key
 * here" (a hand-written entry, or a plugin-manifest-scanned one from the loop
 * in `reconcileMcp` that runs before this function). That id is skipped, not
 * overwritten, and reported back in `skippedCollisions` so a caller can offer
 * it as an explicit "adopt" action later (phase 2) instead of silently taking
 * it. An id already in `previouslyOwned` is a legitimate update, not a
 * collision, and proceeds as before.
 */
export function projectToClaudeJson(
  claudeJson: ClaudeJson,
  servers: ResolvedMcpServer[]
): { claudeJson: ClaudeJson; skippedCollisions: string[] } {
  const previouslyOwned = Array.isArray(claudeJson._youcodedOwnedMcpServers)
    ? claudeJson._youcodedOwnedMcpServers
    : [];
  // Non-object mcpServers (hand-edited/corrupted file: a string, a number)
  // is treated as absent rather than spread — see isPlainObject's comment.
  const mcpServers: Record<string, unknown> = {
    ...(isPlainObject(claudeJson.mcpServers) ? claudeJson.mcpServers : {}),
  };
  const stillInRegistry = new Set(servers.map((s) => s.id));

  // An id we owned last run that isn't in THIS run's registry has left
  // (disabled or deleted in YouCoded) — remove it. Deleting a key that's
  // already gone (the user hand-deleted the entry too) is a no-op, not a
  // crash — Set/delete on a missing key is always safe.
  for (const id of previouslyOwned) {
    if (!stillInRegistry.has(id)) delete mcpServers[id];
  }

  const nowOwned: string[] = [];
  const skippedCollisions: string[] = [];
  for (const server of servers) {
    // Defensive: projectToClaudeJson's contract is "enabled, resolved
    // servers only" regardless of what the caller passes — resolveAllEnabled()
    // already filters disabled ones, but a disabled entry must never be
    // projected even if a future caller passes list() by mistake.
    if (server.enabled === false) continue;
    if (server.credentialError) {
      // WHY: keep a previously working projection and its ownership while the
      // wallet is inaccessible; never publish partial credentials or adopt an
      // unowned entry. Independent servers still reconcile normally.
      if (previouslyOwned.includes(server.id) && Object.prototype.hasOwnProperty.call(mcpServers, server.id)) nowOwned.push(server.id);
      continue;
    }
    // A server synced from another device without its matching secret is
    // "needs setup" (McpRegistry.resolveEntry's missingSecrets) — projecting
    // it would hand Claude Code a command/header missing a required value,
    // so it's skipped until the secret actually resolves.
    if (server.missingSecrets && server.missingSecrets.length > 0) continue;
    // Collision guard — see this function's header comment. `mcpServers`
    // here still reflects the incoming file (pruning above only removes ids
    // NOT in `servers`, so it can never remove the very id being checked).
    const idAlreadyExists = Object.prototype.hasOwnProperty.call(mcpServers, server.id);
    if (idAlreadyExists && !previouslyOwned.includes(server.id)) {
      skippedCollisions.push(server.id);
      continue;
    }
    mcpServers[server.id] = buildRegistryServerConfig(server);
    nowOwned.push(server.id);
  }

  return {
    claudeJson: {
      ...claudeJson,
      mcpServers,
      _youcodedOwnedMcpServers: nowOwned,
    },
    skippedCollisions,
  };
}

export interface ReconcileMcpResult {
  added: number;
  skippedPlatform: number;
  skippedManual: number;
  manifestCount: number;
  /** Registry server ids skipped this run because the id collided with an
   *  entry (hand-written by the user, or manifest-scanned) that YouCoded does
   *  not own — see projectToClaudeJson's collision guard. Empty in the common
   *  case; a non-empty list is worth logging so a collision doesn't go
   *  unnoticed even though phase 1 has no UI to surface it yet. */
  skippedCollisions: string[];
  /** Fix (Finding 2): true when ~/.claude.json existed but could not be read
   *  (corrupt JSON, EACCES, a partial read racing an external writer) — the
   *  reconcile aborted WITHOUT writing anything, real cause already logged by
   *  readClaudeJsonFrom. Every other field is the zero-work default in this
   *  case (manifests are scanned above the read, so manifestCount can still
   *  be non-zero even though nothing was written). */
  aborted: boolean;
}

export async function reconcileMcp(): Promise<ReconcileMcpResult> {
  const manifests = listManifests();
  const claudeJson = readClaudeJson();
  if (claudeJson === null) {
    // Fix (Finding 2): abort rather than proceed from `{}` — see
    // readClaudeJsonFrom's comment. Returning a result (never throwing) keeps
    // this from blocking the rest of app startup / a plugin install, which
    // both call reconcileMcp() and only log its outcome.
    return { added: 0, skippedPlatform: 0, skippedManual: 0, manifestCount: manifests.length, skippedCollisions: [], aborted: true };
  }
  const servers = (claudeJson.mcpServers as Record<string, unknown>) || {};

  let added = 0;
  let skippedPlatform = 0;
  let skippedManual = 0;
  let manifestChanged = false;

  // Legacy path (decomposition v3 §9.3), unchanged by this task: plugin-
  // bundled servers declared in mcp-manifest.json. Additive-only — never
  // overwritten, never removed, regardless of the ownership model below.
  // Folding this into the registry (one ownership rule for both sources) was
  // considered for this task and deliberately deferred — see task-7-report.md.
  for (const { entries, pluginRoot } of manifests) {
    for (const entry of entries) {
      if (!entry.name) continue;
      if (!platformMatches(entry.platform)) { skippedPlatform++; continue; }
      if (!entry.auto) { skippedManual++; continue; }
      // Never overwrite a user-configured entry — trust their customizations
      if (servers[entry.name]) continue;

      const config = buildServerConfig(entry, pluginRoot);
      if (!config) continue;
      servers[entry.name] = config;
      added++;
      manifestChanged = true;
    }
  }
  claudeJson.mcpServers = servers;

  // New path (Task 7): project the YouCoded-owned MCP registry on top. A
  // fresh, cheap NativeHome/SecretsStore pair — same construction ipc-
  // handlers.ts already uses for ProviderRegistry; no shared connections to
  // pool here (that's McpManager's job for LIVE sessions), just a read.
  const registry = new McpRegistry(new NativeHome(), new SecretsStore(app.getPath('userData')));
  const resolved = await registry.resolveAllEnabled();
  const { claudeJson: projected, skippedCollisions } = projectToClaudeJson(claudeJson, resolved);

  // added/skippedPlatform/skippedManual intentionally keep their ORIGINAL
  // meaning (manifest-scan counts only) rather than being redefined to
  // include registry churn — the registry re-projects its owned entries on
  // every call by design, so counting that as "added" every launch would be
  // misleading telemetry, not a bug fix.
  const mcpServersChanged = JSON.stringify(claudeJson.mcpServers) !== JSON.stringify(projected.mcpServers);
  const ownershipChanged = JSON.stringify(claudeJson._youcodedOwnedMcpServers ?? []) !== JSON.stringify(projected._youcodedOwnedMcpServers ?? []);

  if (manifestChanged || mcpServersChanged || ownershipChanged) {
    writeClaudeJsonAtomic(projected);
  }
  return { added, skippedPlatform, skippedManual, manifestCount: manifests.length, skippedCollisions, aborted: false };
}
