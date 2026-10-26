// Two tiny per-screen stores for the in-chat notification card (NotifyCard):
//
//   - SEEN: which notifications the person has clicked. A card glows until then.
//     Remembered in localStorage so a reload does not relight every old card; it
//     is per screen by design (a phone and the computer each track their own
//     clicks) and losing it only means an old card glows again.
//   - ON SCREEN: which cards are currently visible in their chat. ChatView reads
//     it to decide whether "Jump to notification" is needed.
//
// Plain subscribe/notify stores read with useSyncExternalStore, so only the one
// card or button whose answer changed redraws (performance.md rule 3).
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'youcoded-notify-seen';
/** Enough for months of notifications; the oldest are dropped first. */
const SEEN_MAX = 300;

function loadSeen(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

let seenOrder: string[] | null = null;
let seen: Set<string> | null = null;
const seenListeners = new Set<() => void>();

function seenSet(): Set<string> {
  if (!seen) { seenOrder = loadSeen(); seen = new Set(seenOrder); }
  return seen;
}

export function markNotifySeen(toolUseId: string): void {
  const set = seenSet();
  if (set.has(toolUseId)) return;
  set.add(toolUseId);
  seenOrder!.push(toolUseId);
  while (seenOrder!.length > SEEN_MAX) set.delete(seenOrder!.shift()!);
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seenOrder)); } catch { /* storage full or blocked: clicks just aren't remembered */ }
  for (const l of seenListeners) l();
}

function subscribeSeen(cb: () => void): () => void {
  seenListeners.add(cb);
  return () => { seenListeners.delete(cb); };
}

export function useNotifySeen(toolUseId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribeSeen, () => (toolUseId ? seenSet().has(toolUseId) : true));
}

const onScreen = new Set<string>();
const screenListeners = new Set<() => void>();

export function setNotifyOnScreen(toolUseId: string, visible: boolean): void {
  if (visible === onScreen.has(toolUseId)) return;
  if (visible) onScreen.add(toolUseId); else onScreen.delete(toolUseId);
  for (const l of screenListeners) l();
}

function subscribeScreen(cb: () => void): () => void {
  screenListeners.add(cb);
  return () => { screenListeners.delete(cb); };
}

export function useNotifyOnScreen(toolUseId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribeScreen, () => (toolUseId ? onScreen.has(toolUseId) : false));
}

/** Tests only: forget everything this module holds in memory. */
export function resetNotifyStoresForTest(): void {
  seen = null; seenOrder = null; onScreen.clear();
}
