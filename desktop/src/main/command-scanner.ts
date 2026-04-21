import * as fs from 'fs';
import * as path from 'path';
import type { CommandEntry } from '../shared/types';

// Scans `.md` files in a single directory and returns one CommandEntry per
// file. The command name is the file stem with a leading slash; the
// description is pulled from the YAML frontmatter `description:` field
// (or empty string if no frontmatter / no description).
export function scanCommandsFromDir(dir: string): CommandEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: CommandEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const stem = entry.name.slice(0, -3);
    let description = '';
    try {
      const raw = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      description = extractFrontmatterDescription(raw);
    } catch {
      // ignore unreadable files
    }
    out.push({
      name: `/${stem}`,
      description,
      source: 'filesystem',
      clickable: true,
    });
  }
  return out;
}

// Scans a plugin's `commands/` subdirectory and namespaces each entry with
// the plugin slug (e.g. `superpowers/commands/brainstorm.md` →
// `/superpowers:brainstorm`). The caller passes `pluginDir` (the plugin
// root) and `pluginSlug` (the namespace prefix).
export function scanPluginCommandsDir(pluginDir: string, pluginSlug: string): CommandEntry[] {
  const commandsDir = path.join(pluginDir, 'commands');
  const raw = scanCommandsFromDir(commandsDir);
  return raw.map((entry) => ({
    ...entry,
    name: `/${pluginSlug}:${entry.name.slice(1)}`, // strip leading '/' then re-add with namespace
  }));
}

// Parse the `description:` field out of a YAML frontmatter block. Not a
// full YAML parser — we only need this one field and it's always a simple
// scalar in existing plugin command files. Returns '' if absent.
function extractFrontmatterDescription(content: string): string {
  // Normalize CRLF → LF so Windows-authored files don't trip the fence
  // detection or leave \r in captured values.
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return '';
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return '';
  const block = normalized.slice(3, end);
  const match = block.match(/^\s*description\s*:\s*(.+?)\s*$/m);
  if (!match) return '';
  let value = match[1].trim();
  // Strip surrounding quotes if present.
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}
