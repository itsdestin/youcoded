// WHY (2026-10-22 freeze hunt): Node runs every async fs call on a pool of only 4 helper threads
// (libuv). On a nearly-full btrfs disk a few stalled reads/writes can occupy all 4 and queue EVERY
// other async fs call behind them, which the app sees as a freeze even though the main thread is idle.
// 16 threads leaves room for the rest to keep flowing. The pool is created lazily on the first async
// fs/dns/crypto call and its size is read ONLY then, so this must run before anything else loads:
// this file is the app's entry point (package.json "main") and does nothing before this line.
// An explicit value set by the person/launcher wins. (headless-main.ts does the same for Android.)
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

// WHY: a recovery helper needs a fresh Electron keychain connection, not a
// second application. Conditional require keeps normal app imports (and their
// hooks, servers, windows and state writes) entirely out of the helper process.
if (process.env.YOUCODED_KEYCHAIN_HELPER === '1') {
  require('./providers/keychain-helper');
} else {
  require('./main');
}
