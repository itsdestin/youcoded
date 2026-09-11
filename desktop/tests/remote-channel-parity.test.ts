import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shim = read('../src/renderer/remote-shim.ts');
const server = read('../src/main/remote-server.ts');

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
