import fs from 'fs';
import os from 'os';
import path from 'path';
import { listPastSessions } from './session-browser';
import { ccProjectSlug } from './slug-encoding';
import type { PastSession } from '../shared/types';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// Cap the per-session read used to build the row preview. The first user message
// sits at the TOP of the transcript, so a bounded head read gets it without
// loading multi-MB transcripts. WHY: the old path called loadHistory(all=true)
// per session, which read AND JSON-parsed every line of EVERY session in the
// project on each list — the dominant cost behind the Project View "loading…"
// stalls. A 64KB head is plenty for the first prompt.
const PREVIEW_HEAD_BYTES = 64 * 1024;
// Mirrors session-browser's guard — only slug/sessionId that match this may be
// turned into a filesystem path (defense against path traversal).
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

// Enriched session for the Conversations tab: adds a one-line preview (the first
// user message). WHY no messageCount: an exact count needs a full transcript
// parse per session — exactly the cost we're removing here. The opened preview
// overlay loads the single clicked session and shows its count there.
export interface ConversationSummary extends PastSession {
  preview: string;
}

// Read at most `bytes` from the start of a file. Returns '' on any error (missing
// file, permission) so a single bad transcript never fails the whole list.
async function readHead(filePath: string, bytes: number): Promise<string> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// Extract the first real user prompt from a transcript head for the row preview.
// Mirrors loadHistory's user rule: type==='user', not meta, has a promptId. A
// trailing partial line (the head may cut mid-line) is skipped.
function firstUserPreview(head: string): string {
  if (!head) return '';
  const lines = head.split('\n');
  const headEndsClean = head.endsWith('\n');
  for (let i = 0; i < lines.length; i++) {
    // The last element may be a truncated line when the head was cut mid-record.
    if (i === lines.length - 1 && !headEndsClean) break;
    const line = lines[i];
    if (!line.trim() || line.includes('\x00')) continue;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed?.type !== 'user' || parsed.isMeta || !parsed.promptId) continue;
    const c = parsed.message?.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      text = c.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join(' ');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 160);
  }
  return '';
}

// WHY: listPastSessions is global. Project View needs just this project's
// sessions, so filter by the same slug CC uses for the project directory, then
// attach a one-line preview via a BOUNDED head read (not a full transcript
// parse). Cheap enough that the hero can call it on every project switch.
export async function listProjectConversations(projectPath: string): Promise<ConversationSummary[]> {
  // CC slugs realpath(cwd) (see slug-encoding.ts fixture "symlink resolves to
  // realpath"). Resolve the same way, falling back exactly as CC's Px() does,
  // so a symlinked project folder finds CC's real directory.
  let resolved: string;
  try { resolved = fs.realpathSync.native(projectPath); } catch { resolved = projectPath; }
  const slug = ccProjectSlug(resolved);
  const all = await listPastSessions();
  const mine = all.filter((s) => s.projectSlug === slug);
  return Promise.all(
    mine.map(async (s) => {
      // s.projectSlug is the REAL on-disk dir name (correct case) from the
      // directory scan — use it directly, not the normalized input slug.
      let preview = '';
      if (SAFE_ID_RE.test(s.projectSlug) && SAFE_ID_RE.test(s.sessionId)) {
        const jsonlPath = path.join(PROJECTS_DIR, s.projectSlug, `${s.sessionId}.jsonl`);
        preview = firstUserPreview(await readHead(jsonlPath, PREVIEW_HEAD_BYTES));
      }
      return { ...s, preview };
    }),
  );
}
