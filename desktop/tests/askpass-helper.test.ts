import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { spawn, type ChildProcess } from 'child_process';

// Exercises the REAL youcoded-askpass wrapper + askpass.cjs against a real
// unix-socket server, driven under the real Electron binary in
// ELECTRON_RUN_AS_NODE mode (exactly the path the wrapper itself uses in
// production — see design §2.1). No part of the helper is mocked: the point
// of this suite is that the shipped files, run as a real subprocess chain,
// behave the way §2 and reviews 1/2 (D1, E1) require.
//
// WHY the real Electron binary and not `node`: askpass.cjs `require()`s koffi
// relative to the app root it lives beside (desktop/node_modules/koffi in
// dev). Running it under plain `node` would exercise the exact same file and
// the exact same resolution, but ELECTRON_RUN_AS_NODE is what the wrapper
// actually sets and what a packaged askpass.cjs runs under in production —
// this repo's own electron binary runs headless fine in that mode (no
// display needed), so there is no reason to substitute node.
const WRAPPER_PATH = path.join(__dirname, '..', 'scripts', 'askpass', 'youcoded-askpass');
const ASKPASS_CJS_PATH = path.join(__dirname, '..', 'scripts', 'askpass', 'askpass.cjs');
const ELECTRON_PATH = require('electron') as unknown as string;

interface HelperResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/** Spawn the real wrapper with a given extra env and socket path. Returns
 *  the live child (so a test can act on its pid mid-flight) plus a promise
 *  that resolves once it exits. `wrapperPath` defaults to the shipped
 *  wrapper; T2-3/T2-4 pass a relocated copy instead (see
 *  makeScratchScriptsAskpassDir). */
function spawnHelper(
  socketPath: string,
  extraEnv: NodeJS.ProcessEnv = {},
  wrapperPath: string = WRAPPER_PATH,
): { child: ChildProcess; done: Promise<HelperResult> } {
  const child = spawn(wrapperPath, [], {
    // WHY spread process.env: the wrapper's own `dirname "$0"` / `cd` / `pwd -P`
    // and /usr/bin/env need a normal PATH etc. to run at all — that is this
    // TEST HARNESS's environment, standing in for whatever launched the real
    // Bash tool call. `env -i` inside the wrapper is what actually matters
    // for production, and it runs regardless of what we pass here.
    env: { ...process.env, ...extraEnv, YOUCODED_ASKPASS_SOCKET: socketPath, YOUCODED_ASKPASS_RUNTIME: ELECTRON_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = new Promise<HelperResult>((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    child.stdout!.on('data', (d: Buffer) => { stdout = Buffer.concat([stdout, d]); });
    child.stderr!.on('data', (d: Buffer) => { stderr = Buffer.concat([stderr, d]); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

/** A throwaway unix socket directory + path, cleaned up by the caller. */
function makeSocketDir(): { dir: string; socketPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-askpass-test-'));
  return { dir, socketPath: path.join(dir, 'askpass.sock') };
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build a scratch `<root>/scripts/askpass/` directory containing a real,
 * BYTE-FOR-BYTE copy of the shipped wrapper (used by T2-3 and T2-4) so a
 * test can substitute a stub for `askpass.cjs`, or omit `node_modules/`
 * entirely, without touching the real files under scripts/askpass/ that
 * every other test in this suite also runs concurrently. The wrapper
 * resolves its own directory from `$0` (never from an env var — see
 * youcoded-askpass's own comments), so relocating it this way exercises
 * its REAL logic unmodified; only its sibling file changes.
 */
function makeScratchScriptsAskpassDir(): { root: string; wrapperCopy: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-askpass-scratch-'));
  const scriptsAskpassDir = path.join(root, 'scripts', 'askpass');
  fs.mkdirSync(scriptsAskpassDir, { recursive: true });
  const wrapperCopy = path.join(scriptsAskpassDir, 'youcoded-askpass');
  fs.copyFileSync(WRAPPER_PATH, wrapperCopy);
  fs.chmodSync(wrapperCopy, 0o755);
  return { root, wrapperCopy };
}

/** A minimal fake AskpassServer: reads the one handshake line, then calls
 *  `onHandshake` with the connection to decide what (if anything) to send
 *  back. Mirrors the real server's protocol (design §2.2) closely enough to
 *  drive the helper end to end without needing AskpassServer itself. */
function startFakeServer(
  socketPath: string,
  onHandshake: (conn: net.Socket, line: string) => void,
): net.Server {
  const server = net.createServer((conn) => {
    let buf = Buffer.alloc(0);
    conn.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      onHandshake(conn, buf.subarray(0, nl).toString('utf8'));
    });
  });
  server.listen(socketPath);
  return server;
}

describe('askpass helper: (i) delivers the password on {ok:true}', () => {
  it('prints exactly the password, nothing else, and exits 0', async () => {
    const { dir, socketPath } = makeSocketDir();
    cleanupDirs.push(dir);
    const SENTINEL = 'sentinel-pw-6f3a9c';
    let handshakeLine = '';
    const server = startFakeServer(socketPath, (conn, line) => {
      handshakeLine = line;
      conn.write(JSON.stringify({ ok: true, password: SENTINEL }) + '\n');
    });
    const { done } = spawnHelper(socketPath);
    const result = await done;
    server.close();

    // The helper's ONLY outbound message is the bare handshake — no pid, no
    // argv, nothing a spoofing peer could reuse (design §2.2, review 1 D3).
    expect(handshakeLine).toBe('{"v":1}');
    expect(result.code).toBe(0);
    expect(result.stdout.toString('utf8')).toBe(SENTINEL + '\n');
    expect(result.stderr.toString('utf8')).toBe('');
  });
});

describe('askpass helper: (ii) refuses silently on anything else', () => {
  it('prints nothing and exits 1 on {ok:false}', async () => {
    const { dir, socketPath } = makeSocketDir();
    cleanupDirs.push(dir);
    const server = startFakeServer(socketPath, (conn) => {
      conn.write(JSON.stringify({ ok: false }) + '\n');
    });
    const { done } = spawnHelper(socketPath);
    const result = await done;
    server.close();

    expect(result.code).toBe(1);
    expect(result.stdout.length).toBe(0);
  });

  it('prints nothing and exits 1 on a garbage (non-JSON) reply', async () => {
    const { dir, socketPath } = makeSocketDir();
    cleanupDirs.push(dir);
    const server = startFakeServer(socketPath, (conn) => {
      conn.write('this is not json at all\n');
    });
    const { done } = spawnHelper(socketPath);
    const result = await done;
    server.close();

    expect(result.code).toBe(1);
    expect(result.stdout.length).toBe(0);
  });

  it('prints nothing and exits 1 when the socket closes with no reply', async () => {
    const { dir, socketPath } = makeSocketDir();
    cleanupDirs.push(dir);
    const server = startFakeServer(socketPath, (conn) => {
      conn.end(); // close right after the handshake, before any reply
    });
    const { done } = spawnHelper(socketPath);
    const result = await done;
    server.close();

    expect(result.code).toBe(1);
    expect(result.stdout.length).toBe(0);
  });
});

describe('askpass helper: (iii) env -i blocks a caller-set loader hijack', () => {
  it('does not run a NODE_OPTIONS --require hook set by the spawning command', async () => {
    const { dir, socketPath } = makeSocketDir();
    cleanupDirs.push(dir);
    const markerPath = path.join(dir, 'hijack-ran.marker');
    const hookPath = path.join(dir, 'hook.js');
    // WHY this hook: it proves the negative concretely — if env -i failed to
    // scrub NODE_OPTIONS, this file would run inside the verified helper
    // and leave evidence on disk BEFORE the password is ever read, which is
    // exactly the review 1 (D1) attack (NODE_OPTIONS='--require=evil.js').
    fs.writeFileSync(hookPath, `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');`);

    const SENTINEL = 'sentinel-pw-env-i';
    const server = startFakeServer(socketPath, (conn) => {
      conn.write(JSON.stringify({ ok: true, password: SENTINEL }) + '\n');
    });
    // WHY set it here, not in the wrapper's own exec line: this simulates the
    // model's Bash command setting NODE_OPTIONS ahead of `sudo` (design's own
    // example) — i.e. a var present in the PROCESS that spawns the wrapper,
    // exactly what `exec /usr/bin/env -i ...` inside the wrapper must drop.
    const { done } = spawnHelper(socketPath, { NODE_OPTIONS: `--require=${hookPath}` });
    const result = await done;
    server.close();

    expect(fs.existsSync(markerPath)).toBe(false);
    // The helper must still work normally once the hijack is neutralised —
    // env -i scrubbing NODE_OPTIONS must not also break the real runtime.
    expect(result.code).toBe(0);
    expect(result.stdout.toString('utf8')).toBe(SENTINEL + '\n');
  });
});

describe('askpass helper: (iv) makes itself non-dumpable before touching the socket', () => {
  // Design §3 (review 2, E1): PR_SET_DUMPABLE=0 is what closes same-uid
  // ptrace/core-dump access to this process while it holds the password.
  // The kernel's ptrace_may_access() check that PR_SET_DUMPABLE=0 triggers
  // is the SAME check that gates opening /proc/<pid>/mem for a same-uid,
  // non-ancestor-privileged process — so "can a same-uid process open
  // /proc/<helper-pid>/mem" is a direct, externally observable proxy for
  // "is this process dumpable", with no ptrace syscall of our own needed.
  // Verified empirically before writing this test: a plain same-uid Node
  // child leaves /proc/<pid>/mem openable; a child that calls
  // prctl(PR_SET_DUMPABLE, 0, ...) makes that same open() fail EACCES.
  //
  // WHY no setTimeout/sleep here (test-suite-hygiene: never let a fixed
  // sleep stand in for a real signal): the REAL signal that the helper has
  // already run hardenSelf() (which design §3 requires runs strictly
  // BEFORE the socket connect — see main()) is the fake server's own
  // `data` event carrying the handshake line. By the time that callback
  // runs, the helper has already hardened and is now blocked waiting for
  // our reply — verified empirically to be reliable (no flakiness from
  // racing it) before writing this test. So the /proc/<pid>/mem probe runs
  // synchronously inside the handshake handler, with no delay at all.
  it.skipIf(process.platform !== 'linux')(
    '/proc/<helper-pid>/mem is not openable from this (same-uid) test process while the helper is alive',
    async () => {
      const { dir, socketPath } = makeSocketDir();
      cleanupDirs.push(dir);
      let memCheckResult: { openable: boolean; code: string | null } | null = null;
      const server = startFakeServer(socketPath, (conn) => {
        try {
          const fd = fs.openSync(`/proc/${child.pid}/mem`, 'r');
          fs.closeSync(fd);
          memCheckResult = { openable: true, code: null };
        } catch (err) {
          memCheckResult = { openable: false, code: (err as NodeJS.ErrnoException).code ?? null };
        }
        conn.write(JSON.stringify({ ok: true, password: 'sentinel-pw-dumpable' }) + '\n');
      });
      const { child, done } = spawnHelper(socketPath);
      const result = await done;
      server.close();

      expect(memCheckResult).not.toBeNull();
      expect(memCheckResult!.openable).toBe(false);
      expect(memCheckResult!.code).toBe('EACCES');
      // Sanity: the reply still reached a working helper.
      expect(result.code).toBe(0);
      expect(result.stdout.toString('utf8')).toBe('sentinel-pw-dumpable\n');
    },
  );

  // Control for the probe above: without the hardening call, the same
  // same-uid /proc/<pid>/mem open succeeds — proving the EACCES above comes
  // from askpass.cjs's own prctl() call, not from some unrelated sandboxing
  // of /proc on this machine (e.g. a restrictive default ptrace_scope would
  // still allow a direct parent to attach/open, since yama's "restricted"
  // mode exempts real ancestors — only the dumpable flag does not).
  // WHY a "ready" stdout marker instead of a sleep: the real signal we need
  // is "the child process exists and is still running", which its own
  // first stdout write proves directly — no arbitrary delay to guess at.
  it.skipIf(process.platform !== 'linux')(
    'control: /proc/<pid>/mem of an ordinary (dumpable) same-uid child IS openable',
    async () => {
      const child = spawn(
        process.execPath,
        ['-e', "process.stdout.write('ready\\n'); setTimeout(() => {}, 5000);"],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      try {
        await new Promise<void>((resolve) => {
          child.stdout!.once('data', () => resolve());
        });
        const fd = fs.openSync(`/proc/${child.pid}/mem`, 'r');
        fs.closeSync(fd);
      } finally {
        child.kill();
      }
    },
  );
});

describe('askpass wrapper: (T2-3) resulting environment is EXACTLY the two-variable allowlist', () => {
  // Design §3 item 1 requires the helper's environment to be EXACTLY
  // {ELECTRON_RUN_AS_NODE, YOUCODED_ASKPASS_SOCKET} — no more, no less.
  // The obvious way to check this ("read /proc/<helper-pid>/environ from
  // outside while it's alive and waiting on the socket") turns out NOT to
  // work for the real, hardened askpass.cjs: verified empirically that
  // /proc/<pid>/environ is gated by the SAME same-uid ptrace_may_access()
  // check as /proc/<pid>/mem (see the (iv) tests above) — once
  // hardenSelf() has run, this test process can no longer read it at all
  // (EACCES), and hardenSelf() always runs before the socket is ever
  // touched. Reading it in the narrow window before hardening would be a
  // real race, which test-suite-hygiene rules out as a signal.
  //
  // So this test exercises the WRAPPER's env -i line directly instead: a
  // byte-for-byte copy of the real, unmodified wrapper script (relocated,
  // not edited — see makeScratchScriptsAskpassDir) is run with a benign
  // stub standing in for askpass.cjs whose only job is to report its own
  // process.env. That proves exactly what the wrapper hands the runtime,
  // without needing to race or defeat askpass.cjs's own hardening.
  it('no other ambient variable (LD_PRELOAD, SSH_AUTH_SOCK, AWS-shaped, HOME, TERM, ...) survives into the child process env', async () => {
    const { root, wrapperCopy } = makeScratchScriptsAskpassDir();
    cleanupDirs.push(root);
    fs.writeFileSync(
      path.join(root, 'scripts', 'askpass', 'askpass.cjs'),
      "process.stdout.write(JSON.stringify(process.env));\n",
    );

    const child = spawn(wrapperCopy, [], {
      env: {
        ...process.env,
        // A pile of ambient variables a real Bash command's own
        // environment could plausibly carry, none of which are in the
        // production allowlist — including a loader-hook-shaped one
        // OTHER than NODE_OPTIONS (test iii already covers that one), per
        // the review's explicit ask.
        LD_PRELOAD: '/tmp/youcoded-test-does-not-exist.so',
        SSH_AUTH_SOCK: '/tmp/youcoded-test-fake-agent.sock',
        AWS_ACCESS_KEY_ID: 'AKIA-YOUCODED-TEST-FAKE',
        TERM: 'xterm-256color',
        YOUCODED_ASKPASS_SOCKET: '/tmp/youcoded-test-unused.sock',
        YOUCODED_ASKPASS_RUNTIME: ELECTRON_PATH,
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const stdout = await new Promise<string>((resolve) => {
      let out = '';
      child.stdout!.on('data', (d: Buffer) => { out += d.toString('utf8'); });
      child.on('close', () => resolve(out));
    });

    const env = JSON.parse(stdout) as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(['ELECTRON_RUN_AS_NODE', 'YOUCODED_ASKPASS_SOCKET'].sort());
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env.YOUCODED_ASKPASS_SOCKET).toBe('/tmp/youcoded-test-unused.sock');
  });
});

describe('askpass helper: (T2-4) hardening runs before the socket is ever touched', () => {
  // main() calls hardenSelf() and, if it fails, exits BEFORE net is ever
  // asked to connect (askpass.cjs's own main(), top of the function). This
  // test makes hardenSelf() fail (by running a copy of askpass.cjs with no
  // node_modules/koffi two levels up from it, so requireKoffi() throws)
  // against a real listening server that records whether it EVER received
  // a connection, and asserts both: exit code 1, and the connection
  // handler was never invoked. No sleep/grace-period needed to check the
  // negative — the assertion runs only after the child's `close` event, by
  // which point a unix-socket connect() attempt would already have either
  // happened or not; nothing can arrive later once the process is gone.
  it('a helper that fails to harden itself never connects to the socket', async () => {
    const { root, wrapperCopy } = makeScratchScriptsAskpassDir();
    cleanupDirs.push(root);
    // Byte-for-byte copy of the real askpass.cjs, relocated to a directory
    // with no node_modules/koffi sibling at all — requireKoffi()'s
    // `fs.existsSync(candidate)` check fails closed exactly as it would
    // for a genuinely broken packaged install.
    fs.copyFileSync(ASKPASS_CJS_PATH, path.join(root, 'scripts', 'askpass', 'askpass.cjs'));

    const { dir, socketPath } = makeSocketDir();
    cleanupDirs.push(dir);
    let sawConnection = false;
    const server = net.createServer((conn) => {
      sawConnection = true;
      conn.destroy();
    });
    server.listen(socketPath);

    const { done } = spawnHelper(socketPath, {}, wrapperCopy);
    const result = await done;
    server.close();

    expect(result.code).toBe(1);
    expect(result.stdout.length).toBe(0);
    expect(sawConnection).toBe(false);
  });
});

describe('askpass wrapper: (T2-5) ulimit -c 0 actually zeroes the core-dump limit', () => {
  // Review 2 (E1)'s primary fix: `ulimit -c 0` in the wrapper must
  // override even an inherited `ulimit -c unlimited` (the design's own
  // attack scenario — a command run earlier in the same shell/session).
  // Spawn the wrapper through `sh -c 'ulimit -c unlimited; exec "$0"'`
  // (rlimits survive exec, so this reproduces "inherited unlimited" for
  // the exact process the wrapper then execs into) and read
  // /proc/<pid>/limits — unlike /proc/<pid>/environ or .../mem, this file
  // is NOT gated by the dumpable flag (verified empirically), so it can be
  // read the same way the (iv) tests read other /proc files: synchronously
  // inside the fake server's handshake handler, no sleep required.
  it('resulting process has "Max core file size" 0/0 even though the spawning shell set it unlimited', async () => {
    const { dir, socketPath } = makeSocketDir();
    cleanupDirs.push(dir);
    let limitsLine: string | undefined;
    const server = startFakeServer(socketPath, (conn) => {
      const limits = fs.readFileSync(`/proc/${child.pid}/limits`, 'utf8');
      limitsLine = limits.split('\n').find((l) => l.includes('core file'));
      conn.write(JSON.stringify({ ok: true, password: 'sentinel-pw-ulimit' }) + '\n');
    });

    const child = spawn('sh', ['-c', 'ulimit -c unlimited; exec "$0"', WRAPPER_PATH], {
      env: { ...process.env, YOUCODED_ASKPASS_SOCKET: socketPath, YOUCODED_ASKPASS_RUNTIME: ELECTRON_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await new Promise<HelperResult>((resolve) => {
      let stdout = Buffer.alloc(0);
      child.stdout!.on('data', (d: Buffer) => { stdout = Buffer.concat([stdout, d]); });
      child.on('close', (code) => resolve({ code, stdout, stderr: Buffer.alloc(0) }));
    });
    server.close();

    expect(limitsLine).toBeDefined();
    // "Max core file size        0                    0                    bytes"
    expect(limitsLine).toMatch(/Max core file size\s+0\s+0\s/);
    // Sanity: the wrapper still worked normally.
    expect(result.code).toBe(0);
    expect(result.stdout.toString('utf8')).toBe('sentinel-pw-ulimit\n');
  });
});

describe('askpass.cjs: (T2-6) isTraced() refuses when a tracer is already attached', () => {
  // isTraced() exists specifically for the race review 2 was concerned
  // with: a tracer that attached BEFORE hardenSelf()'s prctl() call takes
  // effect isn't retroactively severed by setting the dumpable flag
  // afterward. Actually attaching a real tracer before hardening runs, in
  // a process-level test, is a genuine race to construct reliably (the
  // review itself calls this "reasonable to accept as a documented gap
  // rather than build"); this pins the pure parsing/decision logic instead
  // — free, deterministic, and would catch a regression in the `!== '0'`
  // comparison or the regex.
  //
  // require()'d rather than run directly: the require.main === module
  // guard in askpass.cjs (added for this) means importing it here does
  // NOT connect to any socket or call process.exit() as a side effect.
  //
  // WHY dependency injection instead of `vi.spyOn(fs, 'readFileSync')`:
  // tried that first — vitest's ESM handling makes the shared `fs`
  // module's own exports non-configurable ("Cannot redefine property:
  // readFileSync"), so spying on it fails outright. isTraced() now takes
  // an optional `readStatus` parameter (defaulted to the real read, so
  // production behavior — the one real caller, main(), passes no
  // argument — is unchanged) — the same injection shape admin-command.ts
  // already uses for its own `platform` override.
  const askpass = require(ASKPASS_CJS_PATH) as { isTraced: (readStatus?: () => string) => boolean };

  // These four pin the Linux-only TracerPid parsing branch directly; on
  // any other platform isTraced() returns false before ever calling
  // readStatus (see the file), so injected fake status text wouldn't
  // exercise anything — skip rather than assert a platform-dependent
  // value the function was never meant to reach.
  it.skipIf(process.platform !== 'linux')('refuses (returns true) when TracerPid is non-zero', () => {
    expect(askpass.isTraced(() => 'Name:\tnode\nState:\tS (sleeping)\nTracerPid:\t4242\nUid:\t1000\t1000\t1000\t1000\n')).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('allows (returns false) when TracerPid is 0', () => {
    expect(askpass.isTraced(() => 'Name:\tnode\nState:\tR (running)\nTracerPid:\t0\nUid:\t1000\t1000\t1000\t1000\n')).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('fails closed (returns true) when the status text has no TracerPid line at all', () => {
    expect(askpass.isTraced(() => 'Name:\tnode\nState:\tR (running)\n')).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('fails closed (returns true) when /proc/self/status is unreadable', () => {
    expect(askpass.isTraced(() => { throw new Error('ENOENT: no such file or directory'); })).toBe(true);
  });

  it('does not false-positive against this test process\'s own real, untraced /proc/self/status', () => {
    // No mock here — this is the real isTraced() reading this actual test
    // process's real /proc/self/status, which the whole suite already runs
    // under (vitest does not attach a ptrace-style tracer to its workers).
    expect(askpass.isTraced()).toBe(false);
  });
});

describe('askpass helper: (v) packaged-layout koffi resolution', () => {
  // Review 3 (F1): askpass.cjs lives in app.asar.unpacked and must reach
  // koffi at the SIBLING app.asar.unpacked/node_modules/koffi — a bare
  // require('koffi') from inside app.asar cannot see it (proven in review
  // 3's own repro). Proving that packaged layout end to end means building
  // a real app.asar + app.asar.unpacked tree with @electron/asar, which is
  // NOT a devDependency of this package (checked: `grep asar package.json`
  // finds nothing) — adding one only for this test is out of scope for this
  // task, so this sub-test is skipped with the reason on record rather than
  // silently passing or quietly adding a new dependency.
  //
  // What IS proven elsewhere in this suite: requireKoffi() in askpass.cjs
  // resolves `path.join(__dirname, '..', '..', 'node_modules', 'koffi')`,
  // and every test above runs askpass.cjs from its real, shipped location
  // (desktop/scripts/askpass/askpass.cjs) with that exact resolution
  // reaching desktop/node_modules/koffi successfully (hardenSelf()
  // succeeding is itself proof: it requires koffi before doing anything
  // else). The packaged case only changes WHICH directory sits two levels
  // above askpass.cjs (app.asar.unpacked/ instead of desktop/) — the same
  // relative path — which electron-builder.yml's asarUnpack entries (this
  // change's own edit) are what make a real sibling directory exist there.
  it.skip('requires @electron/asar (not a devDependency here) to build a real app.asar/app.asar.unpacked tree — skipped, see comment above', () => {});
});
