// WHY this exists: every session total in the status bar (tokens, cost, code
// changes) is derived from the session's own recorded events and rebuilt by
// replay on resume. That is only true if the record actually carries the
// per-turn usage and the per-edit patch. Pin both — a silent regression here
// would make a resumed session report smaller numbers than it showed live,
// which is the exact class of quiet wrongness this work exists to remove.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeHome } from '../src/main/native-home';
import type { TranscriptEvent, TranscriptEventType, DataOf, EventOf } from '../src/shared/types';
import { ev as mkEv } from './helpers/transcript-events';

describe('native session record completeness', () => {
  let dir: string;
  let home: NativeHome;
  let store: SessionStore;
  // SessionStore.append/readEvents key the on-disk file by a slug derived
  // from cwd — an arbitrary fixed cwd is fine here, it just has to be the
  // same one passed to both append() and readEvents().
  const cwd = '/fake/project';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-record-'));
    // SessionStore takes a NativeHome, not a raw directory — homeRoot is
    // overridable for tests (native-home.ts constructor), so point it at the
    // tmpdir instead of the real ~/.youcoded/.
    home = new NativeHome(dir);
    store = new SessionStore(home);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ev = <T extends TranscriptEventType>(type: T, data: DataOf<T>): EventOf<T> =>
    mkEv(type, data, { uuid: `u-${type}-${JSON.stringify(data).length}`, timestamp: 1 });

  it('round-trips turn-complete usage', async () => {
    // readEvents() treats line 1 of the session file as the header (line
    // 2+ is transcript) — a session must be create()'d before append()ing,
    // or the appended event is itself read back as the header and dropped.
    await store.create({ v: 1, sessionId: 's1', harnessId: 'h1', binding: { providerId: 'anthropic', modelId: 'claude' }, cwd, createdAt: 1 });
    await store.append(cwd, ev('turn-complete', {
      stopReason: 'end_turn',
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, cacheCreationTokens: 100 },
    }));
    const back = store.readEvents('s1', cwd);
    const turn = back.find((e) => e.type === 'turn-complete');
    expect(turn?.data.usage).toEqual({
      inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, cacheCreationTokens: 100,
    });
  });

  // A specialist's whole spend reaches the parent as ONE subagent-usage event
  // on the parent's own stream. If that event didn't survive the disk
  // round-trip, a resumed session would silently forget every specialist it
  // ever ran — the same quiet shrinkage this file exists to prevent for turns.
  it('round-trips a subagent-usage report', async () => {
    await store.create({ v: 1, sessionId: 's1', harnessId: 'h1', binding: { providerId: 'anthropic', modelId: 'claude' }, cwd, createdAt: 1 });
    await store.append(cwd, ev('subagent-usage', {
      model: 'child-model',
      parentAgentToolUseId: 'tc-1',
      agentId: 'child-1',
      usage: { inputTokens: 6000, outputTokens: 600, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.027, free: false },
    }));
    const back = store.readEvents('s1', cwd);
    const report = back.find((e) => e.type === 'subagent-usage');
    expect(report?.data.usage).toEqual({
      inputTokens: 6000, outputTokens: 600, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.027, free: false,
    });
    expect(report?.data.agentId).toBe('child-1');
    expect(report?.data.parentAgentToolUseId).toBe('tc-1');
  });

  it('round-trips a tool-result structuredPatch', async () => {
    await store.create({ v: 1, sessionId: 's1', harnessId: 'h1', binding: { providerId: 'anthropic', modelId: 'claude' }, cwd, createdAt: 1 });
    await store.append(cwd, ev('tool-result', {
      toolUseId: 't1',
      toolName: 'Edit',
      toolResult: 'ok',
      isError: false,
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' keep', '-gone', '+new'] }],
    }));
    const back = store.readEvents('s1', cwd);
    const res = back.find((e) => e.type === 'tool-result');
    expect(res?.data.structuredPatch?.[0].lines).toEqual([' keep', '-gone', '+new']);
  });
});
