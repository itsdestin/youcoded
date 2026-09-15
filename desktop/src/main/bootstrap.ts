// WHY: a recovery helper needs a fresh Electron keychain connection, not a
// second application. Conditional require keeps normal app imports (and their
// hooks, servers, windows and state writes) entirely out of the helper process.
if (process.env.YOUCODED_KEYCHAIN_HELPER === '1') {
  require('./providers/keychain-helper');
} else {
  require('./main');
}
