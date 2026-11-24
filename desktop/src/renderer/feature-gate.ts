// feature-gate.ts — a screen asks "does this feature work where I am?" and gets the answer from the device table.
//
// WHY (Destin, 2026-11-18, review item R-5): screens each guessed from isAndroid()/isRemoteMode()/a nearby capability.
// The one place that decides is now shared/device-table.ts; this is the only function that reads it for a screen.
// Phase 1-2 adopt it in ONE place (the voice-words editor, V-2); the rest of the screens move in phase 3.
import { DEVICE_TABLE, type Door } from '../shared/device-table';
import { getPlatform, isRemoteMode } from './platform';

/** Which of the three places this screen is in, read at call time (the connection can change under a screen).
 *  remote wins first: a browser, or the Android app paired to a computer, has no backend of its own. */
function currentDoor(): Door {
  if (isRemoteMode()) return 'remote';
  return getPlatform() === 'android' ? 'phoneApp' : 'computer';
}

/** True only when the table says this feature works here. An id the table does not know is false (never shown). */
export function featureWorks(id: string): boolean {
  return DEVICE_TABLE.find((row) => row.id === id)?.doors[currentDoor()] === 'works';
}
