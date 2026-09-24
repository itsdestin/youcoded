// desktop/src/main/project-extensions/import-skill.ts
//
// project-extensions:import-skill (T3, design §5 "Choose skill file"): a
// needs-setup "personal skill missing" row's second action. A personal skill
// is a FOLDER (its SKILL.md plus whatever else it needs), so picking the
// SKILL.md the user already has somewhere on this device (synced some other
// way — cloud drive, USB, a git checkout; personal-skill FILE SYNC is
// explicitly out of scope for this feature, design "Scope") copies the WHOLE
// containing folder into ~/.claude/skills/<name>/, exactly where scanSkills()
// already looks for a 'self'-sourced skill.
//
// All I/O is async (performance rule 1) — fs.promises throughout, including
// the recursive copy.
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface ImportSkillResult {
  ok: true;
  /** The imported skill's folder name — also the suffix of its new
   *  `self:<name>` item key (resolve.ts's itemKeyForSkill), so the caller can
   *  mark it on for the project immediately without a second lookup. */
  name: string;
  destination: string;
}

export interface ImportSkillFailure {
  ok: false;
  error: string;
}

function skillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

async function exists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

/**
 * Copy `skillMdPath`'s containing folder into ~/.claude/skills/<folder-name>/.
 * Refuses to overwrite an existing folder there — a typed error, never a
 * silent merge of two directory trees. `skillMdPath` must be named exactly
 * `SKILL.md`: the file picker's own contract (design §5).
 */
export async function importSkillFolder(skillMdPath: string): Promise<ImportSkillResult | ImportSkillFailure> {
  if (path.basename(skillMdPath) !== 'SKILL.md') {
    return { ok: false, error: `not a SKILL.md file: ${path.basename(skillMdPath)}` };
  }
  if (!(await exists(skillMdPath))) {
    return { ok: false, error: 'that file no longer exists' };
  }
  const sourceDir = path.dirname(skillMdPath);
  const name = path.basename(sourceDir);
  const destDir = skillsDir();
  const destination = path.join(destDir, name);
  if (await exists(destination)) {
    // Never invent a merge — a same-named skill is already installed here
    // (possibly this exact one, already imported on an earlier attempt).
    return { ok: false, error: `a skill named "${name}" is already installed on this device` };
  }
  try {
    await fs.promises.mkdir(destDir, { recursive: true });
    await fs.promises.cp(sourceDir, destination, { recursive: true });
  } catch (err: any) {
    // A partial copy is worse than none — it would pass the "already-exists"
    // refusal on retry and hide the real failure. Best-effort cleanup; the
    // ORIGINAL error is still what's reported (never guess a nicer cause).
    await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: err?.message || String(err) };
  }
  return { ok: true, name, destination };
}
