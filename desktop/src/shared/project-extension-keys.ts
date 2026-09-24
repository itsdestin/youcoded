// The one rule that turns a skill into its project-extensions item key (design §1).
//
// WHY in shared/: the main process writes these keys into each project's
// settings and each conversation's frozen set, and the renderer's drawer looks
// them up again to colour its chips. Two copies of this rule (one per side)
// would drift silently — a changed prefix on one side would turn every chip
// amber with no error. Both sides import it from here instead.
//
// `self`/`project` skills have BARE ids from skill-scanner.ts (no plugin
// qualifier), so their scope is folded into the key to keep two same-named
// skills in different scopes apart. Plugin skill ids already carry their
// plugin qualifier and are used as-is.
export function skillItemKey(skill: { id: string; source?: string }): string {
  if (skill.source === 'self') return `self:${skill.id}`;
  if (skill.source === 'project') return `project:${skill.id}`;
  return skill.id;
}
