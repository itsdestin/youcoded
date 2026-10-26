import { createContext, useContext } from 'react';

/**
 * The buddy's small chat window (buddy rebuild, 2026-10-25). The main window's chat components draw themselves smaller
 * when they are inside it: Destin's review (buddy-rebuild-review#N-2) — "i shouldnt have to scroll through a single perm
 * prompt. we need tool cards and such to be small window optimized in the buddy".
 *
 * `null` everywhere else, so the main window, a torn-off window and a phone draw exactly what they did. A context and not
 * a prop because the cards sit several components deep (ChatView → row → turn bubble → tool group → card).
 */
export interface CompactSurface {
  /** How much room a reply's tool steps, sent files and skill cards take:
   *  'slim' = each as one borderless line; 'summary' = one line for the whole reply; 'hidden' = none, the text only. */
  tools: 'slim' | 'summary' | 'hidden';
  /** The summary line's look (AssistantTurnBubble's ReplySteps says what each borrows from the main window). */
  summaryLook?: 'row' | 'pill' | 'footer';
}

export const CompactSurfaceContext = createContext<CompactSurface | null>(null);

export function useCompactSurface(): CompactSurface | null {
  return useContext(CompactSurfaceContext);
}
