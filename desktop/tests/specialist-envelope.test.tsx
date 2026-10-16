// @vitest-environment jsdom
/**
 * Task 10 — the renderer's per-cwd definition lookup (useSpecialistDefinition)
 * and the Always-allow gate it feeds (ToolCard.tsx:1181). Three things this
 * pins, none of which the mock-contract/fixture-replay tests touch:
 *
 *  1. A Task card that passes its session's cwd resolves a PROJECT-defined
 *     specialist (not just built-ins) — the one-line bug this whole cache
 *     exists to prevent is a card that forgets to pass cwd and silently sees
 *     nothing from the project's own .claude/agents.
 *  2. The refetch-on-miss fires AT MOST ONCE per (cwd, agentId) — a
 *     genuinely unknown id costs one extra list() call, never a loop.
 *  3. Always-allow is default-CLOSED: hidden while the definition is
 *     unknown, shown only once the lookup positively says 'builtin', and
 *     never shown for a personal/claude-code hire even once resolved.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, renderHook, act } from '@testing-library/react';
import React from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { SpecialistEnvelope } from '../src/renderer/components/SpecialistEnvelope';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { useSpecialistDefinition, refreshSpecialistRoster } from '../src/renderer/hooks/useSpecialists';
import type { ToolCallState, SpecialistsListResult, SpecialistDefinitionView } from '../src/shared/types';

afterEach(cleanup);

/** Stubs window.claude.specialists.list to resolve `result` every call, and
 *  returns the spy so a test can assert how many times it was invoked. */
function mockSpecialistsList(result: SpecialistsListResult): ReturnType<typeof vi.fn> {
  const list = vi.fn().mockResolvedValue(result);
  (window as any).claude = {
    specialists: {
      list,
      getDelegatedModels: vi.fn().mockResolvedValue({ budget: null, frontier: null }),
      setDelegatedModel: vi.fn(),
      steer: vi.fn(),
      interrupt: vi.fn(),
    },
    session: { respondToPermission: vi.fn().mockResolvedValue(true) },
  };
  return list;
}

function renderTaskCard(tool: ToolCallState, cwd: string) {
  return render(
    <ArtifactProvider value={{ state: { ...initialArtifactState, sessionCwd: { s1: cwd } }, dispatch: () => {} }}>
      <ChatProvider><ToolCard tool={tool} sessionId="s1" /></ChatProvider>
    </ArtifactProvider>,
  );
}

const taskCall = (over: Partial<ToolCallState> = {}): ToolCallState => ({
  toolUseId: 'tc-1',
  toolName: 'Task',
  input: { description: 'x', agent: 'docs-writer', prompt: 'y', work_dir: '.' },
  status: 'awaiting-approval',
  requestId: 'native-1',
  ...over,
} as ToolCallState);

describe('a project-defined helper resolves when the card passes its cwd', () => {
  it('shows the project file\'s definition and provenance, not just the built-ins', async () => {
    mockSpecialistsList({
      definitions: [{
        id: 'docs-writer', displayName: 'Docs Writer', description: 'Writes docs.',
        charter: 'read-write', allowedTools: ['Read', 'Write', 'Edit'],
        source: 'claude-code', grantScope: 'project', path: '/proj/.claude/agents/docs-writer.md',
        warnings: [], offered: true,
      }],
      skipped: [],
      folders: { personal: '/home/d/.youcoded/specialists', claudeUser: '/home/d/.claude/agents', project: '/proj/.claude/agents' },
    });

    renderTaskCard(taskCall({ input: { description: 'x', agent: 'docs-writer', prompt: 'y', work_dir: '.' } }), '/proj');

    const envelope = await waitFor(() => screen.getByTestId('specialist-envelope'));
    await waitFor(() => expect(envelope.textContent).toContain('Docs Writer'));
    // Destin's 2026-08-26/27 copy review folded the standalone provenance line
    // into the lead sentence — the file is still named, inside the sentence
    // that says what approving it grants.
    expect(envelope.textContent).toContain("comes from this project's .claude/agents/docs-writer.md");
  });
});

describe('the definition refetch-on-miss', () => {
  it('fires exactly once per (cwd, agentId) — a genuinely unknown id never loops', async () => {
    const cwd = 'cwd-refetch-once';
    const list = mockSpecialistsList({
      definitions: [],
      skipped: [],
      folders: { personal: '/p', claudeUser: '/c' },
    });

    const { result } = renderHook(() => useSpecialistDefinition(cwd, 'mystery-agent'));

    // Initial load (1) + the one retry the first miss triggers (2).
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(result.current).toBeUndefined();

    // Something UNRELATED refreshes the same cwd (Settings' Refresh button,
    // or another card's own miss on a different id) — the roster object
    // changes, but 'mystery-agent' is STILL missing from it.
    await act(async () => { await refreshSpecialistRoster(cwd); });
    expect(list).toHaveBeenCalledTimes(3);

    // The hook re-evaluated against the new roster and saw the same miss
    // again. definitionMissRetried already recorded (cwd, 'mystery-agent'),
    // so this must NOT trigger a 4th call.
    // settle (negative assertion): the same miss must not trigger a 4th call.
    await new Promise((r) => setTimeout(r, 30));
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe('Always-allow on a Task hire', () => {
  const roster: SpecialistsListResult = {
    definitions: [
      {
        id: 'explorer', displayName: 'Explorer', description: 'Finds things.',
        charter: 'read-only', allowedTools: ['Read'], source: 'builtin',
        grantScope: 'builtin', warnings: [], offered: true,
      },
      {
        id: 'docs-writer', displayName: 'Docs Writer', description: 'Writes docs.',
        charter: 'read-write', allowedTools: ['Write'], source: 'personal',
        grantScope: 'user',
        path: '/home/d/.youcoded/specialists/docs-writer.md', warnings: [], offered: true,
      },
      {
        // A helper the PROJECT ships — same shape, narrower grant.
        id: 'repo-reviewer', displayName: 'Repo Reviewer', description: 'Reviews this repo.',
        charter: 'read-only', allowedTools: ['Read'], source: 'claude-code',
        grantScope: 'project',
        path: '/work/proj/.claude/agents/repo-reviewer.md', warnings: [], offered: true,
      },
    ],
    skipped: [],
    folders: { personal: '/home/d/.youcoded/specialists', claudeUser: '/home/d/.claude/agents' },
  };

  it('offers Always allow for a built-in hire, once resolved — never optimistically', async () => {
    mockSpecialistsList(roster);
    renderTaskCard(
      taskCall({ requestId: 'native-builtin', input: { description: 'x', agent: 'explorer', prompt: 'y', work_dir: '.' } }),
      'cwd-builtin',
    );
    // Default-closed: not shown before the lookup resolves (built-ins are in
    // the very first list result, but that result is still an async call).
    expect(screen.queryByText(/always allow/i)).toBeNull();
    await waitFor(() => expect(screen.getByText(/always allow/i)).toBeTruthy());
  });

  // D2 (2026-08-26) — this REPLACES "never offers Always allow for a personal
  // hire". The old rule hid the button because a grant keyed by a helper's NAME
  // could outlive the file changing under it; the subject now carries the file's
  // content hash (tools/task.ts), so that hazard is closed at the source and the
  // button can be offered. What must NOT regress is the honesty of the promise:
  // a helper in the user's own folder is granted everywhere, one shipped inside
  // a repo is granted in that repo only, and the card has to SAY which.
  it('offers Always allow for a helper in the user\'s own folder, and says it covers every project', async () => {
    mockSpecialistsList(roster);
    renderTaskCard(
      taskCall({ requestId: 'native-personal', input: { description: 'x', agent: 'docs-writer', prompt: 'y', work_dir: '.' } }),
      'cwd-personal',
    );
    await waitFor(() => expect(screen.getByTestId('specialist-envelope').textContent).toContain('Docs Writer'));
    await waitFor(() => expect(screen.getByRole('button', { name: /always allow/i })).toBeTruthy());
    expect(screen.getByText(/in every project/i)).toBeTruthy();
    // The other half of the promise: an edit re-asks. If this sentence is ever
    // dropped, the fingerprint behaviour becomes invisible to the person
    // relying on it.
    expect(screen.getByText(/asked again/i)).toBeTruthy();
  });

  it('offers Always allow for a project-shipped helper, but scoped to that project only', async () => {
    mockSpecialistsList(roster);
    renderTaskCard(
      taskCall({ requestId: 'native-project', input: { description: 'x', agent: 'repo-reviewer', prompt: 'y', work_dir: '.' } }),
      '/work/proj',
    );
    await waitFor(() => expect(screen.getByTestId('specialist-envelope').textContent).toContain('Repo Reviewer'));
    await waitFor(() => expect(screen.getByRole('button', { name: /always allow/i })).toBeTruthy());
    // Names the folder, and never claims the wider grant.
    expect(screen.getByText(/proj only/i)).toBeTruthy();
    expect(screen.queryByText(/in every project/i)).toBeNull();
  });

  // D2 follow-up (2026-08-26, review): the note must name the folder the grant
  // is ACTUALLY pinned to. The subject is built from the call's `work_dir`
  // resolved against the session folder (tools/task.ts), so naming the session
  // folder is only right when the call did not narrow to a subdirectory — and
  // a note naming the WRONG folder is worse than one naming none.
  it('names the session folder when the hire did not narrow (work_dir ".")', async () => {
    mockSpecialistsList(roster);
    renderTaskCard(
      taskCall({
        requestId: 'native-project-dot',
        input: { description: 'x', agent: 'repo-reviewer', prompt: 'y', work_dir: '.' },
      }),
      '/work/proj',
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /always allow/i })).toBeTruthy());
    expect(screen.getByText(/in proj only/i)).toBeTruthy();
  });

  it('names the work_dir folder when the hire narrowed to one — trailing slash and all', async () => {
    mockSpecialistsList(roster);
    renderTaskCard(
      taskCall({
        requestId: 'native-project-elsewhere',
        input: { description: 'x', agent: 'repo-reviewer', prompt: 'y', work_dir: '/other/place/' },
      }),
      '/work/proj',
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /always allow/i })).toBeTruthy());
    expect(screen.getByText(/in place only/i)).toBeTruthy();
    // The session folder is NOT what this grant covers, so it must not be named.
    expect(screen.queryByText(/in proj only/i)).toBeNull();
  });

  // Review-2 minor 4: the note names the folder the grant is PINNED to, so it
  // has to resolve the work_dir the way tools/task.ts does rather than take the
  // last segment of whatever was typed. './' used to read as a folder called
  // "." and '..' as one called ".." — names that exist nowhere.
  it('resolves "./" to the session folder, not a folder named "."', async () => {
    mockSpecialistsList(roster);
    renderTaskCard(
      taskCall({
        requestId: 'native-project-dot-slash',
        input: { description: 'x', agent: 'repo-reviewer', prompt: 'y', work_dir: './' },
      }),
      '/work/proj',
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /always allow/i })).toBeTruthy());
    expect(screen.getByText(/in proj only/i)).toBeTruthy();
    expect(screen.queryByText(/in \. only/)).toBeNull();
  });

  it('walks ".." up from the session folder instead of naming a folder ".."', async () => {
    mockSpecialistsList(roster);
    renderTaskCard(
      taskCall({
        requestId: 'native-project-dotdot',
        input: { description: 'x', agent: 'repo-reviewer', prompt: 'y', work_dir: '..' },
      }),
      '/work/proj',
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /always allow/i })).toBeTruthy());
    expect(screen.getByText(/in work only/i)).toBeTruthy();
  });

  it('resolves a relative sibling path against the session folder', async () => {
    mockSpecialistsList(roster);
    renderTaskCard(
      taskCall({
        requestId: 'native-project-sibling',
        input: { description: 'x', agent: 'repo-reviewer', prompt: 'y', work_dir: '../other' },
      }),
      '/work/proj',
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /always allow/i })).toBeTruthy());
    expect(screen.getByText(/in other only/i)).toBeTruthy();
    expect(screen.queryByText(/in proj only/i)).toBeNull();
  });

  // Review-2 minor 5: a hire with no work_dir has NO permission subject
  // (task.ts permissionSubject returns undefined), so rememberedRuleFor mints
  // nothing and execute() refuses the call outright. Offering the button — with
  // a note stating a width — promises a grant nothing can keep.
  it('never offers Always allow for a hire with no work_dir', async () => {
    mockSpecialistsList(roster);
    renderTaskCard(
      taskCall({ requestId: 'native-no-workdir', input: { description: 'x', agent: 'docs-writer', prompt: 'y' } }),
      'cwd-personal',
    );
    // The definition DOES resolve — this is not the default-closed case — so
    // wait for the envelope before asserting the button's absence.
    await waitFor(() => expect(screen.getByTestId('specialist-envelope').textContent).toContain('Docs Writer'));
    expect(screen.queryByRole('button', { name: /always allow/i })).toBeNull();
    // …and no note promising a width either.
    expect(screen.queryByText(/in every project/i)).toBeNull();
  });

  it('never offers Always allow for an unresolved (unknown) hire', async () => {
    const list = mockSpecialistsList(roster);
    renderTaskCard(
      taskCall({ requestId: 'native-unknown', input: { description: 'x', agent: 'totally-unknown-agent', prompt: 'y' } }),
      'cwd-unknown',
    );
    // Give the initial load AND the one retry-on-miss time to resolve — the
    // id is genuinely absent from every response, so it never resolves.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/always allow/i)).toBeNull();
  });
});

// Fix pass (Task 10 review, finding 1): ToolCard used to pass the session's
// REAL cwd into useSpecialistDefinition for every card, gating only agentId —
// so a Read/Write/Bash card with no hire in sight still forced a per-project
// specialists.list() disk read via the roster hook underneath. Only a hire
// card (truthy hireAgent) has any use for the real cwd.
describe('a non-hire tool card', () => {
  it('never asks the backend to read its own project\'s specialist folders', async () => {
    const list = mockSpecialistsList({
      definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' },
    });
    renderTaskCard(
      {
        toolUseId: 'tc-read-1',
        toolName: 'Read',
        input: { file_path: '/proj/foo.ts' },
        status: 'complete',
      } as ToolCallState,
      'cwd-non-hire-should-never-be-read',
    );
    // Fix (Task 10 review, fix pass 2): the old assertion only checked that
    // list was never called WITH the real cwd — that's still true if list
    // was never called at all, which is exactly what a warm shared cache (the
    // empty-cwd '' key another test or caller already populated) would do,
    // making the assertion pass for the wrong reason. Assert what the WHY
    // above actually claims: a non-hire card DOES still warm the shared
    // empty-cwd entry (hireAgent is falsy, so cwd collapses to undefined),
    // it just never reads the real per-project folder.
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list).toHaveBeenCalledWith({ cwd: undefined, ensurePersonalFolder: undefined });
    expect(list).not.toHaveBeenCalledWith(
      expect.objectContaining({ cwd: 'cwd-non-hire-should-never-be-read' }),
    );
  });
});

// ── The lead sentence, the trust line and the footer ────────────────────────
//
// Destin's 2026-08-26/27 copy review replaced the "What Yes allows" heading +
// provenance line + "X working in Y — description" bullet with ONE narrative
// sentence per origin. These render SpecialistEnvelope directly (no roster
// round-trip) because what is being pinned is the copy, not the lookup.
describe('the hire consent card, per origin', () => {
  const base = { description: '', warnings: [] as string[], offered: true };
  const hire = { description: 'x', agent: 'whoever', prompt: 'y', work_dir: '.' };

  function renderEnvelope(definition?: SpecialistDefinitionView) {
    mockSpecialistsList({ definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' } });
    return render(<SpecialistEnvelope input={hire} definition={definition} cwd="/work/proj" />);
  }
  const text = () => screen.getByTestId('specialist-envelope').textContent ?? '';

  it('built-in + read-only: says it ships with the app, names the folder, and warns about nothing', () => {
    renderEnvelope({
      ...base, id: 'explorer', displayName: 'Explorer', charter: 'read-only',
      allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      source: 'builtin', grantScope: 'builtin',
    });
    expect(text()).toContain('The Explorer is built into YouCoded and is being hired with read-only access to proj/.');
    expect(text()).toContain('Cannot edit files or run commands. It reads and searches using Read, Glob, Grep, WebFetch, WebSearch.');
    // A built-in's instructions ARE YouCoded's, so there is nothing to distrust.
    expect(screen.queryByText(/Its instructions come from a file/)).toBeNull();
    // Read-only footer: a helper that cannot write cannot delete either, so
    // promising a deletion check here would describe a check that never fires.
    expect(text()).toContain('Secrets and anything outside proj/ still come to you.');
    expect(text()).not.toContain('Deleting things');
  });

  it('built-in + read-write: says it may edit files and run commands, and the footer adds deleting', () => {
    renderEnvelope({
      ...base, id: 'worker', displayName: 'Worker', charter: 'read-write',
      allowedTools: ['Read', 'Write', 'Edit', 'Bash'], source: 'builtin', grantScope: 'builtin',
    });
    expect(text()).toContain('The Worker is built into YouCoded and is being hired to edit files and run commands in proj/.');
    expect(text()).toContain('Can edit files and run commands without asking again, using Read, Write, Edit, Bash.');
    expect(text()).toContain('Deleting things, secrets, and anything outside proj/ still come to you.');
  });

  it("project file: names .claude/agents and warns that the instructions came with the project", () => {
    renderEnvelope({
      ...base, id: 'code-reviewer', displayName: 'code-reviewer', charter: 'read-write',
      allowedTools: ['Read', 'Write', 'Edit', 'Bash'], source: 'claude-code', grantScope: 'project',
      path: '/work/proj/.claude/agents/code-reviewer.md',
    });
    expect(text()).toContain("code-reviewer comes from this project's .claude/agents/code-reviewer.md and is being hired to edit files and run commands in proj/.");
    expect(screen.getByText(/Only approve it if you trust where this project came from/)).toBeTruthy();
  });

  it('personal folder: names the file, and a helper with no Bash never claims it can run commands', () => {
    renderEnvelope({
      ...base, id: 'docs-writer', displayName: 'docs-writer', charter: 'read-write',
      allowedTools: ['Read', 'Write', 'Edit'], source: 'personal', grantScope: 'user',
      path: '/home/d/.youcoded/specialists/docs-writer.md',
    });
    expect(text()).toContain('docs-writer comes from your specialists folder (docs-writer.md) and is being hired to edit files in proj/.');
    expect(text()).not.toContain('run commands in proj/');
    expect(text()).toContain('Can edit files without asking again, using Read, Write, Edit. Cannot run commands.');
    expect(screen.getByText(/Open the file if you're not sure what it does/)).toBeTruthy();
  });

  it('~/.claude/agents: names that folder rather than the project one', () => {
    renderEnvelope({
      ...base, id: 'foo', displayName: 'foo', charter: 'read-only',
      allowedTools: ['Read'], source: 'claude-code', grantScope: 'user',
      path: '/home/d/.claude/agents/foo.md',
    });
    expect(text()).toContain('foo comes from your ~/.claude/agents/foo.md and is being hired with read-only access to proj/.');
    expect(text()).not.toContain('.claude/agents/foo.md and is being hired to edit');
    expect(screen.getByText(/Open the file if you're not sure what it does/)).toBeTruthy();
  });

  it('unknown definition: promises nothing, and invents no trust verdict either', () => {
    renderEnvelope(undefined);
    expect(text()).toContain('whoever could not be looked up, so its tools and limits are unknown. Approve only if you know this specialist.');
    expect(screen.queryByText(/Its instructions come from a file/)).toBeNull();
  });
});
