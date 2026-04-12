import fs from 'fs';
import path from 'path';
import os from 'os';
import { SkillEntry } from '../shared/types';

/**
 * Scans the filesystem for installed skills and returns a unified list.
 * Used by both IPC handlers (Electron) and RemoteServer (WebSocket).
 */
export function scanSkills(): SkillEntry[] {
  // Load curated registry (bundled with the app)
  let registry: Record<string, Omit<SkillEntry, 'id'>> = {};
  try {
    const registryPath = path.join(__dirname, '..', 'renderer', 'data', 'skill-registry.json');
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    // In dev mode, try the src path
    try {
      const devPath = path.join(__dirname, '..', '..', 'src', 'renderer', 'data', 'skill-registry.json');
      registry = JSON.parse(fs.readFileSync(devPath, 'utf8'));
    } catch {
      console.warn('[skill-scanner] skill-registry.json not found in prod or dev paths');
    }
  }

  const discoveredIds = new Set<string>();
  const skills: SkillEntry[] = [];

  // Helper: add a discovered skill (curated metadata wins)
  function addSkill(id: string, fallbackName: string, fallbackDesc: string, inferredSource: 'destinclaude' | 'self' | 'plugin', pluginName?: string) {
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

  const pluginsDir = path.join(os.homedir(), '.claude', 'plugins');

  // 1. Scan DestinClaude skills (direct children of destinclaude/skills/)
  const dcSkillsDir = path.join(pluginsDir, 'destinclaude', 'skills');
  try {
    const entries = fs.readdirSync(dcSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        addSkill(entry.name, entry.name, '', 'destinclaude');
      }
    }
  } catch {}

  // 2. Scan installed cache plugins via installed_plugins.json.
  // Fix: the canonical location is ~/.claude/installed_plugins.json, NOT
  // ~/.claude/plugins/installed_plugins.json. The old path always missed the
  // file, which is one reason marketplace-installed plugins never showed up.
  try {
    const installedPath = path.join(os.homedir(), '.claude', 'installed_plugins.json');
    const installed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
    const plugins = installed.plugins || {};

    for (const [pluginKey, versions] of Object.entries(plugins) as Array<[string, any[]]>) {
      const latest = versions[0];
      if (!latest?.installPath) continue;
      const installPath = latest.installPath;
      const pluginSlug = pluginKey.split('@')[0];

      // Check for skills/ directory
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

      // Check for commands/ directory (slash commands)
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

  // 3. Add curated-only entries (skills that exist in registry but weren't discovered on disk)
  for (const [id, meta] of Object.entries(registry)) {
    if (!discoveredIds.has(id)) {
      skills.push({
        id,
        ...meta,
        type: (meta as any).type || 'plugin',
        visibility: (meta as any).visibility || 'published',
      } as SkillEntry);
    }
  }

  return skills;
}
