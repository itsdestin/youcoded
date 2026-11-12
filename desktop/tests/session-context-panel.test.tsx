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

describe('rules are sorted by where they apply', () => {
  // Destin, 2026-11-12 (#251): your every-project file belongs on Global, and
  // the Project tab holds only what this folder adds. Before, both sat on Project.
  const withUser: Partial<SessionContext> = {
    assembledBy: 'claude-code', skills: [], tools: null, contextWindowTokens: null,
    projectInstructions: { path: '/w/CLAUDE.md', truncated: false },
    userInstructions: { path: '/home/me/.claude/CLAUDE.md', truncated: false },
  };

  it('reuses file rows for every captured ancestor and marks a shortened parent', () => {
    show({ assembledBy: 'youcoded', projectInstructionFiles: [
      { path: '/workspace/AGENTS.md', truncated: true, note: 'Outlined parent', notUsed: 'CLAUDE.md' },
      { path: '/workspace/repo/CLAUDE.md', truncated: false },
    ], skills: [], tools: [] });
    expect(screen.getByText('Not everything fit')).toBeInTheDocument();
    // Short, named summary — never "file(s)" or a bare count.
    expect(screen.getByText('Shortened · AGENTS.md')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Project context' }));
    // Folder names, not long absolute paths; a same-folder file that was not used is named.
    expect(screen.getByText('From the “workspace” folder · Outlined parent · CLAUDE.md here not used')).toBeInTheDocument();
    expect(screen.getByText('Read before every chat in this project')).toBeInTheDocument();
  });

  it('counts the captured chain on Overview and keeps the same rows on Project', () => {
    show({ assembledBy: 'youcoded', projectInstructionFiles: [
      { path: '/workspace/AGENTS.md', truncated: false },
      { path: '/workspace/repo/CLAUDE.md', truncated: false },
    ], skills: [], tools: ['Read'] });
    expect(screen.getByText(/2 rules files/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Project context' }));
    expect(screen.getByText('From the “workspace” folder')).toBeInTheDocument();
    expect(screen.getByText('Read before every chat in this project')).toBeInTheDocument();
  });

  it('counts the project file and your own file on separate Overview rows', () => {
    show(withUser);
    expect(screen.getByText('Only in this project · 1 rules file')).toBeInTheDocument();
    expect(screen.getByText('The same in every project · 1 rules file')).toBeInTheDocument();
  });

  it('puts the project file on Project and your every-project file on Global, never both on one', () => {
    show(withUser);
    fireEvent.click(screen.getByRole('tab', { name: 'Project context' }));
    expect(screen.getByText('Read before every chat in this project')).toBeInTheDocument();
    expect(screen.queryByText('Read before every chat, in every project')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Global context' }));
    expect(screen.getByText('Read before every chat, in every project')).toBeInTheDocument();
    expect(screen.queryByText('Read before every chat in this project')).toBeNull();
  });

  it('a file nobody shortened claims nothing about how it was read', () => {
    // For a Claude Code chat "Read in full" would be a claim about someone
    // else's work; deck round 1 (T-5) dropped "didn't shorten it" as well.
    show(withUser);
    for (const tab of ['Project context', 'Global context']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      expect(screen.queryByText(/Read in full/)).toBeNull();
      expect(screen.queryByText(/didn’t shorten it/)).toBeNull();
    }
  });

  it('a native chat says plainly that it has no every-project file, rather than showing nothing', () => {
    show({ assembledBy: 'youcoded', skills: [], tools: ['Read'], contextWindowTokens: 8000 });
    fireEvent.click(screen.getByRole('tab', { name: 'Global context' }));
    expect(screen.getByText('No every-project rules')).toBeInTheDocument();
    expect(screen.getByText(/from the project’s folders only/)).toBeInTheDocument();
  });
});

describe('skills and tools are sorted by where they come from', () => {
  const mixed: Partial<SessionContext> = {
    assembledBy: 'youcoded', contextWindowTokens: 200_000, skillsOffered: true,
    skills: [
      { id: 'p:everywhere', label: 'everywhere', description: 'installed for all', scope: 'global' },
      { id: 'local-one', label: 'local-one', description: 'this folder only', scope: 'project' },
      // A record written before `scope` existed: filed under Global, where every skill used to be.
      { id: 'p:old', label: 'old-record', description: 'no scope' },
    ],
    tools: ['Read', 'Bash', 'mcp__calendar__list_events', 'mcp__calendar__create_event'],
  };

  it('a project skill shows on Project only, and the rest on Global', () => {
    show(mixed);
    fireEvent.click(screen.getByRole('tab', { name: 'Global context' }));
    expect(screen.getByText('everywhere')).toBeInTheDocument();
    expect(screen.getByText('old-record')).toBeInTheDocument();
    expect(screen.queryByText('local-one')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Project context' }));
    expect(screen.getByText('local-one')).toBeInTheDocument();
    expect(screen.queryByText('everywhere')).toBeNull();
  });

  it('an add-on is one row naming how many tools it brought, not a row per tool', () => {
    show(mixed);
    fireEvent.click(screen.getByRole('tab', { name: 'Global context' }));
    expect(screen.getByText('calendar add-on')).toBeInTheDocument();
    expect(screen.queryByText('mcp__calendar__list_events')).toBeNull();
    // Deck round 1, T-4: built-in tools are ONE row that lists every tool when opened.
    expect(screen.queryByText('Read')).toBeNull();
    fireEvent.click(screen.getByText('Built into YouCoded'));
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  it('a long list shows five rows and a button naming the full count', () => {
    show({ ...mixed, skills: Array.from({ length: 12 }, (_, n) => ({ id: `p:s${n}`, label: `skill-${n}`, scope: 'global' as const })) });
    fireEvent.click(screen.getByRole('tab', { name: 'Global context' }));
    expect(screen.getByText('skill-4')).toBeInTheDocument();
    expect(screen.queryByText('skill-5')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 12' }));
    expect(screen.getByText('skill-11')).toBeInTheDocument();
  });

  it('a project with nothing of its own says so instead of showing a blank tab', () => {
    show({ assembledBy: 'youcoded', skills: [], tools: ['Read'], contextWindowTokens: 8000 });
    expect(screen.getByText('Nothing is specific to this project')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Project context' }));
    expect(screen.getByText('No rules file for this project')).toBeInTheDocument();
    expect(screen.getByText('No skills of its own')).toBeInTheDocument();
  });
});

describe('a Claude Code chat never claims what it cannot know', () => {
  const cc: Partial<SessionContext> = {
    assembledBy: 'claude-code', contextWindowTokens: null,
    systemPrompt: null, systemPromptSections: null, tools: null,
    skills: [{ id: 'a:one', label: 'one', description: 'first' }], skillsOffered: true,
  };

  it('names the engine, and what it keeps to itself, on Overview', () => {
    show(cc);
    expect(screen.getByText('Runs this chat')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText(/may not be 100% accurate/)).toBeInTheDocument();
  });

  it('does not present an unknown tool set as an empty one', () => {
    show(cc);
    fireEvent.click(screen.getByRole('tab', { name: 'Global context' }));
    // "no tools — the assistant can only talk" would be a lie in the more
    // alarming direction: it reads as a capability this chat lacks.
    expect(screen.queryByText(/can only talk/)).toBeNull();
    expect(screen.getByText('Chosen by Claude Code')).toBeInTheDocument();
  });

  it('says the system instructions are Claude Code’s, not that there are none', () => {
    show(cc);
    fireEvent.click(screen.getByRole('tab', { name: 'Global context' }));
    expect(screen.queryByText(/Nothing was reported/)).toBeNull();
    expect(screen.getByText('Written by Claude Code')).toBeInTheDocument();
  });

  it('a NATIVE chat with no tools still says so plainly', () => {
    // The other side of the same coin: when we DO know the tool set is empty,
    // that is a fact about the chat and must still be stated.
    show({ assembledBy: 'youcoded', tools: [], skills: [], contextWindowTokens: 8000 });
    fireEvent.click(screen.getByRole('tab', { name: 'Global context' }));
    expect(screen.getByText(/can only talk/)).toBeInTheDocument();
  });
});
