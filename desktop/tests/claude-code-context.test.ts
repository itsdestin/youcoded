// What a CLAUDE CODE chat is allowed to claim.
//
// The rule this file exists to hold: **say what we know, leave out what we
// don't, and never let the second look like the first.** Claude Code assembles
// its own instructions. YouCoded can name the files it reads and the skills it
// can reach, because both are on this machine and the app installed them — but
// its system prompt, its tool list and its own trimming are not ours to report.
//
// A tool list recited from memory would be the "never invent an error cause"
// failure applied to a capability list: confidently wrong, and wrong in the
// direction that makes someone trust a thing that cannot do what it says.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';

const scanSkills = vi.hoisted(() => vi.fn(() => [] as any[]));
const scanProjectSkills = vi.hoisted(() => vi.fn(() => [] as any[]));
vi.mock('../src/main/skill-scanner', () => ({ scanSkills, scanProjectSkills }));

import { buildClaudeCodeContext, readWholeContextFile } from '../src/main/claude-code-context';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-cc-ctx-'));
  fs.mkdirSync(path.join(dir, '.git'));
  scanSkills.mockReturnValue([]);
  scanProjectSkills.mockReturnValue([]);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); vi.clearAllMocks(); });

describe('what a Claude Code chat is allowed to claim', () => {
  it('never claims a system prompt, a tool list, or a context window', () => {
    const ctx = buildClaudeCodeContext(dir, 'claude-sonnet-4-6');
    expect(ctx.assembledBy).toBe('claude-code');
    expect(ctx.systemPrompt).toBeNull();
    expect(ctx.systemPromptSections).toBeNull();
    // null, NOT [] — an empty list reads as "this assistant has no tools", which
    // is a lie in the more alarming direction. The panel words null as
    // "Claude Code chooses its own".
    expect(ctx.tools).toBeNull();
    expect(ctx.contextWindowTokens).toBeNull();
  });

  it('names the instruction file Claude Code actually reads', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Rules');
    const ctx = buildClaudeCodeContext(dir, 'claude-sonnet-4-6');
    expect(ctx.projectInstructions?.path).toBe(path.join(dir, 'CLAUDE.md'));
    // False means "YouCoded did not shorten it" — the only thing we can know.
    expect(ctx.projectInstructions?.truncated).toBe(false);
  });

  it('reports nothing dropped, because nothing was dropped by us', () => {
    expect(buildClaudeCodeContext(dir, null).droppedMcpServers).toEqual([]);
    // Claude Code tells itself about its skills — that is what the registries
    // the app writes are for — so this is not a "not told" state.
    expect(buildClaudeCodeContext(dir, null).skillsOffered).toBe(true);
  });

  it('lists installed skills AND this project’s own', () => {
    scanSkills.mockReturnValue([{ id: 'a:one', displayName: 'one', description: 'first' }]);
    scanProjectSkills.mockReturnValue([{ id: 'proj', displayName: 'proj', description: 'local' }]);
    expect(buildClaudeCodeContext(dir, null).skills?.map((s) => s.id)).toEqual(['a:one', 'proj']);
  });

  it('reads a file whole, with both sides equal so no cut is implied', () => {
    const body = `# Rules\n${'x'.repeat(4000)}`;
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), body);
    const sessions = { getSession: () => ({ cwd: dir }) };
    const res: any = readWholeContextFile(sessions, 's1', 'project');
    expect(res.text).toBe(body);
    expect(res.full).toBe(body);
    expect(res.truncated).toBe(false);
  });

  it('refuses by name rather than inventing a file', () => {
    const sessions = { getSession: () => ({ cwd: dir }) };
    expect(readWholeContextFile(sessions, 's1', 'project')).toEqual({ error: 'not-found' });
    expect(readWholeContextFile({ getSession: () => undefined }, 's1', 'project')).toEqual({ error: 'not-live' });
    expect(readWholeContextFile(sessions, 's1', 'skill', 'no-such')).toEqual({ error: 'not-found' });
  });
});
