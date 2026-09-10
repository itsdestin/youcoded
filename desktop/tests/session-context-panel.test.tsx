// @vitest-environment jsdom
// The panel's own rendering rules — the ones a person would notice.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// The panel opens files through the artifact drawer; a test only needs the call
// not to explode.
vi.mock('../src/renderer/hooks/useOpenFilepath', () => ({ useOpenFilepath: () => vi.fn() }));

import SessionContextPopup from '../src/renderer/components/SessionContextPopup';
import type { SessionContext } from '../src/shared/types';

afterEach(cleanup);

function show(context: Partial<SessionContext>) {
  render(<SessionContextPopup open onClose={() => {}} sessionId="s1" context={context as SessionContext} />);
}

describe('the context window is shown as its nameplate', () => {
  // Destin, 2026-09-10, on seeing "1049k tokens": a million-token window
  // rendered as a four-digit count of thousands, so the largest window the app
  // supports looked like a glitch.
  it.each([
    [1_048_576, '1M tokens'],
    [1_500_000, '1.5M tokens'],
    [200_000, '200k tokens'],
    [16_384, '16k tokens'],
    [900, '900 tokens'],
  ])('%i renders as %s', (tokens, expected) => {
    show({ contextWindowTokens: tokens, skills: [], tools: ['Read'] });
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('says who set it rather than guessing a number', () => {
    show({ contextWindowTokens: null, assembledBy: 'claude-code', skills: [], tools: null });
    expect(screen.getByText('Set by Claude Code')).toBeInTheDocument();
  });
});

describe('the Project tab is named for what it holds', () => {
  // A Claude Code chat shows YOUR rules here as well as the project's, so a
  // heading naming only one of them contradicts the card underneath it.
  const withUser: Partial<SessionContext> = {
    assembledBy: 'claude-code', skills: [], tools: null, contextWindowTokens: null,
    projectInstructions: { path: '/w/CLAUDE.md', truncated: false },
    userInstructions: { path: '/home/me/.claude/CLAUDE.md', truncated: false },
  };

  it('shows both files, and neither card claims to be the other', () => {
    show(withUser);
    fireEvent.click(screen.getByRole('tab', { name: 'Project' }));
    expect(screen.getByText(/This project ·/)).toBeInTheDocument();
    expect(screen.getByText(/You, in every project ·/)).toBeInTheDocument();
    expect(screen.queryByText('This project’s rules')).toBeNull();
  });

  it('does not claim we read your file in full — only that we did not shorten it', () => {
    // For a Claude Code chat "Read in full" would be a claim about someone
    // else's work: the CLI manages its own window and we cannot see what it did.
    show(withUser);
    fireEvent.click(screen.getByRole('tab', { name: 'Project' }));
    expect(screen.queryByText(/Read in full/)).toBeNull();
    expect(screen.getAllByText(/didn’t shorten it/).length).toBe(2);
  });
});

describe('a Claude Code chat never claims what it cannot know', () => {
  const cc: Partial<SessionContext> = {
    assembledBy: 'claude-code', contextWindowTokens: null,
    systemPrompt: null, systemPromptSections: null, tools: null,
    skills: [{ id: 'a:one', label: 'one', description: 'first' }], skillsOffered: true,
  };

  it('does not present an unknown tool set as an empty one', () => {
    show(cc);
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    // "no tools — the assistant can only talk" would be a lie in the more
    // alarming direction: it reads as a capability this chat lacks.
    expect(screen.queryByText(/can only talk/)).toBeNull();
    expect(screen.getByText(/chooses its own tools/)).toBeInTheDocument();
  });

  it('says the system instructions are Claude Code’s, not that there are none', () => {
    show(cc);
    fireEvent.click(screen.getByRole('tab', { name: 'System' }));
    expect(screen.queryByText(/Nothing was reported/)).toBeNull();
    expect(screen.getByText(/writes its own system instructions/)).toBeInTheDocument();
  });

  it('a NATIVE chat with no tools still says so plainly', () => {
    // The other side of the same coin: when we DO know the tool set is empty,
    // that is a fact about the chat and must still be stated.
    show({ assembledBy: 'youcoded', tools: [], skills: [], contextWindowTokens: 8000 });
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    expect(screen.getByText(/can only talk/)).toBeInTheDocument();
  });
});
