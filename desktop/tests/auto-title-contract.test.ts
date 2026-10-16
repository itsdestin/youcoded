import { describe, it, expect } from 'vitest';
import path from 'path';
import { readSource } from './helpers/guard-scope';

// Pins the Auto-Title reminder's message block in hook-scripts/title-update.sh.
// Android clean rebuild (2026-10-14): the phone runs the desktop backend and installs these same
// hook scripts, so there is no second copy to keep identical; only the branch structure is pinned.

const desktopCopy = path.resolve(__dirname, '..', 'hook-scripts', 'title-update.sh');

/** The message-building block of the script. */
function messageBlock(script: string): string {
  const start = script.indexOf('if [ -z "$CURRENT_TOPIC" ]');
  const end = script.indexOf('ESCAPED=');
  expect(start, 'branch not found — did someone collapse it back to one message?').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

describe('Auto-Title reminder contract', () => {
  const desktop = readSource(desktopCopy);

  it('builds a different message for a topic-less session than for a titled one', () => {
    const block = messageBlock(desktop);
    expect(block).toContain('else');
    expect(block).toContain('CURRENT_TOPIC');
  });
});
