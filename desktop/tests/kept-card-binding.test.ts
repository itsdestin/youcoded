// A kept permission card may answer the menu on screen only if that menu's own
// prompt shows THIS call. Real layouts come from Claude Code 2.1.281 captures
// (tests/fixtures/plan-menu/cc-2.1.281-prompt-*.json, app-screen-*); the cases
// marked ASSUMED rest on layouts that could not be triggered on 2.1.281.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { keptCardButtons } from '../src/renderer/parser/kept-card-binding';
import { FixtureTerminal, loadPlanFixture, PLAN_FIXTURE_DIR } from './helpers/plan-menu-fixtures';

const open: FixtureTerminal[] = [];
afterEach(() => { while (open.length) open.pop()!.dispose(); });

async function captured(file: string): Promise<{ screen: string; cwd: string }> {
  const fx = loadPlanFixture(file);
  const t = new FixtureTerminal(fx);
  open.push(t);
  await t.advanceToMark('menu-settled');
  const screen = t.screen();
  // The probe's project folder, as the capture printed it in the banner.
  const cwd = /(\/tmp\/plan-menu-[^\s]+\/project)/.exec(screen)?.[1]
    ?? /(\/tmp\/plan-menu-[^\s]+\/project)/.exec(Buffer.concat(fx.chunks.map((c) => Buffer.from(c.b64, 'base64'))).toString())![1];
  return { screen, cwd };
}
const digits = (b: ReturnType<typeof keptCardButtons>) => b?.map((x) => x.input) ?? null;

describe('Write — real 2.1.281 prompts', () => {
  const APP = fs.readFileSync(path.join(PLAN_FIXTURE_DIR, 'app-screen-cc-2.1.281-write-permission-80col.txt'), 'utf8');
  const CWD = '/tmp/plan-e2e/a1';

  it('binds to the full path, as Claude Code prints it relative to the session folder', () => {
    expect(digits(keptCardButtons(APP, 'Write', { file_path: '/tmp/plan-e2e/a1/hello.txt' }, CWD))).toEqual(['1', '2', '3']);
  });

  it('a same-named file anywhere else is a different call', () => {
    expect(keptCardButtons(APP, 'Write', { file_path: '/x/hello.txt' }, CWD)).toBeNull();
    expect(keptCardButtons(APP, 'Write', { file_path: '/tmp/plan-e2e/a1/sub/hello.txt' }, CWD)).toBeNull();
    expect(keptCardButtons(APP, 'Write', { file_path: '/tmp/plan-e2e/a1/hello.txt' }, '/elsewhere')).toBeNull();
  });

  it('another tool touching the same file is a different call', () => {
    expect(keptCardButtons(APP, 'Edit', { file_path: '/tmp/plan-e2e/a1/hello.txt' }, CWD)).toBeNull();
    expect(keptCardButtons(APP, 'Bash', { command: 'touch hello.txt' }, CWD)).toBeNull();
  });

  it('overwriting an existing file ("Overwrite file", nested path) binds too', async () => {
    const { screen, cwd } = await captured('cc-2.1.281-prompt-write-overwrite-120x40.json');
    expect(digits(keptCardButtons(screen, 'Write', { file_path: `${cwd}/docs/sub/notes.txt`, content: 'bye' }, cwd))).toEqual(['1', '2', '3']);
    expect(keptCardButtons(screen, 'Write', { file_path: `${cwd}/notes.txt`, content: 'bye' }, cwd)).toBeNull();
  });
});

describe('Edit — real 2.1.281 prompt', () => {
  it('binds to the full nested path', async () => {
    const { screen, cwd } = await captured('cc-2.1.281-prompt-edit-120x40.json');
    expect(digits(keptCardButtons(screen, 'Edit', { file_path: `${cwd}/docs/sub/notes.txt`, old_string: 'hi', new_string: 'bye' }, cwd))).toEqual(['1', '2', '3']);
    expect(keptCardButtons(screen, 'Edit', { file_path: `${cwd}/docs/other/notes.txt` }, cwd)).toBeNull();
    expect(keptCardButtons(screen, 'Write', { file_path: `${cwd}/docs/sub/notes.txt` }, cwd)).toBeNull();
  });
});

describe('Bash — real 2.1.281 prompt for a command that wraps over ten lines', () => {
  const cmd = 'touch ' + Array.from({ length: 30 }, (_, i) => `seg${String(i + 1).padStart(2, '0')}-alpha-beta-gamma-delta.txt`).join(' ');

  it('binds to the WHOLE command, read past the old 15-line window', async () => {
    const { screen, cwd } = await captured('cc-2.1.281-prompt-bash-long-120x40.json');
    expect(digits(keptCardButtons(screen, 'Bash', { command: cmd, description: 'Run shell command' }, cwd))).toEqual(['1', '2', '3']);
  });

  it('a command that is only a prefix (or only the first line) of the one shown is a different call', async () => {
    const { screen, cwd } = await captured('cc-2.1.281-prompt-bash-long-120x40.json');
    expect(keptCardButtons(screen, 'Bash', { command: 'touch seg01-alpha-beta-gamma-delta.txt' }, cwd)).toBeNull();
    expect(keptCardButtons(screen, 'Bash', { command: cmd.replace('seg30', 'seg31') }, cwd)).toBeNull();
  });
});

describe('Bash — a command wrapping over 20 lines (the real 2.1.281 layout, made longer)', () => {
  it('still binds: the whole prompt box is read, not just 15 lines above the options', () => {
    const parts = Array.from({ length: 60 }, (_, i) => `part${String(i + 1).padStart(2, '0')}-alpha-beta-gamma-delta.txt`);
    const cmd = 'touch ' + parts.join(' ');
    const wrapped: string[] = [];
    for (let i = 0; i < parts.length; i += 3) wrapped.push('   │ ' + (i === 0 ? 'touch ' : '') + parts.slice(i, i + 3).join(' '));
    const screen = [
      '────────────────────────────────────────────────────────', ' Bash command', ...wrapped,
      '   Run shell command', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No',
    ].join('\n');
    expect(wrapped.length).toBe(20);
    expect(digits(keptCardButtons(screen, 'Bash', { command: cmd }))).toEqual(['1', '2']);
  });
});

describe('MCP — real 2.1.281 prompt ("notes — Save Note Tool: (MCP)")', () => {
  it('binds to server, tool and arguments', async () => {
    const { screen, cwd } = await captured('cc-2.1.281-prompt-mcp-120x40.json');
    expect(digits(keptCardButtons(screen, 'mcp__notes__save_note', { text: 'hello' }, cwd))).toEqual(['1', '2', '3']);
  });

  it('another argument, tool or server is a different call', async () => {
    const { screen, cwd } = await captured('cc-2.1.281-prompt-mcp-120x40.json');
    expect(keptCardButtons(screen, 'mcp__notes__save_note', { text: 'goodbye' }, cwd)).toBeNull();
    expect(keptCardButtons(screen, 'mcp__notes__delete_note', { text: 'hello' }, cwd)).toBeNull();
    expect(keptCardButtons(screen, 'mcp__other__save_note', { text: 'hello' }, cwd)).toBeNull();
  });
});

describe('other tools — ASSUMED layout (name in any case + each short argument)', () => {
  // Not triggerable on 2.1.281: Grep and Glob are not separate tools there, and
  // a personal Skill ran without a prompt.
  const box = (name: string, arg: string) => [
    '────────────────────────────────────────', ` ${name}`, `   ${arg}`, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No',
  ].join('\n');

  it('matches the tool name case-insensitively', () => {
    expect(digits(keptCardButtons(box('Grep', 'pattern: "root"'), 'Grep', { pattern: 'root' }))).toEqual(['1', '2']);
    expect(digits(keptCardButtons(box('skill', 'greet-probe'), 'Skill', { skill: 'greet-probe' }))).toEqual(['1', '2']);
  });

  it('a different argument is a different call', () => {
    expect(keptCardButtons(box('Grep', 'pattern: "root"'), 'Grep', { pattern: 'admin' })).toBeNull();
    expect(keptCardButtons(box('Glob', '*.conf'), 'Grep', { pattern: '*.conf' })).toBeNull();
  });
});
