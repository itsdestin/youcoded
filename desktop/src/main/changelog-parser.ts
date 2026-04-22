// changelog-parser.ts — parses Keep-a-Changelog-style markdown into entries.
// Anchored on `## [X.Y.Z]` headers to survive incidental format drift.

export interface ChangelogEntry {
  version: string;       // e.g. "1.1.2"
  date?: string;         // e.g. "2026-04-21" (optional, from the header line)
  body: string;          // markdown body between this header and the next
}

const HEADER_RE = /^##\s+\[(\d+\.\d+\.\d+)\](?:\s*[—–-]\s*(\S+))?/;

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

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10));
  const pb = b.split('.').map(n => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}
