// The IO shell that turns "a native session's cwd" into the FROZEN
// availability set NativeSessionHost.create() writes into the session header
// (technical design 2026-09-24 §3, "Frozen per conversation"). Pulled out of
// native-session-host.ts so it has its own focused tests against fakes/temp
// dirs instead of needing a whole host construction.
//
// ONLY called from create(). resume() reuses the header's stored set
// unconditionally (design §3's whole point: a project's settings can change
// while a conversation is closed without moving the ground under an already
// -open session) — never re-runs this.
import { resolveProjectKey, type ProjectKeyCandidate } from './project-key';
import { ensureSeeded, type ProjectExtensionsStores, type SeedCatalog } from './store';
import {
  resolveAvailability, itemKeyForSkill, itemKeyForMcp,
  type CatalogSkillEntry, type CatalogMcpEntry, type PluginInstallInfo,
} from './resolve';
import { listProjectKeyCandidatesAsync } from './candidates';
import { log } from '../logger';

export interface SessionAvailability {
  projectKey: string | null;
  /** Catalog ids — skill-catalog.ts's SkillCatalog.list() `id` shape — this
   *  session's Skill tool may list. NOT resolve.ts's itemKey (a self/project
   *  skill keys differently there, `self:<name>`/`project:<name>`); this is
   *  translated back to catalog ids here so HarnessSession never needs to
   *  know resolve.ts's key format at all. */
  skillCatalogIds: Set<string>;
  /** Raw MCP registry server ids (McpServerEntry.id) this session may
   *  connect to — NOT resolve.ts's `mcp:`-prefixed itemKey. Ready to hand
   *  straight to McpManager.acquire's `allowIds`. */
  mcpServerIds: Set<string>;
}

export interface SessionAvailabilityDeps {
  /** ManagedRoots.projectsRoot, or null when no ManagedRoots is wired (a bare
   *  test host construction) — forwarded to listProjectKeyCandidatesAsync. */
  projectsRoot: string | null;
  /** null when this host has no ProjectExtensionsStores wired at all (no
   *  NativeHome / no ManagedRoots.personalRoot) — see the "no stores" branch
   *  below for why that is NOT the same as B-1's empty-set answer. */
  stores: ProjectExtensionsStores | null;
  skills: CatalogSkillEntry[];
  mcp: CatalogMcpEntry[];
  installs: Record<string, PluginInstallInfo>;
  now?: number;
  /** Test seam — overrides candidates.ts's default `~/.claude/youcoded-folders.json`. */
  foldersFile?: string;
  /** Test seam — bypasses listProjectKeyCandidatesAsync's real fs reads. */
  candidates?: ProjectKeyCandidate[];
}

function toSessionAvailability(
  projectKey: string | null,
  resolved: { skillIds: Set<string>; mcpIds: Set<string> },
  skills: CatalogSkillEntry[],
  mcp: CatalogMcpEntry[],
): SessionAvailability {
  const skillCatalogIds = new Set(
    skills.filter((s) => resolved.skillIds.has(itemKeyForSkill(s))).map((s) => s.id),
  );
  const mcpServerIds = new Set(
    mcp.filter((m) => resolved.mcpIds.has(itemKeyForMcp(m))).map((m) => m.id),
  );
  return { projectKey, skillCatalogIds, mcpServerIds };
}

/**
 * Resolve (and, for an existing project's very first touch, seed) the
 * availability a NEW session's create() should freeze into its header.
 *
 * FAILS OPEN (design "Enforcement" — resolution failure must never block a
 * session from opening): any thrown error anywhere in this pipeline — a torn
 * project-extensions record on disk, a permission error reading the folders
 * file — is caught, logged, and answered with `null`. Callers MUST treat
 * `null` exactly like an old session with no stored header set: skip writing
 * the header's availability field, apply no skill/MCP restriction at all.
 *
 * This is DELIBERATELY not the same answer as B-1's "outside any project"
 * empty set. B-1 is a real, successfully resolved decision (nothing is on,
 * and the header says so). `null` means "we don't know" — turning "we don't
 * know" into "nothing is on" would silently break every tool an existing
 * workflow relies on the moment this feature has a bug, which is the exact
 * failure mode the design calls out.
 */
export async function resolveSessionAvailability(
  cwd: string,
  deps: SessionAvailabilityDeps,
): Promise<SessionAvailability | null> {
  try {
    const now = deps.now ?? Date.now();
    const candidates = deps.candidates ?? await listProjectKeyCandidatesAsync(deps.projectsRoot, deps.foldersFile);

    if (candidates.length === 0) {
      // No saved-folder store has EVER been written on this device — an
      // uninitialized/bootstrap state (or a bare test host with nothing
      // seeded), not a genuine "the user put this conversation outside every
      // project" decision. Real usage always seeds a Home folder before any
      // conversation can exist (folders-service.ts's listPickerFolders), so
      // an empty candidate list here means "we don't know yet" — the same
      // fail-open answer as a caught error below, never B-1's confident empty
      // set. B-1 itself only fires once real candidates exist but this
      // particular cwd matches none of them.
      return null;
    }

    const projectKey = resolveProjectKey(cwd, candidates);

    if (projectKey === null) {
      // B-1: resolveAvailability's own null-record short-circuit already
      // returns the empty-set answer for "outside any project" — nothing to
      // seed (there is no project to seed).
      const resolved = resolveAvailability({
        projectKey: null, record: null, skills: deps.skills, mcp: deps.mcp, installs: deps.installs, now,
      });
      return toSessionAvailability(projectKey, resolved, deps.skills, deps.mcp);
    }

    if (!deps.stores) {
      // No ManagedRoots/NativeHome wired at all — there is nowhere to read or
      // persist a record, so nothing here can be a genuine product decision.
      // Same "don't know" answer as a caught error, not B-1's empty set.
      return null;
    }

    const seedCatalog: SeedCatalog = { skills: deps.skills, mcp: deps.mcp, installs: deps.installs };
    // isNewProject defaults false in ensureSeeded: this is a conversation
    // being opened, not a project being freshly created (that seed call, with
    // isNewProject:true, is a later task's responsibility to wire — design §2).
    const record = await ensureSeeded(deps.stores, projectKey, seedCatalog, now);
    const resolved = resolveAvailability({
      projectKey, record, skills: deps.skills, mcp: deps.mcp, installs: deps.installs, now,
    });
    return toSessionAvailability(projectKey, resolved, deps.skills, deps.mcp);
  } catch (err) {
    log('ERROR', 'project-extensions', "availability resolution failed — session opens with today's unrestricted behaviour", {
      cwd, error: String(err),
    });
    return null;
  }
}
