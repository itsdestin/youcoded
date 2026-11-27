// The iPhone's built-in command line, desktop half: the hooks desktop code gained for it (shell-registry's in-app spawner,
// the Bash tool's iPhone behaviour, the tool list, the prompt) and the adapter that makes a worker thread look like a
// started program. WHY these run here: they need none of the shell's own packages (just-bash, just-git live only in
// ios/runtime). The shell itself is judged against the built bundle by ios/runtime/shell/conformance-run.mjs and, inside the
// real app, by the simulator job.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { createInAppSpawner } from '../../ios/runtime/shell/adapter';
import { explainMissingCommands, STUB_NAMES } from '../../ios/runtime/shell/stubs';
import { gitIndexProblem, GIT_INDEX_REFUSAL } from '../../ios/runtime/shell/git-guard';
import { denyCredentialFiles } from '../../ios/runtime/shell/deny-fs';
import { BashTool, getShell, resetShellCache, IPHONE_SHELL_PARAGRAPH } from '../src/main/harness/tools/bash';
import { deviceTools, CORE_TOOLS } from '../src/main/harness/tools';
import { spawnDetached, killTree, setInAppSpawner, ShellRegistry } from '../src/main/harness/shell-registry';
import { assembleSystemPrompt } from '../src/main/harness/prompt-assembly';
import type { ToolContext } from '../src/main/harness/tools/types';

let dir: string;
let workerFile: string;
const savedOs = process.env.YOUCODED_HOST_OS;

// A stand-in for the real worker (which needs just-bash): answers like a tiny shell. `echo X` prints X; `cd D` moves the
// reported folder; `while true` never answers; `crash` ends the thread without an answer; the cwd probe the Bash tool adds
// is echoed back so the tool can read the folder; the tokens it was handed are printed by `tokens`.
const STUB_WORKER = `
const { parentPort, workerData } = require('worker_threads');
const s = workerData.script;
const probe = /printf '\\\\n([^%]+)%s\\\\n'/.exec(s);
if (/while true/.test(s)) { setInterval(() => {}, 1000); }
else if (/^crash/m.test(s)) { process.exit(3); }
else {
  const echoed = [...s.matchAll(/^echo (.*)$/gm)].map((m) => m[1] + '\\n').join('');
  const cd = /^cd (\\S+)/m.exec(s);
  const cwd = cd ? workerData.cwd + '/' + cd[1] : workerData.cwd;
  const tok = /^tokens/m.test(s) ? JSON.stringify(workerData.tokens) + '\\n' : '';
  parentPort.postMessage({ stdout: echoed + tok + (probe ? '\\n' + probe[1] + cwd + '\\n' : ''), stderr: /^warn/m.test(s) ? 'careful\\n' : '', exitCode: /^fail/m.test(s) ? 7 : 0 });
}`;

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: `ios-shell-${process.pid}`, cwd: dir, signal: new AbortController().signal, readRegistry: new Map(), todos: [], toolCallId: 'toolu_ios', ...over } as ToolContext;
}
function spawner(over: Partial<Parameters<typeof createInAppSpawner>[0]> = {}) {
  return createInAppSpawner({ workerPath: workerFile, home: () => dir, tmp: () => os.tmpdir(), ...over });
}
function collect(child: ChildProcess) {
  const seen = { out: '', err: '', events: [] as string[], codes: [] as unknown[] };
  child.stdout!.on('data', (d) => { seen.out += d; });
  child.stderr!.on('data', (d) => { seen.err += d; });
  child.on('exit', (c, sig) => { seen.events.push('exit'); seen.codes.push([c, sig]); });
  child.on('close', () => seen.events.push('close'));
  return { seen, closed: new Promise<void>((r) => child.on('close', () => r())) };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-shell-'));
  workerFile = path.join(dir, 'stub-worker.cjs');
  fs.writeFileSync(workerFile, STUB_WORKER);
  process.env.YOUCODED_HOST_OS = 'ios';
  resetShellCache();
});
afterEach(() => {
  setInAppSpawner(null);
  if (savedOs === undefined) delete process.env.YOUCODED_HOST_OS; else process.env.YOUCODED_HOST_OS = savedOs;
  resetShellCache();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

describe('the fake program the adapter returns', () => {
  it('delivers output, then "exit", then "close", with no process id and no signal', async () => {
    const child = spawner()('echo hi\nwarn\nfail', { cwd: dir });
    const { seen, closed } = collect(child);
    expect(child.pid).toBeUndefined();
    expect(child.exitCode).toBeNull();
    await closed;
    expect(seen.out).toBe('hi\n');
    expect(seen.err).toBe('careful\n');
    expect(seen.events).toEqual(['exit', 'close']);
    expect(seen.codes).toEqual([[7, null]]);
    expect(child.exitCode).toBe(7);
    expect(child.signalCode).toBeNull();
  });

  it('kill() with no process id ends it at once, once, as a signal', async () => {
    const child = spawner()('while true; do :; done', { cwd: dir });
    const { seen, closed } = collect(child);
    await new Promise((r) => setTimeout(r, 150)); // let the worker start
    expect(child.kill()).toBe(true);
    child.kill(); // a second kill changes nothing
    await closed;
    expect(seen.events).toEqual(['exit', 'close']);
    expect(seen.codes).toEqual([[null, 'SIGTERM']]);
    expect(child.signalCode).toBe('SIGTERM');
  });

  it('a Stop that arrives before the worker was even started starts none', async () => {
    let asked = 0;
    const child = spawner({ getTokens: async () => { asked++; await new Promise((r) => setTimeout(r, 50)); return {}; } })('echo never', { cwd: dir });
    const { seen, closed } = collect(child);
    child.kill();
    await closed;
    await new Promise((r) => setTimeout(r, 120));
    expect(asked).toBe(1);
    expect(seen.out).toBe('');
    expect(seen.codes).toEqual([[null, 'SIGTERM']]);
  });

  it('a thread that ends without answering is reported without guessing why', async () => {
    const child = spawner()('crash', { cwd: dir });
    const { seen, closed } = collect(child);
    await closed;
    expect(seen.codes).toEqual([[1, null]]);
    expect(seen.err).toBe('the command stopped without finishing.\n');
  });

  it('hands the worker the saved sign-ins, and nothing from the backend environment', async () => {
    process.env.YC_TEST_BACKEND_SECRET = 'must-not-travel';
    try {
      const child = spawner({ getTokens: async () => ({ 'github.com': 'tok_abc' }) })('tokens', { cwd: dir, env: { ...process.env, ANOTHER: 'x' } });
      const { seen, closed } = collect(child);
      await closed;
      expect(JSON.parse(seen.out)).toEqual({ 'github.com': 'tok_abc' });
      expect(seen.out).not.toContain('must-not-travel');
    } finally {
      delete process.env.YC_TEST_BACKEND_SECRET;
    }
  });

  it('a failing sign-in lookup means "none", not a failed command', async () => {
    const child = spawner({ getTokens: async () => { throw new Error('boom'); } })('echo ok', { cwd: dir });
    const { seen, closed } = collect(child);
    await closed;
    expect(seen.out).toBe('ok\n');
  });
});

describe('the shell registry hooks', () => {
  it('on a device that cannot run programs, spawnDetached uses the plugged-in spawner with the command text', async () => {
    setInAppSpawner(spawner());
    const child = spawnDetached('built-in', ['-c', 'echo via-hook'], { cwd: dir });
    const { seen, closed } = collect(child);
    await closed;
    expect(seen.out).toBe('via-hook\n');
  });

  it('with nothing plugged in it says so instead of starting a real program', () => {
    expect(() => spawnDetached('built-in', ['-c', 'echo x'], { cwd: dir })).toThrow('no way to run commands');
  });

  it('killTree on a handle with no pid calls its kill(); elsewhere a missing pid is left alone', async () => {
    const child = spawner()('while true; do :; done', { cwd: dir });
    const { closed } = collect(child);
    killTree(child, { graceMs: 0 });
    await closed;
    expect(child.signalCode).toBe('SIGTERM');
    delete process.env.YOUCODED_HOST_OS; // a computer
    let killed = false;
    killTree({ pid: undefined, kill: () => { killed = true; return true; } } as unknown as ChildProcess);
    expect(killed).toBe(false);
  });
});

describe('the Bash tool on an iPhone', () => {
  it('is a built-in bash, and offered together with BashOutput and KillShell', () => {
    expect(getShell()).toEqual({ cmd: 'built-in', args: ['-c'], label: 'bash (built-in)' });
    expect(deviceTools()).toBe(CORE_TOOLS);
    expect(deviceTools().map((t) => t.name)).toEqual(expect.arrayContaining(['Bash', 'BashOutput', 'KillShell']));
  });

  it('runs a command, strips the folder probe, and carries the working folder to the next call', async () => {
    setInAppSpawner(spawner());
    let tracked: string | undefined;
    const c = ctx({ setShellCwd: (p: string) => { tracked = p; } } as Partial<ToolContext>);
    fs.mkdirSync(path.join(dir, 'sub'));
    const r = await BashTool.execute({ command: 'echo hello\ncd sub' }, c);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('hello');
    expect(r.text).not.toContain('__yc'); // the probe's marker never reaches the model
    expect(tracked && fs.realpathSync(tracked)).toBe(fs.realpathSync(path.join(dir, 'sub')));
  });

  it('shows the standard-error text and the exit status', async () => {
    setInAppSpawner(spawner());
    const r = await BashTool.execute({ command: 'warn\nfail' }, ctx());
    expect(r.text).toContain('careful');
    expect(r.text).toMatch(/exit[ =:]*7/i);
  });

  it('refuses persistent_env with a sentence, before running anything', async () => {
    let started = 0;
    setInAppSpawner((cmd, o) => { started++; return spawner()(cmd, o); });
    const r = await BashTool.execute({ command: 'echo x', persistent_env: true }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toContain('persistent_env is not available on this iPhone');
    expect(started).toBe(0);
  });

  it('runs in the background and reports back through the registry (BashOutput / KillShell path)', async () => {
    setInAppSpawner(spawner());
    const reg = new ShellRegistry(`ios-bg-${process.pid}`);
    try {
      const r = await BashTool.execute({ command: 'echo from-background', run_in_background: true }, ctx({ shells: reg }));
      expect(r.text).toContain('Started in the background');
      await reg.list()[0].exited;
      expect(reg.list()[0].tail.join('')).toContain('from-background');
      const endless = await BashTool.execute({ command: 'while true; do :; done', run_in_background: true }, ctx({ shells: reg }));
      expect(endless.isError).toBeFalsy();
      const run = reg.list()[1];
      await new Promise((res) => setTimeout(res, 150));
      await reg.kill(run.shellId, 'user', { graceMs: 0 });
      await run.exited;
      expect(run.status).not.toBe('running');
    } finally {
      await reg.killAll('app-quit', { graceMs: 0 });
    }
  });

  it('a Stop (abort) ends a command that would never finish', async () => {
    setInAppSpawner(spawner());
    const ac = new AbortController();
    const p = BashTool.execute({ command: 'while true; do :; done' }, ctx({ signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    ac.abort();
    await p;
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('the description tells the model what this shell is and is not, and does not offer persistent_env or sudo', () => {
    const d = BashTool.description as string;
    expect(d).toContain('bash (built-in)');
    expect(d).toContain(IPHONE_SHELL_PARAGRAPH);
    expect(d).not.toContain('`sudo` works');
    expect(d).not.toContain('use `sudo` instead');
    expect(d).not.toContain('pass `persistent_env: true`');
    expect(IPHONE_SHELL_PARAGRAPH).toMatch(/no Python, Node/);
    expect(IPHONE_SHELL_PARAGRAPH).toMatch(/Grep tool/);
    expect(IPHONE_SHELL_PARAGRAPH.split(/\s+/).length).toBeLessThan(130);
  });

  it('on a computer the description is unchanged by all this', () => {
    delete process.env.YOUCODED_HOST_OS;
    resetShellCache();
    const d = BashTool.description as string;
    expect(d).not.toContain('built-in');
    expect(d).toContain('persistent_env: true');
  });
});

describe('what the model is told about the device', () => {
  const base = { presetBody: 'PRESET', cwd: os.tmpdir(), appVersion: '1.0.0' };

  it('names the iPhone (not "linux"), says the shell is built in, and drops the git line that cannot be true', () => {
    const out = assembleSystemPrompt(base);
    expect(out).toContain('Platform: iPhone (iOS)');
    expect(out).not.toMatch(/Platform: linux/);
    expect(out).toContain('The Bash tool is a built-in shell');
    expect(out).toContain('Grep tool');
    expect(out).not.toContain('cannot run shell commands');
    expect(out).not.toContain('Git: not a repository');
    expect(out).not.toContain('Git branch:');
  });

  it('is exactly as before on a computer', () => {
    delete process.env.YOUCODED_HOST_OS;
    const out = assembleSystemPrompt({ ...base, gitSnapshot: 'Git branch: x (clean)' });
    expect(out).toContain(`Platform: ${process.platform} (${process.arch})`);
    expect(out).toContain('Git branch: x (clean)');
    expect(out).not.toContain('built-in shell');
  });
});

describe('the pieces of the shell that need no packages', () => {
  it('the missing-program sentences replace both of just-bash\'s wordings, and only for programs in the table', () => {
    const e = explainMissingCommands("bash: python3: command not available in browser environments. Exclude 'python3' from your commands or use the Node.js bundle.\nbash: npm: command not found\nbash: nonesuch: command not found\n");
    expect(e).toContain('python3 is not available on this iPhone');
    expect(e).not.toContain('Node.js bundle');
    expect(e).toContain('npm is not available on this iPhone');
    expect(e).toContain('bash: nonesuch: command not found');
    for (const n of ['python', 'node', 'sqlite3', 'sudo', 'npm', 'pip', 'make']) expect(STUB_NAMES).toContain(n);
    // None of them may also be a real command (a stub is never registered, so `which` stays honest).
    for (const n of ['ls', 'cat', 'grep', 'git', 'curl', 'tar', 'jq']) expect(STUB_NAMES).not.toContain(n);
  });

  describe('the git index guard', () => {
    const header = (v: number) => { const b = new Uint8Array(12); b.set([0x44, 0x49, 0x52, 0x43]); new DataView(b.buffer).setUint32(4, v); return b; };
    const files = (map: Record<string, Uint8Array | string[]>) => ({
      resolvePath: (base: string, p: string) => path.posix.resolve(base, p),
      exists: async (p: string) => p in map,
      readFileBuffer: async (p: string) => map[p] as Uint8Array,
      readdir: async (p: string) => (map[p] as string[]) ?? [],
    });

    it('lets a plain version-2 repository through', async () => {
      const fs2 = files({ '/r/.git/index': header(2), '/r/.git': ['index', 'HEAD'] });
      expect(await gitIndexProblem(fs2, '/r', ['status'])).toBeNull();
      expect(await gitIndexProblem(fs2, '/r/sub/deeper', ['log'])).toBeNull();
    });
    it('refuses a version other than 2, and a split index', async () => {
      expect(await gitIndexProblem(files({ '/r/.git/index': header(4), '/r/.git': ['index'] }), '/r', ['status'])).toBe(GIT_INDEX_REFUSAL);
      expect(await gitIndexProblem(files({ '/r/.git/index': header(2), '/r/.git': ['index', 'sharedindex.abc'] }), '/r', ['status'])).toBe(GIT_INDEX_REFUSAL);
    });
    it('looks where `git -C` points, including a second -C relative to the first', async () => {
      const fs2 = files({ '/r/bad/.git/index': header(3), '/r/bad/.git': ['index'] });
      expect(await gitIndexProblem(fs2, '/elsewhere', ['-C', '/r/bad', 'log'])).toBe(GIT_INDEX_REFUSAL);
      expect(await gitIndexProblem(fs2, '/elsewhere', ['-C', '/r', '-C', 'bad', 'log'])).toBe(GIT_INDEX_REFUSAL);
      expect(await gitIndexProblem(fs2, '/elsewhere', ['log'])).toBeNull();
    });
  });

  describe('the credential layer', () => {
    // A tiny in-memory stand-in for the shell's file system (just-bash's own cannot be imported here).
    function memfs(initial: Record<string, string>) {
      const data = new Map(Object.entries(initial));
      const isDir = (p: string) => [...data.keys()].some((k) => k.startsWith(p + '/'));
      return {
        data,
        realpath: async (p: string) => p,
        exists: async (p: string) => data.has(p) || isDir(p),
        stat: async (p: string) => ({ isDirectory: isDir(p) && !data.has(p), isFile: data.has(p) }),
        readFile: async (p: string) => { if (!data.has(p)) throw new Error('ENOENT'); return data.get(p)!; },
        writeFile: async (p: string, c: string) => { data.set(p, c); },
        mkdir: async () => {},
        readdir: async (p: string) => [...new Set([...data.keys()].filter((k) => k.startsWith(p + '/')).map((k) => k.slice(p.length + 1).split('/')[0]))],
        cp: async (a: string, b: string, _opts?: unknown) => { for (const [k, v] of [...data]) if (k === a || k.startsWith(a + '/')) data.set(b + k.slice(a.length), v); },
      };
    }
    const home = '/var/mobile/Documents';

    it('hides credential files from listings and refuses to read, write or copy them', async () => {
      const inner = memfs({ [`${home}/.claude.json`]: 'KEY', [`${home}/.git-credentials`]: 'KEY', [`${home}/notes.txt`]: 'ok', [`${home}/p/.netrc`]: 'KEY', [`${home}/p/a.txt`]: 'a' });
      const f = denyCredentialFiles(inner, [home, '/private' + home]);
      expect(await f.readdir(home)).toEqual(['notes.txt', 'p']);
      expect(await f.readdir(`${home}/p`)).toEqual(['a.txt']);
      expect(await f.readFile(`${home}/notes.txt`)).toBe('ok');
      await expect(f.readFile(`${home}/.claude.json`)).rejects.toThrow(/ENOENT/);
      await expect(f.readFile(`${home}/p/.netrc`)).rejects.toThrow(/ENOENT/);
      await expect(f.writeFile(`${home}/.git-credentials`, 'x')).rejects.toThrow(/ENOENT/);
      await expect(f.cp(`${home}/.claude.json`, `${home}/copy`)).rejects.toThrow(/ENOENT/);
      expect(await f.exists(`${home}/.claude.json`)).toBe(false);
      expect(await f.exists(`${home}/notes.txt`)).toBe(true);
    });

    it('a folder copy leaves the hidden files behind', async () => {
      const inner = memfs({ [`${home}/p/.netrc`]: 'KEY', [`${home}/p/a.txt`]: 'a' });
      const f = denyCredentialFiles(inner, [home]);
      await f.cp(`${home}/p`, `${home}/q`, { recursive: true });
      expect([...inner.data.keys()].filter((k) => k.startsWith(`${home}/q`))).toEqual([`${home}/q/a.txt`]);
    });

    it('follows a link: a harmless name that leads to a credential file is refused too', async () => {
      const inner = memfs({ [`${home}/.claude.json`]: 'KEY' });
      inner.realpath = async (p: string) => (p === `${home}/alias` ? `${home}/.claude.json` : p);
      inner.data.set(`${home}/alias`, 'KEY');
      const f = denyCredentialFiles(inner, [home]);
      await expect(f.readFile(`${home}/alias`)).rejects.toThrow(/ENOENT/);
    });

    it('the same file under the other spelling of the folder (/var vs /private/var) is just as hidden', async () => {
      const inner = memfs({ [`/private${home}/.claude.json`]: 'KEY' });
      const f = denyCredentialFiles(inner, [home, `/private${home}`]);
      await expect(f.readFile(`/private${home}/.claude.json`)).rejects.toThrow(/ENOENT/);
    });
  });
});
