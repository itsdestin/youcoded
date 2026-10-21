// What the chat's red error card says and offers for a native turn that ended
// in a provider error (decks: docs/active/design/2026-10-21-error-card/
// error-card.questions — Q-1 Try again when trying again can help, Q-2 the
// button that fixes an account problem + Switch model, Q-3 Summarise and
// continue, Q-4 one plain sentence with the provider's words under Details).
//
// Pure, so every kind × code is pinned by error-card-copy.test.ts.
//
// WHY the plain sentence names only what main KNOWS: the kind and code come from
// main/providers/provider-failure.ts, which matches documented error shapes. An
// 'unknown' error keeps the provider's own words as its line — never a guess
// (docs/error-message-standards.md).

/** What the card offers, in display order (Try again last, at the right). */
export type ErrorCardAction = 'open-settings' | 'add-credit' | 'billing' | 'switch-model' | 'summarise' | 'report-bug' | 'try-again';

export interface ErrorCardCopy {
  /** The one sentence on the card. */
  line: string;
  /** The provider's exact words, folded under Details; null when `line` already is them. */
  details: string | null;
  actions: ErrorCardAction[];
}

/** The brand a person knows the provider by, from the session's provider type. */
export function providerName(providerType: string | null | undefined): string {
  switch (providerType) {
    case 'anthropic': return 'Anthropic';
    case 'openai': return 'OpenAI';
    case 'google': return 'Google';
    case 'openrouter': return 'OpenRouter';
    case 'chatgpt': return 'ChatGPT';
    case 'local-engine': return 'The local model';
    default: return 'The provider';
  }
}

/** A provider's billing page, where a credit / quota / spending-cap problem is
 *  actually fixed. Null when we know no such page (the card then offers Settings). */
export function billingUrl(providerType: string | null | undefined): string | null {
  switch (providerType) {
    case 'anthropic': return 'https://platform.claude.com/settings/billing';
    case 'openai': return 'https://platform.openai.com/settings/organization/billing/overview';
    case 'google': return 'https://aistudio.google.com/usage';
    default: return null;
  }
}

/**
 * The card for a native error with a known kind. Returns null when the error
 * carries no kind (an older host) or a code the card already handles its own
 * way (OpenRouter's key/credit cards, ChatGPT sign-in and plan limits) — the
 * caller then renders exactly as before.
 */
export function errorCardCopy(kind: string | null | undefined, code: string | null | undefined, message: string, providerType: string | null | undefined): ErrorCardCopy | null {
  if (!kind) return null;
  // Cards with their own long-settled wording and buttons (connection-trust,
  // ChatGPT plan limits): leave them alone.
  if (code && (code.startsWith('openrouter-') || code.startsWith('chatgpt-'))) return null;
  const who = providerName(providerType);
  // WHY: a custom provider's generic name is "The provider" — read mid-sentence it must be
  // lowercase, and "Your The provider key" must read "Your provider key".
  const whoMid = who === 'The provider' ? 'the provider' : who;
  const yours = who === 'The provider' ? 'Your provider' : `Your ${who}`;
  const words = message.trim();
  const plain = (line: string, actions: ErrorCardAction[]): ErrorCardCopy => ({ line, details: words && words !== line ? words : null, actions });
  switch (kind) {
    case 'temporary': {
      const line = code === 'overloaded' ? `${who} is overloaded right now.`
        : code === 'rate-limited' ? `${who} is limiting how fast requests can be sent right now.`
        : code === 'network' ? `Couldn't reach ${whoMid}. Check your internet connection.`
        : code === 'provider-timeout' || code === 'upstream-error' ? `${who} didn't finish answering.`
        : code === 'garbled-response' ? `${who} sent back a reply the app couldn't read.`
        : `${who} had a problem on its side.`;
      return plain(`${line} The app tried again for about a minute.`, ['switch-model', 'try-again']);
    }
    case 'account': {
      if (code === 'key-rejected') return plain(`${who} didn't accept your API key.`, ['open-settings']);
      if (code === 'no-access') return plain(`${yours} key doesn't have access to this model.`, ['switch-model', 'open-settings']);
      if (code === 'model-unavailable') return plain(`${who} doesn't offer this model, or no longer does.`, ['switch-model']);
      const fix: ErrorCardAction = billingUrl(providerType) ? 'billing' : 'open-settings';
      if (code === 'spend-limit') return plain(`${who} stopped this reply: your spending limit has been reached.`, ['switch-model', fix]);
      if (code === 'quota-exhausted') return plain(`${yours} account has used up its quota.`, ['switch-model', fix]);
      if (code === 'out-of-credits') return plain(`${yours} account is out of credit.`, ['switch-model', fix]);
      return plain(`${who} refused this request because of your account.`, ['switch-model', 'open-settings']);
    }
    case 'too-long':
      // Q-3: Summarise and continue only.
      return plain(code === 'request-too-large'
        ? `This conversation's request is too large for ${whoMid} to accept.`
        : 'This conversation is too long for this model.', ['summarise']);
    case 'blocked':
      // No Try again: an unchanged request is refused again. Rephrasing is the fix.
      return plain(`${who} refused this request under its content rules. Rewording it may help.`, ['switch-model']);
    default:
      // Unknown: the provider's words ARE the line (never a guessed cause), with
      // Report bug because nobody knows the cause, and Try again because it may help.
      return { line: words || 'The model request failed.', details: null, actions: ['report-bug', 'try-again'] };
  }
}

/** Q-5: the thinking line while the app waits to try again, naming the reason. */
export function retryWaitLine(code: string | null | undefined, providerType: string | null | undefined, secondsLeft: number): string | null {
  const who = providerName(providerType);
  const reason = code === 'overloaded' ? `${who} is overloaded`
    : code === 'rate-limited' ? `${who} is limiting requests`
    : code === 'network' ? `Can't reach ${who === 'The provider' ? 'the provider' : who}`
    : code ? `${who} had a problem` : null;
  if (!reason) return null;
  return secondsLeft > 0 ? `${reason} — trying again in ${secondsLeft}s…` : `${reason} — trying again…`;
}
