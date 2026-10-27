// headless-main.ts — entry point of the headless backend: `node dist/main/headless/headless-main.js`.
//
// WHY (2026-10-14, Android clean rebuild P1): see headless-boot.ts. The Android app starts this with
// YOUCODED_HEADLESS_PORT and YOUCODED_HEADLESS_TOKEN (and YOUCODED_USER_DATA, YOUCODED_SECRET_KEY,
// YOUCODED_HOST_SOCKET); on a laptop it can be run by hand to test the phone's backend in a browser
// pointed at the built page with ?bridgePort=<port>&bridgeToken=<token>.
// WHY (2026-10-22 freeze hunt): same as bootstrap.ts — 16 libuv threads so a stalled disk cannot occupy
// all 4 default ones and queue every other async fs call. Must precede any import that touches the
// disk. (Statements before imports are safe: TypeScript emits CommonJS in source order.)
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';
import './install-electron-shim'; // must be first: every backend module below imports `electron`
import fs from 'fs';

function fail(message: string): never {
  console.error(`[headless] ${message}`);
  process.exit(2);
}

/** The owner token and the secrets key. WHY not the environment (independent review, 2026-10-15): every terminal this
 *  backend starts inherits its environment (pty-worker.js), and on the phone everything runs as the app's one user,
 *  so Claude Code — or any tool it runs — could read them there, or from this process's own /proc/<pid>/environ, and
 *  print them into a conversation that syncs. The Android app writes them as ONE JSON line on this process's stdin
 *  (YOUCODED_SECRETS_ON_STDIN=1) and closes it; a laptop test run may still pass them as variables. */
function readSecrets(): { token: string; key: string | undefined } {
  if (process.env.YOUCODED_SECRETS_ON_STDIN !== '1') {
    const fromEnv = { token: process.env.YOUCODED_HEADLESS_TOKEN ?? '', key: process.env.YOUCODED_SECRET_KEY };
    delete process.env.YOUCODED_SECRET_KEY;
    delete process.env.YOUCODED_HEADLESS_TOKEN;
    return fromEnv;
  }
  const buf = Buffer.alloc(4096);
  let text = '';
  while (!text.includes('\n')) {
    const n = fs.readSync(0, buf, 0, buf.length, null);
    if (n <= 0) break;
    text += buf.toString('utf8', 0, n);
  }
  const line = JSON.parse(text.split('\n')[0] || '{}') as { token?: string; key?: string };
  return { token: line.token ?? '', key: line.key };
}

const port = Number(process.env.YOUCODED_HEADLESS_PORT);
const { token, key } = readSecrets();
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the stand-in itself, loaded by path after the hook
(require('./electron-headless') as typeof import('./electron-headless')).holdSecretKey(key);
if (!Number.isInteger(port) || port <= 0 || port > 65535) fail('YOUCODED_HEADLESS_PORT must be a port number.');
if (token.length < 32) fail('YOUCODED_HEADLESS_TOKEN must be at least 32 characters.');

// A stray rejection in one feature must not take the whole phone backend down with it.
process.on('unhandledRejection', (reason) => console.error('[headless] unhandled rejection:', reason));

// eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the shim on purpose
const { bootHeadless } = require('./headless-boot') as typeof import('./headless-boot');
bootHeadless({ port, token }).then(({ stop }) => {
  const shutdown = () => { void stop().finally(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}).catch((e) => fail(`Could not start: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
