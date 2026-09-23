// Experiment-only model request gate. Never send prompt, auth or session data.
// WHY: one experiment entry point keeps the already budgeted main process unchanged.
export { openLunaAuthBrowser } from './luna-browser-open';
export function experimentGuardForProfile(
  profile: string | undefined, isPackaged: boolean, optIn: string | undefined,
  address: string | undefined, request?: typeof fetch,
): (() => Promise<void>) | undefined {
  // WHY isPackaged returns (not throws): the installed app must IGNORE a stray
  // YOUCODED_LUNA_EXPERIMENT in the user's environment, never crash on launch over it.
  if (optIn !== '1' || isPackaged) return undefined;
  // WHY: main.ts uses the profile as a path component. An arbitrary nonempty
  // value can traverse back into the installed app's userData; require the one
  // experiment profile instead of trusting caller-provided path syntax.
  if (profile !== 'luna-eval') throw new Error('Luna experiment requires the dedicated dev profile.');
  return createExperimentRequestGuard(address ?? '', request);
}

export function createExperimentRequestGuard(address: string, request: typeof fetch = fetch): () => Promise<void> {
  const url = new URL(address);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Experiment request guard needs a loopback address.');
  }
  return async () => {
    let response: Response;
    try {
      // WHY: fail before the Codex model fetch if the private controller dies.
      // The reservation is bodyless and has no copied model headers.
      response = await request(`${url.origin}/reserve`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw new Error('Experiment request guard unavailable.');
    }
    if (response.status === 429) throw new Error('Experiment request ceiling reached.');
    if (response.status !== 204) throw new Error('Experiment request guard unavailable.');
  };
}
