import { execFile } from 'node:child_process';

// WHY (task 93, 2026-10-24): on KDE the wallet daemons (ksecretd / kwalletd6) are started on demand, and can be gone when the app
// launches (they exit when idle). Electron's safeStorage.isEncryptionAvailable() is SYNCHRONOUS, so the first call made the whole app
// wait for them to start: 4.1 s and 8.2 s freezes, every window, right after launch (hitch log + desktop.log "keychain-available"
// matched to the millisecond; the daemons' start times matched the app's launch). Pinging the services first, as an ordinary
// asynchronous child process, wakes them without blocking anything; the native call then finds them already running.
const WALLET_SERVICES = ['org.kde.kwalletd6', 'org.freedesktop.secrets'];
const PING_TIMEOUT_S = 8;

type Exec = (file: string, args: string[], opts: { timeout: number }) => Promise<unknown>;

const realExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => { execFile(file, args, opts, (err, out) => (err ? reject(err) : resolve(out))); });

/** One shared, never-rejecting warm-up. Any failure (no busctl, no such service, no session bus) just means "no help": the caller then
 *  does exactly what it did before this existed. */
export function createKeychainWarmup(exec: Exec = realExec, env: NodeJS.ProcessEnv = process.env): () => Promise<void> {
  let once: Promise<void> | null = null;
  return () => {
    if (once) return once;
    if (!env.DBUS_SESSION_BUS_ADDRESS) return (once = Promise.resolve());
    once = Promise.all(WALLET_SERVICES.map((svc) =>
      exec('busctl', ['--user', `--timeout=${PING_TIMEOUT_S}`, 'call', svc, '/', 'org.freedesktop.DBus.Peer', 'Ping'],
        { timeout: (PING_TIMEOUT_S + 1) * 1000 }).catch(() => undefined),
    )).then(() => undefined);
    return once;
  };
}
