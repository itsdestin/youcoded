import { expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanProjectSkillsAsync } from '../src/main/skill-scanner';

it('discovers project skill names without bypassing a skipped passive body read', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-passive-'));
  try {
    const dir = path.join(root, '.claude', 'skills', 'cloud-skill');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\ndescription: must not leak\n---\nbody');
    const read = vi.fn(async () => null);
    const skills = await scanProjectSkillsAsync(root, read);
    expect(skills).toMatchObject([{ id: 'cloud-skill', description: '' }]);
    expect(read).toHaveBeenCalledExactlyOnceWith(path.join(dir, 'SKILL.md'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('keeps metadata from an approved locally available body', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-local-'));
  try {
    const dir = path.join(root, '.claude', 'skills', 'local');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'on disk');
    const skills = await scanProjectSkillsAsync(root, async () => '---\nname: Local name\ndescription: Local description\n---\nbody');
    expect(skills).toMatchObject([{ displayName: 'Local name', description: 'Local description' }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
