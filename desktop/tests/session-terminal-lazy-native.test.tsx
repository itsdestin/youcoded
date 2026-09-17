// @vitest-environment jsdom
// A native session gets no terminal (xterm + WebGL context) until its terminal
// view is first selected; a Claude Code or shell session gets one at once
// (2026-09-16 audit W15).
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const mounts = vi.hoisted(() => ({ count: 0, live: 0 }));
vi.mock('../src/renderer/components/TerminalView', () => ({
  default: function FakeTerminalView({ sessionId, visible }: { sessionId: string; visible: boolean }) {
    React.useEffect(() => { mounts.count++; mounts.live++; return () => { mounts.live--; }; }, []);
    return <div data-testid="terminal" data-session={sessionId} data-visible={String(visible)} />;
  },
}));

import { SessionTerminal } from '../src/renderer/components/SessionTerminal';

afterEach(() => { cleanup(); mounts.count = 0; mounts.live = 0; });

describe('SessionTerminal', () => {
  it('a native session mounts no terminal while it is in chat view', () => {
    const { queryByTestId } = render(<SessionTerminal sessionId="n1" provider="native" visible={false} />);
    expect(queryByTestId('terminal')).toBeNull();
    expect(mounts.count).toBe(0);
  });

  it('a native session mounts its terminal the first time terminal view is selected, and keeps it after switching back', () => {
    const { rerender, getByTestId } = render(<SessionTerminal sessionId="n1" provider="native" visible={false} />);
    rerender(<SessionTerminal sessionId="n1" provider="native" visible={true} />);
    expect(getByTestId('terminal').getAttribute('data-visible')).toBe('true');
    rerender(<SessionTerminal sessionId="n1" provider="native" visible={false} />);
    expect(getByTestId('terminal').getAttribute('data-visible')).toBe('false');
    expect(mounts.count).toBe(1);
    expect(mounts.live).toBe(1);
  });

  it('a Claude Code session mounts its terminal at once, hidden or not', () => {
    const { getByTestId } = render(<SessionTerminal sessionId="c1" provider="claude" visible={false} />);
    expect(getByTestId('terminal').getAttribute('data-session')).toBe('c1');
    expect(mounts.count).toBe(1);
  });

  it('a shell session and a session with no provider recorded mount at once too', () => {
    render(<SessionTerminal sessionId="s1" provider="shell" visible={false} />);
    render(<SessionTerminal sessionId="u1" provider={undefined} visible={false} />);
    expect(mounts.count).toBe(2);
  });
});
