// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConversationQueueActions } from '../src/renderer/state/conversation-queue-actions';
import { clearChatNotice, getChatNotice } from '../src/renderer/state/chat-notice-store';
import { QUEUE_ACTION_UNSURE } from '../src/renderer/utils/notice-words';
import type { QueuedItem } from '../src/shared/session-live-types';

// Edit on a message waiting behind a running reply, in a chat on YouCoded's own engine.
describe('native queued message — Edit puts it back in the message box', () => {
  let fillDraft: ReturnType<typeof vi.fn<(text: string, files?: string[]) => void>>;
  let toast: ReturnType<typeof vi.fn<(value: unknown) => void>>;
  let hasDraft = false;
  let queue: QueuedItem[] = [];
  let removed = true;

  function actions() {
    return createConversationQueueActions({
      provider: () => 'native',
      composer: () => ({ hasDraft: () => hasDraft, fillDraft } as never),
      session: () => ({ queuedMessages: queue } as never),
      dispatch: vi.fn(),
      toast,
    });
  }

  beforeEach(() => {
    fillDraft = vi.fn<(text: string, files?: string[]) => void>(); toast = vi.fn<(value: unknown) => void>(); hasDraft = false; removed = true;
    (window as any).claude = { native: { queueRemove: vi.fn(async () => removed) } };
  });
  afterEach(() => { delete (window as any).claude; });

  it('gives back the words without the file paths, and the files as attachments', async () => {
    const content = '/home/u/shot.png /home/u/my notes.pdf compare these two';
    queue = [{ queueId: 'q1', content, timestamp: 1, attachments: ['/home/u/shot.png', '/home/u/my notes.pdf'] }];
    await actions().edit('s1', 'q1', content);
    expect(fillDraft).toHaveBeenCalledWith('compare these two', ['/home/u/shot.png', '/home/u/my notes.pdf']);
  });

  it('a files-only message comes back as files with an empty box', async () => {
    queue = [{ queueId: 'q1', content: '/tmp/paste-1.png', timestamp: 1, attachments: ['/tmp/paste-1.png'] }];
    await actions().edit('s1', 'q1', '/tmp/paste-1.png');
    expect(fillDraft).toHaveBeenCalledWith('', ['/tmp/paste-1.png']);
  });

  it('a message without files fills the words exactly as before', async () => {
    queue = [{ queueId: 'q1', content: 'just words', timestamp: 1 }];
    await actions().edit('s1', 'q1', 'just words');
    expect(fillDraft).toHaveBeenCalledWith('just words');
  });

  it('an older computer that lists no files: the words come back whole, as before', async () => {
    queue = [{ queueId: 'q1', content: '/home/u/a.png hi', timestamp: 1 }];
    await actions().edit('s1', 'q1', '/home/u/a.png hi');
    expect(fillDraft).toHaveBeenCalledWith('/home/u/a.png hi');
  });

  it('keeps the draft-in-progress and too-late refusals', async () => {
    queue = [{ queueId: 'q1', content: '/a.png hi', timestamp: 1, attachments: ['/a.png'] }];
    hasDraft = true;
    await actions().edit('s1', 'q1', '/a.png hi');
    expect(toast).toHaveBeenLastCalledWith('Finish or clear your current draft first.');
    hasDraft = false; removed = false;
    await actions().edit('s1', 'q1', '/a.png hi');
    expect(toast).toHaveBeenLastCalledWith('Already sending — too late to edit.');
    expect(fillDraft).not.toHaveBeenCalled();
  });
});

// A queue action the computer would not confirm: its own words never reach the screen (waiting-notice, review A5).
describe('Claude Code queued message — an action the computer does not confirm', () => {
  afterEach(() => { delete (window as any).claude; clearChatNotice('s9'); vi.restoreAllMocks(); });

  it('shows one plain sentence in that chat\'s strip and sends the computer\'s own text to the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (window as any).claude = { session: { queue: { action: vi.fn(async () => ({ status: 'rejected', message: 'Stale send epoch 7 (queue root mismatch)' })) } } };
    const toast = vi.fn();
    const a = createConversationQueueActions({ provider: () => 'claude', composer: () => null, session: () => ({ queuedMessages: [] } as never), dispatch: vi.fn(), toast });
    await a.sendNow('s9', 'q1');
    expect(toast).not.toHaveBeenCalled();
    expect(getChatNotice('s9')?.text).toBe(QUEUE_ACTION_UNSURE);
    expect(getChatNotice('s9')?.text).not.toMatch(/epoch|queue root/i);
    expect(warn).toHaveBeenCalledWith('[queue-action] not confirmed:', expect.objectContaining({ message: 'Stale send epoch 7 (queue root mismatch)' }));
  });
});
