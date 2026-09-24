// desktop/src/renderer/dev/workbench/fixtures/project-extensions.ts
//
// T7 (project-plugin-controls cleanup) — realistic in-memory fixture data for
// the four `project-extensions:*` channels, so the workbench renders the REAL
// Skills & tools tab (SkillsToolsTab.tsx), the drawer's availability chips
// (CommandDrawer.tsx) and the Marketplace post-install panel
// (ProjectSetupPanel.tsx) instead of the deleted workbench-only
// ProjectPluginControlsDemo mockup those three components superseded (T4-T6).
//
// One project — PRIMARY_PROJECT_PATH, the same `/home/destin/youcoded-dev/
// youcoded` path fixtures/artifacts.ts's default project list and
// fixtures/sessions.ts's `wb-1` session already use — gets the full,
// interesting state: a bundled group, one installed plugin ("Research Kit")
// with two skills and a tool connection that needs local setup, a personal
// skill that's already on, and two needs-setup rows (a personal skill and a
// tool connection). `self:writing-helper` is the SAME key/name the original
// design mockup and useSessionAvailability.test.ts both used for "a personal
// skill turned on here but missing on this device" — kept for continuity with
// the ui-review plans and unit tests already written against that example.
// Every other project gets just the three bundled plugins, seeded on — bundled
// plugins are always installed and are NOT the "new download" R19's "starts
// off everywhere" rule is about (that rule covers `inboxGroup()` and
// `installedPluginGroup()` below, for a plugin the user actually installed).
import type {
  ProjectExtensionsChange,
  ProjectExtensionsForSessionResult,
  ProjectExtensionsGetResult,
} from '../../../../shared/types';

type SkillsToolsView = Extract<ProjectExtensionsGetResult, { ok: true }>['view'];
type PluginGroup = SkillsToolsView['builtIn'][number];
type PartRow = PluginGroup['parts'][number];
type NeedsSetupRow = SkillsToolsView['needsSetup'][number];

const PRIMARY_PROJECT_PATH = '/home/destin/youcoded-dev/youcoded';

// Mirrors shared/bundled-plugins.ts's BUNDLED_PLUGIN_IDS — every project
// starts with these on (bundled plugins are always installed; `on` here is
// only "may this project's conversations use it automatically").
function bundledGroups(): PluginGroup[] {
  return [
    { pluginId: 'wecoded-themes-plugin', displayName: 'Theme Builder', bundled: true, on: true, paused: false, parts: [] },
    { pluginId: 'wecoded-marketplace-publisher', displayName: 'Marketplace Publisher', bundled: true, on: true, paused: false, parts: [] },
    { pluginId: 'youcoded-chatsearch', displayName: 'Chat Search', bundled: true, on: true, paused: false, parts: [] },
  ];
}

// The primary project's one non-bundled installed plugin. Starts OFF
// (paused: true) so the review plan's risk-confirm shot (turning it on) has
// something to click; its tool connection is named "Research sources" and its
// group "Research Kit" to match scripts/ui-review/plans/project-plugin-risk-
// confirm.json, which was already written against these exact names.
function researchKitGroup(): PluginGroup {
  return {
    pluginId: 'research-kit',
    displayName: 'Research Kit',
    bundled: false,
    on: false,
    paused: true,
    parts: [
      { key: 'research-kit:web-digest', kind: 'skill', displayName: 'Web digest', on: true },
      { key: 'research-kit:citation-check', kind: 'skill', displayName: 'Citation check', on: true },
      { key: 'research-kit:sources', kind: 'mcp', displayName: 'Research sources', on: true, needsLocalSetup: true },
    ],
  };
}

function primaryPersonal(): PartRow[] {
  return [
    { key: 'self:journal-companion', kind: 'skill', displayName: 'Journal companion', on: true },
  ];
}

// Order matters: scripts/ui-review/plans/project-plugin-setup-rows-phone.json
// opens the SECOND ("Set up here" index 1) row and expects tool-connection
// copy ("sign-in stay on the device") — so the tool connection must be
// second, the personal skill first.
function primaryNeedsSetup(): NeedsSetupRow[] {
  return [
    { key: 'self:writing-helper', displayName: 'Writing helper', kind: 'personal-skill', projectKey: PRIMARY_PROJECT_PATH },
    { key: 'mcp:linear', displayName: 'Linear', kind: 'tool-connection', projectKey: PRIMARY_PROJECT_PATH },
  ];
}

export function defaultView(path: string): SkillsToolsView {
  if (path === PRIMARY_PROJECT_PATH) {
    return {
      projectKey: path,
      builtIn: bundledGroups(),
      installed: [researchKitGroup()],
      personal: primaryPersonal(),
      needsSetup: primaryNeedsSetup(),
    };
  }
  return { projectKey: path, builtIn: bundledGroups(), installed: [], personal: [], needsSetup: [] };
}

// Folded into a project's `installed` list the moment the Marketplace
// fixture's "Inbox" plugin (youcoded-inbox) has been installed live in this
// workbench session — starts OFF/paused (R19 grading pass, 2026-09-24): a
// live probe against the workbench caught this fixture hardcoding on: true
// here, contradicting the product's own "a new download starts inactive
// everywhere" rule (design spec §"Defaults") and the approved
// combined-review-2 screenshot, which shows every project's Inbox toggle
// off right after install. The PREVIOUS comment here claimed this matched
// "starts off everywhere" — it did not; `installedPluginGroup` just below is
// the one that actually followed that rule (mirroring the real store's
// `defaultPluginOn` in main/project-extensions/resolve.ts), and this fixture
// is now identical to it in that respect. One skill, matching the catalog
// entry's own components (fixtures/marketplace/registry.ts: skills:
// ['claudes-inbox']) — "Process inbox" is this fixture's own display name
// for that skill, not a real scanned one.
export function inboxGroup(): PluginGroup {
  return {
    pluginId: 'youcoded-inbox',
    displayName: 'Inbox',
    bundled: false,
    on: false,
    paused: true,
    parts: [
      { key: 'youcoded-inbox:claudes-inbox', kind: 'skill', displayName: 'Process inbox', on: false },
    ],
  };
}

// `remember`, `commit-message` -> `Remember`, `Commit message` — the fixture
// has no curated display name for an arbitrary catalog component (unlike
// researchKitGroup's hand-written "Web digest"/"Research sources" above), so
// this derives a readable one from the raw skill/MCP-server id the catalog
// entry ships.
function humanizeComponentName(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// U2 fix (beta review 2): generalizes inboxGroup — any Marketplace plugin
// installed live during this workbench session (not just youcoded-inbox)
// must appear in every project's "Added on this device" section, built from
// the SAME catalog `.components` block the real `pluginHasParts` gate reads
// (shared/catalog-types.ts) — skills and MCP servers become parts, matching
// what the review found missing for "Remember". Unlike Inbox (grandfathered
// ON as a stand-in for something installed before this feature shipped), the
// master switch starts OFF/paused — matches the real store's
// `defaultPluginOn` rule 2 (main/project-extensions/resolve.ts): a
// marketplace install whose `installedAt` is after this feature's first run
// on the device defaults off.
export function installedPluginGroup(plugin: {
  id: string;
  displayName: string;
  components?: { skills?: readonly string[]; mcpServers?: readonly string[] } | null;
}): PluginGroup {
  const skills = plugin.components?.skills ?? [];
  const mcpServers = plugin.components?.mcpServers ?? [];
  const parts: PartRow[] = [
    ...skills.map((name) => ({
      key: `${plugin.id}:${name}`, kind: 'skill' as const, displayName: humanizeComponentName(name), on: false,
    })),
    ...mcpServers.map((name) => ({
      key: `${plugin.id}:${name}`, kind: 'mcp' as const, displayName: humanizeComponentName(name), on: false,
    })),
  ];
  return {
    pluginId: plugin.id, displayName: plugin.displayName, bundled: false, on: false, paused: true, parts,
  };
}

/** Applies one `project-extensions:set` change to a view, matching the real
 *  store's semantics: a `plugin` change flips the master switch (and
 *  `paused` follows `!on`); an `item` change flips exactly one part, wherever
 *  it lives (a plugin's part, or a standalone personal one). */
export function applyChange(view: SkillsToolsView, change: ProjectExtensionsChange): SkillsToolsView {
  if (change.plugin) {
    const patch = (g: PluginGroup): PluginGroup =>
      (g.pluginId === change.plugin ? { ...g, on: change.on, paused: !change.on } : g);
    return { ...view, builtIn: view.builtIn.map(patch), installed: view.installed.map(patch) };
  }
  const patchPart = (p: PartRow): PartRow => (p.key === change.item ? { ...p, on: change.on } : p);
  const patchGroup = (g: PluginGroup): PluginGroup => ({ ...g, parts: g.parts.map(patchPart) });
  return {
    ...view,
    builtIn: view.builtIn.map(patchGroup),
    installed: view.installed.map(patchGroup),
    personal: view.personal.map(patchPart),
  };
}

/** `project-extensions:for-session` fixture — only `wb-1` (the primary
 *  project's own session in fixtures/sessions.ts) has a real frozen set, so
 *  the drawer's Automatic/Manual split and its one "needs setup here" card
 *  are reachable; every other session answers `frozenSkillIds: null` (no
 *  stored frozen set at all — the pre-T2 / unrestricted default). Ids here
 *  are bare marketplace catalog ids (fixtures/marketplace/registry.ts
 *  INSTALLED_SKILLS), matching `skillItemKey`'s no-prefix rule for
 *  `source: 'marketplace'` skills — 'theme-builder' and 'civic-report' read
 *  Automatic in the drawer, every other installed skill reads Manual. */
export function forSessionFixture(sessionId: string, cwd: string | undefined): ProjectExtensionsForSessionResult {
  if (sessionId !== 'wb-1' || cwd !== PRIMARY_PROJECT_PATH) {
    return { ok: true, projectKey: cwd ?? PRIMARY_PROJECT_PATH, frozenSkillIds: null, frozenMcpIds: null, missing: [], settingsDiffer: false };
  }
  return {
    ok: true,
    projectKey: PRIMARY_PROJECT_PATH,
    frozenSkillIds: ['theme-builder', 'civic-report'],
    frozenMcpIds: ['research-kit:sources'],
    // Same row as this project's own needsSetup[0] (personal-skill,
    // "Writing helper") — "Set up here" (SkillsToolsTab) and the drawer's
    // "Needs setup here" card point at the identical real item.
    missing: [{ key: 'self:writing-helper', displayName: 'Writing helper', kind: 'personal-skill', projectKey: PRIMARY_PROJECT_PATH }],
    settingsDiffer: false,
  };
}
