import { expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('../src/main/cloud-files/path-access', () => ({ requiredRead: read, passiveRead: vi.fn() }));
import { readRequiredInstructionFile, listInstructionDownloads, answerInstructionDownload, releaseInstructionRequests } from '../src/main/cloud-files/production-access';

it('parks only the affected conversation on Not now; consent resumes the exact request', async () => {
  read.mockResolvedValueOnce({ ok: false, error: 'needs-download', operationToken: 'server-only', path: '/p/CLAUDE.md' });
  const pending = readRequiredInstructionFile('/p/CLAUDE.md', 'instructions-test');
  await vi.waitFor(() => expect(listInstructionDownloads('instructions-test')).toHaveLength(1));
  const request = listInstructionDownloads('instructions-test')[0];
  expect(listInstructionDownloads('other')).toEqual([]);
  expect(request).not.toHaveProperty('token');
  await answerInstructionDownload(request.id, 'other', 'allow');
  await answerInstructionDownload(request.id, 'instructions-test', 'deny');
  expect(read).toHaveBeenCalledTimes(1);
  expect(listInstructionDownloads('instructions-test')[0].phase).toBe('denied');
  read.mockResolvedValueOnce({ ok: true, bytes: Buffer.from('real instructions') });
  await answerInstructionDownload(request.id, 'instructions-test', 'allow');
  expect(await pending).toBe('real instructions');
  expect(read).toHaveBeenLastCalledWith('/p/CLAUDE.md', 'instructions-test', { operationToken: 'server-only' });
});
it('release rejects a parked session without pretending its download was canceled', async () => {
  read.mockResolvedValueOnce({ ok: false, error: 'needs-download', operationToken: 'server-only' });
  const pending = readRequiredInstructionFile('/p/AGENTS.md', 'closed-test');
  const rejection = expect(pending).rejects.toThrow('Conversation closed');
  await vi.waitFor(() => expect(listInstructionDownloads('closed-test')).toHaveLength(1));
  releaseInstructionRequests('closed-test');
  await rejection;
  expect(listInstructionDownloads('closed-test')).toEqual([]);
});
