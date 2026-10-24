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
import fs from 'fs';
import path from 'path';
import { NativeHome } from './native-home';
import { isPreRelease } from './update-release-status';

const CONFIG_FILE = 'config.json';

export interface UpdatePreferences {
  /** null = never chosen. The running build decides — see resolveBetaChannel. */
  betaChannel: boolean | null;
  /** Download new versions by itself and install them on quit (#183). Absent or unreadable ⇒ true. */
  autoInstall: boolean;
}

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = { betaChannel: null, autoInstall: true };

/** The one parse of the `updates` section, shared by the sync and async readers so they cannot disagree. */
function parsePreferences(config: unknown): UpdatePreferences {
  const section = config && typeof config === 'object'
    ? (config as { updates?: unknown }).updates : null;
  if (!section || typeof section !== 'object') return { ...DEFAULT_UPDATE_PREFERENCES };
  const s = section as { betaChannel?: unknown; autoInstall?: unknown };
  return {
    // A hand-edited or future-version value falls back to "never chosen" rather
    // than to off: an unreadable preference must not silently look like the user
    // opted out of a channel they are currently running.
    betaChannel: typeof s.betaChannel === 'boolean' ? s.betaChannel : null,
    // WHY unreadable ⇒ ON (design §1): the default is on, and a garbled value is not a choice to
    // opt out; failing to ON matches what a fresh install does.
    autoInstall: typeof s.autoInstall === 'boolean' ? s.autoInstall : true,
  };
}

/** The channel actually used for a check: the saved answer, else what this build is. */
export function resolveBetaChannel(saved: boolean | null, runningVersion: string): boolean {
  return saved ?? isPreRelease(runningVersion);
}

export class UpdateSettings {
  constructor(private readonly home: NativeHome) {}

  read(): UpdatePreferences {
    return parsePreferences(this.home.readJson(CONFIG_FILE));
  }

  /** read() off the main thread, for the service's startup cache (#183: no sync file read on a
   *  check or quit path). ONLY a missing file reads as the defaults ("on", like a fresh install). WHY a
   *  failed read REJECTS (code review F3): a locked file (the dev instance holds the config lock), or a
   *  half-written one, is not a choice, and turning it into "on" would silently re-enable automatic
   *  installs for someone who switched them off. The caller keeps its last known value. */
  async readAsync(): Promise<UpdatePreferences> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(path.join(this.home.root, CONFIG_FILE), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ...DEFAULT_UPDATE_PREFERENCES };
      throw e;
    }
    return parsePreferences(JSON.parse(raw));
  }

  /** The channel this install should check, accounting for the running build. */
  resolve(runningVersion: string): boolean {
    return resolveBetaChannel(this.read().betaChannel, runningVersion);
  }

  async setBetaChannel(value: unknown): Promise<void> {
    // WHY validate before opening the mutation: a malformed write must fail at
    // the IPC boundary, not half-apply and leave config.json holding a channel
    // nothing understands.
    if (typeof value !== 'boolean') throw new TypeError('Beta channel must be true or false');
    await this.writeUpdatesKey('betaChannel', value);
  }

  /** Save "Install updates automatically". Same validate-then-locked-write as the beta channel. */
  async setAutoInstall(value: unknown): Promise<void> {
    if (typeof value !== 'boolean') throw new TypeError('Install updates automatically must be true or false');
    await this.writeUpdatesKey('autoInstall', value);
  }

  // WHY one writer: both settings live in the same `updates` section of a file the dev instance and
  // the installed app share, so both go through the locked mutate and keep every other key.
  private async writeUpdatesKey(key: 'betaChannel' | 'autoInstall', value: boolean): Promise<void> {
    await this.home.mutateJson(CONFIG_FILE, (current) => {
      const config = current && typeof current === 'object'
        ? { ...(current as Record<string, unknown>) }
        : { v: 1 } as Record<string, unknown>;
      const updates = config.updates && typeof config.updates === 'object'
        ? { ...(config.updates as Record<string, unknown>) }
        : {};
      updates[key] = value;
      config.updates = updates;
      return config;
    });
  }
}
