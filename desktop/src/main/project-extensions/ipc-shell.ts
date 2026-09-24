// desktop/src/main/project-extensions/ipc-shell.ts
//
// T3 (project-plugin-controls) — the IO shell shared by ipc-handlers.ts (the
// Electron IPC surface) AND remote-server.ts (the WS host a remote browser
// talks to), so the two transports cannot drift — same convention as
// artifacts/projects-index.ts's own extraction (see that file's header).
//
// Renderer-facing "project key": every parameter and response field named
// `projectKey`/`path` in this module and in shared/types.ts's
// ProjectExtensions* types is the project's CANONICAL PATH — the same value
// every project row already carries from `artifacts:list-projects-index`
// (saved-folder-projects.ts's `.path`). This is a deliberate simplification
// (T3 scope's own "pick the simplest" instruction, option A): rather than
// exposing store.ts's internal storage key (a synced project's cross-device
// sync NAME, or an unsynced folder's own canonical path — two different
// shapes a renderer would otherwise have to learn to tell apart, see
// project-key.ts's header), every handler here accepts a path and resolves
// the real storage key internally via T1's resolveProjectKey, and every
// response echoes the SAME path back — never the internal key. The renderer
// never needs a separate "learn the project key" round trip: it already has
// the path from the projects index it built its row list from.
import { NativeHome } from '../native-home';
import { getManagedRoots } from '../sync-spaces/service';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { resolveProjectKey, type ProjectKeyCandidate } from './project-key';
import { listProjectKeyCandidatesAsync } from './candidates';
import { readFeatureFirstRunAt } from './feature-first-run';
import {
  getProjectExtensions, mutateProjectExtensions, ensureSeeded,
  type ProjectExtensionsStores,
} from './store';
import { resolveSessionAvailability } from './session-availability';
import { discoverSkillEntriesAsync } from '../harness/skills/skill-catalog';
import { itemKeyForSkill, itemKeyForMcp, type PluginInstallInfo } from './resolve';
import {
  buildProjectExtensionsView, applyProjectExtensionsChanges,
  type ProjectExtensionsView, type ProjectExtensionsChange, type ProjectExtensionsNeedsSetupRow,
  type ViewSkillEntry, type ViewMcpEntry,
} from './view';
import type { ResolvedMcpServer } from '../harness/mcp/types';
import type { NativeSessionAvailability, NativeSessionListEntry } from '../harness/session-store';

/** The subset of each real service this module needs — structural, so
 *  ipc-handlers.ts's real nativeHost/mcpManager/skillProvider.configStore
 *  satisfy it without this file importing their concrete classes (same seam
 *  convention as mcp-manager.ts's own McpRegistryLike). */
export interface ProjectExtensionsIpcDeps {
  nativeHome: NativeHome;
  mcpManager?: { listEnabled(): Promise<ResolvedMcpServer[]> };
  skillConfigStore?: { getPackages(): Record<string, PluginInstallInfo> };
  nativeSessions?: { listAsync(): Promise<(NativeSessionListEntry & { provider: 'native' })[]> };
}

async function candidatesAndStores(deps: ProjectExtensionsIpcDeps): Promise<{ candidates: ProjectKeyCandidate[]; stores: ProjectExtensionsStores; featureFirstRunAt: number | undefined }> {
  const roots = getManagedRoots();
  const candidates = await listProjectKeyCandidatesAsync(roots?.projectsRoot ?? null);
  // F1 review fix (T6): the seeding/availability rule's ONLY lower bound is
  // this per-device instant (feature-first-run.ts) — never a folder's
  // addedAt (deleted, see resolve.ts's own header) or a project's seededAt.
  // Read fresh on every call: cheap (one small JSON file), and this module
  // has no long-lived instance to cache it on.
  const featureFirstRunAt = await readFeatureFirstRunAt(deps.nativeHome);
  // WHY personalRoot is never used to null out `stores` here (unlike T2's own
  // resolveProjectAvailabilityInputs in ipc-handlers.ts, which nulls the WHOLE
  // stores object when ManagedRoots/personalRoot is absent, fail-open for
  // session creation): an UNSYNCED project's settings live entirely under
  // stores.home (~/.youcoded/project-extensions.local.json) and never read
  // personalRoot at all (store.ts's isSyncedProjectKey routing). A path only
  // ever resolves to a sync name when a candidate carries one, which only
  // happens when projectsRoot is non-null in the first place — so an absent
  // ManagedRoots can never accidentally route a plain path into the synced
  // branch. Sync spaces being disabled/uninitialized must not disable the
  // WHOLE Skills & tools tab for a purely local project.
  const stores: ProjectExtensionsStores = { personalRoot: roots?.personalRoot ?? '', home: deps.nativeHome };
  return { candidates, stores, featureFirstRunAt };
}

/** Resolve a renderer-supplied canonical path to store.ts's internal storage
 *  key. Falls back to the path's own canonicalization when it matches no
 *  candidate at all (resolveProjectKey's B-1 "outside any project" answer) —
 *  the Skills & tools tab is only ever opened FOR a real project row, so this
 *  only fires on the rare edge described in resolveProjectKey's own review:
 *  a path added to the folder list after this call's candidate snapshot was
 *  read. Treating it as an ordinary unsynced folder (its own canonical path)
 *  is the same answer store.ts already gives any local, un-synced project. */
function resolveStorageKey(path: string, candidates: ProjectKeyCandidate[]): string {
  return resolveProjectKey(path, candidates) ?? canonicalize(path, null);
}

async function gatherCatalog(
  deps: ProjectExtensionsIpcDeps, cwd: string,
): Promise<{ skills: ViewSkillEntry[]; mcp: ViewMcpEntry[]; installs: Record<string, PluginInstallInfo> }> {
  // discoverSkillEntriesAsync, NOT the sync discoverSkillEntries (T3 review
  // F2): get/set/for-session all reach this on every CommandDrawer open and
  // session switch — a sync directory scan there would freeze the main
  // thread on a much hotter path than this scan's other (already-reviewed)
  // callers. See skill-catalog.ts's discoverSkillEntriesAsync doc comment.
  const skills = await discoverSkillEntriesAsync(cwd);
  const mcp = (await deps.mcpManager?.listEnabled?.()) ?? [];
  const installs = deps.skillConfigStore?.getPackages() ?? {};
  return { skills, mcp, installs };
}

export type ProjectExtensionsGetResult = { ok: true; view: ProjectExtensionsView } | { ok: false; error: string };

/** `project-extensions:get` — also the seed trigger (design §2: "opening
 *  that project's Skills & tools tab" is one of exactly two seed moments). */
export async function projectExtensionsGet(deps: ProjectExtensionsIpcDeps, path: string): Promise<ProjectExtensionsGetResult> {
  try {
    const { candidates, stores, featureFirstRunAt } = await candidatesAndStores(deps);
    const storageKey = resolveStorageKey(path, candidates);
    const { skills, mcp, installs } = await gatherCatalog(deps, path);
    // featureFirstRunAt (T6, F1 review fix): see ensureSeeded's own header —
    // without it, a plugin installed moments ago would seed ON in a project
    // that has never opened this tab, defeating "starts off everywhere".
    const record = await ensureSeeded(stores, storageKey, { skills, mcp, installs }, Date.now(), false, featureFirstRunAt);
    return { ok: true, view: buildProjectExtensionsView({ projectKey: path, record, skills, mcp, installs, featureFirstRunAt, now: Date.now() }) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export type ProjectExtensionsSetResult = { ok: true; view: ProjectExtensionsView } | { ok: false; error: string };

/** `project-extensions:set` — writes the batch, then returns the FULL new
 *  view (design §4) so the renderer never has to reconcile a partial patch. */
export async function projectExtensionsSet(
  deps: ProjectExtensionsIpcDeps, path: string, changes: ProjectExtensionsChange[],
): Promise<ProjectExtensionsSetResult> {
  try {
    const { candidates, stores, featureFirstRunAt } = await candidatesAndStores(deps);
    const storageKey = resolveStorageKey(path, candidates);
    const { skills, mcp, installs } = await gatherCatalog(deps, path);

    // itemKey -> owning pluginId, and its inverse, for view.ts's set-semantics
    // (first-enable materialization, partsChosen bookkeeping) — built from
    // the SAME catalog read above, never a second scan.
    const itemPluginOf = new Map<string, string>();
    const itemsForPlugin = new Map<string, string[]>();
    const addPart = (pluginId: string, key: string) => {
      itemPluginOf.set(key, pluginId);
      const list = itemsForPlugin.get(pluginId);
      if (list) list.push(key); else itemsForPlugin.set(pluginId, [key]);
    };
    for (const s of skills) if (s.pluginName) addPart(s.pluginName, itemKeyForSkill(s));
    for (const m of mcp) {
      const pluginId = m.origin.kind === 'marketplace' ? m.origin.plugin : undefined;
      if (pluginId) addPart(pluginId, itemKeyForMcp(m));
    }

    const now = Date.now();
    let applyError: string | null = null;
    const record = await mutateProjectExtensions(stores, storageKey, (cur) => {
      const result = applyProjectExtensionsChanges({ record: cur, changes, now, itemPluginOf, itemsForPlugin });
      if (!result.ok) { applyError = result.error; return null; } // no-op write — see mutateProjectExtensions's own contract
      return result.record;
    });
    if (applyError) return { ok: false, error: applyError };
    return { ok: true, view: buildProjectExtensionsView({ projectKey: path, record, skills, mcp, installs, featureFirstRunAt, now }) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export type ProjectExtensionsForSessionResult =
  | {
      ok: true;
      /** Always the session's own cwd (a real canonical path) — never the
       *  internal storage key a synced project's frozen header stores. Lets
       *  T5's "missing" card open Projects → Skills & tools scrolled to the
       *  matching `.path`-keyed row without a reverse lookup. */
      projectKey: string;
      /** null means this session has no stored frozen set at all (created
       *  before T2, or its resolution failed open at create time) — EVERY
       *  installed item is Automatic, matching today's unrestricted
       *  behaviour (design §3). A non-null value (including `[]`) is a REAL
       *  frozen decision — never collapse the two. */
      frozenSkillIds: string[] | null;
      frozenMcpIds: string[] | null;
      /** Reuses `get`'s own needs-setup computation for this session's
       *  project, rather than trying to reconstruct a display name/kind from
       *  the frozen header's bare skill-catalog/mcp ids — those carry no
       *  such information (session-store.ts's own NativeSessionAvailability
       *  comment: "NOT resolve.ts's itemKey"), so there is nothing to derive
       *  it from even in principle. */
      missing: ProjectExtensionsNeedsSetupRow[];
      settingsDiffer: boolean;
    }
  | { ok: false; error: string };

function idsEqual(frozen: readonly string[], current: ReadonlySet<string>): boolean {
  if (frozen.length !== current.size) return false;
  return frozen.every((id) => current.has(id));
}

/**
 * Q-2's quiet line: does the project's CURRENT setting differ from what this
 * session froze at create time?
 *  - A real frozen set: differs iff either id set no longer matches exactly.
 *  - No frozen set (pre-T2 session, "everything on"): differs iff the
 *    project's current settings would now exclude something that IS
 *    installed here — the only way "everything" and "the current setting"
 *    can disagree when there was never a concrete set to compare against.
 *  - `current === null` (today's resolution itself failed open / couldn't
 *    run): never claim a difference we can't actually see — the honest
 *    answer is silence, not a guess.
 */
function computeSettingsDiffer(
  frozen: NativeSessionAvailability | null,
  current: { skillCatalogIds: Set<string>; mcpServerIds: Set<string> } | null,
  skillCount: number, mcpCount: number,
): boolean {
  if (!current) return false;
  if (frozen) {
    return !idsEqual(frozen.skillCatalogIds, current.skillCatalogIds) || !idsEqual(frozen.mcpServerIds, current.mcpServerIds);
  }
  return current.skillCatalogIds.size < skillCount || current.mcpServerIds.size < mcpCount;
}

/** `project-extensions:for-session` — never a seed trigger (design §2 names
 *  exactly two seed moments, and a drawer chip refresh is neither). */
export async function projectExtensionsForSession(deps: ProjectExtensionsIpcDeps, sessionId: string): Promise<ProjectExtensionsForSessionResult> {
  try {
    const sessions = (await deps.nativeSessions?.listAsync?.()) ?? [];
    const entry = sessions.find((s) => s.sessionId === sessionId);
    if (!entry) return { ok: false, error: 'no session found for that id' };
    const cwd = entry.cwd;
    const frozen = entry.availability ?? null;

    const { candidates, stores, featureFirstRunAt } = await candidatesAndStores(deps);
    const { skills, mcp, installs } = await gatherCatalog(deps, cwd);
    const now = Date.now();

    const storageKey = resolveStorageKey(cwd, candidates);
    const record = await getProjectExtensions(stores, storageKey); // read-only — no seed here
    const missing = buildProjectExtensionsView({ projectKey: cwd, record, skills, mcp, installs, featureFirstRunAt, now }).needsSetup;

    const current = await resolveSessionAvailability(cwd, { projectsRoot: null, candidates, stores, skills, mcp, installs, featureFirstRunAt, now });
    const settingsDiffer = computeSettingsDiffer(
      frozen, current ? { skillCatalogIds: current.skillCatalogIds, mcpServerIds: current.mcpServerIds } : null,
      skills.length, mcp.length,
    );

    return {
      ok: true,
      projectKey: cwd,
      frozenSkillIds: frozen ? frozen.skillCatalogIds : null,
      frozenMcpIds: frozen ? frozen.mcpServerIds : null,
      missing,
      settingsDiffer,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
