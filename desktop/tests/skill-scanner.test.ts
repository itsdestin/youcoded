import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanSkills } from '../src/main/skill-scanner';

describe('scanSkills', () => {
  let tmpHome: string;
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'destincode-skill-scan-'));
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome;
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  function mkdir(p: string) { fs.mkdirSync(p, { recursive: true }); }
  function write(p: string, content: string) { mkdir(path.dirname(p)); fs.writeFileSync(p, content); }

  it('returns empty list when ~/.claude/plugins/ and ~/.claude/skills/ are empty', () => {
    mkdir(path.join(tmpHome, '.claude', 'plugins'));
    expect(scanSkills()).toEqual([]);
  });

  it('does NOT inject curated-registry entries that aren\'t present on disk', () => {
    // This is the regression test for the "every curated skill shows Installed"
    // bug. Before the fix, scanSkills() appended every curated id unconditionally.
    mkdir(path.join(tmpHome, '.claude', 'plugins'));
    const ids = scanSkills().map((s: any) => s.id);
    expect(ids).not.toContain('encyclopedia');
    expect(ids).not.toContain('food');
    expect(ids).not.toContain('inbox');
  });

  it('discovers a plugin with a plugin.json and skills/ subdir', () => {
    const root = path.join(tmpHome, '.claude', 'plugins', 'destinclaude');
    write(path.join(root, 'plugin.json'), '{"name":"destinclaude"}');
    mkdir(path.join(root, 'skills', 'setup-wizard'));
    mkdir(path.join(root, 'skills', 'remote-setup'));

    const skills = scanSkills();
    const ids = skills.map((s: any) => s.id).sort();
    expect(ids).toEqual(['remote-setup', 'setup-wizard']);
    expect(skills.every((s: any) => s.source === 'destinclaude')).toBe(true);
  });

  it('tags user-authored skills under ~/.claude/skills/ with source:"self"', () => {
    mkdir(path.join(tmpHome, '.claude', 'plugins'));
    const userSkill = path.join(tmpHome, '.claude', 'skills', 'my-custom-skill');
    write(path.join(userSkill, 'SKILL.md'),
      '---\nname: My Custom Skill\ndescription: Does the thing\n---\n\nBody\n');

    const skills = scanSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      id: 'my-custom-skill',
      source: 'self',
      visibility: 'private',
      displayName: 'My Custom Skill',
      description: 'Does the thing',
    });
  });

  it('skips ~/.claude/skills/<name> when a destinclaude-* plugin ships the same skill (toolkit mirror)', () => {
    const plugin = path.join(tmpHome, '.claude', 'plugins', 'destinclaude-journaling');
    write(path.join(plugin, 'plugin.json'), '{"name":"destinclaude-journaling"}');
    mkdir(path.join(plugin, 'skills', 'journaling-assistant'));

    const mirror = path.join(tmpHome, '.claude', 'skills', 'journaling-assistant');
    write(path.join(mirror, 'SKILL.md'), '---\nname: Journaling\n---\n');

    const skills = scanSkills();
    // Plugin wins; mirror is NOT added again as a 'self' skill
    expect(skills.filter((s: any) => s.id === 'journaling-assistant')).toHaveLength(1);
    expect(skills.find((s: any) => s.id === 'journaling-assistant').source).toBe('destinclaude');
  });
});
