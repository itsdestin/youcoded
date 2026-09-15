import { createContext, useContext } from 'react';

/**
 * Whether cards in this subtree may answer window-level keys (Enter, arrows, 1–9).
 *
 * WHY: App mounts a ChatView for EVERY open session and only hides the inactive
 * ones, and each waiting card listens on `window`. Without this gate the Enter
 * that sent a message in one chat also pressed the default button on cards in
 * every hidden chat — opening "Always allow" confirms, or saving an Always-allow
 * rule outright, in sessions the user never looked at (2026-09-14).
 *
 * Defaults to true: surfaces rendered outside ChatView (the Specialists popup,
 * the workbench) are only mounted while on screen, so they keep their shortcuts.
 */
export const CardKeysLiveContext = createContext(true);

export function useCardKeysLive(): boolean {
  return useContext(CardKeysLiveContext);
}
