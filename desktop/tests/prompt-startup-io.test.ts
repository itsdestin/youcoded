import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assembleSystemPromptParts, findProjectInstructionsAsync } from '../src/main/harness/prompt-assembly';

const child = vi.hoisted(() => ({ execFileSync: vi.fn(() => Buffer.from('main')) }));
vi.mock('child_process', () => child);
afterEach(() => vi.clearAllMocks());

it('uses prepared instructions without opening a project file again', () => {
  const parts = assembleSystemPromptParts({ cwd: '/not-on-disk', presetBody: '', appVersion: 'test',
    projectInstructions: { path: '/not-on-disk/CLAUDE.md', name: 'CLAUDE.md', text: 'ALREADY_APPROVED_BYTES' } });
  expect(parts.find(part => part.id === 'project')?.text).toContain('ALREADY_APPROVED_BYTES');
});

it('finds required instructions asynchronously and delegates the one content read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-async-'));
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'must not read directly');
    const read = vi.fn(async () => 'approved contents');
    expect(await findProjectInstructionsAsync(dir, read)).toEqual({ path: path.join(dir, 'CLAUDE.md'), name: 'CLAUDE.md', text: 'approved contents' });
    expect(read).toHaveBeenCalledExactlyOnceWith(path.join(dir, 'CLAUDE.md'));
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
});

it('does not swallow a required instruction consent/read rejection as no instructions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-denied-'));
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'not implicitly readable');
    await expect(findProjectInstructionsAsync(dir, async () => { throw new Error('download-denied'); })).rejects.toThrow('download-denied');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
});

it('does not run automatic Git commands while assembling a conversation prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-no-git-'));
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    const parts = assembleSystemPromptParts({ cwd: dir, presetBody: '', appVersion: 'test' });
    expect(child.execFileSync).not.toHaveBeenCalled();
    expect(parts.find(part => part.id === 'env')?.text).toContain('Git: not checked automatically');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
