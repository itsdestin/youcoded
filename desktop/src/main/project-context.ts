import fs from 'fs';
import { passiveRead, readPath, type PathReadOptions } from './cloud-files/path-access';
import os from 'os';
import path from 'path';
import { discoverContext, RuleEntry } from './project/context-discovery';
import { ccProjectSlug } from './slug-encoding';
import { RECOGNIZED_INSTRUCTION_FILES, ContextGroup, ContextFile } from '../shared/project-context-types';
import { canonicalize } from '../shared/artifacts/canonicalize';

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');

async function exists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

// Find recognized instruction files in a directory and (for project scope) its
// .claude subdir. Returns basename → absolutePath for those that exist.
async function findInstructionFiles(dirs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const dir of dirs) {
    for (const name of RECOGNIZED_INSTRUCTION_FILES) {
      const p = path.join(dir, name);
      if (!out[name] && await exists(p)) out[name] = p;
    }
  }
  return out;
}

// Parse a rule .md frontmatter's `paths:` YAML list (per .claude/rules/README.md
// convention — inline `["a","b"]` or block `- "a"`). A missing `paths:` key, or
// a list containing only the catch-all "**", means the rule is eager (loaded
// every time, per the README's "omitting it makes the rule EAGER" note and
// live-app-safety.md's explicit paths: ["**"]).
export function parseRulePaths(frontmatter: string): string[] {
  const inline = /^\s*paths\s*:\s*\[(.*)\]\s*$/im.exec(frontmatter);
  if (inline) {
    return inline[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  // WHY: anchor to line start (m flag) so a key like `myPaths:` does not
  // shadow the real `paths:` key.
  const blockStart = /^\s*paths\s*:\s*$/im.exec(frontmatter);
  if (!blockStart) return [];
  const afterKey = frontmatter.slice(blockStart.index + blockStart[0].length);
  const out: string[] = [];
  for (const line of afterKey.split('\n').slice(1)) {
    const item = /^\s*-\s*(.+)\s*$/.exec(line);
    if (!item) break; // next top-level key (e.g. last_verified:) ends the list
    out.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

async function readRules(rulesDir: string, enrich: boolean): Promise<RuleEntry[]> {
  let files: string[];
  try { files = (await fs.promises.readdir(rulesDir)).filter(f => f.endsWith('.md')); }
  catch { return []; }
  const out: RuleEntry[] = [];
  for (const file of files) {
    const absolutePath = path.join(rulesDir, file);
    let glob: string | undefined;
    try {
      // WHY: a metadata-discovered rule remains selectable even when its content
      // is unavailable. The authorization path must never read rule contents.
      const bytes = enrich ? await passiveRead(absolutePath) : null;
      const head = bytes?.toString('utf8').slice(0, 2000) ?? '';
      const fm = /^---\s*([\s\S]*?)\s*---/.exec(head)?.[1] ?? '';
      const paths = parseRulePaths(fm);
      const isEager = paths.length === 0 || (paths.length === 1 && paths[0] === '**');
      if (!isEager) glob = paths.length === 1 ? paths[0] : `${paths[0]} +${paths.length - 1} more`;
    } catch { /* unreadable rule — list it with no glob (renders as eager) */ }
    out.push({ file, glob, absolutePath });
  }
  return out;
}

// Discovery WITHOUT the per-file stat+head-read enrichment — used by both
// listContext (which enriches for display) and the isAllowed guard (which only
// needs the path set; enriching there made every single context-file read do a
// full stat+read sweep of the project's context files).
async function discoverContextGroups(projectPath: string, enrichRules = false): Promise<ContextGroup[]> {
  // CC slugs realpath(cwd) (see slug-encoding.ts fixture "symlink resolves to
  // realpath"). Resolve the same way, falling back exactly as CC's Px() does,
  // so a symlinked project folder finds CC's real directory.
  let resolved: string;
  try { resolved = await fs.promises.realpath(projectPath); } catch { resolved = projectPath; }
  const slug = ccProjectSlug(resolved);
  const projInstr = await findInstructionFiles([projectPath, path.join(projectPath, '.claude')]);
  const globalInstr = await findInstructionFiles([CLAUDE_DIR]);
  const projRules = await readRules(path.join(projectPath, '.claude', 'rules'), enrichRules);
  const globalRules = await readRules(path.join(CLAUDE_DIR, 'rules'), enrichRules);

  const memoryDir = path.join(CLAUDE_DIR, 'projects', slug, 'memory');
  let memoryFiles: string[] = [];
  const memoryPaths: Record<string, string> = {};
  try {
    memoryFiles = (await fs.promises.readdir(memoryDir)).filter(f => f.endsWith('.md'));
    for (const f of memoryFiles) memoryPaths[f] = path.join(memoryDir, f);
  } catch { /* no memory dir for this project */ }

  const groups = discoverContext({
    projectRoot: projectPath, homeDir: HOME, projectSlug: slug,
    projectInstructionFiles: Object.keys(projInstr), projectInstructionPaths: projInstr,
    projectRules: projRules,
    globalInstructionFiles: Object.keys(globalInstr), globalInstructionPaths: globalInstr,
    globalRules,
    memoryFiles, memoryPaths,
  });
  return groups;
}

export async function listContext(projectPath: string): Promise<ContextGroup[]> {
  const groups = await discoverContextGroups(projectPath, true);
  // Enrich each file with a one-line description + formatted size for the rows
  // (the prototype's ctxRow shows both). Cheap — a handful of files per project.
  await Promise.all(groups.flatMap((g) => g.files).map(enrichContextFile));
  return groups;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// First useful line of a context file → a plain-language description. Prefers a
// frontmatter `description:` (common in rule files), else the first non-empty,
// non-heading body line. Mutates the file in place (it's the discovered object).
function deriveDescription(headRaw: string): string | undefined {
  let head = headRaw;
  const fm = /^---\s*([\s\S]*?)\s*---/.exec(head)?.[1];
  if (fm) {
    const d = /^\s*description\s*:\s*(.+)$/im.exec(fm)?.[1]?.trim();
    if (d) return d.replace(/^['"]|['"]$/g, '').slice(0, 120);
    const close = head.indexOf('---', 3);
    if (close !== -1) head = head.slice(close + 3);
  }
  for (const raw of head.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('---') || line.startsWith('<!--')) continue;
    return line.replace(/[*_`>]/g, '').trim().slice(0, 120);
  }
  return undefined;
}

async function enrichContextFile(f: ContextFile): Promise<void> {
  try {
    const stat = await fs.promises.stat(f.absolutePath);
    f.size = formatBytes(stat.size);
  } catch { /* leave size undefined */ }
  try {
    // WHY: descriptions never justify downloading a context file.
    const bytes = await passiveRead(f.absolutePath);
    if (bytes) f.description = deriveDescription(bytes.toString('utf8').slice(0, 4000));
  } catch { /* leave description undefined */ }
}

// Allow-list guard: only paths that appear in the discovered set for this
// project may be read or written. Prevents arbitrary-path I/O via these IPCs.
// Uses the enrichment-free discovery (no per-file stat/read sweep per guard
// call) and compares CANONICAL paths so a renderer-side normalization (slash
// direction, drive case) can't silently break the allow-list.
async function isAllowed(projectPath: string, absolutePath: string): Promise<boolean> {
  const groups = await discoverContextGroups(projectPath);
  const target = canonicalize(absolutePath, null);
  return groups.some(g => g.files.some(f => canonicalize(f.absolutePath, null) === target));
}

export async function readContextFile(projectPath: string, absolutePath: string, options: PathReadOptions = {}) {
  if (!await isAllowed(projectPath, absolutePath)) return { ok: false, error: 'not-a-context-file' };
  try {
    const resolved = await fs.promises.realpath(absolutePath);
    const guarded = await readPath(resolved, { ...options, intent: options.intent ?? 'preview' });
    if (guarded) return guarded.ok ? { ok: true, content: guarded.bytes.toString('utf8') } : guarded;
    return { ok: true, content: await fs.promises.readFile(resolved, 'utf8') };
  }
  catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
}

export async function writeContextFile(projectPath: string, absolutePath: string, content: string): Promise<{ ok: boolean; error?: string }> {
  if (!await isAllowed(projectPath, absolutePath)) return { ok: false, error: 'not-a-context-file' };
  try { await fs.promises.writeFile(absolutePath, content, 'utf8'); return { ok: true }; }
  catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
}
