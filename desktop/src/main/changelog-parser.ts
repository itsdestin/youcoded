// changelog-parser.ts — parses Keep-a-Changelog-style markdown into entries.
// Anchored on `## [X.Y.Z]` headers to survive incidental format drift.

// compareSemver lives in shared/ so the renderer can import it without pulling
// in any main-process module. Re-exported here so existing callers keep working.
import { compareSemver } from '../shared/semver';
export { compareSemver };

export interface ChangelogEntry {
  version: string;       // e.g. "1.1.2"
  date?: string;         // e.g. "2026-04-21" (optional, from the header line)
  body: string;          // markdown body between this header and the next
}

// Accept 2-4 numeric components so headers like `## [1.2]` or `## [1.2.3.4]`
// parse cleanly instead of being silently dropped as preamble. compareSemver
// defaults missing components to 0 and truncates beyond the third — consistent
// with how the rest of the codebase treats versions.
const HEADER_RE = /^##\s+\[(\d+(?:\.\d+){1,3})\](?:\s*[—–-]\s*(\S+))?/;

export function parseChangelog(markdown: string): ChangelogEntry[] {
  if (!markdown) return [];
  const lines = markdown.split('\n');
  const entries: ChangelogEntry[] = [];
  let current: { version: string; date?: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(HEADER_RE);
    if (m) {
      if (current) {
        entries.push({ version: current.version, date: current.date, body: current.bodyLines.join('\n').trim() });
      }
      current = { version: m[1], date: m[2], bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
    // else: preamble — drop it
  }
  if (current) {
    entries.push({ version: current.version, date: current.date, body: current.bodyLines.join('\n').trim() });
  }
  return entries;
}

// Returns entries strictly newer than `currentVersion`.
export function filterEntriesSinceVersion(entries: ChangelogEntry[], currentVersion: string): ChangelogEntry[] {
  return entries.filter(e => compareSemver(e.version, currentVersion) > 0);
}

