export type ContextMode = 'standard' | 'long';
export type ContextPreferences = { openrouter: ContextMode; chatgpt: ContextMode };
export const DEFAULT_CONTEXT_PREFERENCES: ContextPreferences = { openrouter: 'standard', chatgpt: 'standard' };
