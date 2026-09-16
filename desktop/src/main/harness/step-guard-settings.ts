import { NativeHome } from '../native-home';

const CONFIG_FILE = 'config.json';

export function normalizeStepGuard(value: unknown): number | null {
  // WHY fail closed to "unset" instead of coercing: stale or hand-edited config
  // must not unexpectedly interrupt a long-running native session.
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export class StepGuardSettings {
  constructor(private readonly home: NativeHome) {}

  read(): number | null {
    const config = this.home.readJson(CONFIG_FILE);
    if (!config || typeof config !== 'object') return null;
    const native = (config as { native?: unknown }).native;
    if (!native || typeof native !== 'object') return null;
    return normalizeStepGuard((native as { stepGuard?: unknown }).stepGuard);
  }

  async update(value: unknown): Promise<number | null> {
    // WHY validate before opening the config mutation so malformed IPC writes cannot
    // silently clear a valid preference or disturb unrelated settings.
    if (value !== null && normalizeStepGuard(value) === null) {
      throw new TypeError('Step guard must be null or a positive safe integer');
    }
    const stepGuard = normalizeStepGuard(value);
    await this.home.mutateJson(CONFIG_FILE, (current) => {
      const config = current && typeof current === 'object'
        ? { ...(current as Record<string, unknown>) }
        : { v: 1 } as Record<string, unknown>;
      const native = config.native && typeof config.native === 'object'
        ? { ...(config.native as Record<string, unknown>) }
        : {};
      if (stepGuard === null) delete native.stepGuard;
      else native.stepGuard = stepGuard;
      config.native = native;
      return config;
    });
    return stepGuard;
  }
}
