// The launch decision: does this device open on the setup screen or the app?
//
// WHY this exists (2026-11-25, Android setup review): App used to wait 3 s for the answer and then ASSUME setup was
// finished. A phone whose backend was still starting (or a desktop whose sign-in check was slow) therefore skipped
// setup entirely: the main screen opened with no account, the first message failed and nothing was reported. Now the
// loading screen waits much longer, a failed ask is asked again, and an answer that arrives after the wait gave up
// still sends the person to setup.

/** How long the loading screen waits for the setup answer before opening the app anyway. Never hang for good. */
export const FIRST_RUN_ANSWER_WAIT_MS = 20_000;
/** How soon a failed ask (the phone's backend not listening yet) is asked again. */
const FIRST_RUN_RETRY_MS = 1_000;

type SetupState = { currentStep?: string } | null | undefined;

/**
 * Calls `decide(true|false)` once with the launch answer, and later `decide(true)` once more if a late answer says
 * setup is still needed after the wait had already opened the app. Returns a stop function for unmount.
 */
export function decideFirstRun(
  getState: (() => Promise<SetupState>) | undefined,
  decide: (needsSetup: boolean) => void,
  opts: { waitMs?: number; retryMs?: number } = {},
): () => void {
  const waitMs = opts.waitMs ?? FIRST_RUN_ANSWER_WAIT_MS;
  const retryMs = opts.retryMs ?? FIRST_RUN_RETRY_MS;
  let decided = false;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const needs = (s: SetupState) => !!(s && s.currentStep !== 'COMPLETE');

  // No setup channel at all (an old or partial bridge): nothing to wait for.
  if (typeof getState !== 'function') { decide(false); return () => {}; }

  const giveUp = setTimeout(() => { if (!decided && !stopped) { decided = true; decide(false); } }, waitMs);

  const ask = () => {
    if (stopped) return;
    getState().then((state) => {
      if (stopped) return;
      if (!decided) { decided = true; clearTimeout(giveUp); decide(needs(state)); return; }
      // The wait already opened the app; a late "setup needed" still wins, so nobody is left signed out in an empty app.
      if (needs(state)) decide(true);
    }, () => {
      // A failed ask is usually a backend still starting; ask again until the wait runs out.
      if (stopped || decided) return;
      retry = setTimeout(ask, retryMs);
    });
  };
  ask();

  return () => { stopped = true; clearTimeout(giveUp); if (retry) clearTimeout(retry); };
}
