import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyClaudeQueueEvidence } from '../src/main/claude-queue-evidence';
import type { QueueAttempt } from '../src/shared/conversation-queue-types';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))); });
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-evidence-')); roots.push(home); vi.spyOn(os, 'homedir').mockReturnValue(home);
  const dir = path.join(home, '.claude', 'projects', 'original-project'); await fs.mkdir(dir, { recursive: true });
  const attempt: QueueAttempt = { attemptId: 'attempt', queueItemId: 'item', sendId: 'send', alias: { provider: 'claude', conversationId: 'original' }, incarnation: 'old', boundaryId: 'boundary', boundarySeq: 1, wireHash: 'a'.repeat(64), createdAt: 1 };
  const write = async (conversation: string, rows: unknown[], complete = true) => fs.writeFile(path.join(dir, conversation + '.jsonl'), rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + (complete ? '\n' : ''));
  return { attempt, write };
}
describe('read-only original conversation queue evidence', () => {
  it('confirms exact native UUIDs in the original user and queued-command rows, not matching text or a new conversation', async () => {
    const f = await fixture();
    await f.write('current', [{ uuid: 'real-row', sessionId: 'current', type: 'user', message: { role: 'user', content: 'same text' } }]);
    await f.write('original', [{ uuid: 'different-row', sessionId: 'original', type: 'user', message: { role: 'user', content: 'same text' } }]);
    expect(await verifyClaudeQueueEvidence(f.attempt, 'real-row')).toBe(false);
    await f.write('original', ['broken JSON', { uuid: 'real-row', sessionId: 'original', type: 'user', message: { role: 'user', content: 'transformed content is irrelevant' } }]);
    expect(await verifyClaudeQueueEvidence(f.attempt, 'real-row')).toBe(true);
    await f.write('original', [{ uuid: 'queued-row', sessionId: 'original', type: 'attachment', attachment: { type: 'queued_command' } }]);
    expect(await verifyClaudeQueueEvidence(f.attempt, 'queued-row')).toBe(true);
  });
  it('retains unknown for missing, truncated, child, wrong-session or non-human UUID evidence', async () => {
    const f = await fixture(); expect(await verifyClaudeQueueEvidence(f.attempt, 'row')).toBe(false);
    for (const row of [
      { uuid: 'row', sessionId: 'other', type: 'user', message: { role: 'user' } },
      { uuid: 'row', sessionId: 'original', type: 'user', isSidechain: true, message: { role: 'user' } },
      { uuid: 'row', sessionId: 'original', type: 'assistant', message: { role: 'assistant' } },
    ]) { await f.write('original', [row]); expect(await verifyClaudeQueueEvidence(f.attempt, 'row')).toBe(false); }
    await f.write('original', [{ uuid: 'row', sessionId: 'original', type: 'user', message: { role: 'user' } }], false);
    expect(await verifyClaudeQueueEvidence(f.attempt, 'row')).toBe(false);
    expect(await verifyClaudeQueueEvidence({ ...f.attempt, alias: { provider: 'claude', conversationId: '../original' } }, 'row')).toBe(false);
  });
});
