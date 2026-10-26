import { useEffect, useRef, useState } from 'react';
import type { AttentionSummary } from '../../../shared/types';
import type { SessionStatusColor } from '../StatusDot';
import type { PoseName } from '../mascot/mascot-poses';

/**
 * What the buddy is doing, from the same colours the status dots show (buddy rebuild, 2026-10-25):
 * buddy-rebuild-questions#Q-7 "he visibly reacts when Claude is working, finishes, or needs you, matching the dot
 * colours", and #Q-8 / card 85c "small spontaneous moments (a glance, a stretch, dozing off after a few quiet minutes,
 * waking when anything happens), always quieter than the 'a session needs you' animation and stopping the instant a
 * session turns red, amber or blue".
 *
 *   alert    a session is red or amber — today's shocked pose and bounce, unchanged
 *   working  a session is green — a focused look (the curious face)
 *   done     a session just turned blue (a reply is ready) — a short wave, then back to resting
 *   glance / stretch   short idle moments while nothing is happening
 *   sleep    nothing has changed for SLEEP_AFTER_MS — the signed-off sleep pose
 *   idle     resting
 */
export type MascotMood = 'alert' | 'working' | 'done' | 'glance' | 'stretch' | 'sleep' | 'idle';

/** The strongest colour across every session, in the dots' own order of urgency. */
export function strongestStatus(summary: AttentionSummary | null): SessionStatusColor {
  const rank: Record<SessionStatusColor, number> = { red: 4, amber: 3, green: 2, blue: 1, gray: 0 };
  let best: SessionStatusColor = 'gray';
  for (const s of Object.values(summary?.perSession ?? {})) {
    const c = (s?.status ?? 'gray') as SessionStatusColor;
    if ((rank[c] ?? 0) > rank[best]) best = c;
  }
  return best;
}

/** The pose each mood draws; 'alert' keeps BuddyMascot's own shocked pose and bounce. */
export const MOOD_POSE: Record<MascotMood, PoseName> = {
  alert: 'shocked',
  working: 'curious',
  done: 'welcome',
  glance: 'curious',
  stretch: 'flap',
  sleep: 'sleep',
  idle: 'idle',
};

export const DONE_MS = 2400;
export const SLEEP_AFTER_MS = 4 * 60_000;
/** An idle moment comes every 70–130 s while nothing is happening (randomised so it never feels mechanical). */
export const MOMENT_MIN_MS = 70_000;
export const MOMENT_SPREAD_MS = 60_000;
export const GLANCE_MS = 1600;
export const STRETCH_MS = 900;

/**
 * The mood for `summary`. Owns its timers: the 'done' beat, the idle moments and the sleep countdown. Every change of
 * the strongest colour restarts the quiet clock — that is "waking when anything happens".
 */
export function useMascotMood(summary: AttentionSummary | null, reducedEffects: boolean): MascotMood {
  const status = strongestStatus(summary);
  const [beat, setBeat] = useState<'done' | 'glance' | 'stretch' | 'sleep' | null>(null);
  const prevStatus = useRef(status);

  // A change of colour: a fresh blue plays the 'done' wave; anything else simply wakes him.
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (prev === status) return;
    if (status === 'blue' && prev !== 'blue' && !reducedEffects) {
      setBeat('done');
      const t = setTimeout(() => setBeat(null), DONE_MS);
      return () => clearTimeout(t);
    }
    setBeat(null);
  }, [status, reducedEffects]);

  // While quiet (grey or an already-seen blue, no beat playing): idle moments, then sleep. Never while red, amber or green.
  const quiet = (status === 'gray' || status === 'blue') && beat !== 'done';
  useEffect(() => {
    if (!quiet || reducedEffects || beat === 'sleep') return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const sleepAt = setTimeout(() => setBeat('sleep'), SLEEP_AFTER_MS);
    timers.push(sleepAt);
    let which: 'glance' | 'stretch' = 'glance';
    const schedule = () => {
      const t = setTimeout(() => {
        const moment = which;
        which = which === 'glance' ? 'stretch' : 'glance';
        setBeat(moment);
        timers.push(setTimeout(() => { setBeat((b) => (b === moment ? null : b)); schedule(); }, moment === 'glance' ? GLANCE_MS : STRETCH_MS));
      }, MOMENT_MIN_MS + Math.random() * MOMENT_SPREAD_MS);
      timers.push(t);
    };
    schedule();
    return () => timers.forEach(clearTimeout);
    // `beat` changes on every moment; only quiet/sleep entry restart this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quiet, reducedEffects, beat === 'sleep']);

  if (status === 'red' || status === 'amber') return 'alert';
  if (status === 'green') return 'working';
  return beat ?? 'idle';
}
