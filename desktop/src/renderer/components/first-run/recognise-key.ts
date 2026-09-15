// Whose API key was pasted, read from how it starts (design
// 2026-09-14-first-run-local-models, F-1 "recognise it"). PURE so the prefixes
// can be pinned by a test without a screen.
//
// WHY order matters: OpenAI keys start with a bare `sk-`, which the Anthropic
// (`sk-ant-`) and OpenRouter (`sk-or-`) prefixes also begin with — the longer
// prefixes must be tested first or both would read as OpenAI.

export type KeyService = 'anthropic' | 'openai' | 'google' | 'openrouter';

export const KEY_SERVICES: readonly KeyService[] = ['anthropic', 'openai', 'google', 'openrouter'];

export const KEY_SERVICE_LABEL: Record<KeyService, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
};

export function recogniseKey(raw: string): KeyService | null {
  const key = raw.trim();
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('sk-or-')) return 'openrouter';
  if (key.startsWith('AIza')) return 'google';
  if (key.startsWith('sk-')) return 'openai';
  return null;
}
