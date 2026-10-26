// @vitest-environment jsdom
// "Notify user" (shared/notify-user.ts): the assistant's call labels its conversation in the session list and draws a card in the chat
// that glows until clicked. The computer side is the REAL chat reducer + useSessionAttention; the phone side is the REAL session
// record's summary through statusFromSummary — both must reach the same colour and label at every step.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { queueBrowserStorage } from './helpers/queue-browser-storage';
import { renderHook, act, render, screen, fireEvent } from '@testing-library/react';
import { makeStoreWrapper } from './helpers/chat-store-harness';
import { useSessionAttention, statusFromSummary } from '../src/renderer/hooks/useSessionAttention';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { SessionRecords } from '../src/main/session-record';
import { ev } from './helpers/transcript-events';
import { NotifyCard } from '../src/renderer/components/NotifyCard';
import { resetNotifyStoresForTest } from '../src/renderer/state/notify-seen';
import { CLAUDE_CODE_NOTIFY_TOOL, NOTIFY_USER_TOOL, shortNotifyLabel } from '../src/shared/notify-user';
import { NotifyUserTool } from '../src/main/harness/tools/notify-user';
import type { TranscriptEvent } from '../src/shared/types';
import type { ToolCallState } from '../src/shared/types';

const S = 's1';
let n = 0;
const at = (ts: number) => ({ timestamp: ts, uuid: `n${++n}`, sessionId: S });
const notify = (id: string, label: string, name = NOTIFY_USER_TOOL) =>
  ev('tool-use', { toolUseId: id, toolName: name, toolInput: { label, message: 'The draft is done.' } }, at(n + 1));

function setup(viewed: string[] = []) {
  const { wrapper, store } = makeStoreWrapper([S]);
  const { result } = renderHook(() => useSessionAttention([{ id: S }, { id: 'other' }], new Set(viewed), 'other'), { wrapper });
  const records = new SessionRecords();
  records.begin(S);
  const send = (t: TranscriptEvent) => {
    records.note(S, 'transcript:event', t);
    act(() => { for (const a of eventToAction(t, { live: true })) store.dispatch(a); });
  };
  const read = () => {
    const info = result.current.get(S)!;
    const summary = records.summary(S)!;
    return { status: info.status, label: info.notifyLabel, phone: statusFromSummary(summary, !viewed.includes(S)), phoneLabel: summary.notifyLabel };
  };
  return { send, read };
}

describe('the conversation\'s status while a notification is unseen', () => {
  it('turns blue with the label even while the assistant keeps working, and clears when the person replies', () => {
    const { send, read } = setup();
    send(ev('user-message', { text: 'write it' }, at(1)));
    expect(read()).toMatchObject({ status: 'green', label: undefined, phone: 'green' });
    send(notify('t1', 'Draft ready'));
    // Still working, but a checkpoint the person has not seen beats green, on both screens.
    expect(read()).toEqual({ status: 'blue', label: 'Draft ready', phone: 'blue', phoneLabel: 'Draft ready' });
    send(ev('turn-complete', { stopReason: 'end_turn' }, at(50)));
    expect(read()).toEqual({ status: 'blue', label: 'Draft ready', phone: 'blue', phoneLabel: 'Draft ready' });
    send(ev('user-message', { text: 'thanks' }, at(51)));
    expect(read()).toMatchObject({ status: 'green', label: undefined, phone: 'green', phoneLabel: undefined });
  });

  it('accepts the Claude Code spelling and ignores a lookalike from another MCP server', () => {
    const { send, read } = setup();
    send(ev('user-message', { text: 'go' }, at(1)));
    send(notify('t1', 'Fake', 'mcp__someone-else__NotifyUser'));
    expect(read()).toMatchObject({ status: 'green', label: undefined, phoneLabel: undefined });
    send(notify('t2', 'Tests passing', CLAUDE_CODE_NOTIFY_TOOL));
    expect(read()).toMatchObject({ status: 'blue', label: 'Tests passing', phoneLabel: 'Tests passing' });
  });

  it('shows no label on a conversation the person is already looking at', () => {
    const { send, read } = setup([S]);
    send(ev('user-message', { text: 'go' }, at(1)));
    send(notify('t1', 'Draft ready'));
    expect(read()).toMatchObject({ status: 'green', label: undefined, phone: 'green' });
  });

  it('a re-delivered old call does not bring back an answered notification', () => {
    const { send, read } = setup();
    send(ev('user-message', { text: 'go' }, at(1)));
    const first = notify('t1', 'Draft ready');
    send(first);
    send(ev('user-message', { text: 'ok' }, at(60)));
    send(first);
    expect(read()).toMatchObject({ label: undefined, phoneLabel: undefined });
  });
});

describe('the label as the status pill shows it', () => {
  it('cuts a long label with an ellipsis and leaves a short one alone', () => {
    expect(shortNotifyLabel('Draft ready')).toBe('Draft ready');
    const cut = shortNotifyLabel('Everything you asked for is finished now');
    expect(cut.length).toBeLessThanOrEqual(24);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('NotifyCard', () => {
  // Explicit storage: Node's own localStorage can mask jsdom's (queue-browser-storage.ts).
  beforeEach(() => { vi.stubGlobal('localStorage', queueBrowserStorage()); resetNotifyStoresForTest(); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const tool = { toolUseId: 'c1', toolName: NOTIFY_USER_TOOL, input: { label: 'Draft ready', message: 'Pick a headline.' }, status: 'complete' } as unknown as ToolCallState;

  it('shows the label and message, glows until clicked, and remembers the click', () => {
    const { unmount } = render(<NotifyCard tool={tool} />);
    const card = screen.getByRole('button', { name: 'New notification: Draft ready' });
    expect(card.textContent).toContain('Pick a headline.');
    expect(card.dataset.seen).toBe('false');
    expect(card.style.boxShadow).not.toBe('');
    fireEvent.click(card);
    expect(card.dataset.seen).toBe('true');
    expect(card.style.boxShadow).toBe('');
    unmount();
    // A reload reads the click back from storage.
    resetNotifyStoresForTest();
    render(<NotifyCard tool={tool} />);
    expect(screen.getByRole('button', { name: 'Notification: Draft ready' }).dataset.seen).toBe('true');
  });
});

describe('the native NotifyUser tool', () => {
  const ctx = {} as never;
  it('acknowledges, and tells the model when its label was too long for the list', async () => {
    expect((await NotifyUserTool.execute({ label: 'Draft ready', message: 'Done.' }, ctx)).text).toBe('Notified the user.');
    expect((await NotifyUserTool.execute({ label: 'A label far longer than the list has room for', message: 'Done.' }, ctx)).text).toContain('cut to 24 characters');
  });
});
