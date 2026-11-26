// provider-sign-in-store.ts — one "Sign in again" flow per provider, shared by every
// surface that offers it (card #236).
//
// WHY one store, not state in each button: the same expired sign-in is offered in
// several places at once — the card in the chat, the provider's row in Settings,
// and (for ChatGPT/OpenRouter) the red error card. If each kept its own "waiting
// for the browser" state, pressing one would leave the others still offering a
// second browser tab, and finishing in one would leave the others saying "expired".
// Every surface reads this store, so they all move together.
//
// WHY the connection check comes first (Destin, 2026-09-14 S-honest +
// Q-offline-signin "stop and say so"): offline, the browser opened onto a page that
// never loads and the app waited minutes before saying "timed out", which sounds
// like the user's fault. The check runs in main (`network.check`), which only says
// offline when its own probe failed twice — never a guess from an error message
// (docs/error-message-standards.md).
import { useSyncExternalStore } from 'react';

export type SignInProvider = 'claude' | 'chatgpt' | 'openrouter';

export type SignInPhase =
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** The browser is open; waiting for the person to finish there. */
  | { phase: 'waiting' }
  /** The app's own connection check failed — the browser was never opened. */
  | { phase: 'offline' }
  /** Signing in did not finish. `message` is the backend's own sentence. */
  | { phase: 'failed'; message: string }
  /** Signed in again this run of the app. */
  | { phase: 'signed-in' };

const IDLE: SignInPhase = { phase: 'idle' };
const phases = new Map<SignInProvider, SignInPhase>();
const listeners = new Set<() => void>();

function set(provider: SignInProvider, next: SignInPhase) {
  phases.set(provider, next);
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The phase for one provider. Each reader re-renders only when the store changes,
 *  and the snapshot is the same object until then (useSyncExternalStore). */
export function useSignInPhase(provider: SignInProvider): SignInPhase {
  return useSyncExternalStore(subscribe, () => phases.get(provider) ?? IDLE, () => IDLE);
}

/** Forget a finished outcome (signed-in / failed / offline) so a NEW expiry draws the red card again.
 *  WHY (card #236 review F1): the phase lives for the whole app run, so after one successful sign-in every
 *  later expiry card would have drawn the green "Sign in successful" with no button. An open sign-in
 *  (checking / waiting) is never reset. Called when a card for a fresh expiry appears. */
export function resetSignIn(provider: SignInProvider): void {
  const p = phases.get(provider)?.phase;
  if (p === 'signed-in' || p === 'failed' || p === 'offline') set(provider, IDLE);
}

/** Start the browser sign-in the first-launch screen uses. Resolves when it ends. */
export async function startSignIn(provider: SignInProvider): Promise<void> {
  const current = phases.get(provider)?.phase;
  if (current === 'checking' || current === 'waiting') return; // one browser tab, whichever button was pressed
  set(provider, { phase: 'checking' });
  const api = (window as any).claude;
  try {
    const net = await api.network?.check?.();
    if (net && net.online === false) { set(provider, { phase: 'offline' }); return; }
  } catch { /* A check that itself failed proves nothing — go on and let the sign-in say what happened. */ }
  set(provider, { phase: 'waiting' });
  try {
    // All three verbs answer as soon as the browser is open (true), or false when it
    // could not start; the end of the sign-in is read from the provider's status below.
    const opened = provider === 'claude' ? await api.claudeCode.signIn()
      : provider === 'chatgpt' ? await api.chatgpt.signIn()
      : await api.openrouter.signIn();
    if (!opened) { set(provider, IDLE); return; }
  } catch (err) {
    // The backend THROWS a sentence written for the screen (chatgpt/openrouter already do).
    set(provider, { phase: 'failed', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  // Wait for the person to finish in the browser. WHY a slow poll and not a push: the
  // three providers already answer `status()` and none pushes; this runs only while a
  // sign-in is open, stops the moment it ends, and gives up after the backends' own
  // longest wait (ChatGPT's 10 minutes).
  const started = Date.now();
  while (phases.get(provider)?.phase === 'waiting' && Date.now() - started < 10 * 60_000) {
    await new Promise((r) => setTimeout(r, 1500));
    if (phases.get(provider)?.phase !== 'waiting') return; // Cancel pressed meanwhile
    try {
      const outcome = await readOutcome(provider, api);
      if (outcome === 'done') { set(provider, { phase: 'signed-in' }); return; }
      if (outcome && typeof outcome === 'object') { set(provider, { phase: 'failed', message: outcome.failed }); return; }
    } catch { /* one unanswered status read is not a failed sign-in — ask again */ }
  }
  if (phases.get(provider)?.phase === 'waiting') set(provider, { phase: 'failed', message: 'The sign-in timed out.' });
}

/** Has the open sign-in finished? 'done', a failure sentence, or null (still going). */
async function readOutcome(provider: SignInProvider, api: any): Promise<'done' | { failed: string } | null> {
  if (provider === 'claude') {
    // WHY no `refresh` (review F6): main's own sign-in loop already re-reads every 2 s; asking for a fresh
    // read here too ran a second `claude auth status` process loop for the whole wait.
    const s = await api.claudeCode.status();
    return s?.state === 'signed-in' && s.expired !== true ? 'done' : null;
  }
  if (provider === 'chatgpt') {
    const s = await api.chatgpt.status();
    return s?.state === 'signed-in' ? 'done' : null;
  }
  const s = await api.openrouter.status();
  if (s?.state === 'failed') return { failed: s.message ?? "OpenRouter didn't finish signing in." };
  return s?.state === 'idle' ? 'done' : null;
}

export function cancelSignIn(provider: SignInProvider): void {
  const api = (window as any).claude;
  const cancel = provider === 'claude' ? api.claudeCode?.cancelSignIn
    : provider === 'chatgpt' ? api.chatgpt?.cancelSignIn : api.openrouter?.cancelSignIn;
  void Promise.resolve(cancel?.()).catch(() => {});
  set(provider, IDLE);
}
