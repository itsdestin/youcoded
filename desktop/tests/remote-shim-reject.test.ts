// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REJECT_ON_NOT_OK, responseOutcome, applyResponse } from '../src/renderer/remote-shim';
import { REMOTE_UNSUPPORTED_EVENT } from '../src/renderer/remote-unsupported';

// WHY this file exists: remote-server.ts answers `{ ok:false, error }` when a
// handler throws, and the shim RESOLVES that for any channel not on this list —
// handing the caller a failure object dressed as a success. Deleting an entry
// silently restores a screen that lies to the user, and until this test existed
// the whole suite stayed green while it did.
// WHY .replace(): git checks these sources out with CRLF on Windows, and the
// scans below look for LF-anchored shapes — `indexOf('\n}\n')` returns -1, so
// `slice(0, -1)` silently widens "inside applyResponse" to the whole file and
// the settle-site count reads 5 instead of 3. Normalise at the read, the way
// every other source-scanning test in this suite does.
const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');
const shim = read('../src/renderer/remote-shim.ts');
const server = read('../src/main/remote-server.ts');

/** Every channel remote-server can answer `{ ok:false, error }` to: a `case`
 *  whose body reaches the `{ ok: false, error: … }` responder before the next
 *  case begins. Derived, not hand-listed, so it tracks the server. */
function channelsThatCanAnswerNotOk(): Set<string> {
  const out = new Set<string>();
  const caseRe = /^\s*case '([^']+)': \{$/gm;
  const starts: Array<[string, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(server)) !== null) starts.push([m[1], m.index]);
  for (let i = 0; i < starts.length; i++) {
    const body = server.slice(starts[i][1], starts[i + 1]?.[1] ?? server.length);
    if (body.includes('{ ok: false, error:')) out.add(starts[i][0]);
  }
  return out;
}

describe('the shim rejects a failure instead of resolving it', () => {
  // Sanity: if the scan below silently found nothing, the subset check would
  // pass vacuously and prove nothing at all.
  it('the remote-server scan actually resolves known channels', () => {
    const canFail = channelsThatCanAnswerNotOk();
    expect(canFail.has('models:set-settings')).toBe(true);
    expect(canFail.has('engine:set-config')).toBe(true);
    // A channel that responds with no try/catch is genuinely not in the set.
    expect(canFail.has('engine:status')).toBe(false);
  });

  // The membership itself. Pinned exactly: this is the assertion that goes red
  // when someone tidies an entry away, which is the failure mode this guards.
  it('lists every channel of this feature whose success shape is a plain object', () => {
    expect([...REJECT_ON_NOT_OK].sort()).toEqual([
      'engine:prereqs',
      'engine:run-in-terminal',
      'engine:set-config',
      'models:add-vision',
      'models:set-settings',
      'models:settings',
      'native:get-step-guard',
      'native:set-step-guard',
    ]);
  });

  // A channel here that the server can never answer `{ ok:false }` to would be
  // dead weight pretending to protect something.
  it('every listed channel is one remote-server can actually fail', () => {
    const canFail = channelsThatCanAnswerNotOk();
    expect([...REJECT_ON_NOT_OK].filter((ch) => !canFail.has(ch))).toEqual([]);
  });

  // The BEHAVIOUR, not just the list. Membership alone left the real hole open:
  // making the dispatcher stop consulting the set at all kept every test green.
  it('turns a listed channel\u2019s failure into a rejection, and leaves others alone', () => {
    // A refused save must reach the dialog's error line…
    expect(responseOutcome('models:set-settings', { ok: false, error: 'nope' })).toBe('failure');
    expect(responseOutcome('engine:set-config', { ok: false, error: 'nope' })).toBe('failure');
    // …while a channel that MEANS { ok:false } as data keeps its answer. This is
    // why the list exists rather than a blanket rule.
    expect(responseOutcome('sync:force', { ok: false, error: 'nope' })).toBe('value');
    // A real answer is never mistaken for a failure.
    expect(responseOutcome('models:settings', { contextLength: 8_192, keepLoaded: true })).toBe('value');
    // And "the host does not implement this" stays its own case, so the user
    // gets the plain-language notice rather than a raw error string.
    expect(responseOutcome('models:settings', { ok: false, unsupported: true })).toBe('unsupported');
  });

  // The BEHAVIOUR of settling a caller, not a source string. A text pin caught
  // "stopped calling it" and missed "calls it and ignores the answer" — and
  // ignoring the answer IS the original bug.
  it('a listed channel\u2019s failure REJECTS the caller, with the host\u2019s reason', () => {
    const resolve = vi.fn(); const reject = vi.fn();
    applyResponse({ resolve, reject }, 'models:set-settings', { ok: false, error: 'Context length must be at least 1024 tokens.' });
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0][0].message).toBe('Context length must be at least 1024 tokens.');
  });

  it('an ordinary answer still reaches the caller as a value', () => {
    const resolve = vi.fn(); const reject = vi.fn();
    const settings = { contextLength: 8_192, keepLoaded: true };
    applyResponse({ resolve, reject }, 'models:settings', settings);
    expect(reject).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith(settings);
  });

  it('an unlisted channel\u2019s { ok:false } is still DATA, not an error', () => {
    const resolve = vi.fn(); const reject = vi.fn();
    applyResponse({ resolve, reject }, 'sync:force', { ok: false, error: 'nope' });
    expect(reject).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith({ ok: false, error: 'nope' });
  });

  it('“the host does not implement this” rejects AND announces it in plain words', () => {
    // Both halves in one test on purpose: the announcement is deduped per
    // feature for the life of the module, so only the FIRST call for a feature
    // can observe it.
    const seen: any[] = [];
    const onNotice = (e: any) => seen.push(e.detail);
    window.addEventListener(REMOTE_UNSUPPORTED_EVENT, onNotice);
    try {
      const resolve = vi.fn(); const reject = vi.fn();
      applyResponse({ resolve, reject }, 'models:settings', { ok: false, unsupported: true });
      expect(resolve).not.toHaveBeenCalled();
      expect(reject.mock.calls[0][0].message).toBe('remote-unsupported: models:settings');
      // The notice is the whole reason this is a separate case from 'failure':
      // on a phone the caller's rejection is invisible, and this sentence is
      // what the user actually reads. It must name the FEATURE, never the
      // channel id.
      expect(seen).toHaveLength(1);
      expect(seen[0].message).toBe("The local model manager isn't available via remote access yet.");
    } finally {
      window.removeEventListener(REMOTE_UNSUPPORTED_EVENT, onNotice);
    }
  });

  // …and the dispatcher must not settle a caller behind applyResponse's back.
  // A `entry.resolve(payload); return;` placed before the call would leave every
  // assertion above green while the bug ran in production.
  it('applyResponse is the ONLY place a response settles a caller', () => {
    const body = shim.slice(shim.indexOf('export function applyResponse'));
    const inApplyResponse = body.slice(0, body.indexOf('\n}\n'));
    const settlesEverywhere = [...shim.matchAll(/entry\.(resolve|reject)\(/g)].length;
    const settlesInApplyResponse = [...inApplyResponse.matchAll(/entry\.(resolve|reject)\(/g)].length;
    // The two outside it are the connection-drop path ('Server switched'), which
    // settles nothing about a response.
    const outside = shim.split('\n').filter((l) => /entry\.(resolve|reject)\(/.test(l) && !inApplyResponse.includes(l));
    expect(settlesInApplyResponse).toBe(3);
    expect(settlesEverywhere - settlesInApplyResponse).toBe(2);
    expect(outside.every((l) => l.includes('Server switched'))).toBe(true);
  });

  // And each is a REQUEST the shim makes — a push channel has no caller to
  // reject, so an entry for one would never fire.
  it('every listed channel is invoked by the shim', () => {
    expect([...REJECT_ON_NOT_OK].filter((ch) => !shim.includes(`invoke('${ch}'`))).toEqual([]);
  });
});
