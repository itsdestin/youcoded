// Guard: the SendUserLink MCP server exists in TWO places — embedded in
// claude-code-mcp.ts (desktop writes it into userData at session start) and as
// an Android asset (PtyBridge writes it into .claude-mobile). They must stay
// byte-identical, and the three name literals must agree across TypeScript and
// Kotlin. Drift here is invisible until a phone silently loses the link tool.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LINK_SERVER_JS } from '../src/main/claude-code-mcp';
import { CLAUDE_CODE_LINK_TOOL, CLAUDE_CODE_MCP_SERVER_ID, SEND_USER_LINK_TOOL } from '../src/shared/send-user-link';
import { readSource } from './helpers/guard-scope';

const ANDROID_ASSET = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'send-user-link-mcp.js');
const ANDROID_KT = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'ClaudeCodeMcp.kt');

describe('SendUserLink MCP server parity', () => {
  it('the embedded desktop copy is byte-identical to the Android asset', () => {
    // WHY: byte-identical comparison — LINK_SERVER_JS is a TS string constant,
    // never a disk read, so it cannot be run through readSource; normalising
    // only the Android side would compare a stripped string against a raw one
    // and mask real drift. Left as a raw read on purpose (Task 2 clarification).
    expect(LINK_SERVER_JS).toBe(fs.readFileSync(ANDROID_ASSET, 'utf8'));
  });

  it('the server source stays String.raw-safe', () => {
    // A backtick would end the template early and a ${ would interpolate —
    // either one corrupts the embedded copy silently at build time.
    expect(LINK_SERVER_JS.includes('`')).toBe(false);
    expect(LINK_SERVER_JS.includes('${')).toBe(false);
  });

  it('the server advertises the tool under the name the renderer matches', () => {
    // The server declares a bare tool name; Claude Code prefixes it. Both
    // halves of the composed name have to be right or the tile never draws.
    expect(LINK_SERVER_JS).toContain(`var TOOL_NAME = '${SEND_USER_LINK_TOOL}';`);
    expect(CLAUDE_CODE_LINK_TOOL).toBe(`mcp__${CLAUDE_CODE_MCP_SERVER_ID}__${SEND_USER_LINK_TOOL}`);
    expect(LINK_SERVER_JS).toContain(`serverInfo: { name: '${CLAUDE_CODE_MCP_SERVER_ID}', version:`);
  });

  it('Kotlin declares the same server id and tool name', () => {
    const kt = readSource(ANDROID_KT);
    expect(kt).toContain(`const val SERVER_ID = "${CLAUDE_CODE_MCP_SERVER_ID}"`);
    expect(kt).toContain(`const val TOOL_NAME = "${CLAUDE_CODE_LINK_TOOL}"`);
    expect(kt).toContain('const val SERVER_FILE = "send-user-link-mcp.js"');
  });
});
