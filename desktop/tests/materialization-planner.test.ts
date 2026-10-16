// desktop/tests/materialization-planner.test.ts
import { describe, it, expect } from 'vitest';
import { planReconcile, activeManagedSpaces } from '../src/main/sync-spaces/materialization-planner';
import { PROJECT_REGISTRY_SCHEMA, type ProjectRegistryEntry } from '../src/main/sync-spaces/project-registry';
import type { SyncSpace } from '../src/main/sync-spaces/types';

const E = (name: string, state: 'active' | 'stopped' = 'active'): ProjectRegistryEntry =>
  ({ schemaVersion: PROJECT_REGISTRY_SCHEMA, name, repoName: `r-${name}`, displayName: name, state, updatedAt: 1,
    // description fields are required on the entry type; the planner never reads them.
    description: null, descriptionUpdatedAt: 0 });
const projSpace = (name: string): SyncSpace => ({ id: `project:${name}`, kind: 'project', root: `/p/${name}` });
const personalSpace: SyncSpace = { id: 'personal', kind: 'personal', root: '/personal' };

describe('planReconcile', () => {
  it('materializes active registry projects missing locally', () => {
    const p = planReconcile([E('alpha'), E('beta')], ['alpha'], []);
    expect(p.toMaterialize.map(e => e.name)).toEqual(['beta']);
    expect(p.toStop).toEqual([]);
  });

  it('skips active projects already local', () => {
    expect(planReconcile([E('alpha')], ['alpha'], ['alpha']).toMaterialize).toEqual([]);
  });

  it('never materializes a stopped project', () => {
    expect(planReconcile([E('beta', 'stopped')], [], []).toMaterialize).toEqual([]);
  });

  it('stops a stopped project that currently has a live space', () => {
    const p = planReconcile([E('beta', 'stopped')], ['beta'], ['beta']);
    expect(p.toStop).toEqual(['beta']);
    expect(p.toMaterialize).toEqual([]);
  });

  it('does not stop a stopped project with no live space (already detached)', () => {
    expect(planReconcile([E('beta', 'stopped')], ['beta'], []).toStop).toEqual([]);
  });

  it('dedups duplicate registry names', () => {
    expect(planReconcile([E('beta'), E('beta')], [], []).toMaterialize.map(e => e.name)).toEqual(['beta']);
  });
});

describe('activeManagedSpaces', () => {
  it('drops stopped project spaces and always keeps personal', () => {
    const spaces = [personalSpace, projSpace('alpha'), projSpace('beta')];
    const out = activeManagedSpaces([E('alpha'), E('beta', 'stopped')], spaces);
    expect(out.map(s => s.id)).toEqual(['personal', 'project:alpha']);
  });

  it('keeps project spaces with no registry entry (not yet registered)', () => {
    const out = activeManagedSpaces([], [personalSpace, projSpace('alpha')]);
    expect(out.map(s => s.id)).toEqual(['personal', 'project:alpha']);
  });
});
