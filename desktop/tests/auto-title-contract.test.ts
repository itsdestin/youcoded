import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Pins the Auto-Title reminder's two-branch contract.
//
// WHY (measured 2026-08-28 across the 46 Claude Code sessions started 08-26 → 08-28):
// the reminder deliberately re-fires every 10 minutes so a long session gets re-titled
// as it drifts, and 55 of those re-titles genuinely tracked a drift. But 181 of the 236
// re-writes wrote the SAME string back to the same file — one wasted Bash round trip
// each — because the reminder never told the model what the title already was. The fix
// is the `else` branch below: state the current title and say plainly that doing nothing
// is an acceptable answer.
//
// Two ways this regresses, both pinned here:
//   1. Someone "simplifies" back to a single unconditional "write a title NOW" message.
//   2. The desktop and Android copies drift (they are near-identical by design).
// The prose deployed into ~/.claude/CLAUDE.md must agree with the hook, or the model
// gets told "always write" by one and "do nothing" by the other — so that is pinned too.

const desktopCopy = path.resolve(__dirname, '..', 'hook-scripts', 'title-update.sh');
const androidCopy = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'title-update.sh');
const installHooks = path.resolve(__dirname, '..', 'scripts', 'install-hooks.js');
const bootstrapKt = path.resolve(
  __dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'Bootstrap.kt',
);

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
  const desktop = fs.readFileSync(desktopCopy, 'utf8');
  const android = fs.readFileSync(androidCopy, 'utf8');

  it('desktop and Android build the identical message (bundled-hook parity)', () => {
    expect(messageBlock(desktop)).toBe(messageBlock(android));
  });

  it('an untitled session is still told to write a title', () => {
    for (const script of [desktop, android]) {
      expect(script).toMatch(/no title yet/);
      expect(script).toMatch(/Do NOT skip this/);
    }
  });

  it('a titled session is shown its title and told doing nothing is allowed', () => {
    for (const script of [desktop, android]) {
      // The title itself must be interpolated — a reminder that does not say what the
      // title IS cannot let the model decide to skip, which is the whole point.
      expect(script).toMatch(/titled \\"\$CURRENT_TOPIC\\"/);
      expect(script).toMatch(/do nothing at all/);
      expect(script).toMatch(/no tool call/);
    }
  });

  it('the reminder still fires on a real interval where nothing schedules it', () => {
    // The timer is the fallback for a runtime that does not write a mode file
    // (Android today). Deleting it would stop naming conversations there.
    for (const script of [desktop, android]) {
      expect(script).toMatch(/INTERVAL=120/);
      expect(script).toMatch(/INTERVAL=600/);
      expect(script).toMatch(/ELAPSED" -lt "\$INTERVAL/);
    }
  });

  it('Off and Basic stop the request, rather than discarding a title already paid for', () => {
    for (const script of [desktop, android]) {
      expect(script).toMatch(/naming-mode/);
      // The gate must EXIT, not fall through and emit anyway.
      expect(script).toMatch(/\[ "\$MODE" = "ai" \] \|\| exit 0/);
    }
  });

  it('AI naming asks only when the app scheduled a review, and asks once', () => {
    for (const script of [desktop, android]) {
      expect(script).toMatch(/ASK_FILE="\$TOPIC_DIR\/ask-\$SESSION_ID"/);
      expect(script).toMatch(/\[ -f "\$ASK_FILE" \] \|\| exit 0/);
      // Consumed BEFORE the reminder is emitted: two tool calls inside one
      // reply must not produce two title requests.
      const consume = script.indexOf('rm -f "$ASK_FILE"');
      const emit = script.indexOf('hookSpecificOutput');
      expect(consume).toBeGreaterThan(-1);
      expect(consume).toBeLessThan(emit);
    }
  });

  it('the ask files are pruned like the topic and marker files', () => {
    for (const script of [desktop, android]) {
      expect(script).toMatch(/-name "ask-\*" -mtime \+30 -delete/);
    }
  });

  it('the CLAUDE.md prose deployed by both platforms agrees with the hook', () => {
    for (const file of [installHooks, bootstrapKt]) {
      const src = fs.readFileSync(file, 'utf8');
      expect(src).toMatch(/do nothing at all/);
      // The old unconditional wording actively contradicted the new else-branch.
      expect(src).not.toMatch(/\*\*immediately\*\* use Bash to write/);
    }
  });
});
