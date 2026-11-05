import type { ReactNode } from 'react';

/** A permission ask that is not a tool call, drawn by ToolCard itself so it looks and behaves like every
 *  other ask (the assistant browser's site / form / final-step / home-network asks). The caller supplies the
 *  words and where the answer goes; the header line, frame, buttons and keys are ToolCard's. */
export interface ToolCardAsk {
  /** Header label ("Sending a form"). */
  label: string;
  /** Header detail (the site). */
  detail?: string;
  question: string;
  note?: ReactNode;
  /** Receives the standard decision object; resolves when the answer was delivered. */
  answer: (decision: object) => Promise<unknown>;
  /** Hide Always allow (the person's own Chrome can never remember). */
  noAlways?: boolean;
  /** Click-only: no Enter / arrow keys (a step that buys or sends must never be a stray key). */
  noKeyboard?: boolean;
}
