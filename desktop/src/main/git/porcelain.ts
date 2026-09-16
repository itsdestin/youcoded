// Pure parsers for git plumbing output. No I/O, no electron imports — every
// function takes strings so the whole module unit-tests with fixtures.
// Spec: docs/archive/specs/2026-07-22-git-surface.md section 3.
import type { StructuredPatchHunk } from '../../shared/types';
import type { GitFileCounts, GitLogEntry } from '../../shared/git-types';

export interface PorcelainEntry {
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
}

// git status --porcelain=v2 -z --branch. NUL-delimited record shapes:
//   # branch.head <name>          (name is "(detached)" when detached)
//   1 XY ... <path>               (ordinary change; X=index, Y=worktree, "." = unchanged)
//   2 XY ... <path>\0<origPath>   (rename/copy; two NUL records)
//   u XY ... <path>               (unmerged/conflicted — mid-merge)
//   ? <path>                      (untracked)
export function parsePorcelainV2(text: string): { branch: string | null; files: PorcelainEntry[] } {
  let branch: string | null = null;
  const files: PorcelainEntry[] = [];
  // WHY: -z preserves literal tabs/newlines/quotes; rename sources occupy a
  // separate record and must be consumed even if they look like status entries.
  const records = text.split('\0');
  for (let i = 0; i < records.length; i++) {
    const line = records[i];
    if (line.startsWith('# branch.head ')) {
      const name = line.slice('# branch.head '.length).trim();
      branch = name === '(detached)' ? null : name;
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4);
      // Fields are space-separated; the path is everything after the 8th field
      // (v2 format is fixed-width up to the path).
      const fieldCount = line.startsWith('2 ') ? 9 : 8;
      const p = line.split(' ').slice(fieldCount).join(' ');
      if (line.startsWith('2 ')) i++; // original path, not another status entry
      const staged = xy[0] !== '.';
      const unstaged = xy[1] !== '.';
      const kind =
        xy.includes('R') ? 'renamed'
        : xy.includes('A') ? 'added'
        : xy.includes('D') ? 'deleted'
        : 'modified';
      files.push({ path: p, staged, unstaged, untracked: false, kind });
    } else if (line.startsWith('u ')) {
      // Fix (2026-07-22 bug): unmerged lines used to be SKIPPED entirely, so a
      // repo mid-merge showed its conflicted files as clean in the git panel.
      // Porcelain v2: `u XY <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` —
      // 10 fixed space-separated fields before the path (vs 8 for `1` lines).
      // Any XY (UU, AA, DU, …) renders the same honest "Conflict" state.
      // staged:false is deliberate — git refuses to commit an unmerged index
      // entry, so it must not inflate the repo-wide staged count either.
      const p = line.split(' ').slice(10).join(' ');
      files.push({ path: p, staged: false, unstaged: true, untracked: false, kind: 'conflicted' });
    } else if (line.startsWith('? ')) {
      files.push({ path: line.slice(2), staged: false, unstaged: true, untracked: true, kind: 'untracked' });
    }
  }
  return { branch, files };
}

interface NumstatRecord {
  path: string;
  renamedFrom?: string;
  added: number;
  removed: number;
  binary: boolean;
}

// WHY: in --numstat -z only an empty path field signals a rename/copy:
// counts\t\0old\0new\0. Literal arrows, braces and tabs are just filename bytes.
// Share this cursor reader with log so source/destination records cannot be
// mistaken for commit headers (even when a filename contains control bytes).
function readNumstat(records: string[], index: number): { entry: NumstatRecord; next: number } | null {
  const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[index]);
  if (!match) return null;
  const [, a, r, field] = match;
  const renamedFrom = field === '' ? records[++index] : undefined;
  const p = field === '' ? records[++index] : field;
  if (!p || (field === '' && !renamedFrom)) return null;
  return {
    entry: { path: p, renamedFrom, added: parseInt(a, 10) || 0, removed: parseInt(r, 10) || 0, binary: a === '-' || r === '-' },
    next: index + 1,
  };
}

// git diff --numstat -z; keys are the destination paths for renames/copies.
export function parseNumstat(text: string): Map<string, { added: number; removed: number; binary: boolean }> {
  const out = new Map<string, { added: number; removed: number; binary: boolean }>();
  const records = text.split('\0');
  for (let i = 0; i < records.length;) {
    const row = readNumstat(records, i);
    if (!row) { i++; continue; }
    const { path, added, removed, binary } = row.entry;
    out.set(path, { added, removed, binary });
    i = row.next;
  }
  return out;
}

// LOG_FORMAT emits NUL-separated metadata prefixed by an empty record.
// WHY: neither newline nor 0x1e/0x1f is safe in paths/subjects. NUL framing
// plus consuming rename pairs keeps metadata separate from arbitrary paths.
export function parseLogRecords(text: string): GitLogEntry[] {
  const records = text.split('\0');
  const out: GitLogEntry[] = [];
  for (let i = 0; i < records.length;) {
    if (records[i] === '' && /^[0-9a-f]{4,40}$/.test(records[i + 1] ?? '') && i + 3 < records.length) {
      const sha = records[i + 1];
      out.push({ sha, shortSha: sha.slice(0, 7), subject: records[i + 2], authorDate: records[i + 3],
        pathAtCommit: undefined, renamedFrom: undefined, counts: null });
      i += 4;
      continue;
    }
    // Git inserts a newline between the pretty header and the numstat row;
    // strip it only from the count prefix, never from a path field.
    records[i] = records[i].replace(/^\n/, '');
    const row = readNumstat(records, i);
    if (!row) { i++; continue; }
    const current = out[out.length - 1];
    if (current && current.pathAtCommit === undefined) {
      const { path, renamedFrom, added, removed, binary } = row.entry;
      current.pathAtCommit = path;
      current.renamedFrom = renamedFrom;
      current.counts = binary ? null : { added, removed };
    }
    i = row.next;
  }
  return out;
}

// Unified diff -> StructuredPatchHunk[] (absolute file line numbers, the shape
// UnifiedDiff.tsx already renders for tool cards). "@@ -a[,b] +c[,d] @@".
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(text: string): { hunks: StructuredPatchHunk[]; binary: boolean } {
  const hunks: StructuredPatchHunk[] = [];
  let binary = false;
  let current: StructuredPatchHunk | null = null;
  for (const line of text.split('\n')) {
    const m = HUNK_RE.exec(line);
    if (m) {
      current = {
        oldStart: parseInt(m[1], 10),
        oldLines: m[2] !== undefined ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newLines: m[4] !== undefined ? parseInt(m[4], 10) : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (/^Binary files .* differ$/.test(line)) { binary = true; continue; }
    if (current && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
      // "\ No newline at end of file" starts with backslash and is skipped.
      current.lines.push(line);
    } else if (line.startsWith('diff ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      current = null; // next file section header — stop appending to the old hunk
    }
  }
  return { hunks, binary };
}

export function countsFromHunks(hunks: StructuredPatchHunk[]): GitFileCounts {
  let added = 0;
  let removed = 0;
  for (const h of hunks) for (const l of h.lines) {
    if (l.startsWith('+')) added++;
    else if (l.startsWith('-')) removed++;
  }
  return { added, removed };
}

// An untracked file has no diff vs HEAD; render it as one all-additions hunk.
export function synthesizeAddHunk(content: string): StructuredPatchHunk {
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // trailing terminator, not a line
  return { oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => '+' + l) };
}
