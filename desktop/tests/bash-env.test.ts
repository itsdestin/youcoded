// bash-env.test.ts — admin-password design §2.3/§11 task 5: the Bash tool's
// own half of the sudo wiring — SUDO_ASKPASS/YOUCODED_ASKPASS_SOCKET/
// YOUCODED_ASKPASS_RUNTIME applied AFTER shellEnv/persistent_env, never
// persisted, and the NODE_OPTIONS-class drop. No real askpass server or
// sudo runs here — just env-var plumbing through a real `bash -c`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BashTool } from '../src/main/harness/tools/bash';
import type { ToolContext } from '../src/main/harness/tools/types';

let dir: string;
const TEST_SESSION_ID = `test-bash-env-${process.pid}`;

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: TEST_SESSION_ID,
    cwd: dir,
    signal: new AbortController().signal,
    readRegistry: new Map(),
    todos: [],
    ...over,
  };
}

const ADMIN_ENV = {
  SUDO_ASKPASS: '/opt/YouCoded/resources/app.asar.unpacked/scripts/askpass/askpass.cjs',
  YOUCODED_ASKPASS_SOCKET: '/run/user/1000/youcoded/askpass-123.sock',
  YOUCODED_ASKPASS_RUNTIME: process.execPath,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-env-'));
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  } catch {
    /* best-effort */
  }
});

// admin-password design section 2.3 — the SUDO_ASKPASS/socket/runtime vars.
describe('Bash env — the sudo askpass variables', () => {
  it('sets SUDO_ASKPASS / YOUCODED_ASKPASS_SOCKET / YOUCODED_ASKPASS_RUNTIME when the askpass server is available', async () => {
    const ctx = makeCtx({ adminPasswordEnv: ADMIN_ENV });
    const r = await BashTool.execute({ command: 'echo "$SUDO_ASKPASS|$YOUCODED_ASKPASS_SOCKET|$YOUCODED_ASKPASS_RUNTIME"' }, ctx);
    expect(r.text).toContain(`${ADMIN_ENV.SUDO_ASKPASS}|${ADMIN_ENV.YOUCODED_ASKPASS_SOCKET}|${ADMIN_ENV.YOUCODED_ASKPASS_RUNTIME}`);
  });

  it('is absent entirely when the askpass server never started (ctx.adminPasswordEnv unset) — sudo fails exactly as before', async () => {
    const ctx = makeCtx();
    const r = await BashTool.execute({ command: 'echo "[$SUDO_ASKPASS][$YOUCODED_ASKPASS_SOCKET][$YOUCODED_ASKPASS_RUNTIME]"' }, ctx);
    expect(r.text).toContain('[][][]');
  });

  it('wins over a persisted shellEnv value from an earlier persistent_env call (applied AFTER shellEnv)', async () => {
    const ctx = makeCtx({ adminPasswordEnv: ADMIN_ENV, shellEnv: { SUDO_ASKPASS: '/evil/askpass' } });
    const r = await BashTool.execute({ command: 'echo "$SUDO_ASKPASS"' }, ctx);
    expect(r.text).toContain(ADMIN_ENV.SUDO_ASKPASS);
    expect(r.text).not.toContain('/evil/askpass');
  });

  it('is NEVER persisted, even when the command exports a different value under persistent_env:true', async () => {
    let captured: Record<string, string> | undefined;
    const ctx = makeCtx({
      adminPasswordEnv: ADMIN_ENV,
      setShellEnv: (next) => {
        captured = next;
      },
    });
    const r = await BashTool.execute({ command: 'export SUDO_ASKPASS=/evil/askpass', persistent_env: true }, ctx);
    expect(r.isError).toBeFalsy();
    expect(captured).toBeDefined();
    expect(captured?.SUDO_ASKPASS).toBeUndefined();
    expect(captured?.YOUCODED_ASKPASS_SOCKET).toBeUndefined();
    expect(captured?.YOUCODED_ASKPASS_RUNTIME).toBeUndefined();
  });

  it('drops NODE_OPTIONS / NODE_REPL_EXTERNAL_MODULE / NODE_V8_COVERAGE / ELECTRON_RUN_AS_NODE inherited from the app, for every call', async () => {
    const saved = {
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      NODE_REPL_EXTERNAL_MODULE: process.env.NODE_REPL_EXTERNAL_MODULE,
      NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
    };
    process.env.NODE_OPTIONS = '--require=/tmp/evil.js';
    process.env.NODE_REPL_EXTERNAL_MODULE = '/tmp/evil.js';
    process.env.NODE_V8_COVERAGE = '/tmp/cov';
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const ctx = makeCtx();
      const r = await BashTool.execute(
        { command: 'echo "[$NODE_OPTIONS][$NODE_REPL_EXTERNAL_MODULE][$NODE_V8_COVERAGE][$ELECTRON_RUN_AS_NODE]"' },
        ctx,
      );
      expect(r.text).toContain('[][][][]');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
        else process.env[key] = value;
      }
    }
  });

  it('a command CAN still override the vars for its own process — the app is simply never asked', async () => {
    // `export` (not a prefix assignment) so the SAME shell's own expansion
    // of $SUDO_ASKPASS below sees the new value — a prefix assignment
    // (`VAR=x cmd "$VAR"`) is expanded by the shell BEFORE it applies to
    // cmd's own environment, which would test bash semantics, not this code.
    const ctx = makeCtx({ adminPasswordEnv: ADMIN_ENV });
    const r = await BashTool.execute({ command: 'export SUDO_ASKPASS=/its/own/helper\necho "$SUDO_ASKPASS"' }, ctx);
    expect(r.text).toContain('/its/own/helper');
  });

  it('run_in_background starts share the SAME spawnEnv, so the vars reach a backgrounded command too', async () => {
    const started: any[] = [];
    const shells = {
      start: (spec: any) => {
        started.push(spec);
        return { ok: false as const, reason: 'spawn-failed' as const, detail: 'not actually started in this test' };
      },
    };
    const ctx = makeCtx({ adminPasswordEnv: ADMIN_ENV, shells: shells as any });
    await BashTool.execute({ command: 'sleep 1', run_in_background: true }, ctx);
    expect(started).toHaveLength(1);
    expect(started[0].env.SUDO_ASKPASS).toBe(ADMIN_ENV.SUDO_ASKPASS);
    expect(started[0].env.YOUCODED_ASKPASS_SOCKET).toBe(ADMIN_ENV.YOUCODED_ASKPASS_SOCKET);
  });
});
