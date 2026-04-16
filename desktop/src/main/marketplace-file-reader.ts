// Reads the raw markdown for a plugin's SKILL.md / command / agent file so
// the in-app file viewer can render it. Installed plugins resolve to the
// on-disk copy; non-installed fall back to a raw GitHub URL derived from the
// marketplace entry's sourceType/sourceRef.
//
// We glob for the file instead of assuming a fixed layout — youcoded-core lays
// skills out under core/skills/, life/skills/, productivity/skills/, while
// single-layer plugins like civic-report use skills/<name>/SKILL.md flat.

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SkillEntry } from '../shared/types';
import { YOUCODED_PLUGINS_DIR } from './claude-code-registry';

export type ComponentKind = 'skill' | 'command' | 'agent';

export interface ReadComponentArgs {
  pluginId: string;
  kind: ComponentKind;
  name: string;
}

export interface ReadComponentResult {
  content: string;
  source: 'local' | 'remote';
  path: string; // for display / debugging only
}

const CLAUDE_PLUGINS_ROOT = path.join(os.homedir(), '.claude', 'plugins');
const REGISTRY_BASE = `https://raw.githubusercontent.com/itsdestin/wecoded-marketplace/${process.env.YOUCODED_MARKETPLACE_BRANCH || 'master'}`;

function resolvePluginDir(id: string): string | null {
  // Core toolkit lives at ~/.claude/plugins/youcoded-core (not the marketplace
  // subtree); marketplace-installed plugins live under YOUCODED_PLUGINS_DIR.
  const topLevel = path.join(CLAUDE_PLUGINS_ROOT, id);
  if (fs.existsSync(topLevel)) return topLevel;
  const marketplace = path.join(YOUCODED_PLUGINS_DIR, id);
  if (fs.existsSync(marketplace)) return marketplace;
  return null;
}

// Relative path shape for each component kind in a plugin tree.
function relativePathsFor(kind: ComponentKind, name: string): string[] {
  if (kind === 'skill') return [`skills/${name}/SKILL.md`];
  if (kind === 'command') return [`commands/${name}.md`];
  return [`agents/${name}.md`];
}

// Walk up to `maxDepth` levels looking for any candidate relative path.
// Depth 4 covers youcoded-core's `core/skills/...` / `life/skills/...` /
// `productivity/skills/...` layouts without descending into node_modules
// or other deep trees.
function findLocalFile(rootDir: string, relative: string, maxDepth = 4): string | null {
  const direct = path.join(rootDir, relative);
  if (fs.existsSync(direct)) return direct;

  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const sub = path.join(dir, entry.name);
      const candidate = path.join(sub, relative);
      if (fs.existsSync(candidate)) return candidate;
      queue.push({ dir: sub, depth: depth + 1 });
    }
  }
  return null;
}

// Build raw.githubusercontent.com URLs for the given relative path. We return
// multiple candidates and try them in order — covers both flat layouts and
// youcoded-core's layered core/life/productivity prefixes.
function buildRemoteCandidates(entry: SkillEntry, relative: string): string[] {
  const prefixes = ['', 'core/', 'life/', 'productivity/'];

  if (entry.sourceType === 'local' && entry.sourceRef) {
    // Plugin lives at <marketplace-repo>/<sourceRef>/...
    return prefixes.map(p => `${REGISTRY_BASE}/${entry.sourceRef}/${p}${relative}`);
  }

  if ((entry.sourceType === 'url' || entry.sourceType === 'git-subdir') && entry.sourceRef) {
    const parsed = parseGithubRepo(entry.sourceRef);
    if (!parsed) return [];
    const subdir = entry.sourceType === 'git-subdir' && entry.sourceSubdir
      ? `${entry.sourceSubdir.replace(/\/$/, '')}/` : '';
    const base = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.branch}`;
    return prefixes.map(p => `${base}/${subdir}${p}${relative}`);
  }

  return [];
}

function parseGithubRepo(url: string): { owner: string; repo: string; branch: string } | null {
  // Accept https://github.com/<owner>/<repo>(.git)(#branch)
  const m = url.match(/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3] || 'master' };
}

export async function readComponent(
  args: ReadComponentArgs,
  fetchIndex: () => Promise<SkillEntry[]>,
): Promise<ReadComponentResult> {
  const { pluginId, kind, name } = args;
  const relatives = relativePathsFor(kind, name);

  // Local first — cheap and works offline.
  const installDir = resolvePluginDir(pluginId);
  if (installDir) {
    for (const rel of relatives) {
      const hit = findLocalFile(installDir, rel);
      if (hit) {
        const content = fs.readFileSync(hit, 'utf8');
        return { content, source: 'local', path: hit };
      }
    }
  }

  // Remote fallback — need the registry entry for sourceType/sourceRef.
  const index = await fetchIndex();
  const entry = index.find(e => e.id === pluginId);
  if (!entry) throw new Error(`Plugin not found in marketplace: ${pluginId}`);

  for (const rel of relatives) {
    const candidates = buildRemoteCandidates(entry, rel);
    for (const url of candidates) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const content = await res.text();
          return { content, source: 'remote', path: url };
        }
      } catch { /* try next */ }
    }
  }

  throw new Error(`File not found: ${kind} "${name}" in ${pluginId}`);
}
