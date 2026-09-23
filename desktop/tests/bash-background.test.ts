// G-1 background Bash — the Bash tool's half: foreground family kill (Task 2),
// run_in_background (Task 3), hand-off at the time limit (Task 4).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BashTool } from '../src/main/harness/tools/bash';
import { ShellRegistry, MAX_EXPLICIT_RUNNING } from '../src/main/harness/shell-registry';
import type { ToolContext } from '../src/main/harness/tools/types';

// Per-process. Background shell logs land in
// `os.tmpdir()/youcoded-harness-bash-output/<sessionId>/bash-<ms>-<shellId>.txt`
// — a fixed path outside the vitest HOME sandbox, and `shellId` restarts at 1 in
// every process, so two concurrent runs could mint the SAME filename within one
// millisecond and write over each other. Same class as the shared spill dir
// fixed in harness-tools-core.test.ts (2026-08-28).
const TEST_SESSION_ID = `bg-test-${process.pid}`;


const posix = process.platform !== 'win32';
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  return new Promise((res, rej) => {
    const tick = () => { if (cond()) return res(); if (Date.now() - start > ms) return rej(new Error('waitFor timed out')); setTimeout(tick, 25); };
    tick();
  });
}

let dir: string;
let reg: ShellRegistry;
function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: TEST_SESSION_ID, cwd: dir, signal: new AbortController().signal, readRegistry: new Map(), todos: [], toolCallId: 'toolu_bg', shells: reg, ...over } as ToolContext;
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-bg-')); reg = new ShellRegistry(TEST_SESSION_ID); });
afterEach(async () => { await reg.killAll('app-quit', { graceMs: 0 }); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

describe.skipIf(!posix)('Luna shell routing', () => {
  it('refuses an opt-in shell when the wrapper or root is missing', async () => {
    const old = process.env.YOUCODED_LUNA_EXPERIMENT;
    const script = process.env.LUNA_SHELL_JAIL_SCRIPT;
    process.env.YOUCODED_LUNA_EXPERIMENT = '1';
    delete process.env.LUNA_SHELL_JAIL_SCRIPT;
    try {
      const result = await BashTool.execute({ command: 'echo UNSAFE' }, ctx());
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain('UNSAFE');
    } finally {
      if (old === undefined) delete process.env.YOUCODED_LUNA_EXPERIMENT; else process.env.YOUCODED_LUNA_EXPERIMENT = old;
      if (script === undefined) delete process.env.LUNA_SHELL_JAIL_SCRIPT; else process.env.LUNA_SHELL_JAIL_SCRIPT = script;
    }
  });

  it('routes foreground and background through a private wrapper without changing tool metadata', async () => {
    const wrapper = path.join(dir, 'synthetic-wrapper.cjs');
    fs.writeFileSync(wrapper, `process.stdout.write('JAILED_ROUTE\\n')`);
    const before = { name: BashTool.name, description: BashTool.description };
    const previous = { opt: process.env.YOUCODED_LUNA_EXPERIMENT, script: process.env.LUNA_SHELL_JAIL_SCRIPT, root: process.env.LUNA_FIXTURE_ROOT };
    process.env.YOUCODED_LUNA_EXPERIMENT = '1';
    process.env.LUNA_SHELL_JAIL_SCRIPT = wrapper;
    process.env.LUNA_FIXTURE_ROOT = dir;
    try {
      const foreground = await BashTool.execute({ command: 'echo MUST_NOT_RUN' }, ctx());
      expect(foreground.text).toContain('JAILED_ROUTE');
      expect(foreground.text).not.toContain('MUST_NOT_RUN');
      const background = await BashTool.execute({ command: 'echo MUST_NOT_RUN', run_in_background: true }, ctx());
      expect(background.isError).toBeFalsy();
      await reg.list()[0].exited;
      expect(reg.list()[0].tail.join('')).toContain('JAILED_ROUTE');
      expect({ name: BashTool.name, description: BashTool.description }).toEqual(before);
    } finally {
      for (const [key, value] of Object.entries({ YOUCODED_LUNA_EXPERIMENT: previous.opt, LUNA_SHELL_JAIL_SCRIPT: previous.script, LUNA_FIXTURE_ROOT: previous.root })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

describe.skipIf(!posix)('foreground interrupt kills the grandchild and still resolves immediately', () => {
  it('sleep 30 & wait — abort resolves at once, the grandchild is gone within the grace period', async () => {
    const ac = new AbortController();
    const pidFile = path.join(dir, 'pid');
    const promise = BashTool.execute({ command: `sleep 30 & echo $! > "${pidFile}"; wait` }, ctx({ signal: ac.signal, shells: undefined }));
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(alive(pid)).toBe(true);
    const t0 = Date.now();
    ac.abort();
    const r = await promise;
    expect(Date.now() - t0).toBeLessThan(1_000);   // resolves NOW, never waits for 'close'
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Canceled: the user interrupted this operation/);
    await waitFor(() => !alive(pid), 4_000);
    expect(alive(pid)).toBe(false);
  }, 15_000);
});

describe.skipIf(!posix)('run_in_background', () => {
  it('returns at once with the started-in-background text and a running registry entry; the tool result is not an error', async () => {
    const t0 = Date.now();
    const r = await BashTool.execute({ command: 'sleep 3', run_in_background: true }, ctx());
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/^Started in the background \(shell id sh-[0-9a-f]{4}\)\. You'll be told when it finishes\. BashOutput reads new output \(or lists runs\); KillShell stops it\. Running now: 1 of 5\.$/);
    const run = reg.list()[0];
    expect(run.status).toBe('running');
    expect(run.toolUseId).toBe('toolu_bg');
    expect(run.explicit).toBe(true);
  });

  it('a background start never changes the working directory or the env', async () => {
    let tracked: string | undefined;
    let env: unknown;
    fs.mkdirSync(path.join(dir, 'sub'));
    await BashTool.execute({ command: 'cd sub; export FOO=1', run_in_background: true }, ctx({ setShellCwd: (n) => { tracked = n; }, setShellEnv: (e) => { env = e; } }));
    await reg.list()[0].exited;
    expect(tracked).toBeUndefined();
    expect(env).toBeUndefined();
  });

  it('stdin is closed: a command that waits for input fails fast instead of hanging', async () => {
    await BashTool.execute({ command: 'read line; echo "got=$line"; exit 7', run_in_background: true }, ctx());
    const run = reg.list()[0];
    await Promise.race([run.exited, new Promise((_, rej) => setTimeout(() => rej(new Error('hung on stdin')), 3_000))]);
    expect(run.exitCode).toBe(7);
  });

  it('persistent_env + run_in_background is refused in one sentence', async () => {
    const r = await BashTool.execute({ command: 'echo x', run_in_background: true, persistent_env: true }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Bash rejected: persistent_env cannot be combined with run_in_background — a background command never reports its environment back. Drop one of the two.');
    expect(reg.list()).toHaveLength(0);
  });

  it('with no registry in the context, run_in_background is refused (never silently foregrounded)', async () => {
    const r = await BashTool.execute({ command: 'echo x', run_in_background: true }, ctx({ shells: undefined }));
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Bash rejected: background execution is not available in this session.');
  });

  it('the 6th explicit start is refused naming the running ids', async () => {
    for (let i = 0; i < MAX_EXPLICIT_RUNNING; i++) await BashTool.execute({ command: 'sleep 5', run_in_background: true }, ctx());
    const ids = reg.runningExplicitIds();
    const r = await BashTool.execute({ command: 'sleep 5', run_in_background: true }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toBe(`5 background commands are already running (${ids.join(', ')}). Stop one with KillShell before starting another.`);
  });
});

describe.skipIf(!posix)('hand-off at the time limit', () => {
  it('a foreground command at its limit is adopted — no SIGKILL, no exit 124, text names the id', async () => {
    const r: any = await BashTool.execute({ command: 'echo early; node -e "setTimeout(()=>{}, 4000)"', timeout: 400 }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.timedOut).toBe(false);
    expect(r.text).toMatch(/^Still running after \d+s — handed off to the background \(shell id sh-[0-9a-f]{4}\)\. You'll be told when it finishes\./);
    expect(r.text).not.toMatch(/exit 124|SIGKILL|force-killed/);
    expect(r.text).toContain('early');                       // output so far, under the usual bounds
    const run = reg.list()[0];
    expect(run.status).toBe('running');
    expect(run.detached).toBe(true);
    expect(run.explicit).toBe(false);
    expect(r.handedOffTo).toBe(run.shellId);
    expect(r.text).toContain(`log: ${run.logPath}`);
    expect(alive(run.child.pid!)).toBe(true);                // the SAME process, never restarted
    await reg.kill(run.shellId, 'assistant');
  });

  it('a leading `sleep` is never handed off — it times out and reports as today', async () => {
    const r: any = await BashTool.execute({ command: 'sleep 5', timeout: 300 }, ctx());
    expect(r.isError).toBe(true);
    expect(r.timedOut).toBe(true);
    expect(r.text).toContain('· exit 124]');
    expect(reg.list()).toHaveLength(0);
  }, 10_000);

  it('a handed-off run applies neither cwd nor persistent_env; the env temp file is removed; the sentinel is filtered on read', async () => {
    let tracked: string | undefined;
    let env: unknown;
    fs.mkdirSync(path.join(dir, 'sub'));
    const r = await BashTool.execute(
      { command: 'cd sub && export FOO=bar && sleep 1', timeout: 200, persistent_env: true },
      ctx({ setShellCwd: (n) => { tracked = n; }, setShellEnv: (e) => { env = e; } }),
    );
    expect(r.text).toMatch(/handed off to the background/);
    const run = reg.list()[0];
    await run.exited;
    // `exited` means the PROCESS ended; onExit assigns run.logDone and resolves
    // `exited` without waiting for it, so a RAW file read races the final
    // flush. reg.read() awaits that internally — a direct readFileSync does
    // not. Linux always won this race; macOS CI did not (2026-08-28).
    await run.logDone;
    expect(run.exitCode).toBe(0);
    expect(tracked).toBeUndefined();
    expect(env).toBeUndefined();
    const raw = fs.readFileSync(run.logPath, 'utf8');
    expect(raw).toContain('__YC_CWD__');
    const envFile = /__YC_ENVFILE__(.+)/.exec(raw)![1].trim();
    expect(fs.existsSync(envFile)).toBe(false);
    const read = await reg.read(run.shellId);
    expect(read!.text).not.toContain('__YC_');
    expect(reg.tailText(run, 50)).not.toContain('__YC_');
  });

  it('hand-off at the cap still succeeds (D5)', async () => {
    for (let i = 0; i < MAX_EXPLICIT_RUNNING; i++) await BashTool.execute({ command: 'sleep 5', run_in_background: true }, ctx());
    const r = await BashTool.execute({ command: 'node -e "setTimeout(()=>{}, 4000)"', timeout: 200 }, ctx());
    expect(r.text).toMatch(/handed off to the background/);
    expect(reg.list()).toHaveLength(MAX_EXPLICIT_RUNNING + 1);
  });

  it('with no registry in the context the old kill still applies', async () => {
    const r: any = await BashTool.execute({ command: 'node -e "setTimeout(()=>{}, 4000)"', timeout: 200 }, ctx({ shells: undefined }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('· exit 124]');
  });
});
