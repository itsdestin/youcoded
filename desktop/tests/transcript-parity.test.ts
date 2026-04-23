import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseTranscriptLine } from '../src/main/transcript-watcher';
import type { TranscriptEvent } from '../src/shared/types';

// ---------------------------------------------------------------------------
// Transcript Parity Fixtures
//
// Drives `parseTranscriptLine` through canonical JSONL fixtures and asserts
// the emitted event stream matches `<fixture>.expected.json` exactly. The
// same fixtures are the contract for the Phase 3 Node CLI bundle that
// Android will spawn instead of running its own Kotlin parser. If a future
// Claude Code CLI release changes the JSONL shape, this suite catches the
// drift before it hits either platform.
//
// `timestamp` is set to `Date.now()` at parse time and would make every run
// a fresh failure. The test strips it from actual events before comparing,
// and the expected JSON omits it.
//
// Fixtures live at `youcoded/shared-fixtures/transcript-parity/` (the
// fixture dir is intentionally outside `desktop/` so a future Android or
// Node-CLI test can read the same files without duplication).
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.resolve(__dirname, '../../shared-fixtures/transcript-parity');
const SESSION_ID = 'fixture-session';

type ExpectedEvent = Omit<TranscriptEvent, 'timestamp'>;

function stripTimestamps(events: TranscriptEvent[]): ExpectedEvent[] {
  return events.map(({ timestamp: _t, ...rest }) => rest as ExpectedEvent);
}

function loadFixture(name: string): { input: string[]; expected: ExpectedEvent[] } {
  const jsonlPath = path.join(FIXTURES_DIR, `${name}.jsonl`);
  const expectedPath = path.join(FIXTURES_DIR, `${name}.expected.json`);
  const input = fs
    .readFileSync(jsonlPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8')) as ExpectedEvent[];
  return { input, expected };
}

function runFixture(name: string): { actual: ExpectedEvent[]; expected: ExpectedEvent[] } {
  const { input, expected } = loadFixture(name);
  const actual: TranscriptEvent[] = [];
  for (const line of input) {
    actual.push(...parseTranscriptLine(line, SESSION_ID));
  }
  return { actual: stripTimestamps(actual), expected };
}

describe('transcript parity fixtures', () => {
  it('01-simple-text: user prompt + assistant text + end_turn', () => {
    const { actual, expected } = runFixture('01-simple-text');
    expect(actual).toEqual(expected);
  });

  it('02-multi-tool-grouped: 3 tool_uses in one assistant turn keep grouping invariants', () => {
    // This is the Bug 2 scenario — desktop and Android must produce identical
    // event order so the shared chat reducer's currentGroupId logic groups
    // the three tool_uses into a single bubble on both platforms.
    const { actual, expected } = runFixture('02-multi-tool-grouped');
    expect(actual).toEqual(expected);
  });

  it('03-intermediate-text-splits-group: assistant text between tools resets group', () => {
    const { actual, expected } = runFixture('03-intermediate-text-splits-group');
    expect(actual).toEqual(expected);
  });

  it('04-skipped-line-types: progress, file-history-snapshot, isMeta, no-promptId user → all skipped', () => {
    // Regression check for the Phase 1 streaming-text removal: a "progress"
    // line MUST emit zero events (desktop already does this). Likewise
    // file-history-snapshot, isMeta user, and tool-wrapper user (no promptId)
    // are all skipped. Only the real user prompt at the end produces an event.
    const { actual, expected } = runFixture('04-skipped-line-types');
    expect(actual).toEqual(expected);
  });
});
