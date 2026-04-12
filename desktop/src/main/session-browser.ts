import fs from 'fs';
import path from 'path';
import os from 'os';
import { PastSession, HistoryMessage } from '../shared/types';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const TOPICS_DIR = path.join(CLAUDE_DIR, 'topics');
const CONVERSATION_INDEX_PATH = path.join(CLAUDE_DIR, 'conversation-index.json');

/** Read the synced complete-flag map from conversation-index.json.
 *  Returned as a { sessionId: true } map for O(1) join. */
function readCompleteFlags(): Record<string, boolean> {
  try {
    const raw = fs.readFileSync(CONVERSATION_INDEX_PATH, 'utf8');
    const index = JSON.parse(raw);
    const out: Record<string, boolean> = {};
    for (const [sid, entry] of Object.entries<any>(index?.sessions || {})) {
      if (entry?.complete) out[sid] = true;
    }
    return out;
  } catch { return {}; }
}

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Retry an async operation up to `attempts` times with a short delay between tries. */
async function withRetry<T>(fn: () => Promise<T>, attempts: number = 3, delayMs: number = 100): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error('unreachable');
}

/**
 * Resolves a project slug back to a real filesystem path by walking the
 * directory tree. The naive approach (replace all dashes with separators)
 * breaks when directory names contain hyphens (e.g. "destinclaude-dev"
 * becomes "destinclaude/dev"). This function tries each segment greedily
 * against the filesystem, extending with hyphens when a single part
 * doesn't match a real directory.
 */
function resolveSlugToPath(slug: string): string {
  let root: string;
  let parts: string[];

  if (/^[A-Z]--/.test(slug)) {
    // Windows: C--Users-desti-project → root=C:\, parts=[Users, desti, project]
    root = slug[0] + ':\\';
    parts = slug.slice(3).split('-').filter(Boolean);
  } else {
    // Unix: -home-user-project → root=/, parts=[home, user, project]
    root = '/';
    parts = slug.slice(1).split('-').filter(Boolean);
  }

  if (parts.length === 0) return root;
  return walkSlugParts(root, parts);
}

/**
 * Recursively resolves slug dash-segments against the filesystem.
 * Tries single segment first; if it doesn't exist as a directory,
 * joins with the next segment via hyphen and retries.
 */
function walkSlugParts(base: string, parts: string[]): string {
  for (let len = 1; len <= parts.length; len++) {
    const segment = parts.slice(0, len).join('-');
    const candidate = path.join(base, segment);

    if (len === parts.length) {
      // Last possible grouping — accept whether or not it exists on disk
      return candidate;
    }

    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return walkSlugParts(candidate, parts.slice(len));
      }
    } catch {}
  }

  // Fallback: naive join
  return path.join(base, parts.join('-'));
}

async function readTopic(sessionId: string): Promise<string> {
  try {
    const content = await fs.promises.readFile(path.join(TOPICS_DIR, `topic-${sessionId}`), 'utf8');
    return content.trim() || 'Untitled';
  } catch {
    return 'Untitled';
  }
}

/**
 * Scans all project directories for JSONL transcript files.
 * Returns sessions sorted by last modified (most recent first).
 * Excludes sessions that are currently active (matching activeSessionIds).
 * Uses async I/O with Promise.all for parallelism.
 */
export async function listPastSessions(activeSessionIds?: Set<string>): Promise<PastSession[]> {
  let slugs: string[];
  try {
    const entries = await withRetry(() => fs.promises.readdir(PROJECTS_DIR));
    const statResults = await Promise.all(
      entries.map(async (f) => {
        try {
          const stat = await withRetry(() => fs.promises.stat(path.join(PROJECTS_DIR, f)));
          return stat.isDirectory() ? f : null;
        } catch { return null; }
      })
    );
    slugs = statResults.filter((s): s is string => s !== null);
  } catch (err) {
    console.warn('[session-browser] Failed to read projects directory:', err);
    return [];
  }

  // Join complete-flag metadata from the synced conversation index
  const completeFlags = readCompleteFlags();

  const allSessions: PastSession[] = [];

  for (const slug of slugs) {
    const slugDir = path.join(PROJECTS_DIR, slug);
    let files: string[];
    try {
      files = (await withRetry(() => fs.promises.readdir(slugDir))).filter((f) => f.endsWith('.jsonl'));
    } catch (err) {
      console.warn(`[session-browser] Failed to read slug dir ${slug} after retries:`, err);
      continue;
    }

    const sessionPromises = files.map(async (file) => {
      const sessionId = file.replace('.jsonl', '');
      if (activeSessionIds?.has(sessionId)) return null;

      try {
        const stat = await withRetry(() => fs.promises.stat(path.join(slugDir, file)));
        if (stat.size < 500) return null;
        const name = await readTopic(sessionId);

        return {
          sessionId,
          name,
          projectSlug: slug,
          projectPath: resolveSlugToPath(slug),
          lastModified: stat.mtimeMs,
          size: stat.size,
          complete: !!completeFlags[sessionId],
        } as PastSession;
      } catch {
        console.warn(`[session-browser] Failed to stat ${slug}/${file} after retries`);
        return null;
      }
    });

    const results = await Promise.all(sessionPromises);
    allSessions.push(...results.filter((s): s is PastSession => s !== null));
  }

  // Deduplicate: aggregation symlinks/copies place project-specific .jsonl
  // files into the home slug for unified browsing. When the same sessionId
  // appears in both the home slug and a project slug, keep the project slug
  // entry so resume uses the correct working directory.
  const deduped = new Map<string, PastSession>();
  for (const s of allSessions) {
    const existing = deduped.get(s.sessionId);
    if (!existing || s.projectSlug.length > existing.projectSlug.length) {
      deduped.set(s.sessionId, s);
    }
  }

  const result = Array.from(deduped.values());
  result.sort((a, b) => b.lastModified - a.lastModified);
  return result;
}

/**
 * Loads the last N conversational messages from a session's JSONL file.
 * "Conversational" = user prompts (with promptId, not meta) and assistant
 * end_turn responses (text content only, no tool calls).
 *
 * Uses async I/O with single-pass deduplication (Map overwrite pattern)
 * and null-byte line filtering.
 */
export async function loadHistory(
  sessionId: string,
  projectSlug: string,
  count: number = 10,
  all: boolean = false,
): Promise<HistoryMessage[]> {
  if (!SAFE_ID_RE.test(projectSlug) || !SAFE_ID_RE.test(sessionId)) return [];
  const jsonlPath = path.join(PROJECTS_DIR, projectSlug, `${sessionId}.jsonl`);

  let content: string;
  try {
    content = await fs.promises.readFile(jsonlPath, 'utf8');
  } catch {
    return [];
  }

  // Filter null-byte corrupted lines (NTFS pre-allocation gaps from process kills)
  const lines = content.trim().split('\n').filter(line =>
    line.trim() && !line.includes('\x00')
  );

  // Single-pass: overwrite Map by UUID (last occurrence wins for dedup)
  const lastParsedByUuid = new Map<string, any>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.uuid && (parsed.type === 'user' || parsed.type === 'assistant')) {
        lastParsedByUuid.set(parsed.uuid, parsed);
      }
    } catch {}
  }

  // Extract conversational messages from deduplicated set (preserves insertion order)
  const messages: HistoryMessage[] = [];
  for (const parsed of lastParsedByUuid.values()) {
    const message = parsed.message;
    if (!message) continue;

    if (parsed.type === 'user') {
      if (parsed.isMeta) continue;
      if (!parsed.promptId) continue;
      const c = message.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
          : '';
      if (!text.trim()) continue;
      messages.push({ role: 'user', content: text.trim(), timestamp: parsed.timestamp || 0 });
    } else if (parsed.type === 'assistant' && message.stop_reason === 'end_turn') {
      const c = message.content;
      const texts = Array.isArray(c)
        ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
        : typeof c === 'string' ? c : '';
      if (!texts.trim()) continue;
      messages.push({ role: 'assistant', content: texts.trim(), timestamp: parsed.timestamp || 0 });
    }
  }

  if (all) return messages;
  return messages.slice(-count);
}
