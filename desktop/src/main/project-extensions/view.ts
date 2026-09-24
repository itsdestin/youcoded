// desktop/src/main/project-extensions/view.ts
//
// T3 (project-plugin-controls) — PURE view/write logic for the two renderer-
// facing operations that need more than resolveAvailability's raw rows:
//   - buildProjectExtensionsView: the Skills & tools tab's whole payload
//     (bundled/installed plugin groups with parts, ungrouped personal items,
//     needs-setup rows) — feeds `project-extensions:get`.
//   - applyProjectExtensionsChanges: plugin first-enable / pause-preserves-
//     parts write semantics — feeds `project-extensions:set`.
// No fs/path/os — same pure-core/IO-shell split as resolve.ts and store.ts;
// the IO shell (ipc-handlers.ts) gathers the real catalog and record, and
// this module never mutates its inputs.
import type { ProjectExtensionsRecord, ProjectPluginState } from './store';
import { PROJECT_EXTENSIONS_SCHEMA } from './store';
import {
  resolveAvailability, itemKeyForSkill, itemKeyForMcp, defaultPluginOn,
  type CatalogSkillEntry, type CatalogMcpEntry, type PluginInstallInfo,
} from './resolve';
import { isBundledPlugin } from '../../shared/bundled-plugins';

// ---------------------------------------------------------------------------
// Renderer-facing shapes (mirrored in desktop/src/shared/types.ts so preload/
// remote-shim/renderer can import them without reaching into main/).
// ---------------------------------------------------------------------------

// Not exported: nothing outside this file names these by type (ipc-shell.ts
// only ever needs ProjectExtensionsView/ProjectExtensionsNeedsSetupRow below,
// and the renderer can't import main/ at all — it gets the shared/types.ts
// mirror instead). knip flags an export nothing imports by name.
interface ProjectExtensionsPartRow {
  /** resolve.ts's itemKey verbatim — the identity `project-extensions:set`'s
   *  `changes[].item` takes. */
  key: string;
  kind: 'skill' | 'mcp';
  displayName: string;
  on: boolean;
  /** kind:'mcp' only — true when this connection IS present in the registry
   *  here but its secrets aren't (ResolvedMcpServer.missingSecrets non-empty).
   *  Never `false` — absent means no local-setup issue. */
  needsLocalSetup?: boolean;
}

interface ProjectExtensionsPluginGroup {
  pluginId: string;
  displayName: string;
  bundled: boolean;
  on: boolean;
  /** Design §2: "Plugin master: plugins[p].on=false pauses automatic use of
   *  every part ... part entries keep their values." `paused` is the same
   *  boolean as `!on` for a plugin that has parts at all — kept as its own
   *  named field (rather than making T4 infer it from `on`) because "off" and
   *  "paused" read as different renderer copy for a group that already has
   *  chosen parts vs. one that has never been touched; the distinction is
   *  presentational only, not a third stored state. */
  paused: boolean;
  parts: ProjectExtensionsPartRow[];
}

type ProjectExtensionsNeedsSetupKind = 'install' | 'personal-skill' | 'tool-connection';

export interface ProjectExtensionsNeedsSetupRow {
  key: string;
  displayName: string;
  kind: ProjectExtensionsNeedsSetupKind;
  /** Carried per-row (not only once on the outer view) because
   *  `project-extensions:for-session`'s `missing[]` reuses this exact shape
   *  outside any single project's `get` response. */
  projectKey: string;
}

export interface ProjectExtensionsView {
  projectKey: string;
  builtIn: ProjectExtensionsPluginGroup[];
  installed: ProjectExtensionsPluginGroup[];
  /** Skills and tool connections owned by no plugin at all — a personal or
   *  project skill (source 'self'/'project'), or a user/adopted MCP server —
   *  each independently on/off (resolve.ts's rule 3). */
  personal: ProjectExtensionsPartRow[];
  needsSetup: ProjectExtensionsNeedsSetupRow[];
}

// ---------------------------------------------------------------------------
// View builder
// ---------------------------------------------------------------------------

/** The one extra field the view needs beyond resolve.ts's narrow
 *  CatalogSkillEntry: something to show the user. */
export interface ViewSkillEntry extends CatalogSkillEntry {
  displayName: string;
}

/** The one extra info the view needs beyond resolve.ts's narrow
 *  CatalogMcpEntry: a label to show, and whether it needs local setup. */
export interface ViewMcpEntry extends CatalogMcpEntry {
  label: string;
  missingSecrets: string[];
}

export interface BuildViewInput {
  /** Renderer-facing identifier — see ipc-handlers.ts's own comment on why
   *  this is the project's canonical path, never the internal sync-name/path
   *  storage key resolve.ts and store.ts use. Echoed back verbatim. */
  projectKey: string;
  record: ProjectExtensionsRecord | null;
  skills: ViewSkillEntry[];
  mcp: ViewMcpEntry[];
  installs: Record<string, PluginInstallInfo>;
  /** Per-device instant this feature's build first ran (feature-first-run.ts)
   *  — the ONLY lower bound a group with no stored plugin state compares its
   *  install against (F1 fix: never the project's own `seededAt`, which has
   *  no relationship to when a plugin was installed). `undefined` -> unknown
   *  -> defaultPluginOn's rule 2 never fires (design §2). */
  featureFirstRunAt: number | undefined;
  now: number;
}

// Same fallback skill-provider.ts's getInstalled() already uses for a plugin
// with no better name available: title-case the id. Kept local (not
// exported/shared) because it's a display-only convenience, not a naming
// authority — the marketplace registry's own displayName (fetched over the
// network, renderer-side via useMarketplace) is the better name when a
// caller has it; this main-process view never does a network fetch to get one.
function titleCaseId(id: string): string {
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// The four bundled plugins ship with fixed, product-facing names — hardcoding
// them (rather than title-casing their ids, which would read "Wecoded Themes
// Plugin") costs nothing since the list can only grow by an app release
// anyway (bundled-plugins.ts's own "PARITY REQUIRED" convention).
const BUNDLED_DISPLAY_NAMES: Record<string, string> = {
  'wecoded-themes-plugin': 'Theme Builder',
  'wecoded-marketplace-publisher': 'Marketplace Publisher',
  'youcoded-chatsearch': 'Chat Search',
  'wecoded-pages-plugin': 'Page Builder',
};

function pluginDisplayName(pluginId: string, parts: ProjectExtensionsPartRow[]): string {
  if (BUNDLED_DISPLAY_NAMES[pluginId]) return BUNDLED_DISPLAY_NAMES[pluginId];
  // A single-part plugin's own part name usually already IS the plugin's
  // friendly name (e.g. a "Theme Builder" skill inside a plugin of the same
  // idea) — multi-part or zero-part plugins fall back to the id.
  if (parts.length === 1) return parts[0].displayName;
  return titleCaseId(pluginId);
}

/**
 * Build the Skills & tools tab's whole payload. Reuses resolveAvailability
 * (T1) as the single source of truth for on/off/removed — this function only
 * adds grouping, display names and the needs-setup rows resolveAvailability's
 * rows structurally cannot express (an item ON in the project but not present
 * in `skills`/`mcp` at all never gets a row there, since those rows are built
 * BY ITERATING the catalog — see resolveAvailability's own loop).
 */
export function buildProjectExtensionsView(input: BuildViewInput): ProjectExtensionsView {
  const { projectKey, record, skills, mcp, installs, featureFirstRunAt, now } = input;

  const resolved = resolveAvailability({ projectKey, record, skills, mcp, installs, featureFirstRunAt, now });

  const skillById = new Map(skills.map((s) => [itemKeyForSkill(s), s]));
  const mcpById = new Map(mcp.map((m) => [itemKeyForMcp(m), m]));

  const groups = new Map<string, ProjectExtensionsPartRow[]>();
  const personal: ProjectExtensionsPartRow[] = [];

  for (const row of resolved.rows) {
    if (row.removed) continue; // uninstalled — hidden everywhere (design §2)
    let displayName = row.key;
    let needsLocalSetup: boolean | undefined;
    if (row.kind === 'skill') {
      const entry = skillById.get(row.key);
      if (entry) displayName = entry.displayName;
    } else {
      const entry = mcpById.get(row.key);
      if (entry) {
        displayName = entry.label;
        if (entry.missingSecrets.length > 0) needsLocalSetup = true;
      }
    }
    const part: ProjectExtensionsPartRow = { key: row.key, kind: row.kind, displayName, on: row.on, ...(needsLocalSetup ? { needsLocalSetup } : {}) };
    if (row.pluginId) {
      const list = groups.get(row.pluginId);
      if (list) list.push(part); else groups.set(row.pluginId, [part]);
    } else {
      personal.push(part);
    }
  }

  const builtIn: ProjectExtensionsPluginGroup[] = [];
  const installed: ProjectExtensionsPluginGroup[] = [];
  for (const [pluginId, parts] of groups) {
    const stored = record?.plugins[pluginId];
    const on = stored ? stored.on : defaultPluginOn(pluginId, installs[pluginId]?.installedAt, featureFirstRunAt);
    const group: ProjectExtensionsPluginGroup = {
      pluginId, displayName: pluginDisplayName(pluginId, parts), bundled: isBundledPlugin(pluginId), on, paused: !on, parts,
    };
    (group.bundled ? builtIn : installed).push(group);
  }
  // Deterministic order — Map insertion order follows resolved.rows' scan
  // order (skills then mcp, each in catalog order), which is fine for
  // `parts` within a group but leaves group order dependent on which plugin's
  // first item happened to appear first; sort by display name so the tab
  // doesn't visibly reorder between two otherwise-identical calls.
  const byName = (a: { displayName: string }, b: { displayName: string }) => a.displayName.localeCompare(b.displayName);
  builtIn.sort(byName);
  installed.sort(byName);
  for (const g of [...builtIn, ...installed]) g.parts.sort(byName);
  personal.sort(byName);

  const needsSetup: ProjectExtensionsNeedsSetupRow[] = [];
  const reportedPluginIds = new Set<string>();
  const catalogPluginIds = new Set(groups.keys());

  for (const [pluginId, state] of Object.entries(record?.plugins ?? {})) {
    if (state.removed || !state.on) continue; // hidden, or off — nothing to set up
    if (catalogPluginIds.has(pluginId)) continue; // installed here already
    needsSetup.push({ key: pluginId, displayName: titleCaseId(pluginId), kind: 'install', projectKey });
    reportedPluginIds.add(pluginId);
  }

  for (const [itemKey, state] of Object.entries(record?.items ?? {})) {
    if (!state.on) continue;
    if (itemKey.startsWith('self:')) {
      if (skillById.has(itemKey)) continue; // the file IS here
      needsSetup.push({ key: itemKey, displayName: itemKey.slice('self:'.length), kind: 'personal-skill', projectKey });
      continue;
    }
    if (itemKey.startsWith('project:')) {
      // A project-scoped skill lives inside the project's OWN folder, which
      // this device already has if it can resolve a projectKey for it at
      // all — "missing" would mean the specific file was deleted from that
      // folder, not a cross-device sync gap. No needs-setup kind covers that
      // case in the approved design (§5 lists exactly three kinds); leaving
      // it unsurfaced here is a deliberate, documented gap rather than an
      // invented fourth kind.
      continue;
    }
    if (itemKey.startsWith('mcp:')) {
      if (mcpById.has(itemKey)) continue; // present (missingSecrets, if any, is handled in the group/personal row above)
      // Absent entirely — rare, since the registry itself syncs across
      // devices without secrets (design's source facts): a user-added/adopted
      // server deleted on this device, or a plugin-scoped one whose OWNING
      // plugin isn't installed here either. The item key alone (`mcp:<id>`)
      // carries no plugin reference to de-duplicate against an 'install' row
      // the way a skill key's `plugin:skill` shape does below — showing both
      // rows in that rarer case is a harmless duplicate, not a wrong one.
      needsSetup.push({ key: itemKey, displayName: itemKey.slice('mcp:'.length), kind: 'tool-connection', projectKey });
      continue;
    }
    // A plugin-scoped skill key (`${pluginName}:${skillName}`, or a bare
    // legacy id with no colon — itemKeyForSkill's own comment). Only worth a
    // ROW when its owning plugin isn't already covered by an 'install' row
    // above (defense-in-depth for a record whose plugins[] entry never got
    // written, e.g. one written before store.ts's ensureSeeded started
    // materializing plugin-level entries alongside item-level ones).
    if (skillById.has(itemKey)) continue; // present here already
    const pluginId = itemKey.includes(':') ? itemKey.slice(0, itemKey.indexOf(':')) : itemKey;
    if (reportedPluginIds.has(pluginId) || catalogPluginIds.has(pluginId)) continue;
    needsSetup.push({ key: pluginId, displayName: titleCaseId(pluginId), kind: 'install', projectKey });
    reportedPluginIds.add(pluginId);
  }
  needsSetup.sort(byName);

  return { projectKey, builtIn, installed, personal, needsSetup };
}

// ---------------------------------------------------------------------------
// Set semantics (project-extensions:set)
// ---------------------------------------------------------------------------

export interface ProjectExtensionsChange {
  /** Exactly one of `plugin` (the master switch) or `item` (one part) —
   *  never both, never neither. */
  plugin?: string;
  item?: string;
  on: boolean;
}

export interface ApplyChangesInput {
  record: ProjectExtensionsRecord | null;
  changes: ProjectExtensionsChange[];
  now: number;
  /** itemKey -> owning pluginId, for every item currently in the catalog —
   *  lets an item-level change flip its plugin's `partsChosen` (see
   *  applyItemChange). Built by the IO shell from the same skills/mcp
   *  catalog `get`/`set` already read; absent from the map means the item is
   *  unscoped (a personal/project skill or a user/adopted MCP server). */
  itemPluginOf: ReadonlyMap<string, string>;
  /** pluginId -> every itemKey currently belonging to it (inverse of
   *  itemPluginOf) — needed only for a plugin's FIRST enable, which
   *  materializes on:true for every one of its current parts (design §2). */
  itemsForPlugin: ReadonlyMap<string, readonly string[]>;
}

export type ApplyChangesResult =
  | { ok: true; record: ProjectExtensionsRecord }
  | { ok: false; error: 'invalid-change' };

function emptyRecord(): ProjectExtensionsRecord {
  return { schemaVersion: PROJECT_EXTENSIONS_SCHEMA, seededAt: 0, plugins: {}, items: {} };
}

function applyPluginChange(
  base: ProjectExtensionsRecord, pluginId: string, on: boolean, now: number, partsForPlugin: readonly string[],
): ProjectExtensionsRecord {
  const existing = base.plugins[pluginId];
  const neverChosenParts = !existing || existing.partsChosen === false;
  let items = base.items;
  if (on && neverChosenParts && partsForPlugin.length > 0) {
    // First enable (design §2): turn EVERY current part on, overriding
    // whatever each part's own default rule would otherwise say — matches
    // resolve.ts's own "first enable" read-time branch, materialized here so
    // the choice survives even after partsChosen flips to true below (a
    // record with partsChosen:true but no item entries would otherwise fall
    // through to each item's plugin-default rule instead of "all on").
    items = { ...base.items };
    for (const key of partsForPlugin) items[key] = { on: true, at: now };
  }
  const next: ProjectPluginState = {
    on,
    // Turning ON always ends in partsChosen:true (design §2, "first enable
    // ... sets partsChosen=true") — whether this is the very first enable or
    // a later re-enable, the plugin's parts are from now on individually
    // managed. Turning OFF (pause) preserves whatever partsChosen already
    // was (§2 "pause remembers choices").
    partsChosen: on ? true : (existing?.partsChosen ?? false),
    at: now,
  };
  // Re-enabling clears an uninstall tombstone (§2: "installing it again
  // clears removed through the setup flow"); never write `removed:false`
  // (store.ts's own convention — only `true` or absent).
  if (!on && existing?.removed) next.removed = true;
  return { ...base, items, plugins: { ...base.plugins, [pluginId]: next } };
}

function applyItemChange(
  base: ProjectExtensionsRecord, itemKey: string, on: boolean, now: number, pluginId: string | undefined,
): ProjectExtensionsRecord {
  const items = { ...base.items, [itemKey]: { on, at: now } };
  let plugins = base.plugins;
  if (pluginId) {
    const existingPlugin = base.plugins[pluginId];
    if (!existingPlugin || existingPlugin.partsChosen === false) {
      // The user is explicitly choosing THIS part — from now on the plugin's
      // parts are individually managed (resolve.ts's own "first enable" rule
      // stops applying once partsChosen is true). The master's own on/off is
      // preserved (defaulting to true — a part control is only reachable in
      // the UI while its plugin's master is already on) rather than reset by
      // this write.
      const next: ProjectPluginState = { on: existingPlugin?.on ?? true, partsChosen: true, at: now };
      if (existingPlugin?.removed) next.removed = true;
      plugins = { ...base.plugins, [pluginId]: next };
    }
  }
  return { ...base, items, plugins };
}

/**
 * Apply a batch of `project-extensions:set` changes, in array order (so a
 * plugin-level "first enable" followed by an item-level override in the SAME
 * call composes correctly — the item write always wins for its own key).
 * Pure; the caller (ipc-handlers.ts) persists the returned record via
 * store.ts's mutateProjectExtensions and re-reads the view from it.
 */
export function applyProjectExtensionsChanges(input: ApplyChangesInput): ApplyChangesResult {
  let record = input.record ?? emptyRecord();
  for (const change of input.changes) {
    const hasPlugin = typeof change.plugin === 'string';
    const hasItem = typeof change.item === 'string';
    if (hasPlugin === hasItem) return { ok: false, error: 'invalid-change' }; // exactly one required
    record = hasPlugin
      ? applyPluginChange(record, change.plugin as string, change.on, input.now, input.itemsForPlugin.get(change.plugin as string) ?? [])
      : applyItemChange(record, change.item as string, change.on, input.now, input.itemPluginOf.get(change.item as string));
  }
  return { ok: true, record };
}
