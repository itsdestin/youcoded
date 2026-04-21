import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { CommandEntry, SkillEntry } from '../shared/types';
import { YOUCODED_COMMANDS, expandWithAliases } from './youcoded-commands';
import { CC_BUILTIN_COMMANDS } from './cc-builtin-commands';
import { scanCommandsFromDir, scanPluginCommandsDir } from './command-scanner';

// Precedence for name collisions: YouCoded (native UI) beats filesystem,
// which beats CC built-in. A command whose name matches an existing skill
// is dropped entirely (avoids double-listing skill-backed CC commands like
// /review, /init, /security-review that ship as skills).
export function mergeCommandSources(
  youcoded: CommandEntry[],
  filesystem: CommandEntry[],
  ccBuiltin: CommandEntry[],
  skills: SkillEntry[],
): CommandEntry[] {
  // Build the skill-name set (names normalized with leading slash for
  // comparison against CommandEntry.name).
  const skillNames = new Set<string>(skills.map((s) => `/${s.displayName}`));

  const byName = new Map<string, CommandEntry>();
  // Insert in reverse precedence so higher-precedence sources overwrite.
  for (const entry of ccBuiltin)  byName.set(entry.name, entry);
  for (const entry of filesystem) byName.set(entry.name, entry);
  for (const entry of youcoded)   byName.set(entry.name, entry);

  // Drop anything that collides with a skill name.
  for (const skillName of skillNames) byName.delete(skillName);

  return Array.from(byName.values());
}

// Stateful provider. Caches the merged list for the session lifetime,
// invalidated via `invalidateCache()` when plugin install/uninstall changes
// the filesystem. Mirrors the LocalSkillProvider caching pattern.
//
// getCommands() is async because LocalSkillProvider.getInstalled() is async
// (even though its body is synchronous — the declaration is `async`, so it
// always returns a Promise). Awaiting the skills list is load-bearing: the
// skill-name dedup step in mergeCommandSources requires a real SkillEntry[]
// array, not a Promise.
export class CommandProvider {
  private cache: CommandEntry[] | null = null;
  private getSkills: () => Promise<SkillEntry[]>;
  private getProjectCwd: () => string | null;

  constructor(
    getSkills: () => Promise<SkillEntry[]>,
    getProjectCwd: () => string | null,
  ) {
    this.getSkills = getSkills;
    this.getProjectCwd = getProjectCwd;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  async getCommands(): Promise<CommandEntry[]> {
    if (this.cache) return this.cache;

    const home = os.homedir();
    const claudeDir = path.join(home, '.claude');

    const youcoded = expandWithAliases(YOUCODED_COMMANDS);

    // Filesystem: user + project + plugin commands
    const user = scanCommandsFromDir(path.join(claudeDir, 'commands'));
    const cwd = this.getProjectCwd();
    const project = cwd ? scanCommandsFromDir(path.join(cwd, '.claude', 'commands')) : [];
    const plugin = scanAllPluginCommandDirs(claudeDir);
    const filesystem = [...user, ...project, ...plugin];

    const skills = await this.getSkills();
    this.cache = mergeCommandSources(youcoded, filesystem, CC_BUILTIN_COMMANDS, skills);
    return this.cache;
  }
}

// Walk `~/.claude/plugins/marketplaces/*/plugins/*/commands/` and collect
// every plugin's namespaced commands.
function scanAllPluginCommandDirs(claudeDir: string): CommandEntry[] {
  const marketplacesRoot = path.join(claudeDir, 'plugins', 'marketplaces');
  const out: CommandEntry[] = [];

  let marketplaces: fs.Dirent[];
  try {
    marketplaces = fs.readdirSync(marketplacesRoot, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const mp of marketplaces) {
    if (!mp.isDirectory()) continue;
    const pluginsRoot = path.join(marketplacesRoot, mp.name, 'plugins');
    let plugins: fs.Dirent[];
    try {
      plugins = fs.readdirSync(pluginsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = path.join(pluginsRoot, plugin.name);
      out.push(...scanPluginCommandsDir(pluginDir, plugin.name));
    }
  }
  return out;
}
