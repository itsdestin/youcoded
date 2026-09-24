// desktop/src/renderer/utils/skill-catalog-key.ts
//
// T5 (project-plugin-controls) — maps a renderer SkillEntry (SkillContext's
// `installed`, as CommandDrawer already renders it) to the catalog itemKey
// `project-extensions:for-session`'s `frozenSkillIds` carries, so a drawer
// chip can look up "is THIS skill in the frozen set" with a plain Set.has().
//
// WHY a thin wrapper: the rule lives in shared/project-extension-keys.ts,
// which main's resolve.ts also uses, so the two sides cannot drift.
import type { SkillEntry } from '../../shared/types';
import { skillItemKey } from '../../shared/project-extension-keys';

export function catalogKeyForSkill(skill: Pick<SkillEntry, 'id' | 'source'>): string {
  return skillItemKey(skill);
}
