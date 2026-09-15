import { NativeHome } from '../native-home';
import { DEFAULT_CONTEXT_PREFERENCES, type ContextPreferences } from '../../shared/context-preferences';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function normalize(value: unknown): ContextPreferences {
  const context = record(value);
  return {
    openrouter: context.openrouter === 'long' ? 'long' : DEFAULT_CONTEXT_PREFERENCES.openrouter,
    chatgpt: context.chatgpt === 'long' ? 'long' : DEFAULT_CONTEXT_PREFERENCES.chatgpt,
  };
}

export class ContextSettingsStore {
  constructor(private readonly home: NativeHome) {}

  read(): ContextPreferences {
    return normalize(record(record(this.home.readJson('config.json')).native).context);
  }

  async update(patch: unknown): Promise<ContextPreferences> {
    // WHY validate and copy before awaiting the lock: invalid IPC input must not
    // mutate config, and callers cannot change a queued patch after validation.
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Context preferences must be an object');
    const validated: Partial<ContextPreferences> = {};
    for (const [key, value] of Object.entries(patch)) {
      if ((key !== 'openrouter' && key !== 'chatgpt') || (value !== 'standard' && value !== 'long')) {
        throw new TypeError('Context preferences accept only openrouter and chatgpt with standard or long');
      }
      validated[key] = value;
    }
    let committed = { ...DEFAULT_CONTEXT_PREFERENCES };
    await this.home.mutateJson('config.json', current => {
      const config = record(current);
      const native = record(config.native);
      // WHY merge inside NativeHome's lock, not from read(): concurrent provider
      // patches must compose. Saving defaults never touches an active session.
      committed = { ...normalize(native.context), ...validated };
      return { ...config, native: { ...native, context: committed } };
    });
    return committed;
  }
}
