// focus-chat-card.ts — bring a waiting card in the chat into view and mark it
// for a moment.
//
// WHY: a refused send says "answer the card first"; the card it means may be
// scrolled away, or one of several things on screen. The refusal's "Show card"
// button calls this so the user lands on it instead of hunting.
//
// Only the VISIBLE chat is searched: App keeps a ChatView mounted for every
// open session and hides the others, and a prompt card's id is derived from
// the menu's text, so two sessions can carry the same one.

const ATTENTION_CLASS = 'card-attention';
const ATTENTION_MS = 1400;

/** The card's element: a permission/question card by its tool id, or a
 *  prompt card by its prompt id. */
export type CardRef = { toolUseId: string } | { promptId: string };

function selectorFor(ref: CardRef): string {
  return 'toolUseId' in ref
    ? `[data-tool-use-id="${CSS.escape(ref.toolUseId)}"]`
    : `[data-prompt-id="${CSS.escape(ref.promptId)}"]`;
}

/** Scroll the card to the middle of the chat and pulse its outline once.
 *  Returns false when it is not in the visible chat (e.g. folded away). */
export function focusChatCard(ref: CardRef): boolean {
  const el = Array.from(document.querySelectorAll<HTMLElement>(selectorFor(ref)))
    .find((x) => x.offsetParent !== null);
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // Restart the pulse if it is already running (a second click).
  el.classList.remove(ATTENTION_CLASS);
  void el.offsetWidth;
  el.classList.add(ATTENTION_CLASS);
  window.setTimeout(() => el.classList.remove(ATTENTION_CLASS), ATTENTION_MS);
  // Keyboard focus is deliberately NOT moved onto the card: its first button
  // is "Yes" on a permission card, and a stray Enter must not approve it.
  return true;
}
