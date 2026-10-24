import type { GoogleFilesBridge } from '../../../shared/google-files-channels';
import type { GoogleAuthState } from '../../../shared/google-files-types';

type AuthApi = Pick<GoogleFilesBridge, 'beginAuth' | 'authState' | 'cancelAuth'>;
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Sign-in canceled.', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 750);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Only a pending, user-started sign-in polls; closing its dialog closes the loopback flow. */
export async function authorizeGoogleFiles(api: AuthApi, accountId: string | undefined, signal: AbortSignal, wait = pause): Promise<Extract<GoogleAuthState, { state: 'complete' }>> {
  signal.throwIfAborted();
  const { flowId } = await api.beginAuth(accountId);
  let complete = false;
  try {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const result = await api.authState(flowId);
      signal.throwIfAborted();
      if (result.state === 'complete') { complete = true; return result; }
      if (result.state === 'error') throw new Error(result.error);
      await wait(signal);
    }
    throw new Error('Google sign-in timed out. Try again.');
  } finally {
    if (!complete) await api.cancelAuth(flowId).catch(() => {});
  }
}
