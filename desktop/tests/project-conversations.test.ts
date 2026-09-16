import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/main/session-browser', () => ({
  listPastSessions: vi.fn(async () => ([
    { sessionId: 'a', name: 'A', projectSlug: '-home-u-proj', projectPath: '/home/u/proj', lastModified: 2, size: 999 },
    { sessionId: 'b', name: 'B', projectSlug: '-home-u-other', projectPath: '/home/u/other', lastModified: 1, size: 999 },
  ])),
}));

import { listProjectConversations } from '../src/main/project-conversations';

describe('listProjectConversations', () => {
  it('keeps only sessions whose slug matches the project path', async () => {
    const res = await listProjectConversations('/home/u/proj');
    expect(res.map(s => s.sessionId)).toEqual(['a']);
  });
});
