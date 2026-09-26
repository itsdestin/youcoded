// admin-password-docker.test.ts — admin-password design §9/§11 task 6, the
// ONE test in this feature that touches a REAL sudo. Everything else
// (askpass-server.test.ts, askpass-verify.test.ts, admin-password-
// service.test.ts, bash-env.test.ts, admin-forget.test.ts, shell-registry.
// test.ts, harness-session-loop.test.ts) drives the same code against fakes.
// This one builds a disposable Debian container with `sudo` and a throwaway
// user of a KNOWN password, then runs the REAL AskpassServer + the REAL
// shipped `askpass.cjs`/`youcoded-askpass` + the REAL system `sudo` inside
// it, delivering that known password over the real unix-socket protocol —
// never against Destin's own account, never against the host at all.
//
// SKIPPED BY DEFAULT. Set YOUCODED_DOCKER_E2E=1 to run it (needs a working
// `docker` on PATH the current user can reach without sudo). It builds an
// image and runs one container; nothing here writes outside its own temp
// build context and the image it creates (removed at the end).
//
// Electron cannot run inside this container (no display, no X libs, and
// nothing here needs Electron at all — AskpassServer/RunningCalls/verify.ts
// are plain Node modules). The harness that runs inside the container is
// therefore plain Node (via `tsx`, so it can import the real .ts sources
// unmodified) — YOUCODED_ASKPASS_RUNTIME inside the container is the
// container's own `node`, not an Electron binary, exactly as the design
// allows for a build/test rig that has no Electron to point at.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const RUN_IT = process.env.YOUCODED_DOCKER_E2E === '1';
const IMAGE_TAG = 'youcoded-admin-password-e2e:test';

// __dirname, Windows-safe (test-suite-hygiene: fileURLToPath, never .pathname).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(HERE, '..', '..'); // desktop/
const SRC_MAIN = path.join(DESKTOP_ROOT, 'src', 'main');

const DOCKERFILE = `
FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends \\
    sudo nodejs npm ca-certificates \\
  && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/sh askpasstest \\
  && echo 'askpasstest:testpass123' | chpasswd \\
  && usermod -aG sudo askpasstest
WORKDIR /app
COPY package.json ./
RUN npm install --no-save --no-audit --no-fund koffi tsx typescript
COPY scripts ./scripts
COPY src ./src
COPY e2e-harness.ts ./
RUN chmod 0755 scripts/askpass/youcoded-askpass
CMD ["npx", "tsx", "e2e-harness.ts"]
`;

const PACKAGE_JSON = JSON.stringify({ name: 'youcoded-admin-password-e2e', private: true, version: '0.0.0' });

// The container-side driver: a REAL AskpassServer + RunningCalls, importing
// this repo's ACTUAL .ts sources (copied verbatim below, never hand-copied
// logic) — so a regression in the real code fails this test, not a
// reimplementation of it.
const HARNESS_TS = `
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { AskpassServer } from './src/main/harness/askpass/askpass-server';
import { RunningCalls } from './src/main/harness/askpass/running-calls';

type AskEvent = { askId: string; sudoArgv: string[] };

async function runSudoIdAsUser(
  server: AskpassServer,
  runningCalls: RunningCalls,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('su', ['-s', '/bin/sh', 'askpasstest', '-c', 'sudo -A id -u'], { env });
    if (child.pid) void runningCalls.registerPid(child.pid, { sessionId: 'e2e', toolCallId: 'e2e-call' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => {
      if (child.pid) runningCalls.unregister(child.pid);
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  const runningCalls = new RunningCalls();
  const server = new AskpassServer({
    execPath: process.execPath,
    helperScriptRealpath: fs.realpathSync(path.join(__dirname, 'scripts', 'askpass', 'askpass.cjs')),
    runningCalls,
    socketDirOverride: '/tmp/youcoded-askpass-e2e',
  });
  await server.start();
  if (!server.available) {
    console.log(JSON.stringify({ ok: false, stage: 'server-unavailable' }));
    process.exit(1);
  }

  const env: Record<string, string> = {
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/root',
    LANG: 'C',
    SUDO_ASKPASS: path.join(__dirname, 'scripts', 'askpass', 'youcoded-askpass'),
    YOUCODED_ASKPASS_SOCKET: server.socketPath!,
    // No Electron in this container — plain node IS the runtime the wrapper execs.
    YOUCODED_ASKPASS_RUNTIME: process.execPath,
  };

  const results: Record<string, unknown> = {};

  // --- a wrong password first, then the real one: expects a SECOND ask ---
  let asksThisRun = 0;
  const onAsk1 = (event: AskEvent) => {
    asksThisRun++;
    const password = asksThisRun === 1 ? 'totally-wrong-password' : 'testpass123';
    server.deliver(event.askId, Buffer.from(password, 'utf8'));
  };
  server.on('ask', onAsk1);
  const r1 = await runSudoIdAsUser(server, runningCalls, env);
  server.off('ask', onAsk1);
  results.firstRun = { code: r1.code, stdout: r1.stdout.trim(), stderr: r1.stderr.trim(), asks: asksThisRun };

  // --- sudo -K as that user, then confirm the NEXT sudo asks again ---
  await new Promise<void>((resolve) => {
    const k = spawn('su', ['-s', '/bin/sh', 'askpasstest', '-c', 'sudo -K'], {
      env: { PATH: env.PATH, HOME: env.HOME },
    });
    k.on('close', () => resolve());
  });

  let askedAfterK = false;
  const onAsk2 = (event: AskEvent) => {
    askedAfterK = true;
    server.deliver(event.askId, Buffer.from('testpass123', 'utf8'));
  };
  server.on('ask', onAsk2);
  const r2 = await runSudoIdAsUser(server, runningCalls, env);
  server.off('ask', onAsk2);
  results.secondRun = { code: r2.code, stdout: r2.stdout.trim(), askedAfterK };

  await server.stop();
  console.log(JSON.stringify(results));
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: String((err && err.stack) || err) }));
  process.exit(1);
});
`;

let contextDir: string | null = null;

describe.skipIf(!RUN_IT)('admin password end to end against a real sudo in a disposable container', () => {
  beforeAll(() => {
    contextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-admin-password-e2e-'));
    fs.writeFileSync(path.join(contextDir, 'Dockerfile'), DOCKERFILE);
    fs.writeFileSync(path.join(contextDir, 'package.json'), PACKAGE_JSON);
    fs.writeFileSync(path.join(contextDir, 'e2e-harness.ts'), HARNESS_TS);
    // Copy the REAL, current source — never a hand-duplicated logic file —
    // so this test exercises the code this branch actually ships.
    fs.mkdirSync(path.join(contextDir, 'src', 'main', 'harness', 'askpass'), { recursive: true });
    for (const name of ['askpass-server.ts', 'peer-cred.ts', 'proc-info.ts', 'verify.ts', 'running-calls.ts']) {
      fs.copyFileSync(path.join(SRC_MAIN, 'harness', 'askpass', name), path.join(contextDir, 'src', 'main', 'harness', 'askpass', name));
    }
    fs.copyFileSync(path.join(SRC_MAIN, 'logger.ts'), path.join(contextDir, 'src', 'main', 'logger.ts'));
    fs.cpSync(path.join(DESKTOP_ROOT, 'scripts', 'askpass'), path.join(contextDir, 'scripts', 'askpass'), { recursive: true });

    const build = spawnSync('docker', ['build', '-t', IMAGE_TAG, contextDir], { encoding: 'utf8' });
    if (build.status !== 0) {
      throw new Error(`docker build failed:\n${build.stdout}\n${build.stderr}`);
    }
  }, 300_000);

  afterAll(() => {
    spawnSync('docker', ['rmi', '-f', IMAGE_TAG], { encoding: 'utf8' });
    if (contextDir) fs.rmSync(contextDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('delivers the known password over the real askpass protocol, retries on a wrong one, and forgets after -K', () => {
    const run = spawnSync('docker', ['run', '--rm', IMAGE_TAG], { encoding: 'utf8', timeout: 120_000 });
    const lastLine = run.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    let parsed: any;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      throw new Error(`container did not print a JSON result line.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    }
    expect(parsed.ok).not.toBe(false);

    // `sudo -A id -u` printed 0 — the real sudo accepted our delivered password.
    expect(parsed.firstRun.stdout).toBe('0');
    expect(parsed.firstRun.code).toBe(0);
    // A wrong password on the first try means sudo asked AGAIN (attempt 2)
    // before the real one succeeded.
    expect(parsed.firstRun.asks).toBe(2);

    // After `sudo -K`, the NEXT sudo call asked again — the ticket was forgotten.
    expect(parsed.secondRun.askedAfterK).toBe(true);
    expect(parsed.secondRun.code).toBe(0);
    expect(parsed.secondRun.stdout).toBe('0');
  }, 120_000);
});
