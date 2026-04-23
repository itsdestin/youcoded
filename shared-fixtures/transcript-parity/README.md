# Transcript Parity Fixtures

JSONL fixtures + expected event streams used by the parity test suite.
Both desktop (`desktop/tests/transcript-parity.test.ts`) and any future
parser implementation (Android Kotlin watcher today, Node CLI in Phase 3)
must produce the same event stream from the same input.

## Format

Each fixture is two files:

- `<name>.jsonl` — raw input. One Claude Code transcript JSON object per line.
- `<name>.expected.json` — expected event stream as a JSON array of
  `{type, sessionId, uuid, data}` objects in emission order. Timestamps
  are intentionally omitted because they're set to `Date.now()` at parse
  time and would make every run a fresh failure; the test strips them
  from actual events before comparing.

## Why no real Anthropic data

Fixtures are hand-crafted to exercise specific parsing behaviors. Real
transcripts contain user PII (prompts, file paths, tool output) and would
also drift with every Claude Code release. Synthetic fixtures keep the
contract small, intentional, and reviewable.

## Adding a fixture

1. Create `NN-name.jsonl` with the input lines.
2. Run `parseTranscriptLine` on each line and dump events.
3. Hand-edit the dump into `NN-name.expected.json`, removing `timestamp`.
4. Add a comment block at the top of the JSONL file explaining what the
   fixture is meant to test.
