// desktop/src/main/update-settings.ts
//
// Which release channel this install takes updates from. Stored in
// ~/.youcoded/config.json under its own `updates` section, beside `naming` and
// `engine.*`, through NativeHome's locked mutateJson — the dev instance and the
// installed app share that file, so a read-outside-then-write loop would drop
// one of two concurrent settings changes.
//
// WHY "unset" is not the same as "off" (Destin, 2026-09-13): someone running
// 1.3.0-beta.77 installed a beta deliberately, and a flat `false` default would
// leave exactly those people stranded — GitHub's /releases/latest hides
// pre-releases, so nothing would ever offer them a newer beta. An install that
// has never been asked therefore inherits the answer its own build implies, and
// an explicit choice always wins over it. Turning the channel OFF while running
// a beta is honest and allowed: the next stable release is still strictly above
// every beta of its line, so the offer arrives on release day either way.
import { NativeHome } from './native-home';
import { isPreRelease } from './update-release-status';

const CONFIG_FILE = 'config.json';

export interface UpdatePreferences {
  /** null = never chosen. The running build decides — see resolveBetaChannel. */
  betaChannel: boolean | null;
}

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = { betaChannel: null };

/** The channel actually used for a check: the saved answer, else what this build is. */
export function resolveBetaChannel(saved: boolean | null, runningVersion: string): boolean {
  return saved ?? isPreRelease(runningVersion);
}

export class UpdateSettings {
  constructor(private readonly home: NativeHome) {}

  read(): UpdatePreferences {
    const config = this.home.readJson(CONFIG_FILE);
    const section = config && typeof config === 'object'
      ? (config as { updates?: unknown }).updates : null;
    if (!section || typeof section !== 'object') return { ...DEFAULT_UPDATE_PREFERENCES };
    const value = (section as { betaChannel?: unknown }).betaChannel;
    // A hand-edited or future-version value falls back to "never chosen" rather
    // than to off: an unreadable preference must not silently look like the user
    // opted out of a channel they are currently running.
    return { betaChannel: typeof value === 'boolean' ? value : null };
  }

  /** The channel this install should check, accounting for the running build. */
  resolve(runningVersion: string): boolean {
    return resolveBetaChannel(this.read().betaChannel, runningVersion);
  }

  async setBetaChannel(value: unknown): Promise<UpdatePreferences> {
    // WHY validate before opening the mutation: a malformed write must fail at
    // the IPC boundary, not half-apply and leave config.json holding a channel
    // nothing understands.
    if (typeof value !== 'boolean') throw new TypeError('Beta channel must be true or false');
    await this.home.mutateJson(CONFIG_FILE, (current) => {
      const config = current && typeof current === 'object'
        ? { ...(current as Record<string, unknown>) }
        : { v: 1 } as Record<string, unknown>;
      const updates = config.updates && typeof config.updates === 'object'
        ? { ...(config.updates as Record<string, unknown>) }
        : {};
      updates.betaChannel = value;
      config.updates = updates;
      return config;
    });
    return { betaChannel: value };
  }
}
