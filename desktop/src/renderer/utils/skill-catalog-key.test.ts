// T5 (project-plugin-controls) — pins catalogKeyForSkill against
// main/project-extensions/resolve.ts's itemKeyForSkill, which it mirrors
// (see this file's own header for why it's a second copy, not an import).
// A drift between the two would silently mismatch every drawer chip: a
// frozen id the main process wrote would never match a renderer-computed
// key, so every installed skill would read "Manual use" regardless of its
// real frozen status.
import { describe, it, expect } from 'vitest';
import { catalogKeyForSkill } from './skill-catalog-key';

describe('catalogKeyForSkill', () => {
  it('namespaces a self-sourced skill as self:<id>', () => {
    expect(catalogKeyForSkill({ id: 'writing-helper', source: 'self' })).toBe('self:writing-helper');
  });

  it('namespaces a project-sourced skill as project:<id>', () => {
    expect(catalogKeyForSkill({ id: 'onboarding', source: 'project' })).toBe('project:onboarding');
  });

  it('leaves a plugin-sourced skill id untouched — skill-scanner already qualifies it plugin:skill', () => {
    expect(catalogKeyForSkill({ id: 'superpowers:brainstorming', source: 'plugin' })).toBe('superpowers:brainstorming');
  });

  it('leaves a marketplace-sourced skill id untouched', () => {
    expect(catalogKeyForSkill({ id: 'some-plugin:some-skill', source: 'marketplace' })).toBe('some-plugin:some-skill');
  });

  it('leaves a youcoded-core skill id untouched', () => {
    expect(catalogKeyForSkill({ id: 'theme-builder', source: 'youcoded-core' })).toBe('theme-builder');
  });
});
