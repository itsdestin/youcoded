// Marketplace overhaul (design 2026-08-27, docs/active/investigations/
// 2026-08-27-marketplace-strategy.md §4 Layers A–B): what a catalog row must
// carry for a listing to be judged BEFORE install — what kind of thing it is,
// who published it, what it can do on the machine, and whether it has been
// checked. Everything hangs off `SkillEntry.catalog`, which is optional so
// today's registry (which has none of these fields) keeps loading unchanged.
//
// Two trust signals are kept deliberately separate — "who made it" (origin)
// and "what it does / was it checked" (capabilities + scan) — because merging
// them into one score hides the reason, and the reason is what a non-technical
// user needs to decide (design decision #2, 2026-08-27).

/** The five browsable kinds of installable thing. Themes stay a separate
 *  registry with their own entry type. Commands and hooks are NOT types —
 *  they only exist inside a plugin bundle. */
export type CatalogItemType = 'plugin' | 'skill' | 'specialist' | 'tool' | 'prompt';

export const CATALOG_ITEM_TYPES: readonly CatalogItemType[] = ['plugin', 'skill', 'specialist', 'tool', 'prompt'];

/** User-facing words (accessibility rule: no jargon in menus). "Connection"
 *  is the word for an MCP server — Destin, 2026-08-28: "Connections for now";
 *  non-MCP tools may join later. "Specialist" is the app's existing word for
 *  an agent definition (see Permissions). */
export const CATALOG_TYPE_LABEL: Record<CatalogItemType, { one: string; many: string }> = {
  plugin: { one: 'Plugin', many: 'Plugins' },
  skill: { one: 'Skill', many: 'Skills' },
  specialist: { one: 'Specialist', many: 'Specialists' },
  tool: { one: 'Connection', many: 'Connections' },
  prompt: { one: 'Prompt', many: 'Prompts' },
};

/** Who published it. `youcoded` = shipped by us; `verified` = the publisher
 *  proved they own the name (MCP registry namespace / GitHub org match);
 *  `community` = anyone else. Mirrored-from is a source line, not a tier. */
export type OriginTier = 'youcoded' | 'verified' | 'community';

/** Result of the automated check on THIS version. `unchecked` is the honest
 *  default for freshly mirrored items — shown grey, never red. */
export type ScanStatus = 'checked' | 'caution' | 'unchecked';

/** What the item can do once installed, computed from its files (hooks,
 *  scripts, MCP config, declared secrets) — never self-declared by the author. */
export type CapabilityKind =
  | 'shell'    // runs commands on this computer
  | 'network'  // talks to a named host
  | 'secret'   // needs a token / API key
  | 'files'    // reads or writes files outside its own folder
  | 'auto'     // runs on its own (hooks) rather than when asked
  | 'adds';    // what it adds: "3 commands, 1 hook"

export interface Capability {
  kind: CapabilityKind;
  /** Plain-words line, e.g. "Runs commands on your computer". */
  label: string;
  /** Optional specifics, e.g. "api.github.com" or "GITHUB_TOKEN". */
  detail?: string;
}

/** Kinds worth a glyph on the card itself so they can be spotted while
 *  scrolling; `adds` and `files` only show on the detail page. */
export const RISKY_CAPABILITY_KINDS: readonly CapabilityKind[] = ['shell', 'network', 'secret', 'auto'];

export interface CatalogMeta {
  itemType: CatalogItemType;
  /** Set when this row is a member of a bundle (a skill inside a plugin).
   *  Grouped views hide members; type-filtered views and search show them. */
  partOf?: { id: string; displayName: string };
  origin: { tier: OriginTier; mirroredFrom?: string };
  /** `rules` is the version of the scan rule set that produced this verdict
   *  (`SCAN_RULES_VERSION`). Never rendered — the ingest reads it back through
   *  `/admin/catalog/shas` so that improving the scanner re-scans the catalog
   *  on the next hourly run instead of waiting for someone to remember
   *  `--force-rescan`. */
  scan: { status: ScanStatus; checkedAt?: string; findings?: string[]; rules?: string };
  capabilities: Capability[];
  /** SPDX id, e.g. "MIT". Absent = unknown / all rights reserved. */
  license?: string;
  /** The exact upstream commit this listing was taken from (pinned). */
  sourceCommit?: string;
  /** The listing's id in its upstream registry (reverse-DNS MCP name, Docker
   *  slug, …) — shown in the detail footer, used by the ingest to dedupe. */
  upstreamId?: string;
  /** GitHub stars at ingest time, where the source reports them (Docker's
   *  `metadata.githubStars`, our own repo lookups). Display and future ranking
   *  only — nothing hides a listing based on it. */
  stars?: number;
}

/** Type of an entry, defaulting to `plugin` for pre-overhaul registry rows. */
export function catalogType(meta: CatalogMeta | undefined): CatalogItemType {
  return meta?.itemType ?? 'plugin';
}

/** Can the app's installer actually take this row?
 *
 *  True for plugins cloned from git (`local` / `url` / `git-subdir`) and for
 *  prompt rows, which install as a private prompt rather than a package.
 *  False for Connections mirrored from the MCP registry (`mcp-registry`) and
 *  single-file rows (`file`) — the installer answers both with "Unknown source
 *  type", so an Install button on them could only ever fail. Those listings show
 *  "Open source" instead; per-type install is a ROADMAP follow-up.
 *
 *  A prompt counts as installable ONLY when the prompt text travels in the row:
 *  the mirrored "instructions" listings are prompt-typed pointers carrying no
 *  text, and installing one would store an empty prompt. */
export function isInstallableSource(entry: { type?: string; sourceType?: string; prompt?: string }): boolean {
  if (entry.type === 'prompt') return typeof entry.prompt === 'string' && entry.prompt.trim().length > 0;
  return entry.sourceType === 'local' || entry.sourceType === 'url' || entry.sourceType === 'git-subdir';
}

/** T6 (project-plugin-controls), moved here U2 fix round (beta review 2):
 *  "has parts" gates the post-install "choose your projects" panel on "a
 *  plugin that has skills or tool connections" — never a fixture id. Shared
 *  between the Marketplace CARD's own install button (grid/rail/search) and
 *  the detail overlay's Install button, so EVERY successful install of a
 *  plugin with parts reaches the same setup panel, not just the one started
 *  from the detail page (a card install used to leave no way there at all).
 *  `components` comes straight off the catalog entry (extract-components.js,
 *  at sync time) — there is no separate signal in the install call itself
 *  (`installSkill` resolves void), so the catalog entry IS "the install
 *  result" here. `null` (extraction failed) or `undefined` (a pre-Phase-1
 *  cached entry) means no data to gate on — keep today's plain installed view
 *  rather than guessing; a prompt-only skill's own `components` is either
 *  absent or an empty object, so it never qualifies either way. */
export function pluginHasParts(entry: { components?: { skills: unknown[]; mcpServers: unknown[] } | null }): boolean {
  const c = entry.components;
  return !!c && (c.skills.length > 0 || c.mcpServers.length > 0);
}
