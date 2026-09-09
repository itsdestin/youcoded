// desktop/src/main/naming-settings.ts
//
// The three-way session-naming preference and the model AI mode should use.
// Stored in ~/.youcoded/config.json under its own `naming` section, beside
// `native.stepGuard` and `engine.*`, through NativeHome's locked mutateJson —
// the dev instance and the installed app share that file, so a read-outside-
// then-write loop would drop one of two concurrent settings changes.
//
// WHY the model is a ModelBinding and not a PortableModelRef: providerId is a
// device-local ULID. This preference is deliberately per-machine, exactly like
// the specialist tier defaults it reuses the picker from — syncing a local
// provider id to another device would name a provider that does not exist there.
import { NativeHome } from './native-home';
import type { ModelBinding } from '../shared/provider-types';

const CONFIG_FILE = 'config.json';

/** Off: never generate or update a name; existing names are kept and can still
 *  be renamed by hand. Basic: quote the opening request, no model call ever.
 *  AI: ask a model, on the approved 1 / 3 / then-every-25 schedule. */
export type NamingMode = 'off' | 'basic' | 'ai';

export interface NamingPreferences {
  mode: NamingMode;
  /** null = use the conversation's own model. Only meaningful in AI mode. */
  model: ModelBinding | null;
}

/** Basic is what an install with no saved preference gets. Chosen in the
 *  questions deck: it is useful, costs nothing, and never surprises anyone
 *  with a provider charge they did not ask for. */
export const DEFAULT_NAMING: NamingPreferences = { mode: 'basic', model: null };

const MODES: ReadonlySet<string> = new Set(['off', 'basic', 'ai']);

export function normalizeMode(value: unknown): NamingMode | null {
  return typeof value === 'string' && MODES.has(value) ? (value as NamingMode) : null;
}

export function normalizeBinding(value: unknown): ModelBinding | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { providerId?: unknown; modelId?: unknown };
  if (typeof v.providerId !== 'string' || !v.providerId) return null;
  if (typeof v.modelId !== 'string' || !v.modelId) return null;
  return { providerId: v.providerId, modelId: v.modelId };
}

export class NamingSettings {
  constructor(private readonly home: NativeHome) {}

  read(): NamingPreferences {
    const config = this.home.readJson(CONFIG_FILE);
    const section = config && typeof config === 'object'
      ? (config as { naming?: unknown }).naming : null;
    if (!section || typeof section !== 'object') return { ...DEFAULT_NAMING };
    const s = section as { mode?: unknown; model?: unknown };
    // A hand-edited or future-version mode falls back to the default rather
    // than disabling naming: an unreadable preference must not silently look
    // like the user chose Off.
    return { mode: normalizeMode(s.mode) ?? DEFAULT_NAMING.mode, model: normalizeBinding(s.model) };
  }

  async update(value: unknown): Promise<NamingPreferences> {
    // WHY validate before opening the mutation: a malformed write must fail
    // loudly at the IPC boundary, not half-apply and leave config.json holding
    // a mode nothing understands.
    const v = (value && typeof value === 'object' ? value : {}) as { mode?: unknown; model?: unknown };
    const mode = normalizeMode(v.mode);
    if (!mode) throw new TypeError('Session naming mode must be off, basic or ai');
    // Anything that is not a usable binding is stored as "conversation model",
    // which is the safe reading: never invent a provider to bill.
    const model = normalizeBinding(v.model);
    const next: NamingPreferences = { mode, model };
    await this.home.mutateJson(CONFIG_FILE, (current) => {
      const config = current && typeof current === 'object'
        ? { ...(current as Record<string, unknown>) }
        : { v: 1 } as Record<string, unknown>;
      config.naming = model ? { mode, model } : { mode };
      return config;
    });
    return next;
  }
}
