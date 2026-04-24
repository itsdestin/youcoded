import { describe, it, expect } from 'vitest';
import { parseTranscriptLine, cwdToProjectSlug } from './transcript-watcher';

function makeUserLine(
  text: string,
  promptId = 'pid-1',
  uuid = 'u-1',
  timestamp = '2026-04-21T00:00:00Z',
) {
  return JSON.stringify({
    type: 'user',
    promptId,
    uuid,
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

describe('transcript-watcher interrupt detection', () => {
  it('emits user-interrupt (kind=plain) for "[Request interrupted by user]"', () => {
    const events = parseTranscriptLine(
      makeUserLine('[Request interrupted by user]'),
      'sess-1',
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'user-interrupt',
        sessionId: 'sess-1',
        data: { kind: 'plain' },
      }),
    ]);
  });

  it('emits user-interrupt (kind=tool-use) for "[Request interrupted by user for tool use]"', () => {
    const events = parseTranscriptLine(
      makeUserLine('[Request interrupted by user for tool use]'),
      'sess-1',
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'user-interrupt',
        sessionId: 'sess-1',
        data: { kind: 'tool-use' },
      }),
    ]);
  });

  it('does NOT emit a user-message when emitting user-interrupt', () => {
    const events = parseTranscriptLine(
      makeUserLine('[Request interrupted by user]'),
      'sess-1',
    );
    expect(events.some((e) => e.type === 'user-message')).toBe(false);
  });

  it('emits user-message for a normal user prompt', () => {
    const events = parseTranscriptLine(makeUserLine('hello claude'), 'sess-1');
    expect(events).toEqual([
      expect.objectContaining({
        type: 'user-message',
        data: expect.objectContaining({ text: 'hello claude' }),
      }),
    ]);
  });

  it('treats interrupt text embedded in longer content as a normal user-message', () => {
    const events = parseTranscriptLine(
      makeUserLine('hey, [Request interrupted by user] btw'),
      'sess-1',
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'user-message' }),
    ]);
  });
});

describe('cwdToProjectSlug', () => {
  it('encodes a Windows path without spaces', () => {
    expect(cwdToProjectSlug('C:\\Users\\alice\\repo')).toBe('C--Users-alice-repo');
  });

  it('encodes a POSIX path without spaces', () => {
    expect(cwdToProjectSlug('/home/alice/repo')).toBe('-home-alice-repo');
  });

  // Regression: CC itself replaces spaces in folder names with dashes, so the
  // watcher must do the same or it reads from a non-existent directory and
  // chat view stays empty for the whole session.
  it('encodes spaces as dashes to match CC (Windows)', () => {
    expect(cwdToProjectSlug('C:\\Users\\desti\\PAF 540 Final Data Project')).toBe(
      'C--Users-desti-PAF-540-Final-Data-Project',
    );
  });

  it('encodes spaces as dashes to match CC (POSIX)', () => {
    expect(cwdToProjectSlug('/home/alice/My Project')).toBe('-home-alice-My-Project');
  });
});
