// Integration installer — plugin-wrapping flow.
//
// setup.type === 'plugin' routes through the existing PluginInstaller +
// ClaudeCodeRegistry rather than inventing a parallel install pipeline. After
// a successful install, the returned state carries an optional
// `postInstallCommand` so the renderer can spin up a fresh Sonnet session
// that runs the setup command (e.g. /google-services-setup) without
// interrupting the user's active session.
//
// api-key / macos-only / script setup types are still stubs — tracked as
// follow-ups once OAuth + keyring work lands.

import fs from "fs";
import path from "path";
import os from "os";
import type { IntegrationEntry, IntegrationIndex, IntegrationState, SkillEntry } from "../shared/types";
import { installPlugin, uninstallPlugin } from "./plugin-installer";

const REGISTRY_BASE = `https://raw.githubusercontent.com/itsdestin/wecoded-marketplace/${process.env.YOUCODED_MARKETPLACE_BRANCH || "master"}`;

const CACHE_DIR = path.join(os.homedir(), ".claude", "youcoded-marketplace-cache");
const INTEGRATIONS_CACHE = path.join(CACHE_DIR, "integrations.json");
const MANIFEST_PATH = path.join(os.homedir(), ".claude", "integrations.json");
const CACHE_TTL = 24 * 60 * 60 * 1000;

// Install response = state + optional post-install hint. The renderer consumes
// `postInstallCommand` to spawn a new Sonnet session and run the command.
export interface IntegrationInstallResult extends IntegrationState {
  postInstallCommand?: string;
}

// The installer looks up plugin entries through a provider-shaped callback so
// it doesn't have a hard dep on the SkillProvider class (keeps this file
// unit-testable with a fake).
export interface IntegrationInstallerDeps {
  getPluginEntryById?: (id: string) => Promise<SkillEntry | null>;
}

// Map the current platform to the string the registry uses in `platforms`.
function currentPlatform(): "darwin" | "linux" | "win32" | "unknown" {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "win32";
  return "unknown";
}

export class IntegrationInstaller {
  private deps: IntegrationInstallerDeps;

  constructor(deps: IntegrationInstallerDeps = {}) {
    this.deps = deps;
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

  // Bust the cache — used after a cross-version schema bump so old cached
  // entries without the new fields (iconUrl, platforms, plugin setup type)
  // don't linger for 24h.
  invalidateCatalogCache(): void {
    try { fs.rmSync(INTEGRATIONS_CACHE, { force: true }); } catch { /* ignore */ }
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

  async install(slug: string): Promise<IntegrationInstallResult> {
    const catalog = await this.listCatalog();
    const entry = (catalog.integrations || []).find((e) => e.slug === slug);
    if (!entry) return this.recordFailure(slug, `Integration not found: ${slug}`);

    // Refuse to install a planned ("Coming soon") entry even if the UI is
    // out of sync — avoids a corrupted manifest that claims it's installed.
    if (entry.status !== "available") {
      return this.recordFailure(slug, `Integration is not available: status=${entry.status}`);
    }

    // Platform gate — honour entry.platforms if present.
    if (entry.platforms && entry.platforms.length > 0) {
      const cur = currentPlatform();
      if (cur === "unknown" || !entry.platforms.includes(cur as any)) {
        return this.recordFailure(slug, `Not supported on this platform (needs ${entry.platforms.join("/")})`);
      }
    }

    if (entry.setup.type === "plugin") {
      return this.installPluginBacked(entry);
    }

    // Non-plugin setup types — still stubs. Keep the manifest in sync with
    // the UI so the user sees a clear error rather than a success that silently
    // does nothing.
    return this.recordFailure(slug, `setup.type "${entry.setup.type}" not yet implemented`);
  }

  private async installPluginBacked(entry: IntegrationEntry): Promise<IntegrationInstallResult> {
    const pluginId = entry.setup.pluginId;
    if (!pluginId) return this.recordFailure(entry.slug, "setup.pluginId missing");
    if (!this.deps.getPluginEntryById) {
      return this.recordFailure(entry.slug, "plugin lookup unavailable");
    }

    const plugin = await this.deps.getPluginEntryById(pluginId);
    if (!plugin) return this.recordFailure(entry.slug, `Plugin not found in marketplace: ${pluginId}`);

    // Hand off to the real plugin installer. It wires up all four Claude Code
    // registries so /reload-plugins picks the plugin up.
    const result = await installPlugin({
      id: plugin.id,
      sourceType: plugin.sourceType || "local",
      sourceRef: plugin.sourceRef || plugin.id,
      sourceSubdir: plugin.sourceSubdir,
      sourceMarketplace: (plugin as any).sourceMarketplace,
      description: plugin.description,
      author: plugin.author,
      version: plugin.version,
    });

    if (result.status === "failed") {
      return this.recordFailure(entry.slug, result.error || "Plugin install failed");
    }

    const manifest = this.readManifest();
    const state: IntegrationState = {
      slug: entry.slug,
      installed: true,
      // `connected` stays false until the post-install setup actually wires
      // up credentials. For plugins without a postInstallCommand we flip it
      // true immediately since there's nothing else to do.
      connected: !entry.setup.postInstallCommand,
      lastSync: new Date().toISOString(),
    };
    manifest[entry.slug] = state;
    this.writeManifest(manifest);

    return { ...state, postInstallCommand: entry.setup.postInstallCommand };
  }

  async uninstall(slug: string): Promise<IntegrationState> {
    const manifest = this.readManifest();
    // Best-effort plugin removal. If the catalog lookup fails we still clear
    // the manifest so the UI isn't stuck with an "installed" label.
    try {
      const catalog = await this.listCatalog();
      const entry = (catalog.integrations || []).find((e) => e.slug === slug);
      if (entry?.setup.type === "plugin" && entry.setup.pluginId) {
        await uninstallPlugin(entry.setup.pluginId);
      }
    } catch { /* ignore — clear state below regardless */ }

    delete manifest[slug];
    this.writeManifest(manifest);
    return { slug, installed: false, connected: false };
  }

  async configure(slug: string, _settings: Record<string, unknown>): Promise<IntegrationState> {
    const manifest = this.readManifest();
    const current = manifest[slug] ?? { slug, installed: false, connected: false };
    return { ...current, error: "not-implemented: configure" };
  }

  private recordFailure(slug: string, error: string): IntegrationInstallResult {
    const manifest = this.readManifest();
    const state: IntegrationState = {
      slug,
      installed: manifest[slug]?.installed ?? false,
      connected: false,
      error,
    };
    manifest[slug] = state;
    this.writeManifest(manifest);
    return state;
  }

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
