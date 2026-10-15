// headless-main.ts — entry point of the headless backend: `node dist/main/headless/headless-main.js`.
//
// WHY (2026-10-14, Android clean rebuild P1): see headless-boot.ts. The Android app starts this with
// YOUCODED_HEADLESS_PORT and YOUCODED_HEADLESS_TOKEN (and YOUCODED_USER_DATA, YOUCODED_SECRET_KEY,
// YOUCODED_HOST_SOCKET); on a laptop it can be run by hand to test the phone's backend in a browser
// pointed at the built page with ?bridgePort=<port>&bridgeToken=<token>.
import './install-electron-shim'; // must be first: every backend module below imports `electron`

function fail(message: string): never {
  console.error(`[headless] ${message}`);
  process.exit(2);
}

const port = Number(process.env.YOUCODED_HEADLESS_PORT);
const token = process.env.YOUCODED_HEADLESS_TOKEN ?? '';
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
