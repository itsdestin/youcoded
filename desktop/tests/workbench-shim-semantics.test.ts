import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../src/renderer/dev/workbench/mock-store';
import { createMockShim, setLatency, getLatency } from '../src/renderer/dev/workbench/mock-shim';

const DEFAULT_LATENCY = getLatency();
setLatency(0);

const shim = () => createMockShim(createStore('default')) as any;

describe('mock shim Proxy semantics', () => {
  // Each of these pins a specific way the catch-all can silently break the app
  // it is standing in for. They are cheap to keep and expensive to rediscover.

  it('an unimplemented channel resolves [] rather than null', async () => {
    // `const rows = await claude.x.list(); rows.map(...)` is the dominant
    // consumer shape — null turns a missing stub into a crash in the surface
    // under design.
    // The example channel here keeps getting promoted out from under the test:
    // `skills.list` held the role until 2026-08-25 (Marketplace/Library needed
    // real cards to review) and `getChips` until 2026-08-28 (the composer chip
    // row lost its hardcoded fallback, so the mock had to answer for real).
    // `getCuratedDefaults` is the current catch-all — if it ever gains a
    // fixture, repoint these two at whatever is still unimplemented.
    const rows = await shim().skills.getCuratedDefaults();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });

  it('gives each caller its own array', async () => {
    const c = shim();
    const a = await c.skills.getCuratedDefaults();
    a.push('poison');
    expect(await c.skills.getCuratedDefaults()).toEqual([]);
  });

  it('warns once per channel, not once per call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = shim();
    await c.social.somethingUnbuilt();
    await c.social.somethingUnbuilt();
    await c.social.somethingUnbuilt();
    const mine = warn.mock.calls.filter((args) =>
      String(args[0]).includes('social.somethingUnbuilt'));
    expect(mine).toHaveLength(1);
    warn.mockRestore();
  });

  // A namespace that answers `then` with a function looks thenable, so
  // `await claude.session` hangs forever instead of resolving to the object —
  // a hang with no error, in the one place nobody would think to look.
  it('never answers `then` or symbols with a function', async () => {
    const c = shim();
    expect(c.session.then).toBeUndefined();
    expect(c.then).toBeUndefined();
    expect(c.session[Symbol.iterator]).toBeUndefined();
    // The actual failure this prevents: awaiting a namespace must settle.
    await expect(Promise.race([
      Promise.resolve(c.session),
      new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 50)),
    ])).resolves.toBeTruthy();
  });

  // `off(handler)` and every React dependency array holding a bridge member
  // depend on the member being the same object each read.
  it('returns a stable function identity per member', () => {
    const c = shim();
    expect(c.skills.list).toBe(c.skills.list);
    expect(c.session.list).toBe(c.session.list);
    expect(c.social).toBe(c.social);
  });

  // A `has` trap returning true for everything makes `'x' in claude.y` lie.
  it('does not claim to have members it lacks', () => {
    const c = shim();
    expect('thisIsNotAChannel' in c.session).toBe(false);
    expect('thisIsNotANamespace' in c).toBe(false);
  });

  // Capability gates read this directly; an unknown top-level property must not
  // become a namespace object where a function is expected.
  it('exposes top-level callables as functions, not namespace proxies', async () => {
    const c = shim();
    expect(typeof c.getPlatform).toBe('function');
    expect(typeof c.getHomePath).toBe('function');
    expect(typeof c.off).toBe('function');
    expect(typeof c.removeAllListeners).toBe('function');
    // platform.ts:23 calls this after a truthiness guard — it must not throw.
    await expect(c.getPlatform()).resolves.toBe('linux');
    await expect(c.getFavorites()).resolves.toEqual([]);
  });

  it('unknown namespaces still degrade gracefully', async () => {
    await expect(shim().someFutureNamespace.someFutureCall()).resolves.toEqual([]);
  });

  // The regression that took the app down at boot: `getIncognito` is a bare
  // top-level callable, but the catch-all handed back a namespace object, so
  // `window.claude?.getIncognito()` threw "is not a function" inside App's
  // startup path and RootErrorBoundary replaced the entire UI. An unknown
  // member must work as EITHER shape, since the property access cannot tell
  // which one the caller wants.
  it('an unknown top-level member is callable as a bare function', async () => {
    const c = shim();
    expect(typeof c.someFutureTopLevelCall).toBe('function');
    await expect(c.someFutureTopLevelCall()).resolves.toEqual([]);
  });

  it('the same unknown member also works as a namespace', async () => {
    const c = shim();
    await expect(c.someOtherFuture.nested()).resolves.toEqual([]);
  });

  // Nested namespaces under a HAND-WRITTEN namespace are the dangerous case:
  // `theme` has an impl, so `theme.marketplace` misses it and hits the
  // catch-all. A plain function there makes `.list` undefined, and calling it
  // throws SYNCHRONOUSLY — before the caller's `.catch()` is even attached.
  // marketplace-context.tsx:171 does exactly that inside a Promise.all, so one
  // missing nested channel rejected the whole marketplace load and left theme
  // favourites empty. The visible symptom was "Appearance offers one theme".
  it('nested namespaces resolve to any depth, including under a real impl', async () => {
    const c = shim();
    // `theme.marketplace.list` and `skills.getFeatured` have fixtures since
    // 2026-08-25; `detail`/`getShareLink` are the still-unimplemented siblings.
    await expect(c.theme.marketplace.detail()).resolves.toEqual([]);
    await expect(c.skills.getShareLink()).resolves.toEqual([]);
    await expect(c.a.b.c.d()).resolves.toEqual([]);
    // And the fixture-backed nested member returns real rows, not the catch-all.
    await expect(c.theme.marketplace.list()).resolves.toContainEqual(expect.objectContaining({ slug: 'meadow-mist' }));
    // And the hand-written members of that same namespace still work.
    await expect(c.theme.list()).resolves.toContain('halftone-dimension');
  });

  it('a nested namespace expression does not throw synchronously', () => {
    const c = shim();
    // The throw that mattered happened while BUILDING the expression, which is
    // why a .catch() on the promise could not save it.
    expect(() => c.theme.marketplace.list().catch(() => [])).not.toThrow();
  });

  // Function targets carry own properties; consulting them instead of the impl
  // would make `claude.session.name` return "" rather than a channel stub.
  it('does not leak the function target\'s own properties', () => {
    const c = shim();
    expect(typeof c.session.name).toBe('function');
    expect(typeof c.session.length).toBe('function');
    expect('name' in c.session).toBe(false);
  });

  it('the top-level callables preload exposes all resolve sensibly', async () => {
    const c = shim();
    await expect(c.getIncognito()).resolves.toBe(false);
    await expect(c.getHomePath()).resolves.toContain('/');
    expect(typeof c.onChatExportSnapshot(() => {})).toBe('function');
    expect(() => c.fireRemoteAttentionChanged({})).not.toThrow();
  });

  it('on.* registrars return an unsubscribe synchronously', () => {
    const off = shim().on.somethingNobodyImplemented(() => {});
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
  });

  // `on[A-Z]` registrars exist on MANY namespaces, not just `on`. Callers do
  // `const cleanup = ns.onThing(cb)` inside a useEffect and return it, so a
  // Promise here makes React call a Promise as the cleanup — which is exactly
  // how `cleanupDir is not a function` took the whole app down at boot.
  it.each([
    ['detach', 'onDirectoryUpdated'],
    ['theme', 'onReload'],
    ['window', 'onFullscreenChanged'],
    ['engine', 'onInstallProgress'],
    ['someUnknownNamespace', 'onSomethingNew'],
  ])('%s.%s returns an unsubscribe synchronously, not a promise', (ns, member) => {
    const cleanup = (shim() as any)[ns][member](() => {});
    expect(typeof cleanup).toBe('function');
    expect(cleanup).not.toBeInstanceOf(Promise);
    expect(() => cleanup()).not.toThrow();
  });

  // The catch-all can only ever be right about SHAPE, not MEANING. These two
  // gate app-level behaviour, so `[]` is actively wrong for them:
  //   - firstRun: `[]` is truthy and `[].currentStep !== 'COMPLETE'`, so the app
  //     routed to the onboarding wizard and crashed in it.
  //   - terminal: the attention classifier does raw.split('\n') once a second.
  it('firstRun.getState reports a completed first run', async () => {
    const state = await shim().firstRun.getState();
    expect(state.currentStep).toBe('COMPLETE');
    expect(Array.isArray(state.prerequisites)).toBe(true);
  });

  it('terminal.getScreenText resolves a string, not an array', async () => {
    const raw = await shim().terminal.getScreenText('wb-1');
    expect(typeof raw).toBe('string');
    expect(() => raw.split('\n')).not.toThrow();
  });

  // Fix (final review): SpecialistsSection's "Open folder" button reads
  // shell.openPath's resolved value as an error message whenever it is truthy
  // (real openPath resolves '' on success, an error string on failure). Before
  // this fix `shell` had no hand-written entry, so the call fell through to the
  // catch-all, which resolves EVERY unknown member to `[]` — truthy, so the
  // button always showed a blank error box. A unit test stubbing the IPC
  // channel directly would not catch this; it has to exercise the mock shim's
  // own resolution path the way the component actually calls it.
  it('shell.openPath resolves to the empty-string success value, not []', async () => {
    const result = await shim().shell.openPath('/home/destin/.youcoded/specialists');
    expect(result).toBe('');
    // The exact assertion SpecialistsSection.tsx's openFolder handler makes —
    // pin the READING, not just the value, so a future change that keeps the
    // value '' but breaks the type (e.g. wrapping it in an object) still fails.
    expect(Boolean(result)).toBe(false);
  });

  it('defaults to non-zero latency so loading states are visible', () => {
    expect(DEFAULT_LATENCY).toBeGreaterThan(0);
  });

  // `?signedIn=1` is the switch that lets the games scene be filmed past the
  // sign-in wall. Signed-out stays the default so the sign-in states remain
  // reviewable — this pins all three legs of that contract. `refresh` matters
  // as much as `signedIn`/`user`: account-context.tsx's window-focus listener
  // calls it (confirmed empirically against the running workbench — it fires
  // within seconds of sign-in), and a `refresh` that always resolved null
  // silently flipped `signedIn` back to false the moment the recording window
  // regained focus, even though `signedIn()`/`user()` still said true.
  it('account.signedIn/user/refresh follow the ?signedIn=1 URL switch', async () => {
    vi.stubGlobal('location', { search: '?signedIn=1' });
    const c = shim();
    expect(await c.account.signedIn()).toBe(true);
    expect(await c.account.user()).toMatchObject({ handle: 'you' });
    expect(await c.account.refresh()).toMatchObject({ handle: 'you' });
    vi.unstubAllGlobals();
  });

  it('account.signedIn/user/refresh stay signed out without the switch', async () => {
    const c = shim();
    expect(await c.account.signedIn()).toBe(false);
    expect(await c.account.user()).toBeNull();
    expect(await c.account.refresh()).toBeNull();
  });

  // `?fail=` exists for review shots of LOAD failures. A read that runs on app mount
  // (the skills list, the installed plugins, the tag registry) is out of reach of a
  // shot's `eval`, which only runs after boot — so the failure has to be in the fake
  // from the first call. Nested paths must work too: the theme list is
  // `theme.marketplace.list`.
  it('?fail= makes the named channels reject and leaves the rest alone', async () => {
    vi.stubGlobal('location', { search: '?fail=skills.list,theme.marketplace.list' });
    const c = shim();
    await expect(c.skills.list()).rejects.toThrow(/Mock failure/);
    await expect(c.theme.marketplace.list()).rejects.toThrow(/Mock failure/);
    await expect(c.skills.listMarketplace()).resolves.toBeDefined();
    vi.unstubAllGlobals();
  });

  // `?update=available` exists because the update pill and its panel only render once
  // status:data carries an update, which no scenario ever sent.
  it('?update=available puts an update on status:data', async () => {
    vi.stubGlobal('location', { search: '?update=available' });
    const c = shim();
    let got: any = null;
    c.on.statusData((d: any) => { got = d; });
    expect(got?.updateStatus).toMatchObject({ update_available: true });
    // Nothing downloaded yet, so the panel offers a download rather than a launch.
    expect(await c.update.getCachedDownload('1.3.0')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('no update is offered without the switch', async () => {
    let got: any = null;
    shim().on.statusData((d: any) => { got = d; });
    expect(got?.updateStatus ?? null).toBeNull();
  });

  it('applies latency to channel results when set', async () => {
    setLatency(60);
    const started = performance.now();
    await shim().skills.list();
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    setLatency(0);
  });

  // Native sessions (the `site` scenario's embed session, `provider: 'native'`)
  // send through `native.send`, NOT `session.sendInput` — App's canPtySend
  // refuses the PTY channel outright for provider:'native'. Pins that the two
  // channels share the same reply machinery (startReply in mock-shim.ts) so a
  // native send actually answers, and that the ack shape matches the real
  // `NativeSendResult` contract (shared/types.ts) rather than session.sendInput's
  // fire-and-forget `void`.
  it('native.send answers a message and resolves the real ack shape', async () => {
    vi.useFakeTimers();
    const c = createMockShim(createStore('site')) as any;
    const transcript: any[] = [];
    c.on.transcriptEvent((e: any) => transcript.push(e));

    const ack = c.native.send('site-1', 'hello');
    await expect(ack).resolves.toEqual({ status: 'sent' });

    await vi.advanceTimersByTimeAsync(15000);
    expect(transcript.length).toBeGreaterThan(0);
    // No user-message echo — the app renders the user's bubble itself.
    expect(transcript[0]).toMatchObject({ type: 'assistant-text' });
    expect(transcript.at(-1)).toMatchObject({ type: 'turn-complete' });
    vi.useRealTimers();
  });
});

describe('site mode additions', () => {
  it('native.setBinding rebinds the session model', async () => {
    const store = createStore('site');
    const shim = createMockShim(store);
    const ok = await shim.native.setBinding('site-1', { providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-5' });
    expect(ok).toBe(true);
    const s = (await shim.session.list()).find((x: any) => x.id === 'site-1');
    expect(s.model).toBe('anthropic/claude-sonnet-5');
  });
  it('theme.list includes the vendored golden-sunbreak pack', async () => {
    const shim = createMockShim(createStore('default'));
    expect(await shim.theme.list()).toContain('golden-sunbreak');
  });
});
