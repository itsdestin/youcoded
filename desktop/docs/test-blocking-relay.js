#!/usr/bin/env node
/**
 * test-blocking-relay.js — Spike test for the hybrid relay protocol.
 *
 * Runs four scenarios against relay-blocking.js:
 *   1. Fire-and-forget: server closes immediately → relay exits 0
 *   2. Blocking allow: server sends {"allow":true} → relay exits 0
 *   3. Blocking deny: server sends {"allow":false} → relay exits 2
 *   4. Timeout: server holds forever → relay exits 0 after timeout
 *
 * Usage: node scripts/test-blocking-relay.js
 */
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

const PIPE_NAME = '\\\\.\\pipe\\claude-desktop-hooks-TEST';
const RELAY_PATH = path.join(__dirname, '..', 'hook-scripts', 'relay-blocking.js');

// Mock hook payload (PreToolUse for a Bash command)
const mockPayload = JSON.stringify({
  hook_event_name: 'PreToolUse',
  session_id: 'test-session-123',
  tool_name: 'Bash',
  tool_input: { command: 'echo hello' },
});

const results = [];

function log(msg) {
  console.log(`  ${msg}`);
}

/**
 * Spawn relay-blocking.js, feed it a payload, return exit code.
 */
function spawnRelay(timeoutOverride, envOverrides = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CLAUDE_DESKTOP_PIPE: PIPE_NAME,
      CLAUDE_DESKTOP_SESSION_ID: 'desktop-test-001',
      ...envOverrides,
    };

    const child = spawn(process.execPath, [RELAY_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    // Feed payload on stdin, then close
    child.stdin.end(mockPayload);

    // Safety: kill after 35s in case something hangs
    const kill = timeoutOverride || 35000;
    setTimeout(() => {
      child.kill();
      resolve({ code: -1, stdout, stderr: 'killed by test timeout' });
    }, kill);
  });
}

/**
 * Start a pipe server, run a test, then clean up.
 * `handler` receives (socket) and decides how to respond.
 */
async function runTest(name, handler, opts = {}) {
  const startTime = Date.now();
  process.stdout.write(`\n[TEST] ${name}... `);

  const server = net.createServer((socket) => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
      const nl = data.indexOf('\n');
      if (nl >= 0) {
        const payload = data.substring(0, nl);
        handler(socket, payload);
      }
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.listen(PIPE_NAME, resolve);
    server.on('error', reject);
  });

  const result = await spawnRelay(opts.timeout, opts.env || {});
  server.close();

  // Brief pause so Windows releases the pipe name
  await new Promise((r) => setTimeout(r, 300));

  const elapsed = Date.now() - startTime;
  const pass = result.code === opts.expectedCode;
  const status = pass ? 'PASS' : 'FAIL';
  console.log(`${status} (exit=${result.code}, expected=${opts.expectedCode}, ${elapsed}ms)`);
  if (!pass) {
    log(`stdout: ${result.stdout}`);
    log(`stderr: ${result.stderr}`);
  }
  results.push({ name, pass, code: result.code, expected: opts.expectedCode, elapsed });
}

async function main() {
  console.log('=== Blocking Relay Protocol Spike Test ===');
  console.log(`Pipe: ${PIPE_NAME}`);
  console.log(`Relay: ${RELAY_PATH}`);

  // Test 1: Fire-and-forget — server closes socket immediately
  await runTest('Fire-and-forget (server closes immediately)', (socket, _payload) => {
    socket.end();
  }, { expectedCode: 0 });

  // Test 2: Blocking allow — server sends allow response
  await runTest('Blocking allow (server sends allow=true)', (socket, payload) => {
    // Simulate a brief "thinking" delay, then approve
    const parsed = JSON.parse(payload);
    log(`  Received: ${parsed.hook_event_name} tool=${parsed.tool_name}`);
    setTimeout(() => {
      socket.end(JSON.stringify({ allow: true }) + '\n');
    }, 500);
  }, { expectedCode: 0 });

  // Test 3: Blocking deny — server sends deny response
  await runTest('Blocking deny (server sends allow=false)', (socket, payload) => {
    setTimeout(() => {
      socket.end(JSON.stringify({ allow: false }) + '\n');
    }, 500);
  }, { expectedCode: 2 });

  // Test 4: Timeout — server holds socket open, never responds
  // Override relay timeout to 3s so this test doesn't take 30s
  await runTest('Timeout (server holds, relay fails open)', (socket, _payload) => {
    // Deliberately do nothing — hold the socket open
  }, { expectedCode: 0, timeout: 10000, env: { CLAUDE_RELAY_TIMEOUT: '3000' } });

  // Summary
  console.log('\n=== Summary ===');
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} tests passed`);
  for (const r of results) {
    console.log(`  ${r.pass ? 'OK' : '**'} ${r.name} (${r.elapsed}ms)`);
  }

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('Test harness error:', err);
  process.exit(1);
});
