import { useCallback, useEffect, useRef, useState } from 'react';
import type { TakeoverDialogPhase } from '../components/takeover-dialog-copy';

type Prompt = { device: string; phase: TakeoverDialogPhase };
type PendingPrompt = Prompt & { resolve: (choice: boolean) => void };

/** Shared ownership dialog: serialize consent, never independent startup work. */
export function useTakeoverPrompts() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const pending = useRef<PendingPrompt[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // WHY drain every resolver: unmount must not strand batch recovery, and
      // late lease-query replies must not open a dialog on a departed screen.
      for (const ask of pending.current.splice(0)) ask.resolve(false);
    };
  }, []);
  const ask = useCallback((device: string, phase: TakeoverDialogPhase): Promise<boolean> => {
    if (!mounted.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      // WHY queue: replacing a single resolver silently declined earlier asks
      // when several concurrent restores discovered another device's ownership.
      pending.current.push({ device, phase, resolve });
      if (pending.current.length === 1) setPrompt({ device, phase });
    });
  }, []);
  const answer = useCallback((choice: boolean) => {
    const current = pending.current.shift();
    const next = pending.current[0];
    setPrompt(next ? { device: next.device, phase: next.phase } : null);
    current?.resolve(choice);
  }, []);
  return { prompt, ask, answer };
}
