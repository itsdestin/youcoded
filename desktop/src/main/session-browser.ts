import fs from 'fs';
import path from 'path';
import os from 'os';
import { PastSession, HistoryMessage } from '../shared/types';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const TOPICS_DIR = path.join(CLAUDE_DIR, 'topics');

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Converts a project slug back to a display-friendly path.
 * e.g. 'C--Users-desti' → 'C:/Users/desti'
 *      '-home-user-project' → '/home/user/project'
 */
function slugToDisplayPath(slug: string): string {
  if (/^[A-Z]--/.test(slug)) {
    return slug.replace(/^([A-Z])--/, '$1:/').replace(/-/g, '/');
  }
  // Unix slugs start with '-' (from leading /); replace all dashes with /
  return slug.replace(/-/g, '/');
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
    const entries = await fs.promises.readdir(PROJECTS_DIR);
    const statResults = await Promise.all(
      entries.map(async (f) => {
        try {
          const stat = await fs.promises.stat(path.join(PROJECTS_DIR, f));
          return stat.isDirectory() ? f : null;
        } catch { return null; }
      })
    );
    slugs = statResults.filter((s): s is string => s !== null);
  } catch {
    return [];
  }

  const allSessions: PastSession[] = [];

  for (const slug of slugs) {
    const slugDir = path.join(PROJECTS_DIR, slug);
    let files: string[];
    try {
      files = (await fs.promises.readdir(slugDir)).filter((f) => f.endsWith('.jsonl'));
    } catch { continue; }

    const sessionPromises = files.map(async (file) => {
      const sessionId = file.replace('.jsonl', '');
      if (activeSessionIds?.has(sessionId)) return null;

      try {
        const stat = await fs.promises.stat(path.join(slugDir, file));
        if (stat.size < 500) return null;
        const name = await readTopic(sessionId);

        return {
          sessionId,
          name,
          projectSlug: slug,
          projectPath: slugToDisplayPath(slug),
          lastModified: stat.mtimeMs,
          size: stat.size,
        } as PastSession;
      } catch { return null; }
    });

    const results = await Promise.all(sessionPromises);
    allSessions.push(...results.filter((s): s is PastSession => s !== null));
  }

  allSessions.sort((a, b) => b.lastModified - a.lastModified);
  return allSessions;
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
