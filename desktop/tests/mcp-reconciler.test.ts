import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readClaudeJsonFrom } from '../src/main/mcp-reconciler';

// Regression tests for Finding 2: readClaudeJson() used to return `{}` on ANY
// throw — corrupt JSON, EACCES, a partial read racing an external writer —
// indistinguishable from "the file doesn't exist yet". reconcileMcp() then
// treated that `{}` as the real config and wrote `projected` back out,
// atomically REPLACING ~/.claude.json (59 top-level keys on Destin's real
// file: project history, onboarding state) with a bare
// {mcpServers, _youcodedOwnedMcpServers} skeleton whenever the registry was
// non-empty. Fix: readClaudeJsonFrom distinguishes "absent" (fine, `{}`) from
// "present but unreadable" (`null`, caller must abort rather than write).
//
// Uses fs.mkdtempSync — an isolated temp path, never the real home directory
// (never `os.homedir()`/`~/.claude.json`, not even the suite-wide sandboxed
// TEST_HOME) — so this test can never touch a real ~/.claude.json under any
// circumstance, matching the "pure/injectable path" the fix pass calls for.
describe('readClaudeJsonFrom', () => {
  let tmpDir: string;

  function withTmpDir<T>(fn: (dir: string) => T): T {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-mcp-reconciler-test-'));
    try {
      return fn(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it('reads an absent file as {} — not an error', () => {
    withTmpDir((dir) => {
      const filePath = path.join(dir, 'does-not-exist.json');
      expect(readClaudeJsonFrom(filePath)).toEqual({});
    });
  });

  it('reads a present, valid file normally', () => {
    withTmpDir((dir) => {
      const filePath = path.join(dir, 'claude.json');
      fs.writeFileSync(filePath, JSON.stringify({ someKey: 'value', mcpServers: {} }));
      expect(readClaudeJsonFrom(filePath)).toEqual({ someKey: 'value', mcpServers: {} });
    });
  });

  // THE regression pin: a file that EXISTS but cannot be parsed (corrupt JSON
  // from a partial write, or any other read failure) must be reported as
  // null — categorically different from "absent" — so the caller can abort
  // instead of silently treating it as an empty config and overwriting it.
  it('reports present-but-unreadable as null, never as {}', () => {
    withTmpDir((dir) => {
      const filePath = path.join(dir, 'claude.json');
      fs.writeFileSync(filePath, '{ this is not valid json, mid-write ');
      expect(readClaudeJsonFrom(filePath)).toBeNull();
    });
  });

  it('does not confuse a valid-but-empty file with an unreadable one', () => {
    withTmpDir((dir) => {
      const filePath = path.join(dir, 'claude.json');
      fs.writeFileSync(filePath, '{}');
      expect(readClaudeJsonFrom(filePath)).toEqual({});
    });
  });
});
