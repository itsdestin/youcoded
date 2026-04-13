// Dev-mode orchestrator: starts Vite renderer, waits for it, then starts Electron main.
// Reads DESTINCODE_PORT_OFFSET to stay in sync with src/shared/ports.ts so dev can
// coexist with a running built app (see docs/local-dev.md in the workspace repo).
//
// Replaces the previous one-liner that hardcoded `wait-on http://localhost:5173` —
// with a port offset the wait-on URL must shift too, or Electron hangs forever.
const { spawn } = require('child_process');

const offset = Number(process.env.DESTINCODE_PORT_OFFSET ?? 0);
const vitePort = 5173 + (Number.isFinite(offset) ? offset : 0);
const viteUrl = `http://localhost:${vitePort}`;

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const npxCmd = isWin ? 'npx.cmd' : 'npx';

// shell:true is required on Windows for .cmd shims (npm.cmd, npx.cmd). Safe on
// other platforms — we only pass trusted, hardcoded argv values, no user input.
function run(cmd, args, label) {
  const child = spawn(cmd, args, { stdio: 'inherit', env: process.env, shell: true });
  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[run-dev] ${label} exited with code ${code}`);
      process.exit(code ?? 1);
    }
  });
  return child;
}

console.log(`[run-dev] Vite → ${viteUrl}`);

const renderer = run(npmCmd, ['run', 'dev:renderer'], 'dev:renderer');

// wait-on polls the URL until it's reachable, then we kick off Electron.
const waiter = spawn(npxCmd, ['wait-on', viteUrl], { stdio: 'inherit', env: process.env, shell: true });
waiter.on('exit', (code) => {
  if (code !== 0) {
    console.error(`[run-dev] wait-on failed with code ${code}`);
    renderer.kill();
    process.exit(code ?? 1);
  }
  run(npmCmd, ['run', 'dev:main'], 'dev:main');
});

const shutdown = () => {
  renderer.kill();
  waiter.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
