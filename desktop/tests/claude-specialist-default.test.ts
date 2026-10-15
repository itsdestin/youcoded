import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (...parts: string[]) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

describe('Claude Code specialist safety parity', () => {
  it('defaults implicit subagents to Sonnet (the phone runs this same worker)', () => {
    expect(read('src', 'main', 'pty-worker.js')).toContain(
      "CLAUDE_CODE_SUBAGENT_MODEL: childEnv.CLAUDE_CODE_SUBAGENT_MODEL || 'sonnet'",
    );
  });
});
