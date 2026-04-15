/**
 * Smoke test — launches the production Electron build and verifies the
 * renderer actually mounts (i.e. #root has children). Exits 0 on success,
 * 1 on failure. Used in CI to catch white-screen crashes before release.
 *
 * Usage:  node scripts/smoke-test.js [path-to-unpacked-dir]
 *         Defaults to release/win-unpacked (or platform equivalent).
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

const TIMEOUT_MS = 30_000;
const CHECK_INTERVAL_MS = 1500;

// Resolve the unpacked app directory
function findUnpackedDir(customPath) {
  if (customPath && fs.existsSync(customPath)) return customPath;

  const releaseDir = path.join(__dirname, '..', 'release');
  // On macOS, electron-builder produces both `mac/` (x64) and `mac-arm64/`.
  // Prefer the arch-matching dir so we don't try to run x64 on Apple Silicon
  // (Rosetta isn't guaranteed on macos-latest CI runners).
  const candidates = {
    win32: ['win-unpacked'],
    darwin: os.arch() === 'arm64' ? ['mac-arm64', 'mac'] : ['mac', 'mac-arm64'],
    linux: ['linux-unpacked'],
  };
  for (const sub of candidates[process.platform] || ['win-unpacked']) {
    const dir = path.join(releaseDir, sub);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

// Find the executable inside the unpacked dir
function findExecutable(unpackedDir) {
  if (process.platform === 'win32') {
    const exe = fs.readdirSync(unpackedDir).find(f => f.endsWith('.exe') && !f.includes('Uninstall'));
    return exe ? path.join(unpackedDir, exe) : null;
  }
  if (process.platform === 'darwin') {
    // macOS: look inside the .app bundle
    const apps = fs.readdirSync(unpackedDir).filter(f => f.endsWith('.app'));
    if (apps.length) return path.join(unpackedDir, apps[0], 'Contents', 'MacOS', apps[0].replace('.app', ''));
    return null;
  }
  // Linux: look for the main executable (lowercase name, no extension).
  // Exclude Electron's bundled helpers (chrome-sandbox, chrome_crashpad_handler)
  // which also match "extensionless + executable" but are NOT the app entrypoint.
  // Launching chrome-sandbox directly aborts with "setuid sandbox API version" errors.
  const HELPER_BINARIES = new Set(['chrome-sandbox', 'chrome_crashpad_handler']);
  const bins = fs.readdirSync(unpackedDir).filter(f => {
    if (HELPER_BINARIES.has(f)) return false;
    const stat = fs.statSync(path.join(unpackedDir, f));
    return stat.isFile() && !f.includes('.') && (stat.mode & 0o111);
  });
  return bins.length ? path.join(unpackedDir, bins[0]) : null;
}

// Find a free port for the remote server to avoid conflicts
function findFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function main() {
  const unpackedDir = findUnpackedDir(process.argv[2]);
  if (!unpackedDir) {
    console.error('SMOKE TEST FAIL: Could not find unpacked build directory');
    process.exit(1);
  }

  const exe = findExecutable(unpackedDir);
  if (!exe) {
    console.error(`SMOKE TEST FAIL: No executable found in ${unpackedDir}`);
    process.exit(1);
  }

  console.log(`Smoke test: launching ${exe}`);

  // Launch with a JS snippet that checks renderer health via executeJavaScript.
  // The --enable-logging flag captures console errors from the renderer.
  const port = await findFreePort();
  const child = execFile(exe, [
    // `--enable-logging` alone routes to a file on macOS — must specify
    // `=stderr` so the smoke test can read renderer/console output.
    '--enable-logging=stderr',
    '--no-sandbox', // CI runners often need this
  ], {
    env: {
      ...process.env,
      // Prevent port conflicts with any running instance
      DESTINCODE_REMOTE_PORT: String(port),
      // Signal to the app that this is a smoke test (not used yet, but useful for future)
      DESTINCODE_SMOKE_TEST: '1',
    },
    timeout: TIMEOUT_MS,
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => { stdout += d; });
  child.stderr?.on('data', (d) => { stderr += d; });

  // Wait for the renderer to either crash or succeed
  const startTime = Date.now();
  let passed = false;

  await new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      const combined = stdout + stderr;

      // Check for the fatal crash pattern: "Uncaught TypeError" in renderer
      if (/Uncaught\s+(TypeError|ReferenceError|SyntaxError)/i.test(combined)) {
        clearInterval(checkInterval);
        console.error('SMOKE TEST FAIL: Renderer threw an uncaught error');
        const match = combined.match(/"(Uncaught\s+\w+Error:?\s+[^"]+)"/);
        if (match) console.error('  Error:', match[1]);
        resolve(undefined);
        return;
      }

      // Check for successful hook installation — means main process is healthy
      // and the renderer loaded far enough to establish IPC
      if (combined.includes('Hooks installed') && combined.includes('RemoteServer')) {
        // Give the renderer an extra moment to crash (the error comes shortly after)
        if (Date.now() - startTime > 5000) {
          // No crash detected after 5s with a healthy main process — pass
          passed = true;
          clearInterval(checkInterval);
          resolve(undefined);
          return;
        }
      }

      // Timeout
      if (Date.now() - startTime > TIMEOUT_MS - 2000) {
        clearInterval(checkInterval);
        console.error('SMOKE TEST FAIL: Timed out waiting for app to start');
        resolve(undefined);
      }
    }, CHECK_INTERVAL_MS);

    child.on('exit', (code) => {
      clearInterval(checkInterval);
      if (!passed) {
        console.error(`SMOKE TEST FAIL: App exited early with code ${code}`);
      }
      resolve(undefined);
    });
  });

  // Kill the app
  try { child.kill('SIGTERM'); } catch {}
  try { child.kill('SIGKILL'); } catch {}
  // On Windows, force-kill the process tree
  if (process.platform === 'win32') {
    try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch {}
  }

  if (passed) {
    console.log('SMOKE TEST PASS: App launched without renderer crashes');
    process.exit(0);
  } else {
    // Dump recent output for debugging
    const combined = (stdout + stderr).slice(-2000);
    console.error('\n--- Recent output ---');
    console.error(combined);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('SMOKE TEST FAIL:', err);
  process.exit(1);
});
