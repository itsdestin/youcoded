// send-ids.ts — the id every chat message a screen sends carries, and what the computer's answer about it means on screen (one-core R5-4b).
import type { SendOutcome } from '../../shared/send-outcome-types';

let counter = 0;
/**
 * A fresh id for one send. Short and URL-safe (the computer's rule is shared/send-outcome-types.ts); unique across devices and reloads because it
 * carries the time and a random part, so two phones can never be mistaken for each other.
 */
export function newSendId(): string {
  const rand = typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
    ? Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')
    : Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  return `s${Date.now().toString(36)}-${rand}-${(++counter).toString(36)}`;
}

/** What a send's note says, from what the computer could tell. `received` shows nothing. */
export function noteFor(outcome: SendOutcome): 'unsure' | 'not-sent' | null {
  return outcome === 'received' ? null : outcome === 'not-received' ? 'not-sent' : 'unsure';
}
