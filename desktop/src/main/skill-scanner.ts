import fs from 'fs';
import path from 'path';
import os from 'os';
import { SkillEntry } from '../shared/types';

/**
 * Scans the filesystem for installed skills and returns a unified list.
 * Used by both IPC handlers (Electron) and RemoteServer (WebSocket).
 *
 * Passes:
 *   1. `~/.claude/plugins/<slug>/skills/` — generic plugin scan (any dir with plugin.json)
 *   2. `~/.claude/plugins/installed_plugins.json` — Claude Code CLI-installed plugins
 *      that may live at non-cache `installPath`s
 *   3. `~/.claude/skills/` — USER-authored local skills (source: 'self')
 *
 * Curated metadata (`skill-registry.json`) is consulted ONLY to enrich entries
 * already discovered on disk — never to inject fake "installed" entries.
 * That earlier behavior caused the marketplace UI to badge uninstalled
 * decomposed packages as "Installed".
 */
export function scanSkills(): SkillEntry[] {
  const registry = loadCuratedRegistry();
  const discoveredIds = new Set<string>();
  const skills: SkillEntry[] = [];

  // Helper: add a discovered skill (curated metadata wins when present)
  function addSkill(
    id: string,
    fallbackName: string,
    fallbackDesc: string,
    inferredSource: 'destinclaude' | 'self' | 'plugin',
    pluginName?: string,
  ) {
    if (discoveredIds.has(id)) return;
    discoveredIds.add(id);

    const curated = registry[id];
    if (curated) {
      skills.push({
        id,
        ...curated,
        type: curated.type || 'plugin',
        visibility: curated.visibility || 'published',
        pluginName,
      } as SkillEntry);
    } else {
      skills.push({
        id,
        displayName: fallbackName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        description: fallbackDesc || `Run the ${fallbackName} skill`,
        category: 'other',
        prompt: `/${id}`,
        source: inferredSource,
        type: 'plugin',
        visibility: 'published',
        pluginName,
      });
    }
  }

  const claudeDir = path.join(os.homedir(), '.claude');
  const pluginsDir = path.join(claudeDir, 'plugins');

  // ── Pass 1: generic plugin scan ──────────────────────────────────────────
  // Decomposition v3 §9.6: every package lives under ~/.claude/plugins/<id>/.
  // Scan both marketplace-installed and CLI-installed plugins uniformly;
  // addSkill() dedupes by id if Pass 2 also picks them up.
  try {
    const pluginEntries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    for (const pluginEntry of pluginEntries) {
      if (!pluginEntry.isDirectory()) continue;
      const pluginRoot = path.join(pluginsDir, pluginEntry.name);
      const hasManifest =
        fs.existsSync(path.join(pluginRoot, 'plugin.json')) ||
        fs.existsSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
      if (!hasManifest) continue;

      const skillsDir = path.join(pluginRoot, 'skills');
      try {
        const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const e of skillEntries) {
          if (e.isDirectory() || e.isSymbolicLink()) {
            // For destinclaude-prefixed packages, keep the bare skill id so
            // existing favorites/curated defaults referencing bare names
            // (e.g. "journaling-assistant") continue to resolve.
            const skillId = pluginEntry.name.startsWith('destinclaude')
              ? e.name
              : `${pluginEntry.name}:${e.name}`;
            const source = pluginEntry.name.startsWith('destinclaude') ? 'destinclaude' : 'plugin';
            addSkill(skillId, e.name, '', source, pluginEntry.name);
          }
        }
      } catch {}
    }
  } catch {}

  // ── Pass 2: installed_plugins.json (CLI-installed plugins) ───────────────
  // Claude Code v2.1+ stores installPath per plugin; the binary's cache dir
  // is `~/.claude/plugins/` so installed_plugins.json lives inside it.
  try {
    const installedPath = path.join(pluginsDir, 'installed_plugins.json');
    const installed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
    const plugins = installed.plugins || {};

    for (const [pluginKey, versions] of Object.entries(plugins) as Array<[string, any[]]>) {
      const latest = versions[0];
      if (!latest?.installPath) continue;
      const installPath = latest.installPath;
      const pluginSlug = pluginKey.split('@')[0];

      const skillsDir = path.join(installPath, 'skills');
      try {
        const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of skillEntries) {
          if (entry.isDirectory()) {
            const skillId = `${pluginSlug}:${entry.name}`;
            addSkill(skillId, entry.name, '', 'plugin', pluginSlug);
          }
        }
      } catch {}

      const commandsDir = path.join(installPath, 'commands');
      try {
        const cmdEntries = fs.readdirSync(commandsDir, { withFileTypes: true });
        for (const entry of cmdEntries) {
          if (entry.isDirectory()) {
            const cmdId = `${pluginSlug}:${entry.name}`;
            addSkill(cmdId, entry.name, '', 'plugin', pluginSlug);
          }
        }
      } catch {}
    }
  } catch {}

  // ── Pass 3: user-authored skills under ~/.claude/skills/ ─────────────────
  // Skills the user wrote locally (not installed from a marketplace, not
  // shipped by any plugin). Tagged source: 'self' so the UI can render a
  // "User Skill" badge instead of "Installed". Mirrors the skip rules in
  // sync-service.findUnroutedSkills() so toolkit-shipped skill mirrors
  // (symlinks, or directories also shipped by a destinclaude-* plugin)
  // are NOT double-counted as user skills.
  try {
    const userSkillsDir = path.join(claudeDir, 'skills');
    const destinclaudePluginDirs = readdirSafe(pluginsDir)
      .filter(d => d.isDirectory() && d.name.startsWith('destinclaude'))
      .map(d => path.join(pluginsDir, d.name));

    for (const entry of readdirSafe(userSkillsDir)) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(userSkillsDir, entry.name);

      // Skip symlinks — those are toolkit-managed mirrors (legacy layout).
      try { if (fs.lstatSync(skillDir).isSymbolicLink()) continue; } catch { continue; }

      // Skip if a destinclaude-* plugin already ships a skill with this name
      // — the on-disk copy is a mirror, not user-authored content.
      const isToolkitMirror = destinclaudePluginDirs.some(p =>
        fs.existsSync(path.join(p, 'skills', entry.name)),
      );
      if (isToolkitMirror) continue;

      // Skip if Pass 1/2 already discovered this id (edge case: a plugin
      // named identically to a user skill). Plugin wins.
      if (discoveredIds.has(entry.name)) continue;

      const meta = readSkillMeta(path.join(skillDir, 'SKILL.md'));
      discoveredIds.add(entry.name);
      skills.push({
        id: entry.name,
        displayName: meta.name || entry.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        description: meta.description || '',
        category: 'other',
        prompt: `/${entry.name}`,
        source: 'self',
        type: 'plugin',
        visibility: 'private',
      });
    }
  } catch {}

  return skills;
}

function loadCuratedRegistry(): Record<string, Omit<SkillEntry, 'id'>> {
  try {
    const registryPath = path.join(__dirname, '..', 'renderer', 'data', 'skill-registry.json');
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    try {
      const devPath = path.join(__dirname, '..', '..', 'src', 'renderer', 'data', 'skill-registry.json');
      return JSON.parse(fs.readFileSync(devPath, 'utf8'));
    } catch {
      console.warn('[skill-scanner] skill-registry.json not found in prod or dev paths');
      return {};
    }
  }
}

function readdirSafe(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Minimal SKILL.md frontmatter reader — just `name` and `description`. */
function readSkillMeta(skillMdPath: string): { name?: string; description?: string } {
  try {
    const raw = fs.readFileSync(skillMdPath, 'utf8');
    const fm = /^---\s*\n([\s\S]*?)\n---/m.exec(raw);
    if (!fm) return {};
    const body = fm[1];
    const name = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(body)?.[1]?.trim();
    const description = /^description:\s*["']?([^"'\n]+)["']?\s*$/m.exec(body)?.[1]?.trim();
    return { name, description };
  } catch { return {}; }
}
