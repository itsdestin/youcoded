// The Browser's saved choices: userData/assistant-browser/preferences.json.
//
// WHY per install (userData), not ~/.youcoded/config.json: design review 1 #24 —
// config.json is shared by the dev instance and the installed app (and synced
// across devices), so a dev run flipping "show window" would change the
// installed app's behaviour, and the always-allowed site list is a fact about
// this computer's browser storage, not about the person everywhere.
//
// WHY async with an in-memory copy: the panel and every tool call read these,
// and performance rule 1 bans blocking fs on those paths. One process (the
// main process) owns the file, so a write is temp-file + rename, no lock.
import * as fs from 'fs';
import * as path from 'path';
import { BROWSER_KINDS, type BrowserKind } from './browser-discovery';

import type { BrowserPreferences, BrowserSettingsPatch } from '../../shared/browser-types';
export type { BrowserPreferences, BrowserSettingsPatch } from '../../shared/browser-types';

export const DEFAULT_BROWSER_PREFERENCES: BrowserPreferences = {
  showWindow: false,
  useMyChrome: false,
  preferredBrowser: null,
  alwaysAllowedSites: [],
  explainerSeen: false,
};

const MAX_SITES = 500;

/** Validate an untrusted (IPC or hand-edited) value; unknown fields fall back. */
export function sanitizeBrowserPreferences(raw: unknown): BrowserPreferences {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const sites = Array.isArray(r.alwaysAllowedSites)
    ? [...new Set(r.alwaysAllowedSites.filter((s): s is string => typeof s === 'string' && isHostName(s)).map((s) => s.toLowerCase()))].slice(0, MAX_SITES)
    : [];
  return {
    showWindow: typeof r.showWindow === 'boolean' ? r.showWindow : DEFAULT_BROWSER_PREFERENCES.showWindow,
    useMyChrome: typeof r.useMyChrome === 'boolean' ? r.useMyChrome : DEFAULT_BROWSER_PREFERENCES.useMyChrome,
    preferredBrowser: BROWSER_KINDS.includes(r.preferredBrowser as BrowserKind) ? r.preferredBrowser as BrowserKind : null,
    alwaysAllowedSites: sites,
    explainerSeen: typeof r.explainerSeen === 'boolean' ? r.explainerSeen : false,
  };
}

function isHostName(s: string): boolean {
  return s.length > 0 && s.length <= 253 && /^[A-Za-z0-9.\-:[\]]+$/.test(s);
}


export function validatePatch(patch: unknown): BrowserSettingsPatch {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Browser settings must be an object');
  const p = patch as Record<string, unknown>;
  const out: BrowserSettingsPatch = {};
  for (const k of Object.keys(p)) {
    if (k === 'showWindow' || k === 'useMyChrome' || k === 'explainerSeen') {
      if (typeof p[k] !== 'boolean') throw new TypeError(`${k} must be true or false`);
      out[k] = p[k] as boolean;
    } else if (k === 'preferredBrowser') {
      if (p[k] !== null && !BROWSER_KINDS.includes(p[k] as BrowserKind)) throw new TypeError('Unknown browser');
      out.preferredBrowser = p[k] as BrowserKind | null;
    } else {
      throw new TypeError(`Unknown browser setting: ${k}`);
    }
  }
  return out;
}

export class BrowserSettings {
  private cache: BrowserPreferences | null = null;
  private loading: Promise<BrowserPreferences> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(rootDir: string) {
    this.file = path.join(rootDir, 'preferences.json');
  }

  async read(): Promise<BrowserPreferences> {
    if (this.cache) return this.cache;
    if (!this.loading) {
      this.loading = (async () => {
        let parsed: unknown = null;
        try { parsed = JSON.parse(await fs.promises.readFile(this.file, 'utf8')); } catch { /* missing or torn → defaults */ }
        this.cache = sanitizeBrowserPreferences(parsed);
        return this.cache;
      })().finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  async update(patch: unknown): Promise<BrowserPreferences> {
    const valid = validatePatch(patch);
    return this.write({ ...(await this.read()), ...valid });
  }

  async allowSite(host: string): Promise<BrowserPreferences> {
    const cur = await this.read();
    const h = host.toLowerCase();
    if (cur.alwaysAllowedSites.includes(h)) return cur;
    return this.write({ ...cur, alwaysAllowedSites: [...cur.alwaysAllowedSites, h] });
  }

  async removeSite(host: string): Promise<BrowserPreferences> {
    const cur = await this.read();
    const h = String(host).toLowerCase();
    return this.write({ ...cur, alwaysAllowedSites: cur.alwaysAllowedSites.filter((s) => s !== h) });
  }

  private async write(next: BrowserPreferences): Promise<BrowserPreferences> {
    const clean = sanitizeBrowserPreferences(next);
    this.cache = clean;
    // Serialize writes so a slow earlier write can never land after a later one.
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(clean, null, 2), 'utf8');
      await fs.promises.rename(tmp, this.file);
    });
    await this.writing;
    return clean;
  }
}
