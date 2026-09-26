import { describe, it, expect } from 'vitest';
import { resolveMappingAction, findLiveSessionForConversation } from '../src/main/session-id-mapping';

describe('resolveMappingAction', () => {
  it('adopts the first mapping from any hook event', () => {
    expect(resolveMappingAction(undefined, 'claude-1', 'PostToolUse')).toBe('adopt');
    expect(resolveMappingAction(undefined, 'claude-1', 'SessionStart')).toBe('adopt');
  });

  it('ignores events that match the current mapping', () => {
    expect(resolveMappingAction('claude-1', 'claude-1', 'SessionStart')).toBe('ignore');
    expect(resolveMappingAction('claude-1', 'claude-1', 'PostToolUse')).toBe('ignore');
  });

  it('remaps on SessionStart with a new id (/clear rotation)', () => {
    expect(resolveMappingAction('claude-1', 'claude-2', 'SessionStart')).toBe('adopt');
  });

  it('never remaps from non-SessionStart events (subagent ids must not poison the map)', () => {
    expect(resolveMappingAction('claude-1', 'claude-2', 'PostToolUse')).toBe('ignore');
    expect(resolveMappingAction('claude-1', 'claude-2', 'SubagentStart')).toBe('ignore');
    expect(resolveMappingAction('claude-1', 'claude-2', 'Stop')).toBe('ignore');
    expect(resolveMappingAction('claude-1', 'claude-2', undefined)).toBe('ignore');
  });

  // A `startup` SessionStart means a Claude process ANNOUNCED ITSELF for the
  // first time. On a desktop session that is already mapped, that can only be a
  // FOREIGN process reporting into our session (CLAUDE_DESKTOP_SESSION_ID is
  // inherited by any descendant of the PTY, so a nested `claude` run inherits
  // our desktop id). Adopting it repointed the transcript watcher at an
  // unrelated JSONL, whose offset-0 replay flooded the chat view with someone
  // else's conversation while the terminal kept showing the real session.
  it('ignores a startup remap on an already-mapped session (foreign process announcing in)', () => {
    expect(resolveMappingAction('claude-1', 'claude-2', 'SessionStart', 'startup')).toBe('ignore');
  });

  // The two legitimate in-session rotations must still be followed: /clear
  // rotates onto a fresh empty transcript, and an in-session /resume switches
  // the live process to another conversation. In both cases the chat view
  // SHOULD follow the new id.
  it('still remaps on a clear rotation', () => {
    expect(resolveMappingAction('claude-1', 'claude-2', 'SessionStart', 'clear')).toBe('adopt');
  });

  it('still remaps on an in-session resume', () => {
    expect(resolveMappingAction('claude-1', 'claude-2', 'SessionStart', 'resume')).toBe('adopt');
  });

  // FAIL-OPEN: `source` is CC-supplied and unverified in the wild. If it is
  // absent or a value we don't recognize, fall back to the pre-guard behavior
  // rather than silently stranding the chat view on a stale transcript. A
  // future CC that drops/renames the field degrades to today's behavior, not
  // to a broken one.
  it('falls back to adopting when source is missing or unrecognized', () => {
    expect(resolveMappingAction('claude-1', 'claude-2', 'SessionStart', undefined)).toBe('adopt');
    expect(resolveMappingAction('claude-1', 'claude-2', 'SessionStart', '')).toBe('adopt');
    expect(resolveMappingAction('claude-1', 'claude-2', 'SessionStart', 'some-future-source')).toBe('adopt');
  });

  // The guard applies ONLY to the remap. A first sighting must still bind
  // unconditionally — a resumed session's very first hook is a `startup`
  // whose transcript is non-empty by definition, and refusing it would leave
  // the chat view permanently empty for every resumed conversation.
  it('adopts a first sighting even from a startup source', () => {
    expect(resolveMappingAction(undefined, 'claude-1', 'SessionStart', 'startup')).toBe('adopt');
  });
});

describe('findLiveSessionForConversation', () => {
  const live = [{ id: 'desk-1', status: 'active' }, { id: 'native-9', status: 'idle' }];
  const of = (m: Record<string, string>) => (id: string) => m[id];

  it('finds a live Claude Code session through the id map', () => {
    expect(findLiveSessionForConversation('claude-A', live, of({ 'desk-1': 'claude-A' }))?.id).toBe('desk-1');
  });

  it('finds a live native session by its own id', () => {
    expect(findLiveSessionForConversation('native-9', live, of({}))?.id).toBe('native-9');
  });

  it('ignores a map entry whose desktop session has exited', () => {
    expect(findLiveSessionForConversation('claude-B', live, of({ 'desk-gone': 'claude-B' }))).toBeUndefined();
  });

  it('ignores a destroyed session', () => {
    const withDead = [{ id: 'desk-1', status: 'destroyed' }];
    expect(findLiveSessionForConversation('claude-A', withDead, of({ 'desk-1': 'claude-A' }))).toBeUndefined();
  });

  it('answers nothing for a conversation no session holds', () => {
    expect(findLiveSessionForConversation('claude-Z', live, of({ 'desk-1': 'claude-A' }))).toBeUndefined();
  });
});
