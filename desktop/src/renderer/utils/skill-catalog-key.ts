// desktop/src/renderer/utils/skill-catalog-key.ts
//
// T5 (project-plugin-controls) — maps a renderer SkillEntry (SkillContext's
// `installed`, as CommandDrawer already renders it) to the catalog itemKey
// `project-extensions:for-session`'s `frozenSkillIds` carries, so a drawer
// chip can look up "is THIS skill in the frozen set" with a plain Set.has().
//
// WHY duplicated rather than imported: the real rule is
// desktop/src/main/project-extensions/resolve.ts's `itemKeyForSkill` — main-
// process code the renderer cannot import (Node/browser boundary,
// react-renderer.md). shared/ (reachable from both) intentionally holds no
// project-extensions logic (see shared/types.ts's own header comment on that
// module), so both sides re-state this exact three-line rule. Any drift is
// caught by this file's own pinning test below plus resolve.test.ts on the
// main side — not by a shared import, because there isn't one to share.
import type { SkillEntry } from '../../shared/types';

export function catalogKeyForSkill(skill: Pick<SkillEntry, 'id' | 'source'>): string {
  if (skill.source === 'self') return `self:${skill.id}`;
  if (skill.source === 'project') return `project:${skill.id}`;
  return skill.id;
}
