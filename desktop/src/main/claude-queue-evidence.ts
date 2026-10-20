import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QueueAttempt } from '../shared/conversation-queue-types';

/** Read-only confirmation of a native receipt in its ORIGINAL conversation, never by message text. */
export async function verifyClaudeQueueEvidence(attempt: QueueAttempt, uuid: string): Promise<boolean> {
  const conversation = attempt.alias.conversationId;
  if (!/^[A-Za-z0-9_-]+$/.test(conversation) || !uuid || uuid.length > 256) return false;
  const projects = path.join(os.homedir(), '.claude', 'projects');
  try {
    const dirs = await fs.promises.readdir(projects, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const file = path.join(projects, dir.name, conversation + '.jsonl');
      try {
        // WHY: old conversations can be huge. Bound both scan work and a malformed single row;
        // missing/truncated/over-budget evidence means unknown, never permission to replay.
        const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 65536 });
        let tail = ''; let bytes = 0;
        try {
          for await (const chunk of stream) {
            bytes += Buffer.byteLength(chunk as string); if (bytes > 256 * 1024 * 1024) return false;
            tail += chunk;
            let end: number;
            while ((end = tail.indexOf('\n')) >= 0) {
              const line = tail.slice(0, end); tail = tail.slice(end + 1);
              if (line.length > 2 * 1024 * 1024 || !line.includes(uuid)) continue;
              let row; try { row = JSON.parse(line); } catch { continue; }
              if (row.uuid === uuid && row.sessionId === conversation && row.isSidechain !== true
                && ((row.type === 'user' && row.message?.role === 'user')
                  || (row.type === 'attachment' && row.attachment?.type === 'queued_command'))) return true;
            }
            if (tail.length > 2 * 1024 * 1024) return false;
          }
        } finally { stream.destroy(); }
      } catch { /* absent/unreadable original file is not nondelivery proof */ }
    }
  } catch { /* no transcript directory is unknown */ }
  return false;
}
