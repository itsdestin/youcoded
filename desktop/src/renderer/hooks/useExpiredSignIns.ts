// Card #236 (round 2 Q-dot "red"): is any connected sign-in expired? Feeds the
// Settings gear's red dot.
//
// WHY when it reads (Destin, 2026-09-14 Q-check-when): "on app open and when a
// message fails. dont need the every 30 min check". So: once when the window opens,
// again whenever a sign-in finishes (the dot must clear itself), and again when a
// reply comes back "sign-in failed" (`recheckExpiredSignIns`). No timer.
import { useEffect, useState } from 'react';
import { useSignInPhase } from '../state/provider-sign-in-store';

const recheckers = new Set<() => void>();
/** Ask again — called when a reply comes back "sign-in failed". */
export function recheckExpiredSignIns(): void { for (const r of recheckers) r(); }

export function useExpiredSignIns(): boolean {
  const [expired, setExpired] = useState(false);
  const [nonce, setNonce] = useState(0);
  // A sign-in that finishes anywhere is a reason to look again.
  const phases = [useSignInPhase('claude').phase, useSignInPhase('chatgpt').phase, useSignInPhase('openrouter').phase].join();
  useEffect(() => {
    const again = () => setNonce((n) => n + 1);
    recheckers.add(again);
    return () => { recheckers.delete(again); };
  }, []);
  useEffect(() => {
    let alive = true;
    const api = (window as any).claude;
    // Each answer is optional: a surface without a channel says nothing, never "expired".
    void Promise.all([
      Promise.resolve(api?.claudeCode?.status?.(nonce > 0 ? { refresh: true } : undefined)).catch(() => null),
      api?.chatgpt?.supported === true ? Promise.resolve(api.chatgpt.status()).catch(() => null) : null,
      Promise.resolve(api?.providers?.list?.()).catch(() => null),
    ]).then(([claude, chatgpt, providers]: any[]) => {
      if (!alive) return;
      setExpired(
        (claude?.state === 'signed-in' && claude.expired === true)
        || (chatgpt?.state === 'signed-out' && chatgpt.expired === true)
        || (Array.isArray(providers) && providers.some((p: any) => p?.type === 'openrouter' && p.hasKey && p.health?.verdict === 'rejected')),
      );
    });
    return () => { alive = false; };
  }, [nonce, phases]);
  return expired;
}
