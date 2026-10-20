export type ContextMode = 'standard' | 'medium' | 'long';
export type ContextPreferences = { openrouter: ContextMode; chatgpt: ContextMode };
export const DEFAULT_CONTEXT_PREFERENCES: ContextPreferences = { openrouter: 'medium', chatgpt: 'medium' };
