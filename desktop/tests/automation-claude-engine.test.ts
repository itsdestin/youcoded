// An automation's run on the person's own Claude Code: how it is started, and that the app answers every step.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { claudeEngine, claudeToolsFor, RUN_SETTINGS, type ClaudeProcess } from '../src/main/automations/claude-engine';
import type { EngineRun } from '../src/main/automations/automation-runner';
import type { StoredAutomation } from '../src/main/automations/automation-store';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'claude-engine-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

const job = (over: Partial<StoredAutomation> = {}): StoredAutomation => ({
  id: 'one', name: 'One', instruction: 'do it', links: [], start: { kind: 'button', label: 'Run' }, model: 'Haiku', subscription: true,
  runsOn: { runtime: 'claude', modelId: 'haiku' },
  tools: [
    { id: 'send', kind: 'command', label: 'Mail', source: 'Your computer', mode: 'ask', exact: 'mail -s hi sam' },
    { id: 'dl', kind: 'folder', label: 'See', source: 'Your computer', mode: 'allow', exact: path.join(tmpdir(), 'yc-claude-engine-folder') },
  ],
  whenAsk: 'wait', waitHours: 1, noAnswer: 'skip', late: 'run', overlap: 'skip-new',
  unlisted: { sites: 'never', commands: 'never' }, devices: [], notify: { needs: false, news: false, fails: false },
  enabled: true, ...over,
});

/** A stand-in for `claude`: the test feeds it lines to print and reads what the engine wrote to it. */
function fakeClaude() {
  const out = new EventEmitter(); const err = new EventEmitter(); const proc = new EventEmitter();
  const written: any[] = [];
  const seen: { args?: string[]; cwd?: string; ended: boolean; killed: boolean } = { ended: false, killed: false };
  const child = {
    stdin: { write: (t: string) => { written.push(JSON.parse(t)); }, end: () => { seen.ended = true; } },
    stdout: { on: (e: string, fn: (c: string) => void) => out.on(e, fn) },
    stderr: { on: (e: string, fn: (c: string) => void) => err.on(e, fn) },
    on: (e: string, fn: (...a: any[]) => void) => proc.on(e, fn),
    kill: () => { seen.killed = true; proc.emit('close', null); },
  } as unknown as ClaudeProcess;
  const spawnClaude = (args: string[], opts: { cwd: string }) => { seen.args = args; seen.cwd = opts.cwd; return child; };
  const print = (m: unknown) => out.emit('data', `${JSON.stringify(m)}\n`);
  return { spawnClaude, written, seen, print, close: (code = 0) => proc.emit('close', code), stderr: (t: string) => err.emit('data', t) };
}

const runOf = (j: StoredAutomation, over: Partial<EngineRun> = {}): EngineRun => ({
  runId: 'r1', job: j, instruction: j.instruction, current: () => j,
  ask: async () => ({ allow: true, note: '' }), spent: async () => true, ...over,
});
const engineWith = (f: ReturnType<typeof fakeClaude>) => claudeEngine({ dir: () => path.join(root, 'automations'), workDirFor: (id) => path.join(root, 'automations', 'work', id), spawnClaude: f.spawnClaude });
const started = (f: ReturnType<typeof fakeClaude>) => expect.poll(() => f.written.length).toBeGreaterThan(0);
const ask = (id: string, tool: string, input: Record<string, unknown>) => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input } });
const answerTo = (f: ReturnType<typeof fakeClaude>, id: string) => f.written.find((w) => w.type === 'control_response' && w.response.request_id === id)?.response.response;

describe('claude engine', () => {
  it('starts Claude Code restricted, with the settings that hand every step to the app, and saves no session', async () => {
    const f = fakeClaude();
    const handle = engineWith(f)(runOf(job()));
    await started(f);
    const a = f.seen.args!;
    for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence']) expect(a).toContain(flag);
    expect(a.slice(a.indexOf('--permission-prompts'), a.indexOf('--permission-prompts') + 4)).toEqual(['--permission-prompts', 'host', '--permission-prompt-tool', 'stdio']);
    expect(a[a.indexOf('--model') + 1]).toBe('haiku');
    expect(a[a.indexOf('--add-dir') + 1]).toBe(path.join(tmpdir(), 'yc-claude-engine-folder'));
    expect(a).not.toContain('--session-id');
    expect(readFileSync(a[a.indexOf('--settings') + 1], 'utf8')).toBe(RUN_SETTINGS);
    expect(JSON.parse(RUN_SETTINGS).hooks.PreToolUse[0]).toMatchObject({ matcher: '*' });
    expect(JSON.parse(RUN_SETTINGS).hooks.PreToolUse[0].hooks[0].command).toContain('"permissionDecision":"ask"');
    expect(readFileSync(a[a.indexOf('--append-system-prompt-file') + 1], 'utf8')).toContain('Run this command exactly as written: mail -s hi sam');
    expect(f.seen.cwd).toBe(path.join(root, 'automations', 'work', 'one'));
    expect(f.written[0]).toEqual({ type: 'user', message: { role: 'user', content: 'do it' } });
    f.print({ type: 'result', subtype: 'success', is_error: false, result: 'Summary: Sent it.\nTell them: no' });
    f.close();
    expect(await handle.done).toEqual({ summary: 'Sent it.', news: false });
    expect(f.seen.ended).toBe(true);
  });

  it("answers each step from the automation's own list: allowed, refused, or asked", async () => {
    const f = fakeClaude();
    const asked: unknown[] = [];
    const handle = engineWith(f)(runOf(job(), { ask: async (q) => { asked.push(q); return { allow: false, note: 'Save a draft instead' }; } }));
    await started(f);
    f.print(ask('q1', 'Read', { file_path: path.join(tmpdir(), 'yc-claude-engine-folder', 'a.txt') }));
    f.print(ask('q2', 'Bash', { command: 'echo hi' }));
    f.print(ask('q3', 'Bash', { command: 'mail -s hi sam' }));
    await expect.poll(() => answerTo(f, 'q3')).toBeTruthy();
    expect(answerTo(f, 'q1')).toMatchObject({ behavior: 'allow' });
    // Claude Code would have run `echo hi` unasked; here it is refused because nothing in the list covers it.
    expect(answerTo(f, 'q2')).toMatchObject({ behavior: 'deny' });
    expect(answerTo(f, 'q3')).toEqual({ behavior: 'deny', message: 'Save a draft instead' });
    expect(asked).toEqual([{ action: 'Run a command', detail: 'mail -s hi sam', toolId: 'send' }]);
    f.print({ type: 'result', subtype: 'success', is_error: false, result: 'Summary: Drafted.' });
    f.close();
    await handle.done;
  });

  it('counts tokens, never dollars', async () => {
    const f = fakeClaude();
    const spent: [number, number][] = [];
    const handle = engineWith(f)(runOf(job(), { spent: async (d, t) => { spent.push([d, t]); return true; } }));
    await started(f);
    f.print({ type: 'assistant', message: { usage: { input_tokens: 4, output_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 9000 } } });
    f.print({ type: 'result', subtype: 'success', is_error: false, result: 'Summary: ok' });
    f.close();
    await handle.done;
    expect(spent).toEqual([[0, 2104]]);
  });

  it("fails with what Claude Code said, and never invents a reason", async () => {
    const a = fakeClaude();
    const ha = engineWith(a)(runOf(job()));
    await started(a);
    a.print({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Usage limit reached.' });
    a.close(1);
    await expect(ha.done).rejects.toThrow('Usage limit reached.');

    const b = fakeClaude();
    const hb = engineWith(b)(runOf(job()));
    await started(b);
    b.stderr("error: unknown option '--restricted'\n");
    b.close(1);
    await expect(hb.done).rejects.toThrow("unknown option '--restricted'");

    const c = fakeClaude();
    const hc = engineWith(c)(runOf(job()));
    await started(c);
    c.close(3);
    await expect(hc.done).rejects.toThrow('Claude Code stopped before finishing (code 3).');
  });

  it('stopping the run ends the program', async () => {
    const f = fakeClaude();
    const handle = engineWith(f)(runOf(job()));
    await started(f);
    handle.stop();
    expect(f.seen.killed).toBe(true);
    await expect(handle.done).rejects.toThrow();
  });

  it('gives a run only the tools its permissions could ever use', () => {
    expect(claudeToolsFor(job({ tools: [] }))).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite']);
    expect(claudeToolsFor(job())).toContain('Bash');
    expect(claudeToolsFor(job({ tools: [], unlisted: { sites: 'ask', commands: 'never' } }))).toContain('WebFetch');
  });
});
