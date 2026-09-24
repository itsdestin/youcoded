// R19 (project-plugin-controls grading pass, 2026-09-24): the workbench's
// project-extensions fixture is what every ui-review capture plan and manual
// workbench check renders against. A live probe caught inboxGroup() (the
// fixture folded into every project once the workbench's "Inbox" demo plugin
// is installed) hardcoding on: true/paused: false, contradicting the
// product's own rule that a freshly installed plugin starts INACTIVE in
// every project — no grandfathering, not even for the one demo plugin this
// fixture uses to exercise the post-install flow. This pins both fixture
// helpers that feed a project's "installed" list to the same starting state.
import { describe, it, expect } from 'vitest';
import { inboxGroup, installedPluginGroup } from '../src/renderer/dev/workbench/fixtures/project-extensions';

describe('project-extensions workbench fixture: a new install starts inactive everywhere (R19)', () => {
  it('inboxGroup starts off/paused, with every part also off — same as any other fresh install', () => {
    const group = inboxGroup();
    expect(group.on).toBe(false);
    expect(group.paused).toBe(true);
    expect(group.parts.length).toBeGreaterThan(0);
    for (const part of group.parts) expect(part.on).toBe(false);
  });

  it('installedPluginGroup (the generic session-install case) starts off/paused too', () => {
    const group = installedPluginGroup({
      id: 'remember', displayName: 'Remember', components: { skills: ['remember'] },
    });
    expect(group.on).toBe(false);
    expect(group.paused).toBe(true);
    for (const part of group.parts) expect(part.on).toBe(false);
  });
});
