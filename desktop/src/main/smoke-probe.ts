// The installer builds' launch check (scripts/smoke-test.js) starts the packaged
// app with YOUCODED_SMOKE_TEST=1 and waits for ONE line on stdout. This module
// is the app's side of that agreement.
//
// WHY a dedicated answer instead of the check reading ordinary log lines: it
// used to wait for "Hooks installed" and "RemoteServer", two background
// messages unrelated to whether the window drew anything. A refactor moved the
// first into desktop.log and every installer build timed out with the app
// healthy (beta.81, 2026-09-19) — and a blank window would have passed as long
// as both messages printed. This asks the question the check exists for: did
// the main window's React root actually render?
import type { WebContents } from 'electron';

export const SMOKE_READY = '[smoke] ready';
export const SMOKE_BLANK = '[smoke] failed: blank window';

const POLL_MS = 500;
const GIVE_UP_MS = 20_000; // under the check's own 30s timeout

export function isSmokeTest(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YOUCODED_SMOKE_TEST === '1';
}

// Poll the renderer until #root has children (React mounted) or give up.
// Only ever runs in the launch check — never in normal use.
export function reportWhenRendered(
  wc: WebContents,
  print: (line: string) => void = (l) => console.log(l),
): void {
  const started = Date.now();
  const tick = async () => {
    let mounted = false;
    try {
      mounted = await wc.executeJavaScript(
        "(document.getElementById('root')?.childElementCount ?? 0) > 0",
      );
    } catch { /* window navigating or gone — treat as not yet mounted */ }
    if (mounted) return print(SMOKE_READY);
    if (Date.now() - started >= GIVE_UP_MS) return print(SMOKE_BLANK);
    setTimeout(() => { void tick(); }, POLL_MS);
  };
  wc.once('did-finish-load', () => { void tick(); });
}
