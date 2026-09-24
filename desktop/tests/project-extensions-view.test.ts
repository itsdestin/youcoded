import { describe, it, expect } from 'vitest';
import {
  buildProjectExtensionsView, applyProjectExtensionsChanges,
  type ViewSkillEntry, type ViewMcpEntry, type BuildViewInput, type ApplyChangesInput,
} from '../src/main/project-extensions/view';
import { PROJECT_EXTENSIONS_SCHEMA, type ProjectExtensionsRecord } from '../src/main/project-extensions/store';

const NOW = 1_800_000_000_000; // fixed clock — never race the real one
const PROJECT_KEY = 'MyProject';

function emptyRecord(seededAt = 0): ProjectExtensionsRecord {
  return { schemaVersion: PROJECT_EXTENSIONS_SCHEMA, seededAt, plugins: {}, items: {} };
}

function baseViewInput(overrides: Partial<BuildViewInput> = {}): BuildViewInput {
  return { projectKey: PROJECT_KEY, record: null, skills: [], mcp: [], installs: {}, featureFirstRunAt: NOW, now: NOW, ...overrides };
}

const researchFindSkill: ViewSkillEntry = { id: 'research-kit:find-sources', source: 'plugin', pluginName: 'research-kit', displayName: 'Find sources' };
const researchToolMcp: ViewMcpEntry = { id: 'research-lib', origin: { kind: 'marketplace', plugin: 'research-kit' }, label: 'Research sources', missingSecrets: [] };
const themeBuilderSkill: ViewSkillEntry = { id: 'wecoded-themes-plugin:theme-builder', source: 'plugin', pluginName: 'wecoded-themes-plugin', displayName: 'Theme Builder' };
const chatSearchSkill: ViewSkillEntry = { id: 'youcoded-chatsearch:chat-search', source: 'plugin', pluginName: 'youcoded-chatsearch', displayName: 'Chat Search' };
const personalSkill: ViewSkillEntry = { id: 'writing-helper', source: 'self', displayName: 'Writing helper' };

describe('buildProjectExtensionsView — grouping', () => {
  it('groups bundled plugins into builtIn and marketplace plugins into installed', () => {
    const view = buildProjectExtensionsView(baseViewInput({ skills: [themeBuilderSkill, chatSearchSkill, researchFindSkill], mcp: [researchToolMcp], record: emptyRecord(NOW) }));
    expect(view.builtIn.map((g) => g.pluginId).sort()).toEqual(['wecoded-themes-plugin', 'youcoded-chatsearch']);
    expect(view.installed.map((g) => g.pluginId)).toEqual(['research-kit']);
    const research = view.installed[0];
    expect(research.parts.map((p) => p.key).sort()).toEqual(['mcp:research-lib', 'research-kit:find-sources']);
  });

  it('uses well-known display names for bundled plugins, not a title-cased id', () => {
    const view = buildProjectExtensionsView(baseViewInput({ skills: [themeBuilderSkill], record: emptyRecord(NOW) }));
    expect(view.builtIn[0].displayName).toBe('Theme Builder');
  });

  it('a single-part installed plugin borrows its part\'s display name', () => {
    const soloSkill: ViewSkillEntry = { id: 'civic-report:file-report', source: 'plugin', pluginName: 'civic-report', displayName: 'File a report' };
    const view = buildProjectExtensionsView(baseViewInput({ skills: [soloSkill] }));
    expect(view.installed[0].displayName).toBe('File a report');
  });

  it('falls back to a title-cased plugin id when it has multiple parts and no better name', () => {
    const partA: ViewSkillEntry = { id: 'civic-report:file', source: 'plugin', pluginName: 'civic-report', displayName: 'File' };
    const partB: ViewSkillEntry = { id: 'civic-report:track', source: 'plugin', pluginName: 'civic-report', displayName: 'Track' };
    const view = buildProjectExtensionsView(baseViewInput({ skills: [partA, partB] }));
    expect(view.installed[0].displayName).toBe('Civic Report');
  });

  it('personal (self-sourced) skills and user MCP servers are ungrouped, under `personal`', () => {
    const userMcp: ViewMcpEntry = { id: 'notes-db', origin: { kind: 'user' }, label: 'Notes DB', missingSecrets: [] };
    const view = buildProjectExtensionsView(baseViewInput({ skills: [personalSkill], mcp: [userMcp], record: emptyRecord(NOW) }));
    expect(view.builtIn).toEqual([]);
    expect(view.installed).toEqual([]);
    expect(view.personal.map((p) => p.key).sort()).toEqual(['mcp:notes-db', 'self:writing-helper']);
  });

  it('a removed plugin is hidden entirely, not shown off', () => {
    const record: ProjectExtensionsRecord = { ...emptyRecord(NOW), plugins: { 'research-kit': { on: false, partsChosen: true, removed: true, at: NOW } } };
    const view = buildProjectExtensionsView(baseViewInput({ skills: [researchFindSkill], mcp: [researchToolMcp], record }));
    expect(view.installed).toEqual([]);
  });

  it('flags an mcp part with missingSecrets as needsLocalSetup, never a skill part', () => {
    const needsSetupMcp: ViewMcpEntry = { ...researchToolMcp, missingSecrets: ['API_KEY'] };
    const view = buildProjectExtensionsView(baseViewInput({ skills: [researchFindSkill], mcp: [needsSetupMcp], record: emptyRecord(NOW) }));
    const research = view.installed[0];
    const mcpPart = research.parts.find((p) => p.kind === 'mcp')!;
    const skillPart = research.parts.find((p) => p.kind === 'skill')!;
    expect(mcpPart.needsLocalSetup).toBe(true);
    expect(skillPart.needsLocalSetup).toBeUndefined();
  });
});

describe('buildProjectExtensionsView — plugin on/off and paused', () => {
  it('an explicit plugins[] entry drives the group on/off, not the default rule', () => {
    const record: ProjectExtensionsRecord = { ...emptyRecord(NOW), plugins: { 'research-kit': { on: false, partsChosen: true, at: NOW } } };
    const view = buildProjectExtensionsView(baseViewInput({ skills: [researchFindSkill], record }));
    expect(view.installed[0].on).toBe(false);
    expect(view.installed[0].paused).toBe(true);
  });

  it('no explicit entry falls back to the default rule (bundled plugins on, Theme Builder off)', () => {
    const view = buildProjectExtensionsView(baseViewInput({ skills: [themeBuilderSkill, chatSearchSkill], record: null }));
    const theme = view.builtIn.find((g) => g.pluginId === 'wecoded-themes-plugin')!;
    const chat = view.builtIn.find((g) => g.pluginId === 'youcoded-chatsearch')!;
    expect(theme.on).toBe(false);
    expect(chat.on).toBe(true);
  });
});

describe('buildProjectExtensionsView — needs-setup rows', () => {
  it('a marketplace plugin on in the project but not installed here shows kind "install"', () => {
    const record: ProjectExtensionsRecord = { ...emptyRecord(NOW), plugins: { 'research-kit': { on: true, partsChosen: true, at: NOW } } };
    const view = buildProjectExtensionsView(baseViewInput({ skills: [], mcp: [], record }));
    expect(view.needsSetup).toEqual([{ key: 'research-kit', displayName: 'Research Kit', kind: 'install', projectKey: PROJECT_KEY }]);
  });

  it('an installed plugin never appears in needsSetup even if on', () => {
    const record: ProjectExtensionsRecord = { ...emptyRecord(NOW), plugins: { 'research-kit': { on: true, partsChosen: true, at: NOW } } };
    const view = buildProjectExtensionsView(baseViewInput({ skills: [researchFindSkill], record }));
    expect(view.needsSetup).toEqual([]);
  });

  it('an off plugin is never a needs-setup row even if not installed here', () => {
    const record: ProjectExtensionsRecord = { ...emptyRecord(NOW), plugins: { 'research-kit': { on: false, partsChosen: true, at: NOW } } };
    const view = buildProjectExtensionsView(baseViewInput({ skills: [], record }));
    expect(view.needsSetup).toEqual([]);
  });

  it('a removed plugin never appears in needsSetup even if it somehow has on:true', () => {
    const record: ProjectExtensionsRecord = { ...emptyRecord(NOW), plugins: { 'research-kit': { on: true, partsChosen: true, removed: true, at: NOW } } };
    const view = buildProjectExtensionsView(baseViewInput({ skills: [], record }));
    expect(view.needsSetup).toEqual([]);
  });

  it('a personal skill on in the project but missing on this device shows kind "personal-skill"', () => {
    const record: ProjectExtensionsRecord = { ...emptyRecord(NOW), items: { 'self:writing-helper': { on: true, at: NOW } } };
    const view = buildProjectExtensionsView(baseViewInput({ skills: [], record }));
    expect(view.needsSetup).toEqual([{ key: 'self:writing-helper', displayName: 'writing-helper', kind: 'personal-skill', projectKey: PROJECT_KEY }]);
  });

  it('a personal skill present on this device never appears in needsSetup', () => {
    const record: ProjectExtensionsRecord = { ...emptyRecord(NOW), items: { 'self:writing-helper': { on: true, at: NOW } } };
    const view = buildProjectExtensionsView(baseViewInput({ skills: [personalSkill], record }));
    expect(view.needsSetup).toEqual([]);
  });

  it('a tool connection on in the project with missingSecrets shows kind "tool-connection"', () => {
    const record: ProjectExtensionsRecord = { ...emptyRecord(NOW), items: { 'mcp:library-search': { on: true, at: NOW } } };
    const needsSetupMcp: ViewMcpEntry = { id: 'library-search', origin: { kind: 'user' }, label: 'Library search', missingSecrets: ['TOKEN'] };
    const view = buildProjectExtensionsView(baseViewInput({ mcp: [needsSetupMcp], record }));
    // Present (missingSecrets) rows surface via the group/personal listing's
    // own needsLocalSetup flag, NOT a duplicate top-level needs-setup row —
    // resolveAvailability's rows only cover items the catalog actually has.
    expect(view.needsSetup).toEqual([]);
    expect(view.personal[0]).toMatchObject({ key: 'mcp:library-search', needsLocalSetup: true });
  });

  it('a tool connection on in the project and entirely absent shows kind "tool-connection"', () => {
    const record: ProjectExtensionsRecord = { ...emptyRecord(NOW), items: { 'mcp:library-search': { on: true, at: NOW } } };
    const view = buildProjectExtensionsView(baseViewInput({ mcp: [], record }));
    expect(view.needsSetup).toEqual([{ key: 'mcp:library-search', displayName: 'library-search', kind: 'tool-connection', projectKey: PROJECT_KEY }]);
  });
});

describe('applyProjectExtensionsChanges — set semantics', () => {
  function baseApplyInput(overrides: Partial<ApplyChangesInput> = {}): ApplyChangesInput {
    return { record: null, changes: [], now: NOW, itemPluginOf: new Map(), itemsForPlugin: new Map(), ...overrides };
  }

  it('rejects a change naming both plugin and item', () => {
    const result = applyProjectExtensionsChanges(baseApplyInput({ changes: [{ plugin: 'p', item: 'i', on: true }] }));
    expect(result).toEqual({ ok: false, error: 'invalid-change' });
  });

  it('rejects a change naming neither plugin nor item', () => {
    const result = applyProjectExtensionsChanges(baseApplyInput({ changes: [{ on: true }] }));
    expect(result).toEqual({ ok: false, error: 'invalid-change' });
  });

  it('first enable turns every current part on and sets partsChosen', () => {
    const result = applyProjectExtensionsChanges(baseApplyInput({
      changes: [{ plugin: 'research-kit', on: true }],
      itemsForPlugin: new Map([['research-kit', ['research-kit:find-sources', 'mcp:research-lib']]]),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.plugins['research-kit']).toEqual({ on: true, partsChosen: true, at: NOW });
    expect(result.record.items['research-kit:find-sources']).toEqual({ on: true, at: NOW });
    expect(result.record.items['mcp:research-lib']).toEqual({ on: true, at: NOW });
  });

  it('pausing (turning a plugin off) preserves existing item choices untouched', () => {
    const record: ProjectExtensionsRecord = {
      ...emptyRecord(NOW),
      plugins: { 'research-kit': { on: true, partsChosen: true, at: NOW } },
      items: { 'research-kit:find-sources': { on: true, at: NOW }, 'mcp:research-lib': { on: false, at: NOW } },
    };
    const result = applyProjectExtensionsChanges(baseApplyInput({ record, changes: [{ plugin: 'research-kit', on: false }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.plugins['research-kit']).toEqual({ on: false, partsChosen: true, at: NOW });
    // Untouched — same objects/values as before the pause.
    expect(result.record.items).toEqual(record.items);
  });

  it('re-enabling a plugin after first-enable (partsChosen already true) does not re-materialize parts the user turned off', () => {
    const record: ProjectExtensionsRecord = {
      ...emptyRecord(NOW),
      plugins: { 'research-kit': { on: false, partsChosen: true, at: NOW } },
      items: { 'research-kit:find-sources': { on: true, at: NOW }, 'mcp:research-lib': { on: false, at: NOW } },
    };
    const result = applyProjectExtensionsChanges(baseApplyInput({
      record, changes: [{ plugin: 'research-kit', on: true }],
      itemsForPlugin: new Map([['research-kit', ['research-kit:find-sources', 'mcp:research-lib']]]),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // mcp:research-lib stays OFF — partsChosen was already true, so this is
    // a plain re-enable, not a first enable.
    expect(result.record.items['mcp:research-lib']).toEqual({ on: false, at: NOW });
  });

  it('re-enabling clears an uninstall tombstone; pausing an already-removed entry keeps it', () => {
    const record: ProjectExtensionsRecord = { ...emptyRecord(NOW), plugins: { 'research-kit': { on: false, partsChosen: true, removed: true, at: NOW } } };
    const enabled = applyProjectExtensionsChanges(baseApplyInput({ record, changes: [{ plugin: 'research-kit', on: true }] }));
    expect(enabled.ok && enabled.record.plugins['research-kit'].removed).toBeUndefined();

    const pausedAgain = applyProjectExtensionsChanges(baseApplyInput({ record, changes: [{ plugin: 'research-kit', on: false }] }));
    expect(pausedAgain.ok && pausedAgain.record.plugins['research-kit'].removed).toBe(true);
  });

  it('toggling an individual part for the first time sets the owning plugin\'s partsChosen without resetting its on state', () => {
    const result = applyProjectExtensionsChanges(baseApplyInput({
      changes: [{ item: 'mcp:research-lib', on: false }],
      itemPluginOf: new Map([['mcp:research-lib', 'research-kit']]),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.items['mcp:research-lib']).toEqual({ on: false, at: NOW });
    expect(result.record.plugins['research-kit']).toEqual({ on: true, partsChosen: true, at: NOW });
  });

  it('toggling a part after partsChosen is already true leaves the plugin entry\'s own on/off untouched', () => {
    const record: ProjectExtensionsRecord = {
      ...emptyRecord(NOW),
      plugins: { 'research-kit': { on: true, partsChosen: true, at: NOW - 1 } },
    };
    const result = applyProjectExtensionsChanges(baseApplyInput({
      record, changes: [{ item: 'mcp:research-lib', on: false }], itemPluginOf: new Map([['mcp:research-lib', 'research-kit']]),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The plugin entry itself is NOT rewritten (same `at`) — only the item changed.
    expect(result.record.plugins['research-kit']).toEqual({ on: true, partsChosen: true, at: NOW - 1 });
  });

  it('an unscoped item (no owning plugin) never touches record.plugins', () => {
    const result = applyProjectExtensionsChanges(baseApplyInput({ changes: [{ item: 'self:writing-helper', on: true }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.plugins).toEqual({});
    expect(result.record.items['self:writing-helper']).toEqual({ on: true, at: NOW });
  });

  it('multiple changes in one batch compose in order — a later item override wins over an earlier first-enable', () => {
    const result = applyProjectExtensionsChanges(baseApplyInput({
      changes: [{ plugin: 'research-kit', on: true }, { item: 'mcp:research-lib', on: false }],
      itemsForPlugin: new Map([['research-kit', ['research-kit:find-sources', 'mcp:research-lib']]]),
      itemPluginOf: new Map([['mcp:research-lib', 'research-kit']]),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.items['research-kit:find-sources']).toEqual({ on: true, at: NOW });
    expect(result.record.items['mcp:research-lib']).toEqual({ on: false, at: NOW });
  });
});
