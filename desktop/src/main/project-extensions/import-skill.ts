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
//
// WHY the guards below (T3 review F1): on desktop this path is normally
// reached only via an OS file picker (the user's own access — see
// remote-server.ts's refusal of this same channel for why a REMOTE caller
// never legitimately reaches this function at all). But nothing here
// enforced that assumption in code, and every other remote-payload-path
// channel in this codebase (fs:read-head, artifacts:read-binary) realpaths
// the input and checks it against the same sensitive-path denylist before
// touching disk — so this function gets the identical treatment as
// defense-in-depth, not just a comment. `fs.cp`'s default `dereference:
// false` copies a symlink AS a symlink rather than its target's contents, so
// a symlinked SKILL.md/folder is refused outright rather than silently
// landing a live symlink under ~/.claude/skills/<name>/.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { isSensitivePath, isUnderRoot } from '../artifacts/read-binary-access';

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
  if (typeof skillMdPath !== 'string' || skillMdPath.length === 0 || !path.isAbsolute(skillMdPath)) {
    return { ok: false, error: 'no path' };
  }
  if (path.basename(skillMdPath) !== 'SKILL.md') {
    return { ok: false, error: `not a SKILL.md file: ${path.basename(skillMdPath)}` };
  }
  if (!(await exists(skillMdPath))) {
    return { ok: false, error: 'that file no longer exists' };
  }

  // Refuse a symlinked SKILL.md or a symlinked containing folder outright —
  // fs.cp below would copy the link itself, not its target, landing a live
  // symlink inside ~/.claude/skills/ that reads back through to wherever it
  // points (see the file header). lstat, not stat: stat would happily follow
  // the link and report the FILE it points to as a plain file.
  const sourceDir = path.dirname(skillMdPath);
  let mdStat: fs.Stats;
  let dirStat: fs.Stats;
  try {
    mdStat = await fs.promises.lstat(skillMdPath);
    dirStat = await fs.promises.lstat(sourceDir);
  } catch {
    return { ok: false, error: 'that file no longer exists' };
  }
  if (mdStat.isSymbolicLink() || dirStat.isSymbolicLink()) {
    return { ok: false, error: 'refusing a symlinked file or folder' };
  }

  // Same secret-location denylist as fs:read-head / artifacts:read-binary,
  // checked on BOTH the raw and the realpath-resolved form (an ancestor
  // directory earlier in the path can itself be a symlink into a sensitive
  // location even though the final component above just proved it isn't
  // one itself).
  let realSkillMd = skillMdPath;
  let realSourceDir = sourceDir;
  try { realSkillMd = await fs.promises.realpath(skillMdPath); } catch { /* decided by the sensitive check below */ }
  try { realSourceDir = await fs.promises.realpath(sourceDir); } catch { /* decided by the sensitive check below */ }
  if (
    isSensitivePath(canonicalize(realSkillMd, null)) || isSensitivePath(canonicalize(skillMdPath, null)) ||
    isSensitivePath(canonicalize(realSourceDir, null)) || isSensitivePath(canonicalize(sourceDir, null))
  ) {
    return { ok: false, error: 'not-allowed' };
  }

  const name = path.basename(sourceDir);
  const destDir = skillsDir();
  const destination = path.join(destDir, name);

  // Refuse when the source and destination nest inside each other in either
  // direction — a bogus "SKILL.md" picked from INSIDE ~/.claude/skills/ (or
  // a folder that itself contains ~/.claude/skills/) would otherwise recurse
  // into itself or clobber a sibling mid-copy.
  const canonSource = canonicalize(realSourceDir, null);
  const canonDestination = canonicalize(destination, null);
  if (isUnderRoot(canonDestination, canonSource) || isUnderRoot(canonSource, canonDestination)) {
    return { ok: false, error: 'source and destination overlap' };
  }

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
