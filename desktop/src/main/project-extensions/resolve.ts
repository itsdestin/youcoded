// desktop/src/main/project-extensions/resolve.ts
//
// PURE availability logic (technical design 2026-09-24 §2/§3). No fs/path/os —
// mirrors saved-folder-projects.ts / conversations/store-core.ts's pure-core
// split, so every default/pause/first-enable/removed rule is unit-testable
// with plain objects and no mocks. The IO shell (store.ts) owns the on-disk
// record shape and calls in here with whatever it read.
import type { ProjectExtensionsRecord } from './store';
import { isBundledPlugin } from '../../shared/bundled-plugins';
import { skillItemKey } from '../../shared/project-extension-keys';

// A project that existed before this feature shipped already gets an
// explicit `on` for Theme Builder via seeding (design §2) — this default only
// ever fires for a BRAND NEW project's first (unseeded) resolve.
const THEME_BUILDER_PLUGIN_ID = 'wecoded-themes-plugin';

// F1 review fix (T6, project-plugin-controls, 2026-09-24): this module used
// to be fed a per-project "seed reference instant" derived from the
// project's folder `addedAt` (resolveProjectAddedAt, now deleted) or the
// record's own `seededAt`. Both are the WRONG signal — a folder's age (or a
// project's own seed time) has no relationship to when a plugin was
// installed into it, so comparing `installedAt` against either one punishes
// an ordinary, long-settled install that simply happened after the folder
// existed. The only question the "installed after seed, starts off" rule
// (design §2 rule 2) actually means to ask is "did this install arrive AFTER
// this feature itself existed on this device" — so every comparison in this
// file now uses `featureFirstRunAt` (feature-first-run.ts), a single
// per-device instant, never a per-project one.

/** Minimal shape resolve.ts needs from a catalog skill entry (shared/types.ts
 *  SkillEntry has many more fields the availability rule never looks at). */
export interface CatalogSkillEntry {
  /** Catalog id: `plugin:skill` for a plugin-sourced skill (skill-scanner.ts
   *  already qualifies it that way), or a bare name for 'self'/'project'. */
  id: string;
  source: 'youcoded-core' | 'self' | 'project' | 'plugin' | 'marketplace';
  /** The owning plugin's marketplace/bundled id. Absent for 'self'/'project'. */
  pluginName?: string;
}

/** Minimal shape resolve.ts needs from an MCP registry entry
 *  (harness/mcp/types.ts McpServerEntry). */
export interface CatalogMcpEntry {
  id: string;
  origin: { kind: 'user' | 'marketplace' | 'adopted'; plugin?: string };
}

/** What resolve.ts needs to know about a marketplace-tracked install
 *  (skill-config-store.ts PackageInfo, narrowed to the one field the
 *  installed-after-seed rule reads). */
export interface PluginInstallInfo {
  /** ISO 8601, as PackageInfo.installedAt records it. */
  installedAt?: string;
}

export interface AvailabilityRow {
  /** itemKey: `plugin:skill` / `self:<name>` / `project:<name>` for a skill,
   *  `mcp:<serverId>` for a tool connection (design §1). */
  key: string;
  kind: 'skill' | 'mcp';
  /** The owning plugin id, when this item is scoped by a plugin master
   *  switch. Absent for a self/project skill or a user/adopted MCP server —
   *  those are never gated by any plugins[] entry. */
  pluginId?: string;
  on: boolean;
  /** True when the owning plugin has been uninstalled (design §2 cascade) —
   *  a future "needs setup" view built on these rows should treat this as
   *  "hide, don't offer to reinstall automatically", never as a live item. */
  removed?: boolean;
}

export interface ResolvedAvailability {
  skillIds: Set<string>;
  mcpIds: Set<string>;
  rows: AvailabilityRow[];
}

export interface ResolveAvailabilityInput {
  /** The project key this resolve is for — only used to gate the B-1
   *  outside-any-project case; not otherwise inspected. */
  projectKey: string | null;
  record: ProjectExtensionsRecord | null;
  skills: CatalogSkillEntry[];
  mcp: CatalogMcpEntry[];
  /** Marketplace-tracked installs, keyed by plugin id (skill-config-store.ts
   *  getPackages()). A plugin absent here is treated as "not a marketplace
   *  install" (bundled, adopted, or too old to have a record) — rule 3. */
  installs: Record<string, PluginInstallInfo>;
  /** Per-device instant: the first time a build with this feature ran here
   *  (feature-first-run.ts). `undefined` means "couldn't be read/written yet"
   *  — rule 2 then never fires (design §2: "if it can't be written, treat as
   *  unknown -> everything on"). This is the ONLY lower bound rule 2 compares
   *  `installedAt` against — never a project's own `addedAt` or `seededAt`
   *  (see this file's own header, F1). */
  featureFirstRunAt: number | undefined;
  /** Injectable clock (ms epoch) — every test in the unit table pins a fixed
   *  `now` rather than racing the real clock. */
  now: number;
}

/** itemKey for a catalog skill (design §1). The rule itself lives in
 *  shared/project-extension-keys.ts so the renderer's drawer uses the exact
 *  same one. */
export function itemKeyForSkill(entry: CatalogSkillEntry): string {
  return skillItemKey(entry);
}

/** itemKey for an MCP server entry (design §1). */
export function itemKeyForMcp(entry: CatalogMcpEntry): string {
  return `mcp:${entry.id}`;
}

/**
 * §2 default rule for a plugin with NO explicit `plugins[id]` entry:
 *   1. Bundled, non-Theme-Builder -> on. Theme Builder -> off.
 *   2. A marketplace install whose installedAt parses AFTER `featureFirstRunAt` -> off.
 *   3. Everything else -> on.
 *
 * `installedAt` missing or unparseable counts as "before" (rule 2's own
 * wording) — `Date.parse` returns NaN for either, and NaN compares false
 * against anything, so the `> featureFirstRunAt` check naturally falls
 * through to "on". A damaged or absent record can only ever keep something
 * ON, never turn it off. Same for `featureFirstRunAt` itself being
 * `undefined` (couldn't be written/read on this device yet) — the check is
 * skipped entirely, so an unknown rollout instant can also only ever keep
 * something ON.
 *
 * Exported (not just used internally) so store.ts's ensureSeeded can
 * materialize the SAME plugin-level default it is about to freeze into the
 * record, without recomputing the rule a second time.
 */
export function defaultPluginOn(
  pluginId: string,
  installedAt: string | undefined,
  featureFirstRunAt: number | undefined,
): boolean {
  if (isBundledPlugin(pluginId)) return pluginId !== THEME_BUILDER_PLUGIN_ID;
  if (featureFirstRunAt !== undefined && installedAt !== undefined) {
    const installedMs = Date.parse(installedAt);
    if (!Number.isNaN(installedMs) && installedMs > featureFirstRunAt) return false;
  }
  return true;
}

/**
 * What to WRITE for a plugin at seed time (design §2's materialize step) —
 * distinct from `defaultPluginOn`, which is the FORWARD-LOOKING rule an
 * unseeded item resolves to on every future read. The two disagree on
 * exactly one plugin: Theme Builder's own default is off (for a project
 * created after this feature ships, which is seeded at creation with
 * `isNewProject: true`), but "don't turn off what works today" means a
 * PRE-EXISTING project — one seeded lazily on its first tab-open, having run
 * every bundled plugin unconditionally for as long as it's existed, long
 * before an on/off switch existed at all — must seed every bundled plugin
 * ON, Theme Builder included. A marketplace plugin's installed-after-seed
 * carve-out (rule 2) is unaffected either way: it is about a genuinely new
 * download, not about this feature's own rollout.
 */
export function seedDefaultOn(
  pluginId: string,
  installedAt: string | undefined,
  featureFirstRunAt: number | undefined,
  isNewProject: boolean,
): boolean {
  if (!isNewProject && isBundledPlugin(pluginId)) return true;
  return defaultPluginOn(pluginId, installedAt, featureFirstRunAt);
}

/**
 * The single source of truth for what a native session's cwd may
 * automatically use (design §3). Pure — never mutates `record`.
 */
export function resolveAvailability(input: ResolveAvailabilityInput): ResolvedAvailability {
  const { projectKey, record, skills, mcp, installs, featureFirstRunAt, now } = input;

  // B-1 (Resolved by Destin #1): a conversation whose cwd matched no saved
  // folder at all gets NO automatic skills and NO tool connections — not
  // even the bundled ones. Manual /skill still works because that path
  // never calls resolveAvailability (native-session-host.ts's manual-skill
  // route builds an unfiltered catalog directly).
  if (projectKey === null && record === null) {
    return { skillIds: new Set(), mcpIds: new Set(), rows: [] };
  }

  // Private memo — NOT exposed on the return value. store.ts's ensureSeeded
  // needs the SAME per-plugin default even for a plugin whose every item
  // already has an explicit itemState (so this loop never calls the
  // default rule for it); it gets that by calling the exported
  // `defaultPluginOn` directly rather than reading this cache back out.
  const pluginDefaultCache = new Map<string, boolean>();
  const pluginDefaultOnCached = (pluginId: string): boolean => {
    const cached = pluginDefaultCache.get(pluginId);
    if (cached !== undefined) return cached;
    const val = defaultPluginOn(pluginId, installs[pluginId]?.installedAt, featureFirstRunAt);
    pluginDefaultCache.set(pluginId, val);
    return val;
  };

  const skillIds = new Set<string>();
  const mcpIds = new Set<string>();
  const rows: AvailabilityRow[] = [];

  const resolveItem = (key: string, kind: 'skill' | 'mcp', pluginId: string | undefined): void => {
    const pluginState = pluginId ? record?.plugins[pluginId] : undefined;
    const itemState = record?.items[key];
    let on: boolean;
    if (pluginState?.removed) {
      // Uninstall cascade already writes on:false too, but stay explicit —
      // a record from an older build might carry removed without on:false.
      on = false;
    } else if (pluginState && pluginState.on === false) {
      // Master pause: every part is unavailable, but nothing here TOUCHES
      // itemState — its stored value survives for when the plugin re-enables
      // (design §2 "pause remembers choices").
      on = false;
    } else if (pluginState && pluginState.on === true && pluginState.partsChosen === false) {
      // First enable: the user has never individually chosen parts for this
      // plugin, so turning the master on turns EVERY current part on —
      // overriding whatever the plugin's own default rule would say (a
      // marketplace plugin that defaulted off because it installed after
      // seeding still turns fully on the moment its master switch is
      // explicitly flipped on for the first time).
      on = true;
    } else if (itemState) {
      on = itemState.on;
    } else if (pluginId) {
      on = pluginDefaultOnCached(pluginId);
    } else {
      on = true; // rule 3: no plugin scoping at all (self/project skill, user/adopted MCP server)
    }
    if (on) (kind === 'skill' ? skillIds : mcpIds).add(key);
    rows.push({ key, kind, pluginId, on, removed: pluginState?.removed === true });
  };

  for (const s of skills) resolveItem(itemKeyForSkill(s), 'skill', s.pluginName);
  for (const m of mcp) {
    resolveItem(itemKeyForMcp(m), 'mcp', m.origin.kind === 'marketplace' ? m.origin.plugin : undefined);
  }

  return { skillIds, mcpIds, rows };
}
