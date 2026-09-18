// Which known failure a chat turn's error is, for the chat card's action button
// (connection-trust design §3.3). Its own file so the harness only imports it.
import { CHATGPT_SIGN_IN_EXPIRED_MESSAGE, CHATGPT_SIGN_IN_REQUIRED_MESSAGE } from './chatgpt-oauth';

/** Unwraps the retry wrapper like describeProviderError. An OpenRouter refusal
 *  carries its own `errorCode` (ProviderAccountError); ChatGPT's sign-in errors
 *  are plain Errors on purpose (chatgpt-oauth.ts plainError), so they are
 *  recognised by their exact sentence — one origin each. undefined = show the
 *  text as it is. */
export function classifyProviderError(err: any): string | undefined {
  const e = err?.lastError ?? err;
  if (typeof e?.errorCode === 'string') return e.errorCode;
  if (e?.message === CHATGPT_SIGN_IN_EXPIRED_MESSAGE) return 'chatgpt-signin-expired';
  if (e?.message === CHATGPT_SIGN_IN_REQUIRED_MESSAGE) return 'chatgpt-signin-required';
  return undefined;
}
