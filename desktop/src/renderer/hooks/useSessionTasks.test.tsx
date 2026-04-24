// @vitest-environment jsdom
// Fix: Node.js 22+ ships a stub globalThis.localStorage that lacks real methods
// and requires --localstorage-file. In the jsdom worker, `localStorage` in hook
// code resolves to Node's stub (globalThis), not jsdom's window.localStorage.
// vi.stubGlobal replaces the global for the lifetime of this test file so bare
// `localStorage` calls in both the test and the hook reach a working
// in-memory implementation.
import React from 'react';
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ChatProvider, useChatDispatch } from '../state/chat-context';
import { useSessionTasks, INACTIVE_STORAGE_KEY } from './useSessionTasks';

const SESSION_ID = 'sess-test';

// ── localStorage stub for Node 25 ──────────────────────────────────────────
// Replace Node's non-functional globalThis.localStorage with a plain
// in-memory Map-backed storage so all bare `localStorage` accesses work.
function makeLocalStorageMock() {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = String(value); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (n: number) => Object.keys(store)[n] ?? null,
  };
}

const lsMock = makeLocalStorageMock();
beforeAll(() => { vi.stubGlobal('localStorage', lsMock); });
afterAll(() => { vi.unstubAllGlobals(); });

function Providers({ children }: { children: React.ReactNode }) {
  return <ChatProvider>{children}</ChatProvider>;
}

interface SeedCall {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  response?: string;
}

/**
 * Injects tool-use + tool-result actions into the chat store for SESSION_ID.
 * Matches the real transcript-watcher flow: SESSION_INIT first (the reducer
 * ignores TRANSCRIPT_TOOL_USE for sessions that don't exist yet), then
 * TRANSCRIPT_TOOL_USE creates the entry, then TRANSCRIPT_TOOL_RESULT populates
 * `response`.
 */
function useSeedTasks() {
  const dispatch = useChatDispatch();
  return (calls: SeedCall[]) => {
    // Ensure the session exists — the reducer ignores TRANSCRIPT_TOOL_USE
    // for unknown session IDs.
    dispatch({ type: 'SESSION_INIT', sessionId: SESSION_ID });
    for (const call of calls) {
      dispatch({
        type: 'TRANSCRIPT_TOOL_USE',
        sessionId: SESSION_ID,
        toolUseId: call.toolUseId,
        toolName: call.toolName,
        toolInput: call.input,
      } as any);
      if (call.response !== undefined) {
        dispatch({
          type: 'TRANSCRIPT_TOOL_RESULT',
          sessionId: SESSION_ID,
          toolUseId: call.toolUseId,
          result: call.response,
          isError: false,
        } as any);
      }
    }
  };
}

describe('useSessionTasks', () => {
  beforeEach(() => {
    localStorage.removeItem(INACTIVE_STORAGE_KEY);
  });

  it('returns empty state for a session with no task tool calls', () => {
    const { result } = renderHook(() => useSessionTasks(SESSION_ID), { wrapper: Providers });
    expect(result.current.tasks).toEqual([]);
    expect(result.current.counts).toEqual({ running: 0, pending: 0, completed: 0, inactive: 0 });
  });

  it('derives tasks live as TaskCreate/TaskUpdate events arrive', () => {
    const { result } = renderHook(() => {
      const seed = useSeedTasks();
      const tasks = useSessionTasks(SESSION_ID);
      return { seed, ...tasks };
    }, { wrapper: Providers });

    act(() => {
      result.current.seed([
        {
          toolUseId: 't1', toolName: 'TaskCreate',
          input: { subject: 'First', description: 'desc' },
          response: 'Task #1 created successfully: First',
        },
        {
          toolUseId: 't2', toolName: 'TaskUpdate',
          input: { taskId: '1', status: 'in_progress' },
        },
      ]);
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].id).toBe('1');
    expect(result.current.tasks[0].status).toBe('in_progress');
    expect(result.current.counts.running).toBe(1);
  });

  it('marks a task inactive and persists it to localStorage', () => {
    const { result } = renderHook(() => {
      const seed = useSeedTasks();
      return { seed, ...useSessionTasks(SESSION_ID) };
    }, { wrapper: Providers });

    act(() => {
      result.current.seed([{
        toolUseId: 't1', toolName: 'TaskCreate',
        input: { subject: 'X' }, response: 'Task #1 created successfully: X',
      }]);
    });
    act(() => { result.current.markInactive('1'); });

    expect(result.current.tasks[0].markedInactive).toBe(true);
    expect(result.current.counts.inactive).toBe(1);
    const stored = JSON.parse(localStorage.getItem(INACTIVE_STORAGE_KEY)!);
    expect(stored[SESSION_ID]).toContain('1');
  });

  it('unhides a task and updates localStorage', () => {
    localStorage.setItem(INACTIVE_STORAGE_KEY, JSON.stringify({ [SESSION_ID]: ['1'] }));

    const { result } = renderHook(() => {
      const seed = useSeedTasks();
      return { seed, ...useSessionTasks(SESSION_ID) };
    }, { wrapper: Providers });

    act(() => {
      result.current.seed([{
        toolUseId: 't1', toolName: 'TaskCreate',
        input: { subject: 'X' }, response: 'Task #1 created successfully: X',
      }]);
    });
    expect(result.current.tasks[0].markedInactive).toBe(true);

    act(() => { result.current.unhide('1'); });
    expect(result.current.tasks[0].markedInactive).toBeFalsy();
    const stored = JSON.parse(localStorage.getItem(INACTIVE_STORAGE_KEY) ?? '{}');
    expect(stored[SESSION_ID] ?? []).not.toContain('1');
  });

  it('clears markedInactive automatically when the task transitions to completed', () => {
    localStorage.setItem(INACTIVE_STORAGE_KEY, JSON.stringify({ [SESSION_ID]: ['1'] }));

    const { result } = renderHook(() => {
      const seed = useSeedTasks();
      return { seed, ...useSessionTasks(SESSION_ID) };
    }, { wrapper: Providers });

    act(() => {
      result.current.seed([
        {
          toolUseId: 't1', toolName: 'TaskCreate',
          input: { subject: 'X' }, response: 'Task #1 created successfully: X',
        },
        {
          toolUseId: 't2', toolName: 'TaskUpdate',
          input: { taskId: '1', status: 'completed' },
        },
      ]);
    });

    // The auto-clear effect fires inside `act`, so by now the flag is cleared.
    expect(result.current.tasks[0].markedInactive).toBeFalsy();
    const stored = JSON.parse(localStorage.getItem(INACTIVE_STORAGE_KEY) ?? '{}');
    expect(stored[SESSION_ID] ?? []).not.toContain('1');
  });
});
