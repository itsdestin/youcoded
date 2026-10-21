import { describe, it, expect } from 'vitest';
import { errorCardCopy, retryWaitLine, providerName, billingUrl } from '../src/renderer/components/error-card-copy';

// The decisions this pins: docs/active/design/2026-10-21-error-card/
// error-card.questions.answers.json (Q-1 … Q-5).
describe('errorCardCopy — one plain sentence and the right way forward per kind', () => {
  it('temporary: names the provider, says the app already tried, offers Switch model + Try again (Q-1)', () => {
    const c = errorCardCopy('temporary', 'overloaded', 'Overloaded (provider error 529)', 'anthropic')!;
    expect(c.line).toBe('Anthropic is overloaded right now. The app tried again for about a minute.');
    expect(c.details).toBe('Overloaded (provider error 529)');
    expect(c.actions).toEqual(['switch-model', 'try-again']);
    expect(errorCardCopy('temporary', 'network', 'Cannot connect to API: getaddrinfo EAI_AGAIN', 'openai')!.line).toContain("Couldn't reach OpenAI");
  });

  it('account: never Try again; the button that fixes it plus Switch model (Q-2)', () => {
    expect(errorCardCopy('account', 'key-rejected', 'invalid x-api-key', 'anthropic')).toMatchObject({ line: "Anthropic didn't accept your API key.", actions: ['open-settings'] });
    expect(errorCardCopy('account', 'spend-limit', 'cap reached', 'anthropic')).toMatchObject({ actions: ['switch-model', 'billing'] });
    expect(errorCardCopy('account', 'quota-exhausted', 'You exceeded your current quota', 'openai')).toMatchObject({ actions: ['switch-model', 'billing'] });
    // No billing page known for this provider → Settings instead, never a dead link.
    expect(errorCardCopy('account', 'out-of-credits', 'no credit', 'openai-compatible')).toMatchObject({ actions: ['switch-model', 'open-settings'] });
    for (const code of ['key-rejected', 'spend-limit', 'quota-exhausted', 'out-of-credits', 'no-access', 'model-unavailable']) {
      expect(errorCardCopy('account', code, 'x', 'anthropic')!.actions).not.toContain('try-again');
    }
  });

  it('too-long: Summarise and continue only (Q-3)', () => {
    expect(errorCardCopy('too-long', 'context-too-long', 'prompt is too long: 210000 tokens > 200000 maximum', 'anthropic'))
      .toEqual({ line: 'This conversation is too long for this model.', details: 'prompt is too long: 210000 tokens > 200000 maximum', actions: ['summarise'] });
  });

  it('blocked: no Try again — the same request is refused again', () => {
    expect(errorCardCopy('blocked', 'moderation', 'flagged', 'openrouter')!.actions).toEqual(['switch-model']);
  });

  it('unknown: the provider\'s own words ARE the line — never a guessed cause — with Report bug and Try again', () => {
    expect(errorCardCopy('unknown', null, 'messages: text content blocks must be non-empty', 'anthropic'))
      .toEqual({ line: 'messages: text content blocks must be non-empty', details: null, actions: ['report-bug', 'try-again'] });
  });

  it('leaves cards that already have their own wording and buttons alone, and an older host\'s error (no kind)', () => {
    expect(errorCardCopy('account', 'openrouter-credit-short', 'x', 'openrouter')).toBeNull();
    expect(errorCardCopy('account', 'chatgpt-signin-expired', 'x', 'chatgpt')).toBeNull();
    expect(errorCardCopy(null, null, 'x', 'anthropic')).toBeNull();
  });

  it('a provider it cannot name says "The provider", and billing pages exist only where known', () => {
    expect(providerName(undefined)).toBe('The provider');
    expect(providerName('openai-compatible')).toBe('The provider');
    expect(billingUrl('anthropic')).toMatch(/^https:\/\/platform\.claude\.com\//);
    expect(billingUrl('openrouter')).toBeNull();
  });
});

describe('retryWaitLine — the thinking line names why it is waiting (Q-5)', () => {
  it('names the reason and counts down', () => {
    expect(retryWaitLine('overloaded', 'anthropic', 8)).toBe('Anthropic is overloaded — trying again in 8s…');
    expect(retryWaitLine('network', 'anthropic', 0)).toBe("Can't reach Anthropic — trying again…");
  });
  it('has nothing to say without a reason (the stream watchdog keeps its own line)', () => {
    expect(retryWaitLine(undefined, 'anthropic', 5)).toBeNull();
  });
});
