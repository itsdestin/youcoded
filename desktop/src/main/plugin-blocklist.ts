// The plugin off-switch list: which installed plugins YouCoded must turn off because they were
// found to be unsafe (security runbook §5; UI approved 2026-11-05). The server half is
// wecoded-marketplace/worker/src/security/blocked-plugins.ts — a reviewed list in code.
//
// Top half: fetch, check and remember the list. Bottom half (PluginOffSwitch): what "turned off"
// means — hooks and connected tools removed, unhooked from Claude Code, folder moved aside,
// settings kept. skill-provider.ts asks it what is blocked; main.ts / headless-boot.ts schedule it.
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { pluginInstallDir, registerPluginInstall, unregisterPluginInstall } from './claude-code-registry';
import { reconcileHooks, removePluginHooks } from './hook-reconciler';
import { reconcileMcp, removePluginMcpServers } from './mcp-reconciler';
import { log } from './logger';
import type { SkillConfigStore } from './skill-config-store';

interface BlockedPlugin { id: string; reason?: string }
export type Blocklist = Map<string, BlockedPlugin>;

// WHY caps: the answer comes over the network. A broken or hostile reply must not make the app
// hold an unbounded list or show an essay as a reason.
const MAX_ENTRIES = 1000;
const MAX_ID = 128;
const MAX_REASON = 500;

/** Reads `{ blocked: [{ id, reason? }] }`. Returns null when the shape is wrong, so a garbled
 *  reply is never mistaken for "nothing is blocked any more". Bad rows are skipped. */
export function parseBlocklist(raw: unknown): Blocklist | null {
  if (!raw || typeof raw !== 'object') return null;
  const rows = (raw as { blocked?: unknown }).blocked;
  if (!Array.isArray(rows)) return null;
  const list: Blocklist = new Map();
  for (const row of rows.slice(0, MAX_ENTRIES)) {
    if (!row || typeof row !== 'object') continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    const clean = id.trim();
    if (!clean || clean.length > MAX_ID) continue;
    const reason = (row as { reason?: unknown }).reason;
    list.set(clean, typeof reason === 'string' && reason.trim()
      ? { id: clean, reason: reason.trim().slice(0, MAX_REASON) }
      : { id: clean });
  }
  return list;
}

/** The last list this computer saw, or an empty one on a first run. */
async function readSavedBlocklist(file: string): Promise<Blocklist> {
  try {
    return parseBlocklist(JSON.parse(await fsp.readFile(file, 'utf8'))) ?? new Map();
  } catch {
    return new Map();
  }
}

/**
 * Ask the server for the current list. On success it is saved and returned. On ANY failure
 * (offline, server down, garbled reply) the last saved list is returned instead.
 *
 * WHY never fall back to "empty": a plugin that was turned off must stay off while the server
 * can't be reached — otherwise simply cutting the network (or the server having a bad hour) would
 * quietly switch a harmful plugin back on. Only a real, well-formed answer can shorten the list.
 */
export async function fetchBlocklist(
  url: string,
  file: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ list: Blocklist; fresh: boolean }> {
  try {
    const resp = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (resp.ok) {
      const list = parseBlocklist(await resp.json());
      if (list) {
        await saveBlocklist(file, list);
        return { list, fresh: true };
      }
    }
  } catch { /* fall back to the saved list below */ }
  return { list: await readSavedBlocklist(file), fresh: false };
}

async function saveBlocklist(file: string, list: Blocklist): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Temp file then rename, so a crash mid-write can't leave half a list that reads as empty.
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ blocked: [...list.values()] }), 'utf8');
    await fsp.rename(tmp, file);
  } catch { /* best effort: the in-memory list still applies this run */ }
}

/**
 * Apply the off-switch now and then every hour. `onChanged` runs when a plugin was turned off
 * or put back (the caller asks open chats to reload their plugins). Shared by main.ts and the
 * Android backend (headless-boot.ts) so both platforms run the identical schedule.
 */
export function startPluginOffSwitch(
  provider: { enforceBlocklist: () => Promise<{ turnedOff: string[]; turnedOn: string[] }> },
  onChanged: () => void,
): void {
  const apply = async () => {
    try {
      const { turnedOff, turnedOn } = await provider.enforceBlocklist();
      if (turnedOff.length || turnedOn.length) onChanged();
    } catch (e) { log('ERROR', 'plugin-off-switch', 'check failed', { error: String(e) }); }
  };
  void apply();
  setInterval(() => { void apply(); }, 60 * 60 * 1000).unref();
}

/** What install and update say for a plugin on the off-switch list. */
export const BLOCKED_MESSAGE = 'This plugin was turned off because it was found to be unsafe.';

/** Where a turned-off plugin's folder is held. WHY outside the plugins folder: everything that
 *  loads plugins (Claude Code, the hook and connected-tool reconcilers, YouCoded's own assistant)
 *  looks there, so a folder moved out is a folder nothing can run — and it is still whole if the
 *  plugin is later taken off the list. Read at call time so tests that move the home folder work. */
export function turnedOffDir(id: string): string {
  return path.join(os.homedir(), '.claude', 'youcoded-turned-off-plugins', id);
}

/** Remove a plugin's own hooks and connected tools while its folder still says which are its
 *  own. The reconcilers only clean up after plugins whose folder exists, so without this they
 *  outlive Uninstall — a connected online service kept being started. Best effort, logged. */
export async function detachPluginExtras(dir: string): Promise<void> {
  await removePluginHooks(dir).catch((e) => log('ERROR', 'plugin-off-switch', 'could not remove plugin hooks', { dir, error: String(e) }));
  await removePluginMcpServers(dir).catch((e) => log('ERROR', 'plugin-off-switch', 'could not remove plugin connected tools', { dir, error: String(e) }));
}

const isDir = (p: string) => fsp.stat(p).then((st) => st.isDirectory(), () => false);

export class PluginOffSwitch {
  private list: Blocklist | null = null;
  private loading: Promise<Blocklist> | null = null;
  private running: Promise<unknown> | null = null;

  /** `url` "" skips the network and uses only the saved list. `onChange` runs when the list or
   *  any plugin changed, so the provider drops its cached Library list. */
  constructor(
    private readonly url: string,
    private readonly file: string,
    private readonly store: SkillConfigStore,
    private readonly onChange: () => void,
  ) {}

  /** The last list this computer saw. Never fetches. */
  async getList(): Promise<Blocklist> {
    if (this.list) return this.list;
    this.loading ??= readSavedBlocklist(this.file).then((list) => (this.list ??= list));
    return this.loading;
  }

  /** True when `id`, or the plugin/bundle it belongs to, is listed. */
  static isBlocked(list: Blocklist, id: string, parent?: string): boolean {
    return list.has(id) || (parent !== undefined && list.has(parent));
  }

  /** WHY (at most 3 s): at launch the screen's first request can arrive while the check is still
   *  running; without the wait the "Turned off" card and its notice would only show next launch. */
  async waitForLaunchCheck(): Promise<void> {
    if (!this.running) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.running, new Promise((r) => { timer = setTimeout(r, 3000); })]);
    clearTimeout(timer);
  }

  /** Fetch the list and make installed plugins match it: turn off every listed one, put back any
   *  we turned off that is no longer listed. Returns what changed. */
  enforce(fetchImpl?: typeof fetch): Promise<{ turnedOff: string[]; turnedOn: string[] }> {
    const run = this.enforceNow(fetchImpl);
    const tracked: Promise<unknown> = run.catch(() => {}).finally(() => { if (this.running === tracked) this.running = null; });
    this.running = tracked;
    return run;
  }

  private async enforceNow(fetchImpl?: typeof fetch): Promise<{ turnedOff: string[]; turnedOn: string[] }> {
    const list = this.url ? (await fetchBlocklist(this.url, this.file, fetchImpl)).list : await readSavedBlocklist(this.file);
    const listChanged = !this.list || !sameIds(this.list, list);
    this.list = list;
    const turnedOff: string[] = [];
    const turnedOn: string[] = [];
    // WHY: ~/.claude is shared with the live app; a run-dev.sh copy must never rewrite the real
    // install (same guard as reconcileBundledPlugins). The dev copy still SHOWS the list.
    const devCopy = Boolean(process.env.YOUCODED_PROFILE) && process.env.YOUCODED_BUNDLED_UPGRADE !== '1';
    if (!devCopy) {
      for (const [id, pkg] of Object.entries(this.store.getInstalledPlugins()) as Array<[string, { turnedOff?: boolean; version?: string }]>) {
        try {
          if (list.has(id)) {
            // Every time, not only the first: if anything put it back (a sync from another
            // computer, a hand-copied folder), it goes off again.
            if (await this.turnOff(id) && !pkg.turnedOff) turnedOff.push(id);
            this.store.setPackageTurnedOff(id, true);
          } else if (pkg.turnedOff) {
            if (await this.turnOn(id, pkg.version)) turnedOn.push(id);
            this.store.setPackageTurnedOff(id, false);
          }
        } catch (e) {
          log('ERROR', 'plugin-off-switch', 'could not apply the off-switch to a plugin', { id, error: String(e) });
        }
      }
    }
    if (turnedOff.length || turnedOn.length) {
      log('WARN', 'plugin-off-switch', 'plugins changed', { turnedOff, turnedOn });
      await reconcileHooks().catch((e) => log('ERROR', 'plugin-off-switch', 'hook reconcile failed', { error: String(e) }));
      await reconcileMcp().catch((e) => log('ERROR', 'plugin-off-switch', 'MCP reconcile failed', { error: String(e) }));
    }
    if (listChanged || turnedOff.length || turnedOn.length) this.onChange();
    return { turnedOff, turnedOn };
  }

  /** Hooks and connected tools first (while the folder says which are its own), then unhook it,
   *  then move the folder aside. True when there was a folder to move. Safe to repeat. */
  private async turnOff(id: string): Promise<boolean> {
    const dir = pluginInstallDir(id);
    const present = await isDir(dir);
    if (present) await detachPluginExtras(dir);
    await unregisterPluginInstall(id);
    if (!present) return false;
    const held = turnedOffDir(id);
    await fsp.mkdir(path.dirname(held), { recursive: true });
    await fsp.rm(held, { recursive: true, force: true });
    try {
      await fsp.rename(dir, held);
    } catch (e) {
      // WHY delete rather than leave it: a folder left in place is loaded again at the next
      // launch (its hooks re-added). Safety beats keeping a copy; the settings live elsewhere.
      log('ERROR', 'plugin-off-switch', 'could not move the plugin aside; deleting it instead', { id, error: String(e) });
      await fsp.rm(dir, { recursive: true, force: true });
    }
    return true;
  }

  /** Put back a plugin no longer listed. True when its folder came back. */
  private async turnOn(id: string, version?: string): Promise<boolean> {
    const held = turnedOffDir(id);
    const dir = pluginInstallDir(id);
    if (!(await isDir(held))) return false; // removed meanwhile: the Library then offers a fresh install
    if (await fsp.stat(dir).then(() => true, () => false)) {
      await fsp.rm(held, { recursive: true, force: true }); // reinstalled by hand: keep that copy
    } else {
      await fsp.rename(held, dir);
    }
    await registerPluginInstall({ id, installPath: dir, version });
    return true;
  }
}

/** Same ids in both lists (reasons are not compared: the UI shows one fixed sentence). */
function sameIds(a: Blocklist, b: Blocklist): boolean {
  if (a.size !== b.size) return false;
  for (const id of a.keys()) if (!b.has(id)) return false;
  return true;
}
