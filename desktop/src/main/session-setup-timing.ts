import { performance } from 'node:perf_hooks';
import { log } from './logger';

export type SetupStage = 'native-profile' | 'native-skills' | 'native-specialists' | 'native-instructions' | 'native-mcp' | 'claude-context' | 'keychain-available' | 'keychain-encrypt' | 'keychain-decrypt';

/** Stage elapsed time is NOT proof of blocking: an awaited network request can
 * be slow while the app stays responsive. Correlate these with hitch records. */
export async function timeSessionSetup<T>(stage: SetupStage, operation: () => Promise<T>): Promise<T> {
  const start = performance.now();
  let outcome: 'ok' | 'failed' = 'failed';
  try {
    const value = await operation();
    outcome = 'ok';
    return value;
  } finally {
    // WHY: the tab is announced before setup finishes. Slow-stage timings let
    // the next freeze be correlated with the work after that announcement,
    // without prompts, file paths, credentials, results or error messages.
    const durationMs = Math.round(performance.now() - start);
    if (durationMs >= 100) {
      try { log('INFO', 'SessionSetup', 'slow setup stage', { stage, durationMs, outcome }); }
      catch { /* diagnostics must never replace the operation's result/error */ }
    }
  }
}
