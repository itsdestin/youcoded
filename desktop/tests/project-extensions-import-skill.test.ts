import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { importSkillFolder } from '../src/main/project-extensions/import-skill';

// Same per-test homedir-mocking convention as skill-scanner.test.ts — fully
// isolated from both the developer's real ~/.claude and the suite-wide HOME
// sandbox, and cleaned up unconditionally (maxRetries per test-suite-hygiene.md).
describe('importSkillFolder', () => {
  let tmpHome: string;
  let sourceRoot: string;
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-import-skill-home-'));
    sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-import-skill-source-'));
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome;
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(sourceRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  function writeSourceSkill(name: string, extraFiles: Record<string, string> = {}): string {
    const dir = path.join(sourceRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const skillMdPath = path.join(dir, 'SKILL.md');
    fs.writeFileSync(skillMdPath, `---\nname: ${name}\ndescription: a test skill\n---\nDo the ${name} thing.`);
    for (const [rel, content] of Object.entries(extraFiles)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return skillMdPath;
  }

  it('copies the whole containing folder into ~/.claude/skills/<name>/', async () => {
    const skillMdPath = writeSourceSkill('writing-helper', { 'reference/style.md': 'style notes' });
    const result = await importSkillFolder(skillMdPath);
    expect(result).toMatchObject({ ok: true, name: 'writing-helper' });
    if (!result.ok) return;
    expect(fs.readFileSync(path.join(result.destination, 'SKILL.md'), 'utf8')).toContain('writing-helper');
    expect(fs.readFileSync(path.join(result.destination, 'reference', 'style.md'), 'utf8')).toBe('style notes');
    // Landed exactly where scanSkills() looks for a 'self'-sourced skill.
    expect(result.destination).toBe(path.join(tmpHome, '.claude', 'skills', 'writing-helper'));
  });

  it('refuses a file not named SKILL.md, with a typed error', async () => {
    const dir = path.join(sourceRoot, 'not-a-skill');
    fs.mkdirSync(dir, { recursive: true });
    const otherPath = path.join(dir, 'notes.md');
    fs.writeFileSync(otherPath, 'not a skill file');
    const result = await importSkillFolder(otherPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('not a SKILL.md file');
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'skills'))).toBe(false);
  });

  it('refuses to overwrite an existing folder of the same name', async () => {
    const skillMdPath = writeSourceSkill('writing-helper');
    const destDir = path.join(tmpHome, '.claude', 'skills', 'writing-helper');
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'SKILL.md'), 'already here');
    const result = await importSkillFolder(skillMdPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('already installed');
    // The existing folder is untouched, not merged/overwritten.
    expect(fs.readFileSync(path.join(destDir, 'SKILL.md'), 'utf8')).toBe('already here');
  });

  it('reports the source file vanishing rather than throwing', async () => {
    const skillMdPath = writeSourceSkill('ghost');
    fs.rmSync(path.dirname(skillMdPath), { recursive: true, force: true });
    const result = await importSkillFolder(skillMdPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('no longer exists');
  });

  // T3 review F1 — a remote client is refused before ever reaching this
  // function (remote-server.ts), but this function still hardens itself the
  // same way fs:read-head / artifacts:read-binary do: realpath + symlink
  // refusal + the shared sensitive-path denylist + a source/destination
  // overlap check.
  it('refuses a symlinked containing folder', async () => {
    const realDir = path.join(sourceRoot, 'real-writing-helper');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'SKILL.md'), '---\nname: writing-helper\n---\nBody.');
    const linkDir = path.join(sourceRoot, 'writing-helper');
    fs.symlinkSync(realDir, linkDir, 'dir');

    const result = await importSkillFolder(path.join(linkDir, 'SKILL.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('symlinked');
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'skills'))).toBe(false);
  });

  it('refuses a SKILL.md that is itself a symlink', async () => {
    const dir = path.join(sourceRoot, 'linked-md');
    fs.mkdirSync(dir, { recursive: true });
    const realFile = path.join(sourceRoot, 'real-SKILL.md');
    fs.writeFileSync(realFile, '---\nname: linked-md\n---\nBody.');
    const linkedSkillMd = path.join(dir, 'SKILL.md');
    fs.symlinkSync(realFile, linkedSkillMd, 'file');

    const result = await importSkillFolder(linkedSkillMd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('symlinked');
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'skills'))).toBe(false);
  });

  it('refuses a source folder inside a sensitive location (the fs:read-head/artifacts:read-binary denylist)', async () => {
    // '.ssh' is a SENSITIVE_SEGMENTS entry (editable-path-policy.ts) — reused
    // here, not redefined, per the finding's "find and reuse it" instruction.
    const dir = path.join(sourceRoot, '.ssh', 'planted-skill');
    fs.mkdirSync(dir, { recursive: true });
    const skillMdPath = path.join(dir, 'SKILL.md');
    fs.writeFileSync(skillMdPath, '---\nname: planted-skill\n---\nBody.');

    const result = await importSkillFolder(skillMdPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('not-allowed');
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'skills'))).toBe(false);
  });

  it('refuses when the source folder itself contains the destination (picking a SKILL.md from inside ~/.claude/skills/)', async () => {
    const skillsRoot = path.join(tmpHome, '.claude', 'skills');
    fs.mkdirSync(skillsRoot, { recursive: true });
    const skillMdPath = path.join(skillsRoot, 'SKILL.md');
    fs.writeFileSync(skillMdPath, '---\nname: skills\n---\nBody.');

    const result = await importSkillFolder(skillMdPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('overlap');
  });

  it('refuses when the computed destination would land inside the source folder', async () => {
    // sourceDir = ~/.claude/skills/loop/sub/loop -> name "loop" ->
    // destination = ~/.claude/skills/loop, which is an ANCESTOR of sourceDir
    // (the reverse direction of the check above).
    const sourceDir = path.join(tmpHome, '.claude', 'skills', 'loop', 'sub', 'loop');
    fs.mkdirSync(sourceDir, { recursive: true });
    const skillMdPath = path.join(sourceDir, 'SKILL.md');
    fs.writeFileSync(skillMdPath, '---\nname: loop\n---\nBody.');

    const result = await importSkillFolder(skillMdPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('overlap');
  });
});
