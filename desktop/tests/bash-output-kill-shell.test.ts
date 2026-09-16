// G-1 companions: BashOutput (new output since the last look / list mode) and
// KillShell. Registry-backed with real bash where a process is needed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BashOutputTool, BASH_OUTPUT_MAX_LINES } from '../src/main/harness/tools/bash-output';
import { KillShellTool } from '../src/main/harness/tools/kill-shell';
import { ShellRegistry } from '../src/main/harness/shell-registry';
import type { ToolContext } from '../src/main/harness/tools/types';

// Per-process. Background shell logs land in
// `os.tmpdir()/youcoded-harness-bash-output/<sessionId>/bash-<ms>-<shellId>.txt`
// — a fixed path outside the vitest HOME sandbox, and `shellId` restarts at 1 in
// every process, so two concurrent runs could mint the SAME filename within one
// millisecond and write over each other. Same class as the shared spill dir
// fixed in harness-tools-core.test.ts (2026-08-28).
const TEST_SESSION_ID = `bo-test-${process.pid}`;


const posix = process.platform !== 'win32';
const BASH = { shellCmd: '/bin/bash', shellArgs: ['-c'] };
let dir: string;
let reg: ShellRegistry;
function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: TEST_SESSION_ID, cwd: dir, signal: new AbortController().signal, readRegistry: new Map(), todos: [], shells: reg, ...over } as ToolContext;
}
function start(command: string, toolUseId = 'tu') {
  const r = reg.start({ toolUseId, command, cwd: dir, ...BASH, env: { ...process.env, NO_COLOR: '1' } });
  if (!r.ok) throw new Error('start failed');
  return r.run;
}
function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  return new Promise((res, rej) => { const tick = () => { if (cond()) return res(); if (Date.now() - t0 > ms) return rej(new Error('waitFor')); setTimeout(tick, 25); }; tick(); });
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-')); reg = new ShellRegistry(TEST_SESSION_ID); });
afterEach(async () => { await reg.killAll('app-quit', { graceMs: 0 }); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

describe('schemas', () => {
  it('BashOutput: shell_id optional, strict; KillShell: shell_id required, strict; neither ever asks', () => {
    expect(BashOutputTool.inputSchema.safeParse({}).success).toBe(true);
    expect(BashOutputTool.inputSchema.safeParse({ shell_id: 'sh-1', extra: 1 }).success).toBe(false);
    expect(KillShellTool.inputSchema.safeParse({}).success).toBe(false);
    expect(KillShellTool.inputSchema.safeParse({ shell_id: 'sh-1' }).success).toBe(true);
    expect(BashOutputTool.permissionSubject?.({ shell_id: 'sh-1' })).toBeUndefined();
    expect(KillShellTool.permissionSubject?.({ shell_id: 'sh-1' })).toBeUndefined();
    expect(BashOutputTool.shortDescription).toBeTruthy();
    expect(KillShellTool.shortDescription).toBeTruthy();
  });
  it('without a registry: list mode says none, id mode says unknown', async () => {
    const r = await BashOutputTool.execute({}, ctx({ shells: undefined }));
    expect(r.text).toBe('No background commands in this conversation.');
    const k = await KillShellTool.execute({ shell_id: 'sh-1' }, ctx({ shells: undefined }));
    expect(k.isError).toBe(true);
    expect(k.text).toBe('No background command sh-1. Running: none.');
  });
});

describe.skipIf(!posix)('BashOutput', () => {
  it('id mode: header + new output since the last look; then the "nothing new" sentence', async () => {
    const run = start('echo one; sleep 0.5; echo two');
    await waitFor(() => reg.tailText(run, 5).includes('one'));
    const a = await BashOutputTool.execute({ shell_id: run.shellId }, ctx());
    expect(a.text).toMatch(new RegExp(`^${run.shellId} · running · \\d+s\\none$`));
    const b = await BashOutputTool.execute({ shell_id: run.shellId }, ctx());
    expect(b.text).toMatch(new RegExp(`^No new output from ${run.shellId} since your last look \\(still running · \\d+s\\)\\. You'll be told when it finishes — do NOT poll for it\\.$`));
    await run.exited;
    const c = await BashOutputTool.execute({ shell_id: run.shellId }, ctx());
    expect(c.text).toMatch(new RegExp(`^${run.shellId} · exited 0 · \\d+s\\ntwo$`));
    const d = await BashOutputTool.execute({ shell_id: run.shellId }, ctx());
    expect(d.text).toMatch(new RegExp(`^No new output from ${run.shellId} since your last look \\(exited 0 · \\d+s\\)\\.$`));
  });
  it('id mode is bounded in lines, and the moreHint names the log path', async () => {
    const run = start('seq 1 500');
    await run.exited;
    const r = await BashOutputTool.execute({ shell_id: run.shellId }, ctx());
    expect(r.bounds).toEqual({ shown: BASH_OUTPUT_MAX_LINES, total: 500, unit: 'lines', moreHint: `the earlier lines are in the log: ${run.logPath}` });
    // header + 200 lines is the TOOL's own body; defineTool renders one more
    // line from `bounds` (composeNotice) — the tool never writes that prose.
    const lines = r.text.split('\n');
    expect(lines[0]).toMatch(/^sh-[0-9a-f]{4} · exited 0 · \d+s$/);
    expect(lines.slice(1, BASH_OUTPUT_MAX_LINES + 1)).toEqual(Array.from({ length: BASH_OUTPUT_MAX_LINES }, (_, i) => String(301 + i)));
    expect(lines[BASH_OUTPUT_MAX_LINES + 1]).toContain(run.logPath);
    expect(lines).toHaveLength(BASH_OUTPUT_MAX_LINES + 2);
  });
  it('list mode: one line per run with state, elapsed, first 60 chars of the command', async () => {
    const a = start('sleep 5', 'a');
    const b = start(`echo ${'x'.repeat(80)}`, 'b');
    await b.exited;
    const r = await BashOutputTool.execute({}, ctx());
    const lines = r.text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(new RegExp(`^${a.shellId} · running · \\d+s · sleep 5$`));
    // 60-char budget: 55 kept + the ellipsis. 'echo ' eats 5 of the 55.
    expect(lines[1]).toMatch(new RegExp(`^${b.shellId} · exited 0 · \\d+s · echo ${'x'.repeat(50)}…$`));
  });
  it('unknown id names the running ids', async () => {
    const a = start('sleep 5', 'a');
    const r = await BashOutputTool.execute({ shell_id: 'sh-zzzz' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toBe(`No background command sh-zzzz. Running: ${a.shellId}.`);
  });
});

describe.skipIf(!posix)('KillShell', () => {
  it('stops the family, waits for the exit, returns the §4.3 sentence + last lines + log path', async () => {
    const run = start('echo starting; sleep 30 & wait');
    await waitFor(() => reg.tailText(run, 5).includes('starting'));
    const r = await KillShellTool.execute({ shell_id: run.shellId }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(new RegExp(`^Stopped ${run.shellId} after \\d+s \\(was: echo starting; sleep 30 & wait\\)\\. Last lines:\\n`));
    expect(r.text).toContain('\nstarting\n');
    expect(r.text.endsWith(`Full log: ${run.logPath}`)).toBe(true);
    expect(run.status).toBe('stopped');
    expect(run.stopReason).toBe('assistant');
  });
  it('an already-ended run gets its current state in one sentence, never a fake "stopped"', async () => {
    const run = start('exit 4');
    await run.exited;
    const r = await KillShellTool.execute({ shell_id: run.shellId }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(new RegExp(`^${run.shellId} is not running — exited 4 · \\d+s\\.$`));
  });
});
