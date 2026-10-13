import { useEffect, useRef } from 'react';
import { playSound } from '../utils/sounds';
import { playSoundOncePerBurst } from '../utils/sound-burst';

/**
 * The 'attention' sound: plays when one of THIS window's sessions turns red (awaiting approval). Red is a visible state, so
 * colour-driven dedup is correct here.
 *
 * WHY `oncePerBurst` (phone only): on a phone's reconnect or first summary, several sessions can already be red and each one is
 * "first seen red", which used to play one sound per session. With it on, any number of sessions turning red together sound once;
 * a session that turns red later, on its own, still sounds. The computer passes false and plays exactly as before.
 *
 * WHY it walks `sessions` rather than the whole map (2026-09-07): sessionStatuses also contains sessions OTHER windows own;
 * chiming on those would play the same alert once per open window on top of the owner's own chime.
 */
export function useAttentionSound(
  sessions: ReadonlyArray<{ id: string }>,
  statuses: ReadonlyMap<string, string>,
  oncePerBurst: boolean,
): void {
  const prevRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const prev = prevRef.current;
    const next = new Map<string, string>();
    let newRed = 0;
    for (const s of sessions) {
      const color = statuses.get(s.id);
      if (!color) continue;
      next.set(s.id, color);
      if (color === 'red' && prev.get(s.id) !== 'red') newRed++;
    }
    prevRef.current = next;
    // Computer: one sound per newly-red session, exactly as before this hook existed.
    if (oncePerBurst) { if (newRed > 0) playSoundOncePerBurst('attention'); }
    else for (let i = 0; i < newRed; i++) playSound('attention');
  }, [statuses, sessions, oncePerBurst]);
}
