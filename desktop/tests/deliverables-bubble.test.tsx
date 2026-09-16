// @vitest-environment jsdom
// Pins spec §2.1 (card LAST in the bubble, calls hoisted out of the tool
// group, prose padding for a card-only bubble, multi-call merge) and §5
// (friendlyToolDisplay + ToolBody fallbacks never show raw JSON).
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { AssistantTurn } from '../src/renderer/state/chat-types';
import type { ToolCallState, ToolGroupState } from '../src/shared/types';

vi.mock('../src/renderer/components/ArtifactThumbnail', () => ({
  ArtifactThumbnail: () => <div data-testid="thumb" />,
}));
vi.mock('../src/renderer/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

import AssistantTurnBubble from '../src/renderer/components/AssistantTurnBubble';
import ToolCard, { friendlyToolDisplay } from '../src/renderer/components/ToolCard';
import { CLAUDE_CODE_LINK_TOOL } from '../src/shared/send-user-link';

(window as any).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} });
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

afterEach(cleanup);

const send = (id: string, files: string[], extra: Partial<ToolCallState> = {}): ToolCallState =>
  ({ toolUseId: id, toolName: 'SendUserFile', input: { files, status: 'normal' }, status: 'complete', response: `Sent ${files.length} file(s) to the user.`, ...extra });
const bash = (id: string): ToolCallState =>
  ({ toolUseId: id, toolName: 'Bash', input: { command: 'node scripts/perf.mjs' }, status: 'complete', response: 'ok' });

function turn(segments: AssistantTurn['segments']): AssistantTurn {
  return { id: 'turn_1', segments, timestamp: 0, stopReason: null, model: null, usage: null, anthropicRequestId: null };
}

function renderTurn(t: AssistantTurn, groups: Record<string, string[]>, calls: ToolCallState[]) {
  const toolGroups = new Map<string, ToolGroupState>(Object.entries(groups).map(([id, toolIds]) => [id, { id, toolIds }]));
  const toolCalls = new Map(calls.map((c) => [c.toolUseId, c]));
  return render(
    <ChatProvider>
      <AssistantTurnBubble turn={t} toolGroups={toolGroups} toolCalls={toolCalls} sessionId="s" showTimestamps={false} />
    </ChatProvider>,
  );
}

describe('Deliverables card in the bubble', () => {
  it('renders LAST in the bubble and its call is absent from the tool group', () => {
    renderTurn(
      turn([{ type: 'text', content: 'Done.', messageId: 'm1' }, { type: 'tool-group', groupId: 'g1' }]),
      { g1: ['send1', 'bash1'] },   // SendUserFile listed FIRST; must render LAST, outside the group
      [send('send1', ['/p/report.md']), bash('bash1')],
    );
    const card = screen.getByTestId('deliverables-card');
    expect(card.nextElementSibling).toBeNull();                 // nothing after it in the bubble
    expect(screen.queryByText(/Sent a file/)).toBeNull();        // no ToolCard was drawn for the call
    expect(screen.getByText(/perf\.mjs/)).toBeInTheDocument();  // the Bash card still renders
    expect(card.compareDocumentPosition(screen.getByText(/perf\.mjs/)) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('a bubble holding only the card gets prose padding, not the tools-only padding', () => {
    const { container } = renderTurn(
      turn([{ type: 'tool-group', groupId: 'g1' }]),
      { g1: ['send1'] },
      [send('send1', ['/p/report.md'])],
    );
    const bubble = container.querySelector('.assistant-bubble') as HTMLElement;
    expect(bubble.className).toContain('pt-4');
    expect(bubble.className).not.toContain('py-2.5');
  });

  it('merges every SendUserFile call in the bubble into ONE card: files in call order, each keeping its own call\'s status', () => {
    const err = 'SendUserFile failed — nothing was sent:\n- /p/b.md is a directory';
    renderTurn(
      turn([{ type: 'text', content: 'Two batches.', messageId: 'm1' }, { type: 'tool-group', groupId: 'g1' }, { type: 'tool-group', groupId: 'g2' }]),
      { g1: ['send1'], g2: ['send2', 'bash1'] },
      // send2 is a SEPARATE, FAILED call so per-tile status is actually
      // exercised (every other fixture in this file uses 'complete', which
      // never touches the failed/running rendering at all).
      [send('send1', ['/p/a.md']), send('send2', ['/p/b.md', '/p/c.md'], { status: 'failed', error: err }), bash('bash1')],
    );
    expect(screen.getAllByTestId('deliverables-card')).toHaveLength(1);
    // send2 failed, so the card seeds OPEN on mount (Finding 2 fix) — no
    // click needed, and one would toggle it back closed.
    const tiles = screen.getAllByTestId('sent-file-tile');
    expect(tiles).toHaveLength(3);

    // Order: files concatenate in CALL order (send1's file, then send2's two
    // files) — not sorted, not reversed. Read straight off DOM order.
    const names = tiles.map((t) => t.querySelector('.text-sm-tight')?.textContent);
    expect(names).toEqual(['a.md', 'b.md', 'c.md']);

    // Per-call status: only send2's tiles (b.md, c.md) show the failed
    // state. send1's tile (a.md) is a separate, still-complete call and
    // must not.
    expect(within(tiles[0]).queryByText('Couldn’t send')).toBeNull();
    expect(within(tiles[1]).getByText('Couldn’t send')).toBeInTheDocument();
    expect(within(tiles[2]).getByText('Couldn’t send')).toBeInTheDocument();
  });
});

describe('fallback surfaces', () => {
  it('friendlyToolDisplay: singular, plural, and never "Sent 0 files" on malformed input', () => {
    expect(friendlyToolDisplay({ toolName: 'SendUserFile', input: { files: ['/p/a.md'] } } as any))
      .toEqual({ label: 'Sent a file', detail: '· a.md' });
    expect(friendlyToolDisplay({ toolName: 'SendUserFile', input: { files: ['/p/a.md', '/q/b.png'] } } as any))
      .toEqual({ label: 'Sent 2 files', detail: '· a.md, b.png' });
    // Pin the label only: whether the code yields '' or '· ' for detail on
    // garbage input is not worth a rule.
    expect(friendlyToolDisplay({ toolName: 'SendUserFile', input: { files: 'not-an-array' } } as any).label)
      .toBe('Sent files');
  });

  it('friendlyToolDisplay: SendUserLink shows the host, never the raw id', () => {
    expect(friendlyToolDisplay({ toolName: 'SendUserLink', input: { links: [{ url: 'https://example.com', label: 'The Site' }] } } as any))
      .toEqual({ label: 'Sent a link', detail: '· example.com' });
    expect(friendlyToolDisplay({ toolName: 'SendUserLink', input: { links: [{ url: 'http://localhost:5173' }, { url: 'http://192.168.1.5:8000' }] } } as any))
      .toEqual({ label: 'Sent 2 links', detail: '· localhost:5173, 192.168.1.5:8000' });
    expect(friendlyToolDisplay({ toolName: 'SendUserLink', input: { links: 'not-an-array' } } as any).label)
      .toBe('Sent links');
  });

  it('friendlyToolDisplay: the Claude Code MCP link tool reads identically', () => {
    // Without an explicit case it would fall to the generic MCP label
    // ("Youcoded: Senduserlink"), which names the plumbing, not the deliverable.
    expect(friendlyToolDisplay({ toolName: CLAUDE_CODE_LINK_TOOL, input: { links: [{ url: 'https://example.com' }] } } as any))
      .toEqual({ label: 'Sent a link', detail: '· example.com' });
  });

  it('a bare Claude Code MCP link ToolCard expands to the card, not the raw JSON view', () => {
    const mcpTool: any = {
      toolUseId: 'm1', toolName: CLAUDE_CODE_LINK_TOOL,
      input: { links: [{ url: 'https://example.com', label: 'The Site' }] }, status: 'complete',
    };
    render(
      <ChatProvider>
        <ToolCard tool={mcpTool} sessionId="s" />
      </ChatProvider>,
    );
    fireEvent.click(screen.getByTestId('tool-card-chevron'));
    expect(screen.getByTestId('deliverables-card')).toBeInTheDocument();
    expect(screen.queryByText(/"links"/)).toBeNull();
  });

  it('a bare SendUserFile ToolCard expands to the card, not the raw JSON view', () => {
    render(
      <ChatProvider>
        <ToolCard tool={send('send1', ['/p/report.md'])} sessionId="s" />
      </ChatProvider>,
    );
    fireEvent.click(screen.getByTestId('tool-card-chevron'));
    expect(screen.getByTestId('deliverables-card')).toBeInTheDocument();
    expect(screen.queryByText(/"files"/)).toBeNull();
  });
});
