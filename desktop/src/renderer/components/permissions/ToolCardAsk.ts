import type { ReactNode } from 'react';

/** A permission ask that is not a tool call, drawn by ToolCard itself so it looks and behaves like every
 *  other ask (the assistant browser's site / form / final-step / home-network asks). The caller supplies the
 *  words and where the answer goes; the header line, frame, buttons and keys are ToolCard's. */
export interface ToolCardAsk {
  /** Header label ("Sending a form"). */
  label: string;
  /** Header detail (the site). */
  detail?: ReactNode;
  question: string;
  note?: ReactNode;
  /** Receives the standard decision object; resolves when the answer was delivered. */
  answer: (decision: object) => Promise<unknown>;
  /** Hide Always allow (the person's own Chrome can never remember). */
  noAlways?: boolean;
  /** Click-only: no Enter / arrow keys (a step that buys or sends must never be a stray key). */
  noKeyboard?: boolean;
  /** A block of its own between the question and the buttons (card #267: the maker picker). Absent = nothing drawn. */
  body?: ReactNode;
  /** An ask that SPENDS money (card #267, picture / sound / video). WHY it is a field of the shared ask and not a
   *  second card: Destin (2026-11-18) rejected a look-alike; the money ask must be the same frame, header and note
   *  as every other ask. Its buttons are the generic ask's own pills with this ask's words (Destin 2026-11-18: no orange),
   *  flush right. Click-only (never a stray Enter).
   *  The chat-wide choice answers with `{ decision: { behavior: 'allow' }, allowForChat: true }`. */
  money?: { approve: string; decline: string; chat?: string; approveVariant?: 'primary'; lead?: ReactNode };
}
