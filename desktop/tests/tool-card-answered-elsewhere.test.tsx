// @vitest-environment jsdom
// Remote access batch 2, design §7: a card whose ask the computer answered
// while this phone could not see it shows a neutral note — not a failure, not
// a claim about a socket — and only while the tool is still running.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState } from '../src/shared/types';

afterEach(cleanup);

const NOTE = 'Answered on the computer; Refresh to see the result';

function mount(t: ToolCallState) {
  return render(<ChatProvider><ToolCard tool={t} sessionId="s1" /></ChatProvider>).container;
}

describe('a card answered elsewhere', () => {
  it('shows the neutral note while running', () => {
    const c = mount({ toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' }, status: 'running', answeredElsewhere: true } as ToolCallState);
    expect(c.textContent).toContain(NOTE);
    expect(c.textContent).not.toMatch(/socket|failed|expired/i);
  });

  it('drops the note once the result lands', () => {
    const c = mount({ toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' }, status: 'complete', response: 'ok', answeredElsewhere: true } as ToolCallState);
    expect(c.textContent).not.toContain(NOTE);
  });

  it('shows nothing extra on an ordinary running card', () => {
    const c = mount({ toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' }, status: 'running' } as ToolCallState);
    expect(c.textContent).not.toContain(NOTE);
  });
});
