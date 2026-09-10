// @vitest-environment jsdom
//
// The buddy floater's empty screen — its New Session form and its Resume list.
//
// WHAT THIS FILE IS REALLY GUARDING. Before 2026-09-10 there was NO test
// touching this screen anywhere in the suite (19 buddy test files, none of them
// here), and it drifted for two months without anyone noticing: Resume Session
// was a July placeholder that set an error string and did nothing, the form
// hardcoded provider:'claude' so ChatGPT and local models were unreachable from
// the floater, and a saved non-Claude default was silently replaced by Claude
// Sonnet. Every assertion below is one of those.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { BuddyWelcome } from '../src/renderer/components/buddy/BuddyWelcome';

const create = vi.fn();
const browse = vi.fn();
const defaultsGet = vi.fn();

// jsdom ships no localStorage in this suite (the gap buddy-linux-migration
// documents), and RuntimeBinding's remembered binding reads through it.
const store = new Map<string, string>();
const localStorageShim = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  for (const target of [globalThis, window]) {
    Object.defineProperty(target, 'localStorage', {
      value: localStorageShim, configurable: true, writable: true,
    });
  }
  create.mockResolvedValue({ id: 'live-1' });
  browse.mockResolvedValue([]);
  defaultsGet.mockResolvedValue({ projectFolder: '/p', skipPermissions: false, model: 'sonnet' });
  (window as any).claude = {
    session: { create, browse },
    defaults: { get: defaultsGet },
    folders: { list: vi.fn().mockResolvedValue([{ path: '/p', nickname: 'p' }]), add: vi.fn() },
    dialog: { openFolder: vi.fn() },
    providers: { list: vi.fn().mockResolvedValue([]), catalog: vi.fn().mockResolvedValue([]) },
    syncSpaces: {},
    native: { supported: true },
  };
});
afterEach(cleanup);

describe('the buddy floater empty screen', () => {
  it('offers both buttons', () => {
    render(<BuddyWelcome onSessionCreated={vi.fn()} />);
    expect(screen.getByRole('button', { name: /New Session/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resume Session/i })).toBeInTheDocument();
  });

  it('Resume Session opens a list instead of telling you to go to the main window', async () => {
    // The July placeholder rendered the literal sentence below and nothing else.
    // The button read as an action and behaved as a label.
    render(<BuddyWelcome onSessionCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Resume Session/i }));
    await waitFor(() => expect(browse).toHaveBeenCalled());
    expect(screen.queryByText(/Open Resume from the main window/i)).not.toBeInTheDocument();
  });

  it('lists past conversations, newest first, and hides ones filed as complete', async () => {
    browse.mockResolvedValue([
      { sessionId: 'a', name: 'older thing', projectPath: '/p/a', projectSlug: 'a', lastModified: 1000 },
      { sessionId: 'b', name: 'newer thing', projectPath: '/p/b', projectSlug: 'b', lastModified: 9000 },
      { sessionId: 'c', name: 'filed away', projectPath: '/p/c', projectSlug: 'c', lastModified: 9999, flags: { complete: true } },
    ]);
    render(<BuddyWelcome onSessionCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Resume Session/i }));
    await screen.findByText('newer thing');
    expect(screen.queryByText('filed away')).not.toBeInTheDocument();
    const names = screen.getAllByText(/thing$/).map((n) => n.textContent);
    expect(names).toEqual(['newer thing', 'older thing']);
  });

  it('says WHY a conversation cannot be picked up, and does not expand it', async () => {
    browse.mockResolvedValue([
      { sessionId: 'a', name: 'elsewhere', projectPath: '/p/a', projectSlug: 'a', lastModified: 1, missingProject: true },
      { sessionId: 'b', name: 'in flight', projectPath: '/p/b', projectSlug: 'b', lastModified: 2, notSyncedYet: true },
    ]);
    render(<BuddyWelcome onSessionCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Resume Session/i }));
    await screen.findByText(/project folder isn't on this device/i);
    expect(screen.getByText(/Hasn't synced to this device yet/i)).toBeInTheDocument();
    // Blocked rows are inert — never a row that opens onto a Resume button that
    // could not work.
    fireEvent.click(screen.getByText('elsewhere'));
    expect(screen.queryByRole('button', { name: /^Resume$/ })).not.toBeInTheDocument();
  });

  it('resumes a Claude conversation through the shared payload builder', async () => {
    browse.mockResolvedValue([
      { sessionId: 'past-1', name: 'pick me up', projectPath: '/p/a', projectSlug: 'a', lastModified: 1 },
    ]);
    const onSessionCreated = vi.fn();
    render(<BuddyWelcome onSessionCreated={onSessionCreated} />);
    fireEvent.click(screen.getByRole('button', { name: /Resume Session/i }));
    fireEvent.click(await screen.findByText('pick me up'));
    fireEvent.click(await screen.findByRole('button', { name: /^Resume$/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({
      cwd: '/p/a',
      provider: 'claude',
      resumeSessionId: 'past-1',
      // Not a bare 'Resuming' literal: main's title feeder has to recognise the
      // constant or auto-titling stays blocked for the whole conversation.
      name: 'Resuming...',
    });
    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith('live-1'));
  });

  it('a native conversation is never resumed on a stored binding without asking', async () => {
    // Destin's ruling (Task 6): native resume ALWAYS offers the model selector.
    // A remembered binding in localStorage must not short-circuit that.
    store.set('youcoded-last-binding', JSON.stringify({ providerId: 'openrouter', modelId: 'gpt-5' }));
    browse.mockResolvedValue([
      { sessionId: 'past-n', name: 'native chat', projectPath: '/p/n', projectSlug: 'n', lastModified: 1, provider: 'native' },
    ]);
    render(<BuddyWelcome onSessionCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Resume Session/i }));
    fireEvent.click(await screen.findByText('native chat'));
    const resume = await screen.findByRole('button', { name: /^Resume$/ });
    expect(resume).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });

  it('the new-session form uses the shared model picker, not a Claude-only button row', async () => {
    // The retired form rendered four fixed <button>s labelled Haiku / Sonnet /
    // Opus / Fable, which is why no ChatGPT or local model was reachable from
    // the floater at all.
    render(<BuddyWelcome onSessionCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /New Session/i }));
    await screen.findByText(/Project Folder/i);
    expect(screen.queryByRole('button', { name: /^Fable$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Haiku$/ })).not.toBeInTheDocument();
  });

  it('creating a session sends a payload built by the shared builder', async () => {
    render(<BuddyWelcome onSessionCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /New Session/i }));
    // Wait for the defaults to hydrate the folder — submitting before they land
    // is the form's own "Pick a project folder first" branch, not a create.
    await waitFor(() => expect(defaultsGet).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /Create Session/i }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({
      name: 'New Session', cwd: '/p', provider: 'claude', skipPermissions: false,
    });
  });

  it('honours a saved non-Claude default instead of silently starting Claude', async () => {
    // The bug this replaces: the form read `defaults.model` (only ever a Claude
    // alias) and ignored `defaults.startModel` (the actual saved pick), so a
    // ChatGPT or local default opened a Claude Sonnet session with nothing on
    // screen saying so.
    defaultsGet.mockResolvedValue({
      projectFolder: '/p', skipPermissions: false, model: 'sonnet',
      startModel: { runtime: 'native', providerId: 'openrouter', modelId: 'gpt-5' },
    });
    render(<BuddyWelcome onSessionCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /New Session/i }));
    // Skip Permissions is Claude-Code-only, so its disappearance is the visible
    // proof the form switched runtimes off the saved default.
    await waitFor(() => expect(screen.queryByLabelText('Skip Permissions')).not.toBeInTheDocument());
  });
});
