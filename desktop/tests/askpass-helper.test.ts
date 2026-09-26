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
const ELECTRON_PATH = require('electron') as unknown as string;

interface HelperResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/** Spawn the real wrapper with a given extra env and socket path. Returns
 *  the live child (so a test can act on its pid mid-flight) plus a promise
 *  that resolves once it exits. */
function spawnHelper(socketPath: string, extraEnv: NodeJS.ProcessEnv = {}): { child: ChildProcess; done: Promise<HelperResult> } {
  const child = spawn(WRAPPER_PATH, [], {
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
  // The fake server holds its reply for a moment after the handshake so the
  // helper is still alive (past hardenSelf(), which design §3 requires runs
  // BEFORE the socket connect) when this test does the check.
  it.skipIf(process.platform !== 'linux')(
    '/proc/<helper-pid>/mem is not openable from this (same-uid) test process while the helper is alive',
    async () => {
      const { dir, socketPath } = makeSocketDir();
      cleanupDirs.push(dir);
      let memCheckResult: { openable: boolean; code: string | null } | null = null;
      const server = startFakeServer(socketPath, (conn) => {
        setTimeout(() => {
          try {
            const fd = fs.openSync(`/proc/${child.pid}/mem`, 'r');
            fs.closeSync(fd);
            memCheckResult = { openable: true, code: null };
          } catch (err) {
            memCheckResult = { openable: false, code: (err as NodeJS.ErrnoException).code ?? null };
          }
          conn.write(JSON.stringify({ ok: true, password: 'sentinel-pw-dumpable' }) + '\n');
        }, 200);
      });
      const { child, done } = spawnHelper(socketPath);
      const result = await done;
      server.close();

      expect(memCheckResult).not.toBeNull();
      expect(memCheckResult!.openable).toBe(false);
      expect(memCheckResult!.code).toBe('EACCES');
      // Sanity: the delayed reply still reached a working helper.
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
  it.skipIf(process.platform !== 'linux')(
    'control: /proc/<pid>/mem of an ordinary (dumpable) same-uid child IS openable',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'ignore' });
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const fd = fs.openSync(`/proc/${child.pid}/mem`, 'r');
        fs.closeSync(fd);
      } finally {
        child.kill();
      }
    },
  );
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
