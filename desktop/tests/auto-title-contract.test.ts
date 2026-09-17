import { describe, it, expect } from 'vitest';
import path from 'path';
import { readSource } from './helpers/guard-scope';

// Pins the Auto-Title reminder's bundled-hook parity: desktop and Android ship
// near-identical copies of hook-scripts/title-update.sh, and the message the
// two build must be byte-identical or the model is told "always write" by one
// platform and "do nothing" by the other.
//
// Plan B (2026-09-16): this file's other 7 cases (each a literal-substring pin
// on the bash script's wording, timers and file-ordering, plus the CLAUDE.md
// prose copy) were deleted — bash is not one of this workspace's ast-grep
// languages, so there is no structural replacement, and Destin's own call
// (deck answer Q-4, 2026-09-16) was to convert-or-delete rather than leave a
// literal-text pin that breaks on whitespace or a Windows line ending. This
// one case survives because it is the ONE regression a rule-less deletion
// cannot recover from silently: the two scripts drifting apart. See
// docs/active/plans/2026-09-16-sweep-ledger.md for the deleted titles.

const desktopCopy = path.resolve(__dirname, '..', 'hook-scripts', 'title-update.sh');
const androidCopy = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'title-update.sh');

/** The message-building block both copies must share verbatim. The rest of the two
 *  scripts legitimately differs: the header comment, and how each parses session_id
 *  (desktop has node available, Android does not and uses sed). */
function messageBlock(script: string): string {
  const start = script.indexOf('if [ -z "$CURRENT_TOPIC" ]');
  const end = script.indexOf('ESCAPED=');
  expect(start, 'branch not found — did someone collapse it back to one message?').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

describe('Auto-Title reminder contract', () => {
  const desktop = readSource(desktopCopy);
  const android = readSource(androidCopy);

  it('desktop and Android build the identical message (bundled-hook parity)', () => {
    expect(messageBlock(desktop)).toBe(messageBlock(android));
  });
});
