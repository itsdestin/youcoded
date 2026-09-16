import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readStripped, assertPatternMatches } from './helpers/guard-scope';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shim = read('../src/renderer/remote-shim.ts');
const server = read('../src/main/remote-server.ts');
// Comment-blanked copies for the guards below: the WHY comments beside a case
// quote channel names, and a guard reading raw text would count the explanation
// of a missing case as the case.
const shimCode = readStripped(fileURLToPath(new URL('../src/renderer/remote-shim.ts', import.meta.url))).replace(/\r\n/g, '\n');
const serverCode = readStripped(fileURLToPath(new URL('../src/main/remote-server.ts', import.meta.url))).replace(/\r\n/g, '\n');

/** Every `remote:*` channel the shim asks the host for an answer on. */
function invokedRemoteChannels(): string[] {
  return [...new Set([...shim.matchAll(/invoke\('(remote:[^']+)'/g)].map(m => m[1]))].sort();
}

/** Every `remote:*` channel the WS host has a case for. */
function hostedRemoteChannels(): string[] {
  return [...new Set([...server.matchAll(/case '(remote:[^']+)':/g)].map(m => m[1]))].sort();
}

/**
 * A channel has five surfaces (`.claude/rules/ipc-bridge.md`), and `remote-server.ts` — the
 * host a remote BROWSER talks to — is the one that gets forgotten, because every other
 * surface is exercised by simply running the desktop app.
 *
 * This is the guard that was missing. `remote:status` shipped to preload, the shim, the
 * desktop IPC handlers and Android, and not to the host; the panel requests it in the same
 * `Promise.all` as the config, the Tailscale info and the device list, so one missing case
 * opened the whole Remote Access screen blank on a phone. Every test that could have caught
 * it was a `toContain` over source text for the channels somebody remembered to list.
 */
describe('every remote channel the shim invokes is answered by the host', () => {
  it('leaves none of them to the unsupported default', () => {
    const missing = invokedRemoteChannels().filter(c => !hostedRemoteChannels().includes(c));
    expect(missing).toEqual([]);
  });

  it('finds real channels on both sides, so an empty diff cannot pass vacuously', () => {
    // Without this, deleting `invoke(` from the shim would make the test above pass.
    expect(invokedRemoteChannels()).toContain('remote:status');
    expect(invokedRemoteChannels()).toContain('remote:devices:unpair');
    expect(hostedRemoteChannels().length).toBeGreaterThanOrEqual(invokedRemoteChannels().length);
  });

  it('rejects, rather than resolving, on every channel the host refuses', () => {
    // The host answers `{ok:false}` to host administration. The shim turns that into a
    // rejection only for channels in REJECT_ON_NOT_OK; anywhere else it resolves as an
    // ordinary value and the caller reads a refusal as success — which is how Unpair
    // removed a row from the list for a device that kept full access.
    const refused = [...server.matchAll(/case '(remote:[^']+)': \{\s*\n\s*this\.respond\([^\n]*ok: false/g)]
      .map(m => m[1]).sort();
    expect(refused.length).toBeGreaterThan(0);
    const rejectList = /export const REJECT_ON_NOT_OK[^[]*\[([\s\S]*?)\n\]\);/.exec(shim)?.[1] ?? '';
    const unguarded = refused.filter(c => !rejectList.includes(`'${c}'`));
    expect(unguarded).toEqual([]);
  });
});

// ── Batch 3: the file channels (design 2026-09-10 §8, review R2-16) ──────────
//
// The same shape of guard, for the prefixes the phone's Files screens live on.
// Before batch 3 the shim invoked fourteen `artifacts:` / `project:` channels
// and the host had a case for ONE; every other request fell to the unsupported
// default and the phone's file lists were empty. This is the guard that would
// have said so.

const INVOKE = (prefix: string) => new RegExp(`invoke\\('(${prefix}[^']+)'`, 'g');
const CASE = (prefix: string) => new RegExp(`case '(${prefix}[^']+)':`, 'g');
const unique = (src: string, re: RegExp) => [...new Set([...src.matchAll(re)].map(m => m[1]))].sort();

/**
 * The file channels the host deliberately does NOT answer: every one is a
 * WRITE, and editing over remote is not in batch 3 ("Not in this batch"). A
 * phone that asks gets the honest `unsupported` refusal and the toast that
 * names the feature. Bridge one and delete its row here — the honesty checks
 * below fail on a stale exemption.
 */
const FILE_WRITES_NOT_OVER_REMOTE = [
  'artifacts:save',
  'artifacts:append-version',
  'artifacts:import-file',
  'artifacts:include-external',
  'artifacts:exclude',
  'artifacts:delete-project',
  'artifacts:rename',
  'artifacts:remove-record',
  'project:conversation-history',
  'project:write-context-file',
];

describe('every file channel a phone reads through is answered by the host', () => {
  it('the patterns can see real channels on both sides, so an empty diff is not vacuous', () => {
    assertPatternMatches(INVOKE('artifacts:'), "invoke('artifacts:get', { projectRoot, artifactId })", 'a shim invoke of an artifacts: channel');
    assertPatternMatches(CASE('project:'), "case 'project:list-context': {", 'a host case for a project: channel');
    expect(unique(shimCode, INVOKE('artifacts:'))).toContain('artifacts:get');
    expect(unique(serverCode, CASE('artifacts:'))).toContain('artifacts:get');
    expect(unique(shimCode, INVOKE('project:'))).toContain('project:list-context');
    expect(unique(serverCode, CASE('project:'))).toContain('project:list-context');
  });

  for (const prefix of ['artifacts:', 'project:']) {
    it(`leaves no ${prefix} read to the unsupported default`, () => {
      const invoked = unique(shimCode, INVOKE(prefix));
      const hosted = unique(serverCode, CASE(prefix));
      const missing = invoked.filter(c => !hosted.includes(c) && !FILE_WRITES_NOT_OVER_REMOTE.includes(c));
      expect(missing).toEqual([]);
    });
  }

  it('the exemption list is honest: each entry is still invoked by the shim and still unhandled by the host', () => {
    const invoked = [...unique(shimCode, INVOKE('artifacts:')), ...unique(shimCode, INVOKE('project:'))];
    const hosted = [...unique(serverCode, CASE('artifacts:')), ...unique(serverCode, CASE('project:'))];
    expect(FILE_WRITES_NOT_OVER_REMOTE.filter(c => !invoked.includes(c))).toEqual([]);
    // A write that gained a host case is bridged now; its row here would claim otherwise.
    expect(FILE_WRITES_NOT_OVER_REMOTE.filter(c => hosted.includes(c))).toEqual([]);
  });
});

// ── Batch 2's bare frames (design 2026-09-10 §1, §7; review R2-16) ────────────
//
// `client:ready` is sent by the shim with no id and no reply; `pty:reset:<sid>`
// is pushed by the host. Neither goes through invoke() or a response, so the
// prefix guards above cannot see them. Checked as a PAIR — if either side names
// the string, the other must — rather than as presence, because batch 2 is
// built on a sibling branch: presence would be red here until the merge, and a
// one-sided name after the merge is exactly the drift this file exists to catch.
describe('the bare frames batch 2 adds are named on both ends or neither', () => {
  for (const name of ['client:ready', 'pty:reset']) {
    it(`${name}`, () => {
      const inShim = shimCode.includes(`'${name}`);
      const inHost = serverCode.includes(`'${name}`);
      expect(inShim, `${name}: shim ${inShim ? 'names' : 'lacks'} it, host ${inHost ? 'names' : 'lacks'} it`).toBe(inHost);
    });
  }
});
