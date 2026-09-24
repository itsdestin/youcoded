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
});
