// @vitest-environment jsdom
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import MarkdownContent from '../src/renderer/components/MarkdownContent';
import UserMessage from '../src/renderer/components/UserMessage';
import AssistantTurnBubble from '../src/renderer/components/AssistantTurnBubble';
import { describe, expect, it, afterEach } from 'vitest';
import { ChatMessageFindIndex, extractMessageFindRows, resolveBodyRanges, messageBodyBlocks } from '../src/renderer/components/chat-message-find';
import type { AssistantTurn, TimelineEntry } from '../src/renderer/state/chat-types';

describe('chat message Find corpus', () => {
  afterEach(() => cleanup());
  it('prepares 1000 rows in yielded slices and never publishes partial results', async () => {
    const index = new ChatMessageFindIndex();
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `${i}`, bodies: [`**needle${i}**`], markdown: true }));
    const steps: Array<() => void> = [];
    const work = index.prepareSearch(rows, 'needle', new AbortController().signal, {
      schedule: () => new Promise<void>((done) => { steps.push(done); }), now: () => 0, maxRows: 8,
    });
    expect(steps).toHaveLength(1);
    expect(index.search('needle')).toEqual([]);
    while (steps.length) { steps.shift()?.(); await Promise.resolve(); }
    const hits = await work;
    expect(hits?.map(({ id }) => id)).toEqual(rows.map(({ id }) => id));
    expect(index.search('needle')).toHaveLength(1000);
  });
  it('cancels stale preparation without committing partial results', async () => {
    const index = new ChatMessageFindIndex();
    const steps: Array<() => void> = [];
    const controller = new AbortController();
    const work = index.prepareSearch(Array.from({ length: 40 }, (_, i) => ({ id: `${i}`, bodies: ['old'], markdown: true })), 'old', controller.signal,
      { schedule: () => new Promise<void>((done) => { steps.push(done); }), now: () => 0, maxRows: 4 });
    controller.abort(); steps.shift()?.();
    expect(await work).toBeNull();
    expect(index.search('old')).toEqual([]);
  });
  it('source projection agrees with real rendered Markdown across formatting, links, highlighted code and file chips', () => {
    const content = '**hel**lo [label](https://hidden.example) and `inline`\n\n```js\nconst codeword = 1\n```\n\nOpen /tmp/find-example.txt now';
    const view = render(React.createElement('div', { 'data-testid': 'body' }, React.createElement(MarkdownContent, { content, sessionId: 'test', incremental: true })));
    const body = view.getByTestId('body');
    const index = new ChatMessageFindIndex();
    index.setRows([{ id: 'a', bodies: [content], markdown: true }]);
    expect(index.blocksOf('a', 0)).toEqual(messageBodyBlocks(body));
    for (const term of ['hello', 'label', 'inline', 'codeword', 'find-example.txt']) {
      expect(index.search(term).length, `source ${term}`).toBe(resolveBodyRanges(body, term).length);
      expect(index.search(term).length).toBeGreaterThan(0);
    }
    for (const excluded of ['hidden.example', 'Copy', 'https://', '```']) {
      expect(index.search(excluded)).toHaveLength(0);
      expect(resolveBodyRanges(body, excluded)).toHaveLength(0);
    }
    expect(index.search('/tmp/find-example.txt')).toHaveLength(0); // pill shows basename, not destination
    expect(resolveBodyRanges(body, '/tmp/find-example.txt')).toHaveLength(0);
    expect(resolveBodyRanges(body, 'hello')[0].toString()).toBe('hello');
  });
  it('plain user body projection excludes timestamp and hidden file destination', () => {
    const content = 'Open /tmp/deep/notes.txt now';
    const message = { id: 'u', content, role: 'user' as const, timestamp: 1000 };
    const view = render(React.createElement(UserMessage, { message, sessionId: 'test', showTimestamps: true }));
    const body = view.container.querySelector<HTMLElement>('[data-message-find-body]')!;
    const index = new ChatMessageFindIndex();
    index.setRows([{ id: 'u', bodies: [content], markdown: false }]);
    expect(index.search('notes.txt')).toHaveLength(1);
    expect(resolveBodyRanges(body, 'notes.txt')).toHaveLength(1);
    expect(index.search('/tmp/deep')).toHaveLength(0);
    expect(resolveBodyRanges(body, '/tmp/deep')).toHaveLength(0);
    expect(resolveBodyRanges(body, '1970')).toHaveLength(0);
    const attached = '/tmp/My Folder/notes.txt hello';
    const withFile = { ...message, content: attached, attachments: ['/tmp/My Folder/notes.txt'] };
    view.rerender(React.createElement(UserMessage, { message: withFile, sessionId: 'test', showTimestamps: true }));
    index.setRows(extractMessageFindRows([{ kind: 'user', message: withFile }], new Map()));
    expect(index.search('My Folder')).toHaveLength(0);
    expect(index.search('notes.txt')).toHaveLength(1);
    expect(index.blocksOf('u', 0)).toEqual(messageBodyBlocks(view.container.querySelector('[data-message-find-body]')!));
    expect(resolveBodyRanges(view.container.querySelector('[data-message-find-body]')!, 'My Folder')).toHaveLength(0);
  });
  it('projects sent reference pills and surrounding prose exactly like UserMessage', () => {
    const content = 'Review ⦃"quoted words"_/tmp/hidden-source.txt_L2-3⦄ and /tmp/other.txt now';
    const message = { id: 'u-ref', content, role: 'user' as const, timestamp: 1000 };
    const view = render(React.createElement(UserMessage, { message, sessionId: 'test', showTimestamps: false }));
    const body = view.container.querySelector<HTMLElement>('[data-message-find-body]')!;
    const index = new ChatMessageFindIndex();
    index.setRows([{ id: message.id, bodies: [content], markdown: false }]);
    expect(body.textContent).toContain('lines 2-3 · hidden-source.txt');
    expect(index.blocksOf(message.id, 0)).toEqual(messageBodyBlocks(body));
    for (const query of ['Review', 'lines 2-3', 'other.txt', 'now']) {
      expect(index.search(query)).toHaveLength(1);
      expect(resolveBodyRanges(body, query)[0].toString()).toBe(query);
    }
    expect(index.search('quoted words')).toHaveLength(0);
    expect(index.search('/tmp')).toHaveLength(0);
  });
  it('maps expanding Unicode case folds back to original DOM UTF-16 offsets', () => {
    const view = render(React.createElement('div', { 'data-testid': 'unicode' }, 'İ', React.createElement('span', null, 'A'), ' İA'));
    const body = view.getByTestId('unicode');
    const index = new ChatMessageFindIndex();
    index.setRows([{ id: 'unicode', bodies: ['İA İA'], markdown: false }]);
    expect(resolveBodyRanges(body, 'a').map(r => r.toString())).toEqual(['A', 'A']);
    expect(index.search('a')).toHaveLength(2);
    expect(resolveBodyRanges(body, 'İ').map(r => r.toString())).toEqual(['İ', 'İ']);
    // A partial case-expansion is not a navigable source substring.
    expect(index.search('i')).toHaveLength(0);
    expect(resolveBodyRanges(body, 'i')).toHaveLength(0);
  });
  it('does not claim hidden text in collapsed message disclosures is navigable', () => {
    const content = '<details>\n<summary>Visible summary</summary>\n\nHidden inner\n</details>';
    const view = render(React.createElement('div', { 'data-testid': 'body' }, React.createElement(MarkdownContent, { content })));
    const body = view.getByTestId('body');
    const index = new ChatMessageFindIndex();
    index.setRows([{ id: 'a', bodies: [content], markdown: true }]);
    expect(index.blocksOf('a', 0)).toEqual(messageBodyBlocks(body));
    expect(index.search('Visible summary').length).toBe(resolveBodyRanges(body, 'Visible summary').length);
    expect(index.search('Hidden inner')).toHaveLength(0);
  });
  it('unpaired raw HTML displays readable text rather than silently losing it', () => {
    const content = '<details><summary>Visible summary</summary>Hidden inner</details>';
    const view = render(React.createElement('div', { 'data-testid': 'body' }, React.createElement(MarkdownContent, { content })));
    const index = new ChatMessageFindIndex();
    index.setRows([{ id: 'a', bodies: [content], markdown: true }]);
    expect(index.blocksOf('a', 0)).toEqual(messageBodyBlocks(view.getByTestId('body')));
    expect(index.search('Hidden inner')).toHaveLength(1);
  });
  it('fenced code keeps its full raw path, including syntax-highlighted spans', () => {
    const content = '```bash\ncat /tmp/My Folder/notes.txt\n```';
    const view = render(React.createElement('div', { 'data-testid': 'body' }, React.createElement(MarkdownContent, { content, sessionId: 'test' })));
    const body = view.getByTestId('body');
    const index = new ChatMessageFindIndex();
    index.setRows([{ id: 'a', bodies: [content], markdown: true }]);
    expect(index.blocksOf('a', 0)).toEqual(messageBodyBlocks(body));
    expect(index.search('/tmp/My Folder/notes.txt')).toHaveLength(1);
    expect(resolveBodyRanges(body, '/tmp/My Folder/notes.txt')).toHaveLength(1);
  });
  it('inline code filepath chips index the visible basename rather than hidden directory', () => {
    const content = 'Read `/tmp/notes.txt`';
    const view = render(React.createElement('div', { 'data-testid': 'body' }, React.createElement(MarkdownContent, { content, sessionId: 'test' })));
    const body = view.getByTestId('body');
    const index = new ChatMessageFindIndex();
    index.setRows([{ id: 'a', bodies: [content], markdown: true }]);
    expect(index.blocksOf('a', 0)).toEqual(messageBodyBlocks(body));
    expect(index.search('notes.txt')).toHaveLength(1);
    expect(index.search('/tmp')).toHaveLength(0);
  });
  it('a conversations reference fence is a replaced card, not searchable raw IDs', () => {
    const index = new ChatMessageFindIndex();
    index.setRows([{ id: 'a', bodies: ['Before\n\n```conversations\nprivate-reference-id\n```\n\nAfter'], markdown: true }]);
    expect(index.search('Before')).toHaveLength(1);
    expect(index.search('private-reference-id')).toHaveLength(0);
    expect(index.search('After')).toHaveLength(1);
  });
  it('hard line breaks divide navigable text without hiding either side', () => {
    const content = 'before  \nafter';
    const view = render(React.createElement('div', { 'data-testid': 'body' }, React.createElement(MarkdownContent, { content })));
    const body = view.getByTestId('body');
    const index = new ChatMessageFindIndex();
    index.setRows([{ id: 'a', bodies: [content], markdown: true }]);
    expect(index.blocksOf('a', 0)).toEqual(messageBodyBlocks(body));
    expect(index.search('before')).toHaveLength(1);
    expect(index.search('after')).toHaveLength(1);
    expect(index.search('beforeafter')).toHaveLength(0);
    expect(resolveBodyRanges(body, 'beforeafter')).toHaveLength(0);
  });
  it('unsupported raw HTML displays only readable words, not tags', () => {
    const content = '<custom>Hello world</custom>';
    const view = render(React.createElement('div', { 'data-testid': 'body' }, React.createElement(MarkdownContent, { content })));
    const index = new ChatMessageFindIndex();
    index.setRows([{ id: 'a', bodies: [content], markdown: true }]);
    expect(index.blocksOf('a', 0)).toEqual(messageBodyBlocks(view.getByTestId('body')));
    expect(index.search('Hello world')).toHaveLength(1);
    expect(index.search('custom')).toHaveLength(0);
  });
  it('extracts real timeline entries excluding reasoning, tool groups, plan and injected cards', () => {
    const timeline = [
      { kind: 'user', message: { id: 'u', content: 'needle user' } },
      { kind: 'user', message: { id: 'injected', content: 'needle specialist' }, injected: 'specialist-report' },
      { kind: 'assistant-turn', turnId: 'a' },
      { kind: 'prompt', prompt: { promptId: 'prompt', title: 'needle card' } },
    ] as TimelineEntry[];
    const turns = new Map<string, AssistantTurn>([['a', { id: 'a', segments: [
      { type: 'reasoning', content: 'needle reasoning', messageId: 'r' },
      { type: 'text', content: 'needle first', messageId: 't1' },
      { type: 'tool-group', groupId: 'g' },
      { type: 'plan', content: 'needle plan', messageId: 'p', toolUseId: 'tool' },
      { type: 'text', content: 'needle second', messageId: 't2' },
    ], stopReason: null, model: null, usage: null, anthropicRequestId: null }]]);
    const index = new ChatMessageFindIndex();
    index.setRows(extractMessageFindRows(timeline, turns));
    expect(index.search('needle').map(({ id, body }) => [id, body])).toEqual([
      ['u', 0], ['a', 0], ['a', 1],
    ]);
    expect(index.search('reasoning')).toHaveLength(0);
    expect(index.search('specialist')).toHaveLength(0);
    expect(index.search('plan')).toHaveLength(0);
  });
  it('real assistant bubbles mark separate text segments but not reasoning, plan or tool content', () => {
    const turn: AssistantTurn = { id: 'a', segments: [
      { type: 'reasoning', content: 'private', messageId: 'r' },
      { type: 'text', content: 'one', messageId: 't1' },
      { type: 'tool-group', groupId: 'g' },
      { type: 'text', content: 'two', messageId: 't2' },
    ], stopReason: null, model: null, usage: null, anthropicRequestId: null };
    const view = render(React.createElement(AssistantTurnBubble, { turn, toolGroups: new Map(), toolCalls: new Map(), sessionId: 'test', showTimestamps: false }));
    const bodies = [...view.container.querySelectorAll<HTMLElement>('[data-message-find-body]')];
    expect(bodies.map((body) => body.dataset.messageFindBody)).toEqual(['0', '1']);
    expect(bodies.map((body) => body.textContent)).toEqual(['one', 'two']);
    expect(resolveBodyRanges(bodies[0], 'onetwo')).toHaveLength(0);
  });
  it('resolves an inline-formatted hit across text nodes but never across ignored controls', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span>hel</span><strong>lo</strong><button data-message-find-ignore>control</button><em> there</em>';
    const hits = resolveBodyRanges(root, 'hello');
    expect(hits).toHaveLength(1);
    expect(hits[0].toString()).toBe('hello');
    expect(hits[0].startContainer.textContent).toBe('hel');
    expect(hits[0].endContainer.textContent).toBe('lo');
    expect(resolveBodyRanges(root, 'locontrol')).toHaveLength(0);
    expect(resolveBodyRanges(root, 'control')).toHaveLength(0);
  });
  it('indexes only user bodies and assistant text, not reasoning, tools, cards or metadata', () => {
    const index = new ChatMessageFindIndex();
    index.setRows([
      { id: 'u', bodies: ['plain message'], markdown: false },
      { id: 'a', bodies: ['visible reply'], markdown: true },
    ]);
    expect(index.search('reasoning')).toEqual([]);
    expect(index.search('plain')).toMatchObject([{ id: 'u', body: 0 }]);
    expect(index.search('reply')).toMatchObject([{ id: 'a', body: 0 }]);
  });
  it('searches visible markdown text, link labels and code but not markup or link destinations', () => {
    const index = new ChatMessageFindIndex();
    index.setRows([{ id: 'a', bodies: ['**Bold** [label](https://hidden.example) `inline`\n\n```js\ncodeword\n```'], markdown: true }]);
    for (const word of ['Bold', 'label', 'inline', 'codeword']) expect(index.search(word)).toHaveLength(1);
    for (const word of ['hidden.example', 'https', '**', '```']) expect(index.search(word)).toHaveLength(0);
  });
  it('preserves chronological occurrence order, wraps outside the index and replaces removed or streamed bodies', () => {
    const index = new ChatMessageFindIndex();
    index.setRows([{ id: 'first', bodies: ['foo foo'], markdown: false }, { id: 'second', bodies: ['foo'], markdown: true }]);
    expect(index.search('foo').map((hit) => hit.id)).toEqual(['first', 'first', 'second']);
    index.setRows([{ id: 'second', bodies: ['bar foo foo'], markdown: true }]);
    expect(index.search('foo').map((hit) => hit.id)).toEqual(['second', 'second']);
    index.clear();
    expect(index.search('foo')).toEqual([]);
  });
});
