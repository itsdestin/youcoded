import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (...parts: string[]) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

describe('Claude Code specialist safety parity', () => {
  it('defaults implicit subagents to Sonnet on desktop and Android', () => {
    expect(read('src', 'main', 'pty-worker.js')).toContain(
      "CLAUDE_CODE_SUBAGENT_MODEL: childEnv.CLAUDE_CODE_SUBAGENT_MODEL || 'sonnet'",
    );
    expect(read('..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'PtyBridge.kt')).toContain(
      "env.putIfAbsent(\"CLAUDE_CODE_SUBAGENT_MODEL\", \"sonnet\")",
    );
  });
});
