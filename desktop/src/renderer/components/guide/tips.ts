// src/renderer/components/guide/tips.ts
//
// Tips after the tour: each one has a MOMENT (decided 2026-09-10, deck Q-6:
// the moment it is relevant, not the calendar). A component that reaches the
// moment calls `triggerTip(id)`; this store decides whether it shows — armed,
// not yet read, nothing else showing, and at most ONE per sitting so a burst of
// firsts in one afternoon does not become a burst of bubbles. The host
// (GuideTipHost) renders whichever tip is active.
//
// A tiny external store rather than context: the triggers live in components
// that have no common ancestor short of App, and a useSyncExternalStore is how
// this renderer already shares that kind of state (rules: react-renderer).
import { useSyncExternalStore } from 'react';
import { markTipSeen, setTipsArmed, tipSeen, tipsArmed } from './guide-state';

export interface GuideTip {
  id: string;
  text: string;
}

export const TIPS: readonly GuideTip[] = [
  { id: 'tags', text: 'Tag this session, or leave yourself a note. Both show under All Sessions, so it is easy to find again.' },
  { id: 'notes', text: 'Before you close a session, a one-line note here is what you will read under All Sessions next week.' },
  { id: 'projects', text: 'Working in the same folder a lot? Add it as a project and the assistant keeps its instructions, memories and conversations together.' },
  { id: 'resume', text: 'You have a session from earlier. Resume Session picks it up where you left off, with everything it remembered.' },
  { id: 'local-models', text: 'Models can run on your own computer, free and private. Local models live under Settings, Assistant settings.' },
  { id: 'floater', text: 'The buddy can sit on your desktop while you work elsewhere and wave when a session needs you. Turn it on under Settings, Buddy Floater.' },
  { id: 'themes', text: 'Themes change more than colours: the buddy, the wallpaper and the chat bubbles all come with one. Settings, Appearance.' },
  { id: 'help', text: 'Something went wrong? Report a bug sends the details to the maintainers, and the community at r/youcoded is a good place to ask.' },
];

let active: GuideTip | null = null;
let shownThisSitting = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Ask for a tip at its moment. Returns whether it will show. */
export function triggerTip(id: string): boolean {
  if (active || shownThisSitting || !tipsArmed() || tipSeen(id)) return false;
  const tip = TIPS.find((t) => t.id === id);
  if (!tip) return false;
  active = tip;
  shownThisSitting = true;
  emit();
  return true;
}

export function dismissTip(): void {
  if (!active) return;
  markTipSeen(active.id);
  active = null;
  emit();
}

export function stopAllTips(): void {
  if (active) markTipSeen(active.id);
  active = null;
  setTipsArmed(false);
  emit();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useActiveTip(): GuideTip | null {
  return useSyncExternalStore(subscribe, () => active, () => null);
}

/** Tests and the workbench: forget the one-per-sitting cap and any active tip. */
export function resetTipsForSitting(): void { active = null; shownThisSitting = false; emit(); }
