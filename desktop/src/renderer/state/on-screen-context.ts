import { createContext, useContext } from 'react';

/**
 * Whether the chat this subtree belongs to is the one on screen.
 *
 * WHY: App keeps a ChatView mounted for EVERY open session and only hides the
 * others, so a clock inside a hidden chat (the thinking line's rotating words
 * and countdowns, a running command's seconds counter) kept waking the app to
 * redraw something nobody could see — once per open tab. ChatView provides its
 * `visible` flag here; clocks read it and stand still while it is false. Every
 * clock derives its number from timestamps, so it is right again on the first
 * frame the chat is back.
 *
 * Defaults to true: surfaces outside ChatView (the buddy feed, popups, the
 * workbench) are only mounted while on screen.
 */
export const OnScreenContext = createContext(true);

export function useOnScreen(): boolean {
  return useContext(OnScreenContext);
}
