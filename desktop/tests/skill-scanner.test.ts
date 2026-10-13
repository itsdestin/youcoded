import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanProjectSkills, scanSkills } from '../src/main/skill-scanner';

describe('scanSkills', () => {
  let tmpHome: string;
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-skill-scan-'));
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
    // Seed as a generic marketplace plugin (non-youcoded-prefixed name so source
    // resolves to 'plugin', not the legacy 'youcoded-core' branch).
    const root = path.join(tmpHome, '.claude', 'plugins', 'test-plugin');
    write(path.join(root, 'plugin.json'), '{"name":"test-plugin"}');
    mkdir(path.join(root, 'skills', 'setup-wizard'));
    mkdir(path.join(root, 'skills', 'remote-setup'));

    const skills = scanSkills();
    const ids = skills.map((s: any) => s.id).sort();
    // Non-youcoded plugins get namespaced ids: <plugin>:<skill>
    expect(ids).toEqual(['test-plugin:remote-setup', 'test-plugin:setup-wizard']);
    expect(skills.every((s: any) => s.source === 'plugin')).toBe(true);
  });

  it('reads a plugin skill\'s real SKILL.md description instead of the generic fallback', () => {
    // Regression test: Pass 1/2 used to pass '' as fallbackDesc unconditionally,
    // so every plugin skill without a curated registry entry showed "Run the X
    // skill" in the drawer even though its SKILL.md has a real description.
    const root = path.join(tmpHome, '.claude', 'plugins', 'test-plugin');
    write(path.join(root, 'plugin.json'), '{"name":"test-plugin"}');
    write(path.join(root, 'skills', 'setup-wizard', 'SKILL.md'),
      '---\nname: setup-wizard\ndescription: Walks the user through first-run setup.\n---\n\nBody\n');

    const skill = scanSkills().find((s: any) => s.id === 'test-plugin:setup-wizard');
    expect(skill?.description).toBe('Walks the user through first-run setup.');
  });

  it('falls back to the generic description when a plugin skill has no SKILL.md', () => {
    const root = path.join(tmpHome, '.claude', 'plugins', 'test-plugin');
    write(path.join(root, 'plugin.json'), '{"name":"test-plugin"}');
    mkdir(path.join(root, 'skills', 'setup-wizard'));

    const skill = scanSkills().find((s: any) => s.id === 'test-plugin:setup-wizard');
    expect(skill?.description).toBe('Run the setup-wizard skill');
  });

  it('joins a YAML folded block-scalar description ("description: >") instead of capturing the ">"', () => {
    // Regression test: a naive single-line regex captures the block indicator
    // itself, not the text — worse than the fallback it was meant to replace.
    // youcoded-encyclopedia's real skills all use this form for long trigger text.
    const root = path.join(tmpHome, '.claude', 'plugins', 'test-plugin');
    write(path.join(root, 'plugin.json'), '{"name":"test-plugin"}');
    write(path.join(root, 'skills', 'encyclopedia-compile', 'SKILL.md'),
      '---\nname: encyclopedia-compile\ndescription: >\n  Compiles the user\'s Encyclopedia from eight\n  modular source files.\n---\n\nBody\n');

    const skill = scanSkills().find((s: any) => s.id === 'test-plugin:encyclopedia-compile');
    expect(skill?.description).toBe("Compiles the user's Encyclopedia from eight modular source files.");
  });

  it('discovers a project skill from its .claude/skills directory', () => {
    mkdir(path.join(tmpHome, '.claude', 'plugins'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-project-skill-'));
    try {
      write(path.join(project, '.claude', 'skills', 'wrap-up', 'SKILL.md'),
        '---\nname: Wrap up\ndescription: Improve this workspace\n---\n\nInstructions\n');

      expect(scanProjectSkills(project)).toContainEqual(expect.objectContaining({
        id: 'wrap-up', source: 'project', visibility: 'private',
        displayName: 'Wrap up', description: 'Improve this workspace',
        skillDir: path.join(project, '.claude', 'skills', 'wrap-up'),
      }));
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
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

});

// WHY: a SKILL.md that is a named pipe made the scan's synchronous read wait forever for a writer, freezing the whole main process
// (and every skill list, the computer's and a phone's). The scan must look at the file kind first and never open anything that is
// not a regular file. The read is stubbed so a regression fails fast instead of hanging the test run.
describe.skipIf(process.platform === 'win32')('skill scan with a named pipe saved as SKILL.md', () => {
  it('never opens it, still lists the skill by its folder name, and keeps reading the regular ones', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-skill-fifo-'));
    try {
      const pipeDir = path.join(cwd, '.claude', 'skills', 'piped');
      const okDir = path.join(cwd, '.claude', 'skills', 'fine');
      fs.mkdirSync(pipeDir, { recursive: true }); fs.mkdirSync(okDir, { recursive: true });
      expect(spawnSync('mkfifo', [path.join(pipeDir, 'SKILL.md')]).status).toBe(0);
      fs.writeFileSync(path.join(okDir, 'SKILL.md'), '---\nname: Fine One\ndescription: reads ok\n---\nbody\n');
      const real = fs.readFileSync;
      const touched: string[] = [];
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
        if (String(p).includes('piped')) { touched.push(String(p)); return '---\nname: x\n---\n'; } // would have blocked
        return (real as any)(p, ...rest);
      }) as any);
      try {
        const skills = scanProjectSkills(cwd);
        expect(touched).toEqual([]);
        expect(skills.map((x) => x.id).sort()).toEqual(['fine', 'piped']);
        expect(skills.find((x) => x.id === 'fine')!.description).toBe('reads ok');
        expect(skills.find((x) => x.id === 'piped')!.description).toBe('');
      } finally { spy.mockRestore(); }
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
