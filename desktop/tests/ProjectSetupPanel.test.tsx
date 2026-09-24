// @vitest-environment jsdom
// ProjectSetupPanel (T6, project-plugin-controls) — the Marketplace post-
// install "choose your projects" panel. Lists every project from
// artifacts:list-projects-index, first one expanded (R20); each row loads
// its OWN project-extensions:get view lazily on expand and writes through
// :set with the same optimistic/serialized/risk-popup semantics as
// SkillsToolsTab (shared useProjectExtensionsController — see its own tests
// for the write-serialization/revert-on-failure behaviour, not repeated here).
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProjectSetupPanel } from '../src/renderer/components/marketplace/ProjectSetupPanel';
import { REVEAL_CHUNK } from '../src/renderer/hooks/use-chunked-reveal';
import { installFiringIntersectionObserver } from './helpers/firing-intersection-observer';

afterEach(cleanup);

function baseView(overrides: Record<string, unknown> = {}) {
  return { projectKey: '', builtIn: [], installed: [], personal: [], needsSetup: [], ...overrides };
}

function installClaude(opts: { listProjectsIndex?: any; get?: any; set?: any } = {}) {
  (window as any).claude = {
    artifacts: {
      listProjectsIndex: opts.listProjectsIndex ?? vi.fn().mockResolvedValue({ ok: true, projects: [] }),
    },
    projectExtensions: {
      get: opts.get ?? vi.fn().mockResolvedValue({ ok: true, view: baseView() }),
      set: opts.set ?? vi.fn(),
    },
  };
}

describe('ProjectSetupPanel', () => {
  it('lists every project, expands only the first one (R20), and fetches lazily per row', async () => {
    const projects = [
      { id: 'p1', path: '/a', name: 'Alpha' },
      { id: 'p2', path: '/b', name: 'Beta' },
    ];
    const group = {
      pluginId: 'youcoded-inbox', displayName: 'Inbox', bundled: false, on: false, paused: true,
      parts: [{ key: 'youcoded-inbox:process', kind: 'skill', displayName: 'Process inbox', on: false }],
    };
    const get = vi.fn().mockResolvedValue({ ok: true, view: baseView({ installed: [group] }) });
    installClaude({ listProjectsIndex: vi.fn().mockResolvedValue({ ok: true, projects }), get });
    render(<ProjectSetupPanel pluginId="youcoded-inbox" />);

    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    // The first project's plugin group shows without an extra tap.
    expect(await screen.findByText('Inbox')).toBeInTheDocument();
    expect(screen.getByText('Process inbox')).toBeInTheDocument();

    await waitFor(() => expect(get).toHaveBeenCalledWith('/a'));
    // Beta is collapsed — its own project-extensions:get never fires.
    expect(get).not.toHaveBeenCalledWith('/b');
  });

  it('toggling the plugin master (no tool connection) writes straight through project-extensions:set', async () => {
    const projects = [{ id: 'p1', path: '/a', name: 'Alpha' }];
    const group = { pluginId: 'youcoded-inbox', displayName: 'Inbox', bundled: false, on: false, paused: true, parts: [] };
    const setMock = vi.fn().mockResolvedValue({ ok: true, view: baseView({ installed: [{ ...group, on: true, paused: false }] }) });
    installClaude({
      listProjectsIndex: vi.fn().mockResolvedValue({ ok: true, projects }),
      get: vi.fn().mockResolvedValue({ ok: true, view: baseView({ installed: [group] }) }),
      set: setMock,
    });
    render(<ProjectSetupPanel pluginId="youcoded-inbox" />);

    const toggle = await screen.findByRole('switch', { name: 'Inbox in this project' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(setMock).toHaveBeenCalledWith('/a', [{ plugin: 'youcoded-inbox', on: true }]));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });

  it('turning on a plugin whose parts include a tool connection opens the risk popup and writes only on Turn on', async () => {
    const projects = [{ id: 'p1', path: '/a', name: 'Alpha' }];
    const group = {
      pluginId: 'youcoded-inbox', displayName: 'Inbox', bundled: false, on: false, paused: true,
      parts: [{ key: 'mcp:inbox', kind: 'mcp', displayName: 'Inbox connection', on: false }],
    };
    const setMock = vi.fn().mockResolvedValue({ ok: true, view: baseView({ installed: [{ ...group, on: true, paused: false }] }) });
    installClaude({
      listProjectsIndex: vi.fn().mockResolvedValue({ ok: true, projects }),
      get: vi.fn().mockResolvedValue({ ok: true, view: baseView({ installed: [group] }) }),
      set: setMock,
    });
    render(<ProjectSetupPanel pluginId="youcoded-inbox" />);

    const toggle = await screen.findByRole('switch', { name: 'Inbox in this project' });
    fireEvent.click(toggle);

    expect(await screen.findByText('Turn on Inbox?')).toBeInTheDocument();
    // "Inbox connection" appears twice: the part row itself, plus the risk
    // dialog's own named list — both are expected once the popup is open.
    expect(screen.getAllByText('Inbox connection')).toHaveLength(2);
    expect(setMock).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute('aria-checked', 'false'); // unmoved until confirmed

    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith('/a', [{ plugin: 'youcoded-inbox', on: true }]));
    await waitFor(() => expect(screen.queryByText('Turn on Inbox?')).not.toBeInTheDocument());
  });

  it('Cancel on the risk popup writes nothing and leaves the switch off', async () => {
    const projects = [{ id: 'p1', path: '/a', name: 'Alpha' }];
    const group = {
      pluginId: 'youcoded-inbox', displayName: 'Inbox', bundled: false, on: false, paused: true,
      parts: [{ key: 'mcp:inbox', kind: 'mcp', displayName: 'Inbox connection', on: false }],
    };
    const setMock = vi.fn();
    installClaude({
      listProjectsIndex: vi.fn().mockResolvedValue({ ok: true, projects }),
      get: vi.fn().mockResolvedValue({ ok: true, view: baseView({ installed: [group] }) }),
      set: setMock,
    });
    render(<ProjectSetupPanel pluginId="youcoded-inbox" />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Inbox in this project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(setMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Turn on Inbox?')).not.toBeInTheDocument();
  });

  it('renders nothing when the backend answers not-implemented-on-mobile (Android has no Projects screen)', async () => {
    installClaude({ listProjectsIndex: vi.fn().mockResolvedValue({ ok: false, error: 'not-implemented-on-mobile' }) });
    const { container } = render(<ProjectSetupPanel pluginId="youcoded-inbox" />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  // renderer-lists.md: "a NEW list of the user's own things ships with its
  // own stress pin: 1,000+ items in, no more than one chunk drawn, seen red
  // with the bound removed" — projects have no enforced cap, the same class
  // as Conversations/Skills. A FIRING (not no-op) IntersectionObserver stub
  // is required: jsdom has none by default, and useChunkedReveal's own
  // fallback for that case draws everything — a no-op stub would make this
  // pass while the real list was stranded either way (see the helper's WHY).
  it('draws only one chunk of project rows at 1,000+ projects', async () => {
    const io = installFiringIntersectionObserver();
    try {
      const projects = Array.from({ length: 1200 }, (_, i) => ({ id: `p${i}`, path: `/p${i}`, name: `Project ${i}` }));
      installClaude({
        listProjectsIndex: vi.fn().mockResolvedValue({ ok: true, projects }),
        get: vi.fn().mockResolvedValue({ ok: true, view: baseView() }),
      });
      render(<ProjectSetupPanel pluginId="youcoded-inbox" />);

      await screen.findByText('Project 0');
      expect(screen.getAllByText(/^Project \d+$/).length).toBeLessThanOrEqual(REVEAL_CHUNK);
      expect(screen.queryByText(`Project ${projects.length - 1}`)).toBeNull();
    } finally {
      io.restore();
    }
  });
});
