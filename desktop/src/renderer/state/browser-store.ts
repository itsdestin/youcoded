// The Browser's screen-side state (spec docs/active/specs/2026-10-13-assistant-browser-design.md):
// each conversation's BrowserSessionState as pushed by main, and which
// conversations have their Browser panel open.
//
// WHY a tiny external store read through useSyncExternalStore selectors, not a
// Context (performance rule 3): the header button, the `|||` row, the chat's
// ask card and App's right-slot all read ONE conversation's slice, and a busy
// browser pushes state several times a second; a Context would redraw every
// tab on each push.
import { useEffect, useSyncExternalStore } from 'react';
import type { BrowserSessionState } from '../../shared/browser-types';
import { getCapabilities } from '../platform';

type Listener = () => void;

const states = new Map<string, BrowserSessionState>();
const paneOpen = new Set<string>();
/** Conversations whose Browser panel fills the chat area (the Expand button). */
const expanded = new Set<string>();
/** Conversations whose browser did something while their panel was closed (header dot). */
const attention = new Set<string>();
const listeners = new Set<Listener>();
let started = false;

function emit(): void { for (const l of listeners) l(); }

function bridge(): any {
  return (globalThis as any).window?.claude?.browser ?? null;
}

/** Whether this screen shows the Browser at all (the computer's own window). */
export function browserSupported(): boolean {
  return getCapabilities().assistantBrowser && !!bridge();
}

/** Start listening for pushes once. Safe to call from every reader. */
export function ensureBrowserStore(): void {
  if (started || !browserSupported()) return;
  started = true;
  bridge().onState((s: BrowserSessionState) => setBrowserState(s));
  // An ended conversation's browser state is dropped (code review F15).
  (globalThis as any).window?.claude?.on?.sessionDestroyed?.((id: string) => forgetBrowserSession(id));
}

export function setBrowserState(s: BrowserSessionState): void {
  const prev = states.get(s.sessionId);
  states.set(s.sessionId, s);
  // A closed panel gets a dot when the assistant starts asking or working there.
  if (!paneOpen.has(s.sessionId) && (s.prompt || (s.busy && !prev?.busy))) attention.add(s.sessionId);
  if (!s.prompt && !s.busy && s.tabs.length === 0) attention.delete(s.sessionId);
  emit();
}

export function getBrowserState(sessionId: string | null | undefined): BrowserSessionState | null {
  return sessionId ? states.get(sessionId) ?? null : null;
}

export function isBrowserPaneOpen(sessionId: string | null | undefined): boolean {
  return !!sessionId && paneOpen.has(sessionId);
}

export function openBrowserPane(sessionId: string): void {
  if (paneOpen.has(sessionId) && !attention.has(sessionId)) return;
  paneOpen.add(sessionId);
  attention.delete(sessionId);
  emit();
}

export function closeBrowserPane(sessionId: string): void {
  if (!paneOpen.delete(sessionId)) return;
  expanded.delete(sessionId); // reopening starts at the side again
  emit();
}

/** Expand: the Browser panel takes the whole chat area, like Session Files' Expand. */
export function toggleBrowserExpanded(sessionId: string): void {
  if (!expanded.delete(sessionId)) expanded.add(sessionId);
  emit();
}

export function isBrowserExpanded(sessionId: string): boolean { return paneOpen.has(sessionId) && expanded.has(sessionId); }

export function useBrowserExpanded(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => !!sessionId && isBrowserExpanded(sessionId), () => false);
}

export function toggleBrowserPane(sessionId: string): void {
  if (paneOpen.has(sessionId)) closeBrowserPane(sessionId); else openBrowserPane(sessionId);
}

/** Forget a conversation that ended. */
export function forgetBrowserSession(sessionId: string): void {
  const had = states.delete(sessionId) || paneOpen.delete(sessionId) || attention.delete(sessionId);
  paneOpen.delete(sessionId); attention.delete(sessionId); expanded.delete(sessionId);
  if (had) emit();
}

function subscribe(l: Listener): () => void {
  ensureBrowserStore();
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** One conversation's state (null until the browser has said anything about it). */
export function useBrowserState(sessionId: string | null | undefined): BrowserSessionState | null {
  return useSyncExternalStore(subscribe, () => getBrowserState(sessionId), () => null);
}

export function useBrowserPaneOpen(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => isBrowserPaneOpen(sessionId), () => false);
}

/** True while the conversation's browser is showing pages in the background
 *  (running, tabs open, no window) — App opens the panel the first time this
 *  turns true. A boolean slice, so App redraws only when it flips. */
export function useBrowserWantsPane(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => {
    const s = getBrowserState(sessionId);
    return !!s && s.run === 'running' && s.tabs.length > 0 && !s.windowShown;
  }, () => false);
}

const primed = new Set<string>();

/** Ask once for a conversation's current state. WHY: the store only learns from
 *  pushes, so a window that reloads or opens later (a torn-off chat, the app's
 *  renderer restarting) would forget a browser that is still open until the
 *  next change — the header button and panel vanished in the dev app
 *  (2026-10-13). main answers from its cache without starting anything. */
function primeBrowserState(sessionId: string | null | undefined): void {
  if (!sessionId || primed.has(sessionId) || states.has(sessionId) || !browserSupported()) return;
  primed.add(sessionId);
  ensureBrowserStore();
  void bridge().state(sessionId).then((s: BrowserSessionState | null) => {
    if (s && !states.has(sessionId)) setBrowserState(s);
  }).catch(() => { primed.delete(sessionId); });
}

/** The header button shows on every chat of a screen that has the Browser
 *  (Destin, 2026-10-13: the person can open it and browse themselves). */
export function useBrowserButton(sessionId: string | null | undefined): { show: boolean; open: boolean; dot: boolean } {
  // The header and the ||| menu are mounted for the active conversation, so
  // priming here catches the panel and the card up too.
  useEffect(() => { primeBrowserState(sessionId); }, [sessionId]);
  const show = !!sessionId && browserSupported();
  const open = useBrowserPaneOpen(sessionId);
  const dot = useSyncExternalStore(subscribe, () => !!sessionId && attention.has(sessionId), () => false);
  return { show, open, dot };
}

/** Test seam. */
export function resetBrowserStoreForTests(): void {
  states.clear(); paneOpen.clear(); attention.clear(); expanded.clear(); listeners.clear(); primed.clear(); started = false;
}
