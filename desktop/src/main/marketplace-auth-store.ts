// marketplace-auth-store.ts
// Stores the marketplace bearer token and user profile in the main process only.
// Tokens never cross the preload boundary into the renderer bundle.
// Never logged, never written to stderr.

import fs from 'fs';
import path from 'path';

export interface MarketplaceUser {
  id: string;         // github:<id>
  login: string;
  avatar_url: string;
}

// Injected backing interface so tests can supply a plain Map (no Electron needed).
interface Backing {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

export class MarketplaceAuthStore {
  constructor(private readonly backing: Backing) {}

  getToken(): string | null {
    return this.backing.get<string>("marketplace.token") ?? null;
  }

  getUser(): MarketplaceUser | null {
    return this.backing.get<MarketplaceUser>("marketplace.user") ?? null;
  }

  setToken(token: string): void {
    this.backing.set("marketplace.token", token);
  }

  setSession(token: string, user: MarketplaceUser): void {
    this.backing.set("marketplace.token", token);
    this.backing.set("marketplace.user", user);
  }

  signOut(): void {
    this.backing.delete("marketplace.token");
    this.backing.delete("marketplace.user");
  }
}

// ── fs-backed implementation ─────────────────────────────────────────────────
// Stores data in userData/marketplace-auth.json.
// Uses the same atomic-write pattern as SkillConfigStore to prevent corruption.
// electron-store is not in package.json, so we implement the same pattern
// directly with fs — consistent with the rest of the main-process stores.

class FsStoreBacking implements Backing {
  private data: Record<string, unknown> = {};
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.data = JSON.parse(raw);
    } catch {
      // File doesn't exist or is corrupt — start empty (safe default)
      this.data = {};
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to temp file then rename to prevent corruption on crash
    const tmp = this.filePath + '.tmp';
    // Intentionally no JSON pretty-print: token file is never read by humans
    fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  get<T>(key: string): T | undefined {
    this.load();
    return this.data[key] as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.load();
    this.data[key] = value;
    this.save();
  }

  delete(key: string): void {
    this.load();
    delete this.data[key];
    this.save();
  }
}

// Factory used by main.ts.
// userData path comes from Electron's app.getPath('userData') at call time.
export function createAuthStore(userDataPath: string): MarketplaceAuthStore {
  const filePath = path.join(userDataPath, 'marketplace-auth.json');
  return new MarketplaceAuthStore(new FsStoreBacking(filePath));
}
