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
 * Project-local `.claude/skills/` are scanned separately by scanProjectSkills().
 * A project cwd must never enter this global, cacheable installed-skills inventory.
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
    inferredSource: 'youcoded-core' | 'self' | 'project' | 'plugin',
    pluginName?: string,
    // The directory holding this skill's SKILL.md. Every call site already
    // computed it to find the skill at all; keeping it lets the native harness
    // LOAD the instructions instead of re-deriving the on-disk layout in a
    // second place. Curated metadata never supplies it — it describes the
    // registry entry, not where this machine installed it — so it is applied
    // AFTER the spread in both branches.
    skillDir?: string,
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
        skillDir,
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
        skillDir,
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
            // For youcoded-core-prefixed packages, keep the bare skill id so
            // existing favorites/curated defaults referencing bare names
            // (e.g. "journaling-assistant") continue to resolve.
            const skillId = pluginEntry.name.startsWith('youcoded')
              ? e.name
              : `${pluginEntry.name}:${e.name}`;
            const source = pluginEntry.name.startsWith('youcoded') ? 'youcoded-core' : 'plugin';
            const skillDir = path.join(skillsDir, e.name);
            // WHY: this loop used to pass '' for fallbackDesc, so every plugin
            // skill without a curated registry entry fell back to the generic
            // "Run the X skill" string even though its SKILL.md has a real
            // description (the same one the Skill tool shows Claude). Read it,
            // same as Pass 3 (user skills) already does below.
            const meta = readSkillMeta(path.join(skillDir, 'SKILL.md'));
            addSkill(skillId, e.name, meta.description || '', source, pluginEntry.name, skillDir);
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
            const skillDir = path.join(skillsDir, entry.name);
            const meta = readSkillMeta(path.join(skillDir, 'SKILL.md'));
            addSkill(skillId, entry.name, meta.description || '', 'plugin', pluginSlug, skillDir);
          }
        }
      } catch {}

      const commandsDir = path.join(installPath, 'commands');
      try {
        const cmdEntries = fs.readdirSync(commandsDir, { withFileTypes: true });
        for (const entry of cmdEntries) {
          if (entry.isDirectory()) {
            const cmdId = `${pluginSlug}:${entry.name}`;
            const cmdDir = path.join(commandsDir, entry.name);
            // A commands/ entry is a slash command, not a skill — it may hold no
            // SKILL.md at all, so meta.description is often empty and the
            // generic fallback still applies. Recording the directory anyway is
            // honest: the catalog reports "installed but unreadable" rather than
            // pretending the entry has no home on disk.
            const meta = readSkillMeta(path.join(cmdDir, 'SKILL.md'));
            addSkill(cmdId, entry.name, meta.description || '', 'plugin', pluginSlug, cmdDir);
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
  // (symlinks, or directories also shipped by a youcoded-core-* plugin)
  // are NOT double-counted as user skills.
  try {
    const userSkillsDir = path.join(claudeDir, 'skills');
    const youcodedCorePluginDirs = readdirSafe(pluginsDir)
      .filter(d => d.isDirectory() && d.name.startsWith('youcoded'))
      .map(d => path.join(pluginsDir, d.name));

    for (const entry of readdirSafe(userSkillsDir)) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(userSkillsDir, entry.name);

      // Skip symlinks — those are toolkit-managed mirrors (legacy layout).
      try { if (fs.lstatSync(skillDir).isSymbolicLink()) continue; } catch { continue; }

      // Skip if a youcoded-core-* plugin already ships a skill with this name
      // — the on-disk copy is a mirror, not user-authored content.
      const isToolkitMirror = youcodedCorePluginDirs.some(p =>
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
        // Already in scope — readSkillMeta just read SKILL.md out of it.
        skillDir,
      });
    }
  } catch {}

  return skills;
}

/** Scan one project's skills separately: they are a session-scoped capability,
 * not app-wide installed inventory. This prevents the Skills screen / remote
 * client from borrowing workflows from whichever project was active last. */
export function scanProjectSkills(projectCwd: string): SkillEntry[] {
  const projectSkillsDir = path.join(projectCwd, '.claude', 'skills');
  const skills: SkillEntry[] = [];
  for (const entry of readdirSafe(projectSkillsDir)) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(projectSkillsDir, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const meta = readSkillMeta(skillFile);
    skills.push({
      id: entry.name,
      displayName: meta.name || entry.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      description: meta.description || '',
      category: 'other',
      prompt: `/${entry.name}`,
      source: 'project',
      type: 'plugin',
      visibility: 'private',
      skillDir,
    });
  }
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
    return { name, description: readFrontmatterDescription(body) };
  } catch { return {}; }
}

// `description:` is sometimes a YAML folded/literal block scalar
// (`description: >` or `description: |`) rather than a plain scalar on one
// line — every youcoded-encyclopedia skill uses this form for its long
// trigger text. A single-line regex captures the block indicator itself
// (">") instead of the text, which is worse than the generic fallback it was
// meant to replace, so walk the following indented lines and join them.
function readFrontmatterDescription(body: string): string | undefined {
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => /^description:\s*/.test(l));
  if (idx === -1) return undefined;
  const inline = /^description:\s*(.*)$/.exec(lines[idx])?.[1]?.trim() ?? '';
  if (!/^[|>][+-]?\d*$/.test(inline)) {
    return inline.replace(/^["']|["']$/g, '').trim() || undefined;
  }
  const collected: string[] = [];
  for (let i = idx + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) {
    collected.push(lines[i].trim());
  }
  return collected.join(' ').trim() || undefined;
}
