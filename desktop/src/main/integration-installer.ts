// Integration installer — Phase 3 scaffold.
//
// Today this reads the integrations index from the marketplace registry and
// returns stub state. The actual install/uninstall/connect work is deferred
// to a follow-up PR that ships Google Workspace as the first vertical slice.
//
// Why ship a scaffold now:
//   - Locks down the IPC shape + 4-file parity (no breaking changes later).
//   - Lets the marketplace UI render an Integrations rail with real cards.
//   - Makes the follow-up PR a purely "wire up the script runner + OAuth" job.

import fs from "fs";
import path from "path";
import os from "os";
import type { IntegrationEntry, IntegrationIndex, IntegrationState } from "../shared/types";

const REGISTRY_BASE = `https://raw.githubusercontent.com/itsdestin/destincode-marketplace/${process.env.DESTINCODE_MARKETPLACE_BRANCH || "master"}`;

const CACHE_DIR = path.join(os.homedir(), ".claude", "destincode-marketplace-cache");
const INTEGRATIONS_CACHE = path.join(CACHE_DIR, "integrations.json");
const MANIFEST_PATH = path.join(os.homedir(), ".claude", "integrations.json");
const CACHE_TTL = 24 * 60 * 60 * 1000;

export class IntegrationInstaller {
  constructor() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  async listCatalog(): Promise<IntegrationIndex> {
    // 24h cache; stale-on-fail so we show something when offline.
    const cached = this.readCache(INTEGRATIONS_CACHE, CACHE_TTL);
    if (cached) return cached;
    try {
      const resp = await fetch(`${REGISTRY_BASE}/integrations/index.json`);
      if (!resp.ok) return this.readCache(INTEGRATIONS_CACHE, Infinity) ?? empty();
      const data = await resp.json() as IntegrationIndex;
      this.writeCache(INTEGRATIONS_CACHE, data);
      return data;
    } catch {
      return this.readCache(INTEGRATIONS_CACHE, Infinity) ?? empty();
    }
  }

  // Manifest = ~/.claude/integrations.json. Single source of truth for which
  // integrations are installed/connected on this machine. Atomic rewrites.
  readManifest(): Record<string, IntegrationState> {
    try {
      if (!fs.existsSync(MANIFEST_PATH)) return {};
      const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
      const parsed = JSON.parse(raw);
      return parsed?.integrations || {};
    } catch {
      return {};
    }
  }

  writeManifest(data: Record<string, IntegrationState>): void {
    const content = JSON.stringify({ integrations: data }, null, 2);
    const tmp = `${MANIFEST_PATH}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, MANIFEST_PATH);
  }

  async status(slug: string): Promise<IntegrationState> {
    const manifest = this.readManifest();
    return manifest[slug] ?? { slug, installed: false, connected: false };
  }

  // STUB: installer. Records intent in the manifest and returns needs-auth so
  // the card can show the right state. The actual OAuth/script execution ships
  // with the Google Workspace vertical slice.
  async install(slug: string): Promise<IntegrationState> {
    const manifest = this.readManifest();
    const state: IntegrationState = {
      slug,
      installed: true,
      connected: false,
      error: "not-implemented: install flow lands with Google Workspace",
    };
    manifest[slug] = state;
    this.writeManifest(manifest);
    return state;
  }

  async uninstall(slug: string): Promise<IntegrationState> {
    const manifest = this.readManifest();
    delete manifest[slug];
    this.writeManifest(manifest);
    return { slug, installed: false, connected: false };
  }

  async configure(slug: string, _settings: Record<string, unknown>): Promise<IntegrationState> {
    // Deferred; real configure per-integration in the follow-up.
    const manifest = this.readManifest();
    const current = manifest[slug] ?? { slug, installed: false, connected: false };
    return { ...current, error: "not-implemented: configure" };
  }

  // ── cache helpers (duplicated from skill-provider intentionally — keeping
  // them small + local avoids coupling the two surfaces before we see if they
  // actually want to share one utility) ──────────────────────────────────────
  private readCache(filePath: string, ttl: number): any {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const { fetchedAt, data } = JSON.parse(raw);
      if (Date.now() - fetchedAt > ttl) return null;
      return data;
    } catch { return null; }
  }

  private writeCache(filePath: string, data: unknown): void {
    try {
      fs.writeFileSync(filePath, JSON.stringify({ fetchedAt: Date.now(), data }), "utf8");
    } catch { /* best-effort */ }
  }
}

function empty(): IntegrationIndex {
  return { version: "", integrations: [] };
}

// Augment listCatalog output with manifest state so the UI renders one object.
export async function listWithState(installer: IntegrationInstaller): Promise<Array<IntegrationEntry & { state: IntegrationState }>> {
  const catalog = await installer.listCatalog();
  const manifest = installer.readManifest();
  return (catalog.integrations || []).map((entry) => ({
    ...entry,
    state: manifest[entry.slug] ?? { slug: entry.slug, installed: false, connected: false },
  }));
}
