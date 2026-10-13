import { playSound, type SoundCategory } from './sounds';

/**
 * How long after a chime the same chime stays quiet.
 *
 * WHY 1.5 s: a phone reconnecting hears about every waiting conversation in one push, and a few more can follow from the
 * slower status feed within a second or so — all of that is ONE "come look" moment and must sound once. It is also about as
 * long as a chime itself lasts, so a second one inside it would only overlap the first. It is short enough that two asks
 * that really are separate (seconds apart) each still get their own sound.
 */
export const SOUND_BURST_WINDOW_MS = 1500;

const quiet = new Set<SoundCategory>();

/**
 * Play a chime, unless the same chime already played within the burst window. The first one plays at once (no delay);
 * the rest of the burst is dropped. Used on a phone, where a reconnect can report many sessions at the same instant.
 */
export function playSoundOncePerBurst(category: SoundCategory): void {
  if (quiet.has(category)) return;
  quiet.add(category);
  setTimeout(() => quiet.delete(category), SOUND_BURST_WINDOW_MS);
  playSound(category);
}
