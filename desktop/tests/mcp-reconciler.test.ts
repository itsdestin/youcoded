import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readClaudeJsonFrom, projectToClaudeJson, applyManifestEntries, platformMatches, expandTokens, type McpManifestEntry } from '../src/main/mcp-reconciler';

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

// OWNER DECISION (2026-07-30, overrides the task brief's per-entry marker):
// ownership lives in a TOP-LEVEL `_youcodedOwnedMcpServers: string[]` key, not
// a per-entry `_youcoded: true` flag. Claude Code demonstrably tolerates
// arbitrary top-level keys (Destin's real ~/.claude.json carries 59) but
// whether it tolerates an unknown key INSIDE an mcpServers entry is
// unverified — writing one there could silently break MCP loading in his live
// sessions if its per-entry schema turns out to be strict. Server entries stay
// schema-clean; every test below asserts against the top-level list instead.
//
// projectToClaudeJson returns `{ claudeJson, skippedCollisions }` so the
// collision guard has somewhere to report skipped ids without polluting the
// projected file's own schema.

describe('projection into ~/.claude.json', () => {
  it('writes an enabled registry server into mcpServers', () => {
    const out = projectToClaudeJson({}, [
      { id: 'gmail', label: 'Gmail', enabled: true, transport: { type: 'stdio', command: 'npx', args: ['gmail-mcp'] }, origin: { kind: 'user' }, missingSecrets: [] } as any,
    ]);
    expect(out.claudeJson.mcpServers!.gmail).toMatchObject({ type: 'stdio', command: 'npx' });
    expect(out.claudeJson._youcodedOwnedMcpServers).toEqual(['gmail']);
    expect(out.skippedCollisions).toEqual([]);
  });

  it('NEVER modifies an entry it does not own', () => {
    const existing = { mcpServers: { handwritten: { type: 'stdio', command: 'my-thing' } } };
    const out = projectToClaudeJson(existing, []);
    expect(out.claudeJson.mcpServers!.handwritten).toEqual({ type: 'stdio', command: 'my-thing' });
  });

  it('removes an owned entry that left the registry', () => {
    const existing = {
      mcpServers: { gone: { type: 'stdio', command: 'x' } },
      _youcodedOwnedMcpServers: ['gone'],
    };
    const out = projectToClaudeJson(existing, []);
    expect(out.claudeJson.mcpServers!.gone).toBeUndefined();
  });

  it('does not project a server with missing secrets', () => {
    const out = projectToClaudeJson({}, [
      { id: 'gmail', label: 'Gmail', enabled: true, transport: { type: 'stdio', command: 'npx' }, origin: { kind: 'user' }, missingSecrets: ['GMAIL_TOKEN'] } as any,
    ]);
    expect(out.claudeJson.mcpServers!.gmail).toBeUndefined();
    expect(out.claudeJson._youcodedOwnedMcpServers ?? []).not.toContain('gmail');
  });

  // Defensive contract test for a guard this task adds beyond the brief's
  // four cases: resolveAllEnabled() already filters disabled servers before
  // calling projectToClaudeJson, but the pure function's OWN contract must
  // not depend on that — a disabled entry must never be projected even if a
  // future caller passes an unfiltered list by mistake.
  it('does not project a disabled registry server', () => {
    const out = projectToClaudeJson({}, [
      { id: 'gmail', label: 'Gmail', enabled: false, transport: { type: 'stdio', command: 'npx' }, origin: { kind: 'user' }, missingSecrets: [] } as any,
    ]);
    expect(out.claudeJson.mcpServers!.gmail).toBeUndefined();
    expect(out.claudeJson._youcodedOwnedMcpServers ?? []).not.toContain('gmail');
  });

  // Fifth case (owner-added): the owned-id list is itself just a top-level
  // key, so a user hand-editing the file around it must not break projection
  // — unrelated keys survive, and a stale ownership record naming a server
  // the user already deleted by hand must not crash or resurrect it.
  it('survives a user hand-editing the file around the owned-id list', () => {
    const existing = {
      mcpServers: {}, // user deleted the 'gmail' entry by hand
      _youcodedOwnedMcpServers: ['gmail'], // stale record left behind
      someUserSetting: 'kept',
      numStartups: 42,
    };
    // 'gmail' isn't in this run's registry either (disabled, removed, or
    // simply never resolved) — nothing should try to recreate it.
    const out = projectToClaudeJson(existing, []);
    expect(out.claudeJson.mcpServers).toEqual({});
    expect(out.claudeJson.mcpServers!.gmail).toBeUndefined();
    expect(out.claudeJson.someUserSetting).toBe('kept');
    expect(out.claudeJson.numStartups).toBe(42);
  });

  // CRITICAL REGRESSION CATCH (fix pass, 2026-07-31, Finding 1): before this
  // fix, `mcpServers[server.id] = buildRegistryServerConfig(server)` ran with
  // no check for a pre-existing, unowned entry at that id. A real user runs
  // `claude mcp add gmail ...` by hand; `sanitizeServerId()` applies no
  // namespace prefix, so a YouCoded registry entry labeled "Gmail" produces
  // the exact same id. Enabling that registry entry would have silently
  // clobbered the user's hand-configured server with no warning. This test
  // MUST fail on the pre-fix code (it would have asserted the registry's
  // config, not the user's original one).
  it('does NOT overwrite a hand-written entry sharing a registry server id (CRITICAL)', () => {
    const handwritten = { type: 'stdio', command: 'my-hand-configured-gmail', args: ['--special-flag'] };
    const existing = {
      mcpServers: { gmail: { ...handwritten } },
      // No _youcodedOwnedMcpServers at all — YouCoded has never owned 'gmail'.
    };
    const out = projectToClaudeJson(existing, [
      { id: 'gmail', label: 'Gmail', enabled: true, transport: { type: 'stdio', command: 'npx', args: ['gmail-mcp'] }, origin: { kind: 'user' }, missingSecrets: [] } as any,
    ]);
    // Byte-for-byte survival of the user's original entry.
    expect(out.claudeJson.mcpServers!.gmail).toEqual(handwritten);
    // The collision must be reported, not silently dropped.
    expect(out.skippedCollisions).toEqual(['gmail']);
    // Skipped ids are never claimed as owned.
    expect(out.claudeJson._youcodedOwnedMcpServers ?? []).not.toContain('gmail');
  });

  // Companion to the CRITICAL test above: the collision guard must not be so
  // broad that it also blocks legitimate updates to a server YouCoded already
  // owns — otherwise editing/re-enabling an owned server in YouCoded would
  // silently stop working the moment this fix landed.
  it('still updates an entry YouCoded already owns (id in previouslyOwned)', () => {
    const existing = {
      mcpServers: { gmail: { type: 'stdio', command: 'old-npx-path' } },
      _youcodedOwnedMcpServers: ['gmail'],
    };
    const out = projectToClaudeJson(existing, [
      { id: 'gmail', label: 'Gmail', enabled: true, transport: { type: 'stdio', command: 'npx', args: ['gmail-mcp'] }, origin: { kind: 'user' }, missingSecrets: [] } as any,
    ]);
    expect(out.claudeJson.mcpServers!.gmail).toMatchObject({ type: 'stdio', command: 'npx' });
    expect(out.claudeJson._youcodedOwnedMcpServers).toEqual(['gmail']);
    expect(out.skippedCollisions).toEqual([]);
  });

  // Finding 2: the same collision can happen against a manifest-scanned entry
  // (reconcileMcp's plugin-manifest loop writes into the SAME mcpServers
  // object before calling projectToClaudeJson). The guard is keyed on
  // "already exists AND not previously owned", not specifically on "written
  // by a human", so it must catch this shape too without any special-casing.
  it('does not overwrite a manifest-scanned entry sharing a registry server id', () => {
    const manifestWritten = { type: 'stdio', command: 'plugin-bundled-gmail' };
    const existing = {
      mcpServers: { gmail: { ...manifestWritten } },
    };
    const out = projectToClaudeJson(existing, [
      { id: 'gmail', label: 'Gmail', enabled: true, transport: { type: 'stdio', command: 'npx' }, origin: { kind: 'user' }, missingSecrets: [] } as any,
    ]);
    expect(out.claudeJson.mcpServers!.gmail).toEqual(manifestWritten);
    expect(out.skippedCollisions).toEqual(['gmail']);
  });

  // Finding 3 / Test 3: a hand-edited or corrupted ~/.claude.json could carry
  // a non-object `mcpServers` (e.g. a string) after a bad manual edit.
  // `{ ...'somestring' }` does NOT throw in JS — it silently produces
  // numeric-indexed keys ('0', '1', ...) that would then get written back
  // into the real config as garbage. This pins the guard that treats a
  // non-object the same as absent.
  it('treats a non-object mcpServers the same as absent', () => {
    const existing = { mcpServers: 'not-an-object' as unknown as Record<string, unknown> };
    const out = projectToClaudeJson(existing, [
      { id: 'gmail', label: 'Gmail', enabled: true, transport: { type: 'stdio', command: 'npx' }, origin: { kind: 'user' }, missingSecrets: [] } as any,
    ]);
    // No numeric-indexed garbage keys ('0', '1', ...) from spreading a string.
    expect(Object.keys(out.claudeJson.mcpServers!)).toEqual(['gmail']);
    expect(out.claudeJson.mcpServers!.gmail).toMatchObject({ type: 'stdio', command: 'npx' });
  });

  // Finding 3 / Test 4: same tolerance for a wrong-shaped
  // `_youcodedOwnedMcpServers` (e.g. a hand-edited string instead of an
  // array) — must behave exactly like an absent/empty owned-id list rather
  // than crashing on `.includes()`/iteration or treating the string as owned.
  it('treats a non-array _youcodedOwnedMcpServers the same as absent', () => {
    const existing = {
      mcpServers: { gmail: { type: 'stdio', command: 'my-thing' } },
      _youcodedOwnedMcpServers: 'gmail' as unknown as string[],
    };
    const out = projectToClaudeJson(existing, [
      { id: 'gmail', label: 'Gmail', enabled: true, transport: { type: 'stdio', command: 'npx' }, origin: { kind: 'user' }, missingSecrets: [] } as any,
    ]);
    // Treated as "not previously owned" -> 'gmail' collides and is skipped,
    // exactly as it would be with _youcodedOwnedMcpServers entirely absent.
    expect(out.claudeJson.mcpServers!.gmail).toEqual({ type: 'stdio', command: 'my-thing' });
    expect(out.skippedCollisions).toEqual(['gmail']);
  });
});

// Roadmap (marketplace, 2026-09-01): two published plugins' manifests —
// copied verbatim below — used `${PACKAGE_DIR}` (never expanded, so the server
// command was written literally wrong) and a `platforms` LIST of Node names
// (never read, so the platform filter did nothing). Pure function, no real
// ~/.claude.json anywhere.
describe('plugin manifest scan (applyManifestEntries)', () => {
  const spotify: McpManifestEntry = {
    name: 'spotify-services', auto: true, platforms: ['darwin', 'win32'],
    command: 'bash', args: ['${PACKAGE_DIR}/mcp-servers/spotify-services/launcher.sh'], env: {},
  };
  const gmessages: McpManifestEntry = {
    name: 'gmessages', auto: true, platforms: ['darwin', 'linux', 'win32'],
    command: '${PACKAGE_DIR}/mcp-servers/gmessages/gmessages', args: [], env: {},
  };
  const root = '/home/u/.claude/plugins/marketplaces/youcoded/plugins/p';

  it('expands ${PACKAGE_DIR} to the plugin directory, like {{plugin_root}}', () => {
    const servers: Record<string, unknown> = {};
    const r = applyManifestEntries(servers, [{ entries: [gmessages], pluginRoot: root }], { platform: 'linux', isWindows: false });
    expect(r.added).toBe(1);
    expect(servers.gmessages).toEqual({ type: 'stdio', command: `${root}/mcp-servers/gmessages/gmessages`, args: [], env: {} });
    expect(expandTokens('{{plugin_root}}/a ${PACKAGE_DIR}/b', '/r')).toBe('/r/a /r/b');
  });

  it('never reads a $ in the real path as a replacement pattern', () => {
    expect(expandTokens('${PACKAGE_DIR}/x', '/tmp/$&odd')).toBe('/tmp/$&odd/x');
  });

  it('honours a platforms list written in Node names', () => {
    const servers: Record<string, unknown> = {};
    const onLinux = applyManifestEntries(servers, [{ entries: [spotify], pluginRoot: root }], { platform: 'linux', isWindows: false });
    expect(onLinux).toMatchObject({ added: 0, skippedPlatform: 1 });
    expect(servers['spotify-services']).toBeUndefined();

    const onMac = applyManifestEntries(servers, [{ entries: [spotify], pluginRoot: root }], { platform: 'macos', isWindows: false });
    expect(onMac.added).toBe(1);
    expect((servers['spotify-services'] as { args: string[] }).args).toEqual([`${root}/mcp-servers/spotify-services/launcher.sh`]);
  });

  it('keeps the single platform field working, in either vocabulary', () => {
    expect(platformMatches({ platform: 'linux' }, 'linux')).toBe(true);
    expect(platformMatches({ platform: 'macos' }, 'linux')).toBe(false);
    expect(platformMatches({}, 'windows')).toBe(true);
    expect(platformMatches({ platforms: ['all'] }, 'windows')).toBe(true);
    // An empty list falls back to the single field rather than hiding the server.
    expect(platformMatches({ platforms: [], platform: 'windows' } as McpManifestEntry, 'windows')).toBe(true);
  });

  it('repairs an untouched entry an older build wrote with the literal placeholder', () => {
    const servers: Record<string, unknown> = {
      gmessages: { type: 'stdio', command: '${PACKAGE_DIR}/mcp-servers/gmessages/gmessages', args: [], env: {} },
    };
    const r = applyManifestEntries(servers, [{ entries: [gmessages], pluginRoot: root }], { platform: 'linux', isWindows: false });
    expect(r).toMatchObject({ added: 0, repaired: 1, changed: true });
    expect((servers.gmessages as { command: string }).command).toBe(`${root}/mcp-servers/gmessages/gmessages`);
  });

  it('still never overwrites an entry the user changed, even one holding the placeholder', () => {
    const custom = { type: 'stdio', command: '${PACKAGE_DIR}/mcp-servers/gmessages/gmessages', args: ['--verbose'], env: {} };
    const servers: Record<string, unknown> = { gmessages: { ...custom } };
    const r = applyManifestEntries(servers, [{ entries: [gmessages], pluginRoot: root }], { platform: 'linux', isWindows: false });
    expect(r).toMatchObject({ added: 0, repaired: 0, changed: false });
    expect(servers.gmessages).toEqual(custom);
  });
});
