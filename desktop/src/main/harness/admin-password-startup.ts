// admin-password-startup.ts — the app-start wiring for the admin password card,
// moved out of ipc-handlers.ts (which sits at its line budget). It builds ONE
// AskpassServer for the app's whole life (Linux only for now: design §11 —
// macOS stays off, Windows never needs one), decides this machine's
// AdminCapability, attaches the password service only when the card can
// really appear, and ALWAYS settles the capability — because session creation
// awaits it (admin-capability.ts), a failure anywhere here must still settle,
// conservatively, never leave conversations waiting.
import { log } from '../logger';
import { AskpassServer } from './askpass/askpass-server';
import { settleAdminCapability, detectAdminCapability } from './admin-capability';
import { forgetOnQuit } from './askpass/admin-forget';
import type { NativeSessionHost } from './native-session-host';

type AskpassPaths = { helperScriptRealpath: string; wrapperRealpath: string };

/** Starts the feature (fire-and-forget) and returns the quit-time teardown. */
export function startAdminPassword(
  nativeHost: NativeSessionHost,
  // Passed in rather than imported: it lives in ipc-handlers.ts (tests import
  // it from there), and importing it here would make the two files a cycle.
  resolveAskpassPaths: () => Promise<AskpassPaths | null>,
): () => void {
  let askpassServer: AskpassServer | null = null;
  if (process.platform === 'linux') {
    void (async () => {
      const paths = await resolveAskpassPaths();
      if (!paths) {
        log('WARN', 'AdminPassword', 'askpass.cjs/youcoded-askpass not found — sudo commands will fail exactly as before this feature existed');
        settleAdminCapability('no-password-only');
        return;
      }
      // T5-1: `helperScriptRealpath` (askpass.cjs) feeds ONLY the verifier's
      // argv[1] check; `wrapperRealpath` (youcoded-askpass) is the ONLY value
      // that may ever become SUDO_ASKPASS — sudo execs the wrapper, never
      // askpass.cjs directly.
      askpassServer = new AskpassServer({
        execPath: process.execPath,
        helperScriptRealpath: paths.helperScriptRealpath,
        runningCalls: nativeHost.runningCallsForAskpass(),
      });
      await askpassServer.start();
      // The sudo-flavour probe is handed THIS self-test's outcome rather than
      // building a second server to ask the same question.
      const capability = await detectAdminCapability({ askpassSelfTestPassed: askpassServer.available });
      if (capability === 'card') nativeHost.attachAdminPassword(askpassServer, paths.wrapperRealpath);
      settleAdminCapability(capability);
    })().catch((err: unknown) => {
      log('WARN', 'AdminPassword', 'startup failed — the password card is off this run', { error: err instanceof Error ? err.message : String(err) });
      settleAdminCapability('no-password-only');
    });
  } else {
    // macOS/Windows: no server is ever built; settle straight from the platform.
    void detectAdminCapability({ askpassSelfTestPassed: false })
      .then(settleAdminCapability, () => settleAdminCapability('no-password-only'));
  }
  return () => {
    // Quit: refuse every still-open password ask (stop() answers each pending
    // one {"ok":false} and removes the socket), then the forget step's final
    // sweep. Fire-and-forget, like the session teardown beside it.
    void askpassServer?.stop().catch(() => {});
    forgetOnQuit(nativeHost.runningCallsForAskpass());
  };
}
