// @vitest-environment jsdom
// The remote shim (src/renderer/remote-shim.ts) — how it refuses: a host failure rejects rather
// than resolving, an unbridged channel is announced in plain words, the phone's own bridge
// refuses as "on the phone", and voice typing exists only on that bridge.
// WHY a separate file: these cases need jsdom (window events, location); remote-shim.test.ts runs in node.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  REJECT_ON_NOT_OK,
  responseOutcome,
  applyResponse,
  markConnectedForNotices,
} from '../src/renderer/remote-shim';
import { REMOTE_UNSUPPORTED_EVENT } from '../src/renderer/remote-unsupported';

// WHY each section starts with isolateGlobals(): every section below was its own file, so each
// began with a clean global object and a fresh module graph. The sections install fakes on
// globalThis (WebSocket, window, location, localStorage, document…) and not all of them remove
// every one; putting the globals back after each section, and dropping the loaded shim, keeps
// one section's fakes from leaking into the next.
const ISOLATED_GLOBALS = ['WebSocket', 'window', 'location', 'localStorage', 'document', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'claude'];
function isolateGlobals() {
  let saved: [string, PropertyDescriptor | undefined][] = [];
  beforeAll(() => { saved = ISOLATED_GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]); });
  afterAll(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as Record<string, unknown>)[k];
    }
    vi.resetModules();
  });
}

describe('remote-shim — rejecting failures', () => {
  isolateGlobals();

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
        'appearance:get-favorite-themes',
        // Install Claude Code (first-run local models, 2026-09-14): success is
        // { success, error? }, so a phone's { ok:false } refusal must reject, or the
        // Settings card would read it as an install that finished.
        'claude-code:install',
        'commands:list',
        'engine:prereqs',
        'engine:run-in-terminal',
        'engine:set-config',
        'models:add-vision',
        'models:set-settings',
        'models:settings',
        'native:get-context-preferences',
        'native:get-step-guard',
        'native:set-context-preferences',
        'native:set-step-guard',
        // Joined after a review found Unpair showing a false success on a phone: the host
        // refuses both, and without an entry the refusal resolved as an ordinary value.
        'remote:devices:rename',
        'remote:devices:unpair',
        // Host administration is refused over the remote socket. Without these the refusal
        // resolves as a value and the phone shows a success tick for a change that never
        // happened — the false success this whole file exists to prevent.
        'remote:set-config',
        'remote:set-password',
        // Reads a phone loads at start, answered by the host since 2026-09-11 (with the two at the
        // top of this list). Success is an ARRAY, which can never be { ok:false } either, so a
        // failure must reach the caller's catch; resolved, it would render as an empty list.
        'theme:list',
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
      // The notice is silent for the first seconds of a connection — that window is the
      // app's own mount fetches, and announcing them greeted a new phone with a list of
      // what does not work. This case is a person hitting the feature later, so it marks a
      // connection and steps past that window. Only the clock is faked.
      vi.useFakeTimers({ toFake: ['Date'] });
      markConnectedForNotices();
      vi.setSystemTime(Date.now() + 10_000);
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
        vi.useRealTimers();
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
      // The ones outside it are connection-drop paths, which settle nothing about a response:
      // switching servers ('Server switched', two) and a drop cutting off requests already sent
      // (failRequestsCutOffByDrop, added 2026-09-11, one).
      const outside = shim.split('\n').filter((l) => /entry\.(resolve|reject)\(/.test(l) && !inApplyResponse.includes(l));
      expect(settlesInApplyResponse).toBe(3);
      expect(settlesEverywhere - settlesInApplyResponse).toBe(3);
      expect(outside.every((l) => l.includes('Server switched') || l.includes('Lost the connection before the computer answered.'))).toBe(true);
    });

    // And each is a REQUEST the shim makes — a push channel has no caller to
    // reject, so an entry for one would never fire.
    it('every listed channel is invoked by the shim', () => {
      expect([...REJECT_ON_NOT_OK].filter((ch) => !shim.includes(`invoke('${ch}'`))).toEqual([]);
    });
  });
});

// The remote server answers unbridged channels with {ok:false, unsupported:true}
// instead of dropping them. The shim turns that into a plain-language
// announcement, because the call sites themselves mostly don't check the
// payload (ProjectView's .then() has no .catch(); account-context calls
// reloadFromStore() as `void`) and would otherwise render an empty panel.
describe('remote-shim — unsupported channels', () => {
  isolateGlobals();

  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = FakeWebSocket.CONNECTING;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) { FakeWebSocket.instances.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  }

  describe('remote-shim unsupported-channel reporting', () => {
    let shim: typeof import('../src/renderer/remote-shim');
    let events: any[];
    let ws: FakeWebSocket;
    let listener: (e: any) => void;
    let unsupportedEvent: string;

    beforeEach(async () => {
      vi.resetModules();
      FakeWebSocket.instances = [];
      events = [];
      // jsdom supplies window, location, localStorage, CustomEvent and a real
      // event target; only the socket needs replacing.
      (globalThis as any).WebSocket = FakeWebSocket;
      // This jsdom setup exposes no Storage, so stub it the way the sibling
      // remote-shim test does.
      (globalThis as any).localStorage = {
        _s: {} as Record<string, string>,
        getItem(k: string) { return this._s[k] ?? null; },
        setItem(k: string, v: string) { this._s[k] = v; },
        removeItem(k: string) { delete this._s[k]; },
      };
      shim = await import('../src/renderer/remote-shim');
      const { REMOTE_UNSUPPORTED_EVENT } = await import('../src/renderer/remote-unsupported');
      // Keep a handle so afterEach can remove it. jsdom's window persists across
      // tests in a file, and the closure reads the shared `events` binding — a
      // leaked listener from an earlier test pushes into the CURRENT array and
      // inflates the count, which reads exactly like a broken dedupe.
      listener = (e: any) => events.push(e.detail);
      window.addEventListener(REMOTE_UNSUPPORTED_EVENT, listener);
      unsupportedEvent = REMOTE_UNSUPPORTED_EVENT;

      const connectPromise = shim.connect('pw', false);
      ws = FakeWebSocket.instances[0];
      ws.open();
      ws.receive({ type: 'auth:ok', token: 'tok', platform: 'browser' });
      await connectPromise;
      shim.installShim();
      // Past the boot-quiet window. These tests are about what a PERSON ran into — they
      // open a panel and it is empty, and the notice explains why. The first seconds after
      // a connection are the app's own mount fetches, which are deliberately silent now:
      // ten of them announced at once was the first thing a new phone showed Destin.
      // Only the clock is faked; the shim's own timers are real.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10_000);
    });
    afterEach(() => {
      vi.useRealTimers();
      window.removeEventListener(unsupportedEvent, listener);
      delete (globalThis as any).WebSocket;
    });

    it('says nothing during the app\u2019s own mount fetches', async () => {
      // The complaint, in one test: "i just get spammed with a bunch of random x/y/z isnt
      // available via remote access yet the second i connect."
      vi.setSystemTime(Date.now() - 10_000); // back inside the quiet window
      await callUnsupported(() => (window as any).claude.social.listFriends());
      expect(events).toHaveLength(0);
    });

    /** Issue a call and answer it with the server's unsupported response. */
    async function callUnsupported(fn: () => Promise<any>) {
      const p = fn();
      const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
      ws.receive({
        type: `${msg.type}:response`,
        id: msg.id,
        payload: { ok: false, error: `nope (${msg.type})`, unsupported: true },
      });
      // The call REJECTS for unsupported channels, so capture rather than await
      // bare — see the "rejects" test below for why rejecting is the fix.
      const settled = await p.then(
        (result: any) => ({ result, error: null as Error | null }),
        (error: Error) => ({ result: undefined, error }),
      );
      return { ...settled, channel: msg.type };
    }

    it('announces an unsupported channel in plain language', async () => {
      await callUnsupported(() => (window as any).claude.social.listFriends());
      expect(events).toHaveLength(1);
      expect(events[0].feature).toBe('Friends and challenges');
      expect(events[0].message).toBe("Friends and challenges isn't available via remote access yet.");
    });

    // This test previously asserted the OPPOSITE — that the call resolves "so the
    // caller does not crash". That was the bug, not the safeguard: resolving hands
    // the caller {ok:false,unsupported:true} where it expects the channel's real
    // shape. marketplace-context does
    //   theme.marketplace.list().catch(() => [])
    // so the object survived `themes || []`, and the next
    // `for (const theme of themeEntries)` threw "undefined is not a function",
    // blanking the whole screen on a phone. Rejecting is what makes every
    // existing `.catch(() => [])` do its job.
    it('rejects so callers fall back through their existing .catch()', async () => {
      const { result, error } = await callUnsupported(() =>
        (window as any).claude.social.listFriends(),
      );
      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toContain('social:list-friends');
    });

    // The regression in its real shape: the marketplace call site must end up
    // with an ARRAY, because the very next thing it does is iterate.
    it('lets a .catch(() => []) call site recover an iterable', async () => {
      const p = (window as any).claude.theme.marketplace.list().catch(() => []);
      const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
      ws.receive({
        type: `${msg.type}:response`,
        id: msg.id,
        payload: { ok: false, error: 'nope', unsupported: true },
      });
      const themes = await p;
      expect(Array.isArray(themes)).toBe(true);
      // The operation that actually threw on the phone.
      expect(() => { for (const _t of themes) { /* iterate */ } }).not.toThrow();
    });

    // The load-bearing one: useAttentionClassifier polls a channel every second.
    // Announcing per response would put a toast on screen permanently.
    it('announces a feature only once no matter how often it is called', async () => {
      for (let i = 0; i < 5; i++) {
        await callUnsupported(() => (window as any).claude.social.listFriends());
      }
      expect(events).toHaveLength(1);
    });

    it('still announces a DIFFERENT feature', async () => {
      await callUnsupported(() => (window as any).claude.social.listFriends());
      await callUnsupported(() => (window as any).claude.artifacts.get('p', 'a'));
      expect(events.map(e => e.feature)).toEqual(['Friends and challenges', 'Project files']);
    });

    it('says nothing for a normal successful response', async () => {
      const p = (window as any).claude.skills.list();
      const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
      ws.receive({ type: `${msg.type}:response`, id: msg.id, payload: [] });
      await p;
      expect(events).toHaveLength(0);
    });
  });
});

describe('remote-shim — phone refusals', () => {
  isolateGlobals();

  /**
   * The phone's OWN bridge as a refusing host (2026-09-10).
   *
   * Two behaviours, both born from the same bug: SessionService.kt's catch-all
   * used to answer an unknown channel with a bare `{error}` object, which the shim
   * RESOLVES as an ordinary value — Project View crashed on a sync "status" with
   * no `spaces`, and the chat reducer threw on every launch when the first
   * transcript page came back as junk.
   *
   *  1. A refusal from the phone reads "on the phone", never "via remote access".
   *  2. The two channels asked for AUTOMATICALLY (transcript:page on launch,
   *     syncspaces:status on opening Settings / Project View) are refused by the
   *     shim itself, quietly: they reject like any unsupported channel, but no
   *     notice fires and nothing is sent to the bridge.
   */

  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = FakeWebSocket.CONNECTING;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) { FakeWebSocket.instances.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  }

  /** `file:` + no remote target is how the shim recognises the phone's own bridge. */
  function setProtocol(protocol: 'file:' | 'http:') {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { protocol, search: '', host: 'localhost:5173', href: `${protocol}//localhost/` },
    });
  }

  async function loadShim() {
    vi.resetModules();
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).localStorage = {
      _s: {} as Record<string, string>,
      getItem(k: string) { return this._s[k] ?? null; },
      setItem(k: string, v: string) { this._s[k] = v; },
      removeItem(k: string) { delete this._s[k]; },
    };
    delete (window as any).claude;
    return import('../src/renderer/remote-shim');
  }

  async function connectPhone() {
    setProtocol('file:');
    const shim = await loadShim();
    const connecting = shim.connect('android-local', false);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'auth:ok', token: 'tok', platform: 'android' });
    await connecting;
    shim.installShim();
    return ws;
  }

  const settle = (p: Promise<unknown>) => p.then(
    (result) => ({ result, error: null as Error | null }),
    (error: Error) => ({ result: undefined, error }),
  );

  describe('remote-shim on the phone\'s own bridge', () => {
    const realLocation = Object.getOwnPropertyDescriptor(window, 'location')!;
    const notices: any[] = [];
    const listener = (e: Event) => notices.push((e as CustomEvent).detail);

    beforeEach(() => {
      notices.length = 0;
      delete (window as any).claude;
      window.addEventListener(REMOTE_UNSUPPORTED_EVENT, listener);
    });
    afterEach(() => {
      vi.useRealTimers();
      window.removeEventListener(REMOTE_UNSUPPORTED_EVENT, listener);
      Object.defineProperty(window, 'location', realLocation);
      delete (globalThis as any).WebSocket;
      delete (window as any).claude;
    });

    it('a refusal from the phone says "on the phone", not "via remote access"', async () => {
      const ws = await connectPhone();
      // WHY the clock moves: nothing is announced for the first seconds after a connection,
      // because the app's own boot fetches are not something the person did
      // (the unsupported-channels section above covers that window). This test is about a tap the
      // user made AFTER the app settled, so it has to happen after the window closes.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10_000);
      const p = (window as any).claude.syncSpaces.enable(true);
      const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(msg.type).toBe('syncspaces:enable');
      // Exactly what SessionService.kt's catch-all now answers.
      ws.receive({
        type: 'syncspaces:enable:response',
        id: msg.id,
        payload: { ok: false, unsupported: true, error: 'not-implemented-on-mobile (no handler for syncspaces:enable)' },
      });
      const { error } = await settle(p);
      expect(error?.message).toBe('remote-unsupported: syncspaces:enable');
      expect(notices).toHaveLength(1);
      expect(notices[0].message).toBe("Syncing across your devices isn't available on the phone yet.");
    });

    it('refuses transcript:page and syncspaces:status quietly, without touching the bridge', async () => {
      const ws = await connectPhone();
      const sentBefore = ws.sent.length;
      const page = await settle((window as any).claude.detach.requestTranscriptPage({ sessionId: 's1' }));
      const status = await settle((window as any).claude.syncSpaces.status());
      expect(page.error?.message).toBe('remote-unsupported: transcript:page');
      expect(status.error?.message).toBe('remote-unsupported: syncspaces:status');
      expect(ws.sent.length).toBe(sentBefore);
      expect(notices).toHaveLength(0);
    });

    it('still sends both to a desktop over remote access', async () => {
      setProtocol('http:');
      const shim = await loadShim();
      const connecting = shim.connect('pw', false);
      const ws = FakeWebSocket.instances[0];
      ws.open();
      ws.receive({ type: 'auth:ok', token: 'tok', platform: 'desktop' });
      await connecting;
      shim.installShim();
      void (window as any).claude.syncSpaces.status().catch(() => {});
      void (window as any).claude.detach.requestTranscriptPage({ sessionId: 's1' }).catch(() => {});
      const types = ws.sent.map((s) => JSON.parse(s).type);
      expect(types).toContain('syncspaces:status');
      expect(types).toContain('transcript:page');
    });
  });
});

// Voice typing is the one part of the shared `window.claude` shape that the
// remote-browser client deliberately does NOT get (contract row R7). This file
// pins the two halves of that decision, because both are easy to weaken by
// accident and neither shows up in a type check:
//
//  1. The NAMESPACE is only installed for the Android app talking to its own
//     on-device bridge — `file:` page AND no remote target. `!targetUrl` alone
//     is also true of a plain browser tab, which is exactly where the mic must
//     not appear (questions deck Q-7: a browser only grants the microphone on
//     the desktop has no voice over that bridge; disconnecting brings it back).
//  2. Every method REFUSES at call time once a target is set, because pairing
//     to a desktop mid-session flips a variable without rebuilding
//     `window.claude` — a phone that paired mid-session would otherwise keep a
//     live microphone pointed at a host with no voice handlers.
//
// Built on the unsupported-channels section's harness (a fake WebSocket plus a
// stubbed localStorage), which is the only way to install the real shim in a
// test without an Electron main process.
describe('remote-shim — voice gate', () => {
  isolateGlobals();

  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = FakeWebSocket.CONNECTING;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) { FakeWebSocket.instances.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  }

  /** Point jsdom's `location.protocol` at a scheme. The shim reads it directly,
   *  and jsdom's own location is read-only, so replace the whole object — the
   *  shim only ever reads `protocol` and `search` off it. */
  function setProtocol(protocol: 'file:' | 'http:') {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { protocol, search: '', host: 'localhost:5173', href: `${protocol}//localhost/` },
    });
  }

  /** connectToHost() awaits a dynamic import before it opens its socket, so the
   *  fake instance does not exist on the next line. Wait for it. */
  async function waitForSocket(count: number): Promise<FakeWebSocket> {
    // Bounded by TIME, not by a count of event-loop turns. Fifty turns is however
    // long fifty turns happen to take, and with the whole suite running in
    // parallel that was measured at less than one dynamic import (this file failed
    // inside a full run on 2026-09-05 and passed on its own straight after).
    // Rule: .claude/rules/test-suite-hygiene.md → "Never let a fixed sleep stand
    // in for a signal" — there is no event to wait on here, so a generous deadline
    // is the honest second best.
    const deadline = Date.now() + 10_000;
    while (FakeWebSocket.instances.length < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1));
    }
    if (FakeWebSocket.instances.length < count) throw new Error('no socket was opened');
    return FakeWebSocket.instances[count - 1];
  }

  async function loadShim() {
    vi.resetModules();
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).localStorage = {
      _s: {} as Record<string, string>,
      getItem(k: string) { return this._s[k] ?? null; },
      setItem(k: string, v: string) { this._s[k] = v; },
      removeItem(k: string) { delete this._s[k]; },
    };
    delete (window as any).claude;
    return import('../src/renderer/remote-shim');
  }

  describe('remote-shim voice gate', () => {
    const realLocation = Object.getOwnPropertyDescriptor(window, 'location')!;

    beforeEach(() => { delete (window as any).claude; });
    afterEach(() => {
      Object.defineProperty(window, 'location', realLocation);
      delete (globalThis as any).WebSocket;
      delete (window as any).claude;
    });

    it('installs the voice namespace on the Android app (file:// with no remote target)', async () => {
      setProtocol('file:');
      const shim = await loadShim();
      shim.installShim();
      expect((window as any).claude.voice).toBeDefined();
      // The whole shared shape, so a missing member can't pass as "present".
      for (const m of ['status', 'download', 'start', 'stop', 'cancel', 'onEvent']) {
        expect(typeof (window as any).claude.voice[m], `voice.${m}`).toBe('function');
      }
    });

    it('installs NO voice namespace in a plain browser tab (http:// with no remote target)', async () => {
      setProtocol('http:');
      const shim = await loadShim();
      shim.installShim();
      // The mic button is drawn from `supported`, which is `!!window.claude.voice`.
      expect((window as any).claude.voice).toBeUndefined();
      // Sanity: the shim really did install, so `undefined` above means "gated
      // out" rather than "installShim never ran".
      expect((window as any).claude.session).toBeDefined();
    });

    it('the phone-only members stay off the shim (Android owns the microphone)', async () => {
      setProtocol('file:');
      const shim = await loadShim();
      shim.installShim();
      // Absent ON PURPOSE — the exception recorded in .claude/rules/ipc-bridge.md.
      // The composer tests for them before opening a microphone itself.
      expect((window as any).claude.voice.sendAudio).toBeUndefined();
      expect((window as any).claude.voice.micAccess).toBeUndefined();
    });

    // The mid-session pairing case. `connectToHost` sets the remote target and
    // flips the connection mode; it never rebuilds `window.claude`, so the bridge
    // the composer captured at mount is still the Android one.
    describe('after pairing to a remote desktop mid-session', () => {
      let shim: typeof import('../src/renderer/remote-shim');
      let voice: any;

      beforeEach(async () => {
        setProtocol('file:');
        shim = await loadShim();
        shim.installShim();
        voice = (window as any).claude.voice;
        const pairing = shim.connectToHost('desk.local', 9900, 'pw');
        const ws = await waitForSocket(1);
        ws.open();
        ws.receive({ type: 'auth:ok', token: 'tok', platform: 'desktop' });
        await pairing;
        // The namespace object is the same one — that IS the hazard being tested.
        expect((window as any).claude.voice).toBe(voice);
      });

      it('status() answers unavailable with the reason, instead of asking the desktop', async () => {
        const before = FakeWebSocket.instances[FakeWebSocket.instances.length - 1].sent.length;
        const readiness = await voice.status();
        expect(readiness.state).toBe('unavailable');
        // The sentence must address the reader who can actually see it — a PHONE paired
        // to a desktop, not a browser — and tell them what to do about it.
        expect(readiness.reason).toMatch(/connected to another computer/);
        expect(readiness.reason).toMatch(/Disconnect/);
        expect(readiness.reason).not.toMatch(/encrypted/);
        // Nothing went over the wire: the refusal is local, so a desktop with no
        // voice:* handlers is never asked a question it cannot answer.
        expect(FakeWebSocket.instances[FakeWebSocket.instances.length - 1].sent.length).toBe(before);
      });

      it('start() refuses rather than opening a microphone', async () => {
        const before = FakeWebSocket.instances[FakeWebSocket.instances.length - 1].sent.length;
        await expect(voice.start()).rejects.toThrow(/connected to another computer/);
        expect(FakeWebSocket.instances[FakeWebSocket.instances.length - 1].sent.length).toBe(before);
      });

      it('download(), stop() and cancel() refuse too', async () => {
        await expect(voice.download()).rejects.toThrow(/connected to another computer/);
        await expect(voice.stop()).rejects.toThrow(/connected to another computer/);
        await expect(voice.cancel()).rejects.toThrow(/connected to another computer/);
      });

      it('onEvent() subscribes to nothing and still returns a usable unsubscribe', async () => {
        const seen: unknown[] = [];
        const off = voice.onEvent((e: unknown) => seen.push(e));
        const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
        ws.receive({ type: 'voice:event', payload: { type: 'final', text: 'hello' } });
        expect(seen).toEqual([]);
        expect(() => off()).not.toThrow();
      });
    });

    // The other direction: on the phone, with no remote target, the calls really
    // do go to the on-device bridge. Without this the refusal tests above could
    // pass with a namespace that refuses ALWAYS.
    it('on the phone the calls actually reach the local bridge', async () => {
      setProtocol('file:');
      const shim = await loadShim();
      const connecting = shim.connect('android-local', false);
      const ws = FakeWebSocket.instances[0];
      ws.open();
      ws.receive({ type: 'auth:ok', token: 'tok', platform: 'android' });
      await connecting;
      shim.installShim();
      const voice = (window as any).claude.voice;

      const p = voice.status();
      const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(msg.type).toBe('voice:status');
      ws.receive({ type: 'voice:status:response', id: msg.id, payload: { state: 'ready', engine: 'android' } });
      expect(await p).toEqual({ state: 'ready', engine: 'android' });

      // ...and the host's push events reach an onEvent subscriber.
      const seen: any[] = [];
      voice.onEvent((e: any) => seen.push(e));
      ws.receive({ type: 'voice:event', payload: { type: 'partial', committed: 'Hello.', tail: 'there' } });
      expect(seen).toEqual([{ type: 'partial', committed: 'Hello.', tail: 'there' }]);
    });
  });
});
