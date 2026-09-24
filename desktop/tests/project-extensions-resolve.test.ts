import { describe, it, expect } from 'vitest';
import {
  resolveAvailability, defaultPluginOn, seedDefaultOn, itemKeyForSkill, itemKeyForMcp,
  type CatalogSkillEntry, type CatalogMcpEntry, type ResolveAvailabilityInput, type AvailabilityRow,
} from '../src/main/project-extensions/resolve';
import { PROJECT_EXTENSIONS_SCHEMA, type ProjectExtensionsRecord } from '../src/main/project-extensions/store';

const NOW = 1_800_000_000_000; // fixed clock — never race the real one
const DAY = 24 * 60 * 60 * 1000;

function emptyRecord(seededAt = 0): ProjectExtensionsRecord {
  return { schemaVersion: PROJECT_EXTENSIONS_SCHEMA, seededAt, plugins: {}, items: {} };
}

function baseInput(overrides: Partial<ResolveAvailabilityInput> = {}): ResolveAvailabilityInput {
  return {
    projectKey: 'MyProject',
    record: null,
    skills: [],
    mcp: [],
    installs: {},
    featureFirstRunAt: NOW,
    now: NOW,
    ...overrides,
  };
}

describe('itemKeyForSkill / itemKeyForMcp', () => {
  it('qualifies self and project skills so bare-name ids never collide', () => {
    const self: CatalogSkillEntry = { id: 'notes', source: 'self' };
    const project: CatalogSkillEntry = { id: 'notes', source: 'project' };
    expect(itemKeyForSkill(self)).toBe('self:notes');
    expect(itemKeyForSkill(project)).toBe('project:notes');
    expect(itemKeyForSkill(self)).not.toBe(itemKeyForSkill(project));
  });

  it('uses a plugin-sourced id as-is (already `plugin:skill` qualified)', () => {
    const entry: CatalogSkillEntry = { id: 'wecoded-themes-plugin:theme-builder', source: 'plugin', pluginName: 'wecoded-themes-plugin' };
    expect(itemKeyForSkill(entry)).toBe('wecoded-themes-plugin:theme-builder');
  });

  it('prefixes an MCP server id with mcp:', () => {
    const entry: CatalogMcpEntry = { id: 'my-server', origin: { kind: 'user' } };
    expect(itemKeyForMcp(entry)).toBe('mcp:my-server');
  });
});

describe('defaultPluginOn — bundled, marketplace-installed-after-seed, and everything-else defaults', () => {
  it('bundled, non-Theme-Builder plugins default on', () => {
    expect(defaultPluginOn('youcoded-chatsearch', undefined, NOW)).toBe(true);
    expect(defaultPluginOn('wecoded-pages-plugin', undefined, NOW)).toBe(true);
    expect(defaultPluginOn('wecoded-marketplace-publisher', undefined, NOW)).toBe(true);
  });

  it('Theme Builder defaults OFF even though it is bundled', () => {
    expect(defaultPluginOn('wecoded-themes-plugin', undefined, NOW)).toBe(false);
  });

  it('a marketplace plugin installed AFTER the seed instant defaults off', () => {
    const installedAt = new Date(NOW + 60_000).toISOString();
    expect(defaultPluginOn('civic-report', installedAt, NOW)).toBe(false);
  });

  it('a marketplace plugin installed BEFORE the seed instant defaults on', () => {
    const installedAt = new Date(NOW - 60_000).toISOString();
    expect(defaultPluginOn('civic-report', installedAt, NOW)).toBe(true);
  });

  it('a missing installedAt counts as "before" — defaults on', () => {
    expect(defaultPluginOn('civic-report', undefined, NOW)).toBe(true);
  });

  it('an unparseable installedAt counts as "before" — defaults on (damaged record can only keep something ON)', () => {
    expect(defaultPluginOn('civic-report', 'not-a-date', NOW)).toBe(true);
  });

  it('everything else (no bundled/marketplace signal at all) defaults on', () => {
    expect(defaultPluginOn('some-random-plugin-id', undefined, NOW)).toBe(true);
  });
});

// F1 review fix (T6, 2026-09-24): the ORIGINAL rule compared installedAt
// against the project's folder addedAt (deleted) or its own seededAt —
// almost every folder is added long before most of what gets installed into
// it, so that rule turned OFF an ordinary, working install on a project's
// first seed. This is the exact regression the review caught ("installed
// months ago, after folder added"). The correct — and now only — lower
// bound is featureFirstRunAt, a per-device instant with no relationship to
// any one project's age at all.
describe('defaultPluginOn — the installed-after-seed rule keys off featureFirstRunAt, never a project\'s age (F1 fix)', () => {
  it('an ordinary install from months ago, long after any project could plausibly have been "added", stays ON', () => {
    const featureFirstRunAt = NOW; // the feature rolled out today
    const installedAt = new Date(NOW - 90 * DAY).toISOString(); // 3 months ago — an ordinary, working install
    expect(defaultPluginOn('civic-report', installedAt, featureFirstRunAt)).toBe(true);
  });

  it('(i) a plugin installed a year before the feature is ON — a project\'s own age is irrelevant, since it no longer exists as a signal at all', () => {
    const featureFirstRunAt = NOW;
    const installedAt = new Date(NOW - 365 * DAY).toISOString();
    expect(defaultPluginOn('civic-report', installedAt, featureFirstRunAt)).toBe(true);
  });

  it('(ii) a plugin installed a minute after featureFirstRunAt is OFF', () => {
    const featureFirstRunAt = NOW;
    const installedAt = new Date(NOW + 60_000).toISOString();
    expect(defaultPluginOn('civic-report', installedAt, featureFirstRunAt)).toBe(false);
  });

  it('(iii) featureFirstRunAt absent (could not be written yet) -> unknown -> ON, even for a brand-new install', () => {
    const installedAt = new Date(NOW + 60_000).toISOString();
    expect(defaultPluginOn('civic-report', installedAt, undefined)).toBe(true);
  });
});

describe('resolveAvailability — an item with no explicit entry uses featureFirstRunAt, never the project\'s own (possibly much later) seededAt (F1 fix)', () => {
  it('(ii, "already-seeded project -> OFF"): a plugin installed after featureFirstRunAt resolves OFF even when this project\'s record was seeded well AFTER that install — seededAt is never the comparison', () => {
    const skills: CatalogSkillEntry[] = [{ id: 'civic:report', source: 'plugin', pluginName: 'civic' }];
    const featureFirstRunAt = NOW;
    const installedAt = new Date(NOW + 30 * DAY).toISOString(); // installed after the feature shipped
    const record = emptyRecord(NOW + 60 * DAY); // this project's OWN seed happened even later still
    const result = resolveAvailability({
      projectKey: 'MyProject', record, skills, mcp: [], installs: { civic: { installedAt } },
      featureFirstRunAt, now: NOW + 90 * DAY,
    });
    expect(result.skillIds.has('civic:report')).toBe(false);
  });

  it('a plugin installed before featureFirstRunAt resolves ON even in a project seeded long, long after that install', () => {
    const skills: CatalogSkillEntry[] = [{ id: 'civic:report', source: 'plugin', pluginName: 'civic' }];
    const featureFirstRunAt = NOW;
    const installedAt = new Date(NOW - 365 * DAY).toISOString();
    const record = emptyRecord(NOW + 60 * DAY);
    const result = resolveAvailability({
      projectKey: 'MyProject', record, skills, mcp: [], installs: { civic: { installedAt } },
      featureFirstRunAt, now: NOW + 90 * DAY,
    });
    expect(result.skillIds.has('civic:report')).toBe(true);
  });
});

describe('seedDefaultOn — the materialize-time answer, distinct from defaultPluginOn', () => {
  it('seeds Theme Builder ON for a pre-existing project (isNewProject:false), unlike its own forward-looking default', () => {
    expect(seedDefaultOn('wecoded-themes-plugin', undefined, NOW, false)).toBe(true);
    expect(defaultPluginOn('wecoded-themes-plugin', undefined, NOW)).toBe(false); // the two genuinely disagree
  });

  it('seeds Theme Builder OFF for a project seeded at its own creation (isNewProject:true)', () => {
    expect(seedDefaultOn('wecoded-themes-plugin', undefined, NOW, true)).toBe(false);
  });

  it('agrees with defaultPluginOn for every OTHER bundled plugin regardless of isNewProject', () => {
    expect(seedDefaultOn('youcoded-chatsearch', undefined, NOW, false)).toBe(true);
    expect(seedDefaultOn('youcoded-chatsearch', undefined, NOW, true)).toBe(true);
  });

  it('the marketplace installed-after-seed carve-out still applies during seeding, regardless of isNewProject', () => {
    const installedAt = new Date(NOW + 1).toISOString();
    expect(seedDefaultOn('civic-report', installedAt, NOW, false)).toBe(false);
    expect(seedDefaultOn('civic-report', installedAt, NOW, true)).toBe(false);
  });
});

describe('resolveAvailability — B-1 outside any project', () => {
  it('returns empty sets when projectKey and record are both null', () => {
    const result = resolveAvailability(baseInput({ projectKey: null, record: null }));
    expect(result.skillIds.size).toBe(0);
    expect(result.mcpIds.size).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it('does NOT short-circuit for a real project key with no record yet (never-seeded, still a real project)', () => {
    const skills: CatalogSkillEntry[] = [{ id: 'youcoded-chatsearch', source: 'plugin', pluginName: 'youcoded-chatsearch' }];
    const result = resolveAvailability(baseInput({ projectKey: 'MyProject', record: null, skills }));
    expect(result.skillIds.has('youcoded-chatsearch')).toBe(true);
  });
});

describe('resolveAvailability — defaults, no explicit record entries', () => {
  const skills: CatalogSkillEntry[] = [
    { id: 'youcoded-chatsearch', source: 'plugin', pluginName: 'youcoded-chatsearch' },
    { id: 'wecoded-themes-plugin:theme-builder', source: 'plugin', pluginName: 'wecoded-themes-plugin' },
    { id: 'notes', source: 'self' },
    { id: 'notes', source: 'project' },
  ];
  const mcp: CatalogMcpEntry[] = [
    { id: 'user-server', origin: { kind: 'user' } },
    { id: 'adopted-server', origin: { kind: 'adopted' } },
    { id: 'plugin-server', origin: { kind: 'marketplace', plugin: 'civic-report' } },
  ];

  it('bundled Chat Search is on, Theme Builder is off, self/project skills are on, user/adopted MCP is on', () => {
    const result = resolveAvailability(baseInput({ record: null, skills, mcp, installs: {} }));
    expect(result.skillIds.has('youcoded-chatsearch')).toBe(true);
    expect(result.skillIds.has('wecoded-themes-plugin:theme-builder')).toBe(false);
    expect(result.skillIds.has('self:notes')).toBe(true);
    expect(result.skillIds.has('project:notes')).toBe(true);
    expect(result.mcpIds.has('mcp:user-server')).toBe(true);
    expect(result.mcpIds.has('mcp:adopted-server')).toBe(true);
  });

  it('a marketplace-plugin-owned MCP server follows the SAME installed-after-seed rule as its skills', () => {
    const installedAt = new Date(NOW + 60_000).toISOString();
    const withInstall = resolveAvailability(baseInput({
      record: emptyRecord(NOW), skills: [], mcp, installs: { 'civic-report': { installedAt } },
    }));
    expect(withInstall.mcpIds.has('mcp:plugin-server')).toBe(false);
  });
});

describe('resolveAvailability — explicit per-item entries win over the default', () => {
  it('an explicit off beats a bundled-default-on plugin', () => {
    const record: ProjectExtensionsRecord = {
      ...emptyRecord(NOW),
      items: { 'youcoded-chatsearch': { on: false, at: NOW } },
    };
    const skills: CatalogSkillEntry[] = [{ id: 'youcoded-chatsearch', source: 'plugin', pluginName: 'youcoded-chatsearch' }];
    const result = resolveAvailability(baseInput({ record, skills }));
    expect(result.skillIds.has('youcoded-chatsearch')).toBe(false);
  });

  it('an explicit on beats a default-off Theme Builder', () => {
    const record: ProjectExtensionsRecord = {
      ...emptyRecord(NOW),
      items: { 'wecoded-themes-plugin:theme-builder': { on: true, at: NOW } },
    };
    const skills: CatalogSkillEntry[] = [{ id: 'wecoded-themes-plugin:theme-builder', source: 'plugin', pluginName: 'wecoded-themes-plugin' }];
    const result = resolveAvailability(baseInput({ record, skills }));
    expect(result.skillIds.has('wecoded-themes-plugin:theme-builder')).toBe(true);
  });
});

describe('resolveAvailability — plugin master pause preserves parts', () => {
  const skills: CatalogSkillEntry[] = [{ id: 'p:one', source: 'plugin', pluginName: 'p' }, { id: 'p:two', source: 'plugin', pluginName: 'p' }];

  it('turns every part off while paused, without touching the stored item values', () => {
    const record: ProjectExtensionsRecord = {
      ...emptyRecord(NOW),
      plugins: { p: { on: false, partsChosen: true, at: NOW } },
      items: { 'p:one': { on: true, at: NOW }, 'p:two': { on: true, at: NOW } },
    };
    const result = resolveAvailability(baseInput({ record, skills }));
    expect(result.skillIds.has('p:one')).toBe(false);
    expect(result.skillIds.has('p:two')).toBe(false);
    // The record itself is never mutated by resolve — pure function.
    expect(record.items['p:one'].on).toBe(true);
    expect(record.items['p:two'].on).toBe(true);
  });
});

describe('resolveAvailability — first enable turns all parts on', () => {
  const skills: CatalogSkillEntry[] = [{ id: 'p:one', source: 'plugin', pluginName: 'p' }, { id: 'p:two', source: 'plugin', pluginName: 'p' }];

  it('every part is on when partsChosen is false, even with no item entries', () => {
    const record: ProjectExtensionsRecord = {
      ...emptyRecord(NOW),
      plugins: { p: { on: true, partsChosen: false, at: NOW } },
    };
    const result = resolveAvailability(baseInput({ record, skills }));
    expect(result.skillIds.has('p:one')).toBe(true);
    expect(result.skillIds.has('p:two')).toBe(true);
  });

  it('overrides a stray explicit-off item entry while partsChosen is false', () => {
    const record: ProjectExtensionsRecord = {
      ...emptyRecord(NOW),
      plugins: { p: { on: true, partsChosen: false, at: NOW } },
      items: { 'p:one': { on: false, at: NOW } },
    };
    const result = resolveAvailability(baseInput({ record, skills }));
    expect(result.skillIds.has('p:one')).toBe(true);
  });

  it('once partsChosen is true, individual item entries are respected again', () => {
    const record: ProjectExtensionsRecord = {
      ...emptyRecord(NOW),
      plugins: { p: { on: true, partsChosen: true, at: NOW } },
      items: { 'p:one': { on: false, at: NOW } },
    };
    const result = resolveAvailability(baseInput({ record, skills }));
    expect(result.skillIds.has('p:one')).toBe(false);
    expect(result.skillIds.has('p:two')).toBe(true); // no entry -> falls to the plugin default (on, not bundled/marketplace)
  });
});

describe('resolveAvailability — removed plugins are hidden', () => {
  it('a removed plugin resolves off and flags the row removed, regardless of stored item value', () => {
    const record: ProjectExtensionsRecord = {
      ...emptyRecord(NOW),
      plugins: { p: { on: false, partsChosen: true, removed: true, at: NOW } },
      items: { 'p:one': { on: true, at: NOW } },
    };
    const skills: CatalogSkillEntry[] = [{ id: 'p:one', source: 'plugin', pluginName: 'p' }];
    const result = resolveAvailability(baseInput({ record, skills }));
    expect(result.skillIds.has('p:one')).toBe(false);
    const row: AvailabilityRow | undefined = result.rows.find((r) => r.key === 'p:one');
    expect(row).toMatchObject({ kind: 'skill', pluginId: 'p', on: false, removed: true });
  });
});
