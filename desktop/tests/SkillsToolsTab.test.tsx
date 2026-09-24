// @vitest-environment jsdom
// Projects → Skills & tools (T4, project-plugin-controls): rows come from
// `project-extensions:get`, writes go through `:set` with an optimistic
// update reconciled against the real response, and turning on a tool
// connection always confirms first (R3/R23) — whether from a plugin's master
// switch or a single part.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SkillsToolsTab, needsSetupRowDomId } from '../src/renderer/components/project-view/SkillsToolsTab';
import { NARROW_VIEWPORT_QUERY } from '../src/renderer/hooks/use-narrow-viewport';

// WHY: createPortal (Dialog) renders into document.body — clean it between
// tests or a later query can match a previous test's leftover dialog.
afterEach(cleanup);

// A test of a viewport-branching component DECLARES the viewport — jsdom has
// no matchMedia, and the hook reads its absence as wide (narrow-viewport.md).
function declareViewport(narrow: boolean) {
  (window as any).matchMedia = (q: string) => ({
    matches: narrow && q === NARROW_VIEWPORT_QUERY, media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

const PROJECT = { id: 'p1', path: '/home/d/proj', name: 'My Project' } as any;

function baseView(overrides: Record<string, unknown> = {}) {
  return { projectKey: PROJECT.path, builtIn: [], installed: [], personal: [], needsSetup: [], ...overrides };
}

function installClaude(opts: { get?: any; set?: any; importSkill?: any; openFile?: any } = {}) {
  (window as any).claude = {
    projectExtensions: {
      get: opts.get ?? vi.fn().mockResolvedValue({ ok: true, view: baseView() }),
      set: opts.set ?? vi.fn(),
      importSkill: opts.importSkill ?? vi.fn(),
    },
    dialog: { openFile: opts.openFile ?? vi.fn() },
  };
}

describe('SkillsToolsTab', () => {
  beforeEach(() => {
    declareViewport(false);
  });

  it('renders plugin, personal, and needs-setup rows from the fetched view', async () => {
    const view = baseView({
      builtIn: [{ pluginId: 'youcoded-chatsearch', displayName: 'Chat Search', bundled: true, on: true, paused: false, parts: [] }],
      personal: [{ key: 'self:writing-helper', kind: 'skill', displayName: 'Writing helper', on: true }],
      needsSetup: [{ key: 'mcp:library', displayName: 'Library search', kind: 'tool-connection', projectKey: PROJECT.path }],
    });
    installClaude({ get: vi.fn().mockResolvedValue({ ok: true, view }) });
    render(<SkillsToolsTab hidden={false} project={PROJECT} onNewConversation={vi.fn()} />);

    expect(await screen.findByText('Chat Search')).toBeInTheDocument();
    expect(screen.getByText('Writing helper')).toBeInTheDocument();
    expect(screen.getByText('Library search')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up here' })).toBeInTheDocument();
  });

  it('turning on a plugin with a tool connection opens the risk popup and writes only on Turn on', async () => {
    const group = {
      pluginId: 'research-kit', displayName: 'Research Kit', bundled: false, on: false, paused: true,
      parts: [
        { key: 'research-kit:find', kind: 'skill', displayName: 'Find sources', on: false },
        { key: 'mcp:research-lib', kind: 'mcp', displayName: 'Research sources', on: false },
      ],
    };
    const setMock = vi.fn().mockResolvedValue({ ok: true, view: baseView({ installed: [{ ...group, on: true, paused: false }] }) });
    installClaude({ get: vi.fn().mockResolvedValue({ ok: true, view: baseView({ installed: [group] }) }), set: setMock });
    render(<SkillsToolsTab hidden={false} project={PROJECT} onNewConversation={vi.fn()} />);

    const toggle = await screen.findByRole('switch', { name: 'Research Kit in this project' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);

    expect(await screen.findByText('Turn on Research Kit?')).toBeInTheDocument();
    expect(screen.getByText('Research sources')).toBeInTheDocument(); // named connection
    expect(setMock).not.toHaveBeenCalled();
    // The toggle itself hasn't moved yet — only confirming writes anything.
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith(PROJECT.path, [{ plugin: 'research-kit', on: true }]));
    await waitFor(() => expect(screen.queryByText('Turn on Research Kit?')).not.toBeInTheDocument());
  });

  it('Cancel writes nothing and leaves the switch off', async () => {
    const group = {
      pluginId: 'research-kit', displayName: 'Research Kit', bundled: false, on: false, paused: true,
      parts: [{ key: 'mcp:research-lib', kind: 'mcp', displayName: 'Research sources', on: false }],
    };
    const setMock = vi.fn();
    installClaude({ get: vi.fn().mockResolvedValue({ ok: true, view: baseView({ installed: [group] }) }), set: setMock });
    render(<SkillsToolsTab hidden={false} project={PROJECT} onNewConversation={vi.fn()} />);

    const toggle = await screen.findByRole('switch', { name: 'Research Kit in this project' });
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(setMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Turn on Research Kit?')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('reverts the optimistic change and shows the real error when a write fails', async () => {
    const group = { pluginId: 'wecoded-pages-plugin', displayName: 'Page Builder', bundled: true, on: true, paused: false, parts: [] };
    const setMock = vi.fn().mockResolvedValue({ ok: false, error: 'disk is full' });
    installClaude({ get: vi.fn().mockResolvedValue({ ok: true, view: baseView({ builtIn: [group] }) }), set: setMock });
    render(<SkillsToolsTab hidden={false} project={PROJECT} onNewConversation={vi.fn()} />);

    const toggle = await screen.findByRole('switch', { name: 'Page Builder in this project' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    // Turning OFF never risks a tool connection, so this commits straight away.
    fireEvent.click(toggle);

    await waitFor(() => expect(setMock).toHaveBeenCalledWith(PROJECT.path, [{ plugin: 'wecoded-pages-plugin', on: false }]));
    expect(await screen.findByText('disk is full')).toBeInTheDocument();
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true')); // reverted
  });

  it('opens the needs-setup popup with the assistant prompt and (for a personal skill) the file picker', async () => {
    const row = { key: 'self:writing-helper', displayName: 'Writing helper', kind: 'personal-skill', projectKey: PROJECT.path };
    installClaude({ get: vi.fn().mockResolvedValue({ ok: true, view: baseView({ needsSetup: [row] }) }) });
    const onNewConversation = vi.fn();
    render(<SkillsToolsTab hidden={false} project={PROJECT} onNewConversation={onNewConversation} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Set up here' }));
    expect(await screen.findByText('Set up Writing helper')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose skill file' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ask assistant to set it up' }));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
    const [cwd, prompt] = onNewConversation.mock.calls[0];
    expect(cwd).toBe(PROJECT.path);
    expect(prompt).toContain('Writing helper');
  });

  it('a tool-connection needs-setup row has no file picker action', async () => {
    const row = { key: 'mcp:library', displayName: 'Library search', kind: 'tool-connection', projectKey: PROJECT.path };
    installClaude({ get: vi.fn().mockResolvedValue({ ok: true, view: baseView({ needsSetup: [row] }) }) });
    render(<SkillsToolsTab hidden={false} project={PROJECT} onNewConversation={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Set up here' }));
    expect(await screen.findByText('Set up Library search')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose skill file' })).not.toBeInTheDocument();
  });

  it('wraps a needs-setup row description at a narrow viewport instead of truncating it (R21)', async () => {
    // T4 review F2: this row's description now wins via SettingRow's own
    // `wrapDescription` prop (no caller `truncate` to fight, so no
    // `!whitespace-normal` override needed) instead of a caller className
    // escape hatch — `truncate` simply never lands on the class list.
    declareViewport(true);
    const row = { key: 'mcp:library', displayName: 'Library search', kind: 'tool-connection', projectKey: PROJECT.path };
    installClaude({ get: vi.fn().mockResolvedValue({ ok: true, view: baseView({ needsSetup: [row] }) }) });
    render(<SkillsToolsTab hidden={false} project={PROJECT} onNewConversation={vi.fn()} />);

    const desc = await screen.findByText(/Not on this device/);
    expect(desc.className).not.toContain('truncate');
  });

  it('gives a needs-setup row a stable DOM id derived from its key (F6)', async () => {
    const row = { key: 'mcp:library', displayName: 'Library search', kind: 'tool-connection', projectKey: PROJECT.path };
    installClaude({ get: vi.fn().mockResolvedValue({ ok: true, view: baseView({ needsSetup: [row] }) }) });
    render(<SkillsToolsTab hidden={false} project={PROJECT} onNewConversation={vi.fn()} />);

    const desc = await screen.findByText(/Not on this device/);
    expect(document.getElementById(needsSetupRowDomId(row.key))).toBe(
      desc.closest('.rounded-lg.border.border-edge-dim.bg-panel'),
    );
  });

  it('two quick toggles on different rows both land (F3)', async () => {
    const groupA = { pluginId: 'plugin-a', displayName: 'Plugin A', bundled: true, on: false, paused: true, parts: [] };
    const groupB = { pluginId: 'plugin-b', displayName: 'Plugin B', bundled: true, on: false, paused: true, parts: [] };
    // Neither response knows about the OTHER's change — exactly what a real
    // per-change `project-extensions:set` round trip returns — so this only
    // passes if the renderer itself serializes/reconciles the two writes.
    const setMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, view: baseView({ builtIn: [{ ...groupA, on: true, paused: false }, groupB] }) })
      .mockResolvedValueOnce({ ok: true, view: baseView({ builtIn: [{ ...groupA, on: true, paused: false }, { ...groupB, on: true, paused: false }] }) });
    installClaude({ get: vi.fn().mockResolvedValue({ ok: true, view: baseView({ builtIn: [groupA, groupB] }) }), set: setMock });
    render(<SkillsToolsTab hidden={false} project={PROJECT} onNewConversation={vi.fn()} />);

    const toggleA = await screen.findByRole('switch', { name: 'Plugin A in this project' });
    const toggleB = await screen.findByRole('switch', { name: 'Plugin B in this project' });
    fireEvent.click(toggleA);
    fireEvent.click(toggleB);

    await waitFor(() => expect(setMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toggleA).toHaveAttribute('aria-checked', 'true'));
    await waitFor(() => expect(toggleB).toHaveAttribute('aria-checked', 'true'));
  });

  describe('lazy fetch (F4)', () => {
    it('does not fetch project-extensions:get while the tab is hidden', () => {
      const getMock = vi.fn().mockResolvedValue({ ok: true, view: baseView() });
      installClaude({ get: getMock });
      render(<SkillsToolsTab hidden project={PROJECT} onNewConversation={vi.fn()} />);
      expect(getMock).not.toHaveBeenCalled();
    });

    it('fetches the first time the tab is shown, and refetches on a project change while visible', async () => {
      const getMock = vi.fn().mockResolvedValue({ ok: true, view: baseView() });
      installClaude({ get: getMock });
      const { rerender } = render(<SkillsToolsTab hidden project={PROJECT} onNewConversation={vi.fn()} />);
      expect(getMock).not.toHaveBeenCalled();

      rerender(<SkillsToolsTab hidden={false} project={PROJECT} onNewConversation={vi.fn()} />);
      await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));

      // Hiding and re-showing the SAME project costs nothing more — it's
      // already loaded (switching tabs must never re-fetch).
      rerender(<SkillsToolsTab hidden project={PROJECT} onNewConversation={vi.fn()} />);
      rerender(<SkillsToolsTab hidden={false} project={PROJECT} onNewConversation={vi.fn()} />);
      expect(getMock).toHaveBeenCalledTimes(1);

      // A DIFFERENT project while visible does refetch.
      const other = { ...PROJECT, id: 'p2', path: '/home/d/other' };
      rerender(<SkillsToolsTab hidden={false} project={other} onNewConversation={vi.fn()} />);
      await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    });
  });

  describe('render budget while hidden (F5)', () => {
    it('an unrelated parent re-render does not re-render a hidden SkillsToolsTab', () => {
      // A <Profiler> WRAPPING the already-exported (memoized) SkillsToolsTab
      // fires on every commit reaching that position in the tree regardless
      // of whether the memoized child bails out — it would report a "render"
      // on every parent tick even with memo working correctly, which proves
      // nothing. The busy-app harness's own `probe()` helper
      // (tests/helpers/busy-app-probes.tsx) solves this by putting the
      // Profiler INSIDE the memo boundary, wrapping the same underlying
      // function with the same comparator, so it bails out exactly when the
      // real component would and only fires for a render that actually ran.
      // Reused here rather than re-solving it differently.
      const MEMO = Symbol.for('react.memo');
      installClaude();
      let renders = 0;
      const real = SkillsToolsTab as any;
      const isMemo = real && typeof real === 'object' && real.$$typeof === MEMO;
      const Inner = isMemo ? real.type : real;
      function Probed(props: any) {
        return (
          <React.Profiler id="skills-tab" onRender={() => { renders += 1; }}>
            <Inner {...props} />
          </React.Profiler>
        );
      }
      const ProbedSkillsToolsTab = isMemo ? React.memo(Probed, real.compare ?? undefined) : Probed;

      // Mirrors ProjectView's real contract: a STABLE `onNewConversation`
      // (its own useCallback) and a project object that doesn't change
      // identity on an unrelated parent re-render — memo only holds if both
      // stay stable (performance.md rule 2's "memo + stable props").
      function Harness() {
        const [, setTick] = React.useState(0);
        const onNewConversation = React.useCallback(() => {}, []);
        return (
          <div>
            <button onClick={() => setTick((t) => t + 1)}>tick</button>
            <ProbedSkillsToolsTab hidden project={PROJECT} onNewConversation={onNewConversation} />
          </div>
        );
      }
      render(<Harness />);
      const afterMount = renders;
      expect(afterMount).toBeGreaterThan(0);

      fireEvent.click(screen.getByText('tick'));
      fireEvent.click(screen.getByText('tick'));
      expect(renders, 'a hidden SkillsToolsTab must not redraw for an unrelated parent state change').toBe(afterMount);
    });
  });
});
