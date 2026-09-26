// mock-shim.ts — the UI Workbench's fake backend (window.claude without Electron).
// Sections: the channels it serves, its Proxy semantics, the transcript fixture
// the preview replays, and the promo video's URL/global switches. The two
// sections that need a browser window (engine states, the mock contract) live in
// mock-shim-window.test.ts, because they run under jsdom.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Workbook } from 'exceljs';
import { createStore } from '../src/renderer/dev/workbench/mock-store';
import { createMockShim, setLatency, getLatency } from '../src/renderer/dev/workbench/mock-shim';
import { CS_RESUMABLE } from '../src/renderer/dev/workbench/fixtures/chatsearch';
import { validateTheme } from '../src/renderer/themes/theme-validator';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatState } from '../src/renderer/state/chat-types';
import type { TranscriptEvent, TranscriptPageResult } from '../src/shared/types';

// WHY read before zeroing: the proxy-semantics section asserts the real default.
const DEFAULT_LATENCY = getLatency();
// Latency is real, so it would add 150ms to every awaited call in this file.
setLatency(0);

describe('channels', () => {
  const shim = (scenario: Parameters<typeof createStore>[0] = 'default') =>
    createMockShim(createStore(scenario)) as any;

  describe('workbench channels', () => {
    it('session.browse returns the seeded past sessions', async () => {
      expect((await shim().session.browse()).length).toBeGreaterThan(0);
    });

    it('session.create adds a row that session.list then returns', async () => {
      const c = shim();
      const before = (await c.session.list()).length;
      await c.session.create({ name: 'new one', cwd: '/tmp', skipPermissions: false });
      expect((await c.session.list()).length).toBe(before + 1);
    });

    it('session.setTag persists and is readable back', async () => {
      const c = shim();
      const id = (await c.session.browse())[0].sessionId;
      await c.session.setTag(id, 'tag_idea', true);
      const row = (await c.session.browse()).find((s: any) => s.sessionId === id);
      expect(row.tags).toContain('tag_idea');
    });

    // The refused scenario is what makes ResumeBrowser.tsx:428's revert visible.
    it('writes resolve {ok:false} under the refused scenario', async () => {
      const c = shim('refused');
      const id = (await c.session.browse())[0].sessionId;
      expect(await c.session.setTag(id, 'tag_idea', true)).toEqual({ ok: false });
    });

    it('providers.list reflects the scenario', async () => {
      expect((await shim('no-providers').providers.list())
        .every((p: any) => !p.ready)).toBe(true);
    });

    // The renderer does not poll — it re-fetches on these events. A mock that
    // mutates the store without emitting them leaves the UI showing stale data,
    // and "I created a session and nothing appeared" reads as a bug in the
    // surface under design rather than a hole in the mock. Spec §3.3.
    it('session.create fires sessionCreated', async () => {
      const c = shim();
      const seen: any[] = [];
      c.on.sessionCreated((s: any) => seen.push(s));
      await c.session.create({ name: 'n', cwd: '/tmp', skipPermissions: false });
      expect(seen).toHaveLength(1);
      expect(seen[0].name).toBe('n');
    });

    it('session.destroy fires sessionDestroyed', async () => {
      const c = shim();
      const seen: string[] = [];
      c.on.sessionDestroyed((id: string) => seen.push(id));
      await c.session.destroy('wb-1');
      expect(seen).toEqual(['wb-1']);
    });

    it('session.setTag fires sessionMetaChanged', async () => {
      const c = shim();
      let fired = 0;
      c.on.sessionMetaChanged(() => { fired += 1; });
      await c.session.setTag('wb-past-0', 'tag_idea', true);
      expect(fired).toBe(1);
    });

    // session.destroy is typed `Promise<boolean>` in useIpc.ts, NOT {ok}. Getting
    // this wrong would have the caller treat a refusal as success.
    it('session.destroy resolves a boolean, and false when refused', async () => {
      expect(await shim().session.destroy('wb-1')).toBe(true);
      const refused = shim('refused');
      const before = (await refused.session.list()).length;
      expect(await refused.session.destroy('wb-1')).toBe(false);
      expect((await refused.session.list()).length).toBe(before);
    });

    // Every write honours `refused`, not just the tag/flag/note trio. A write
    // that quietly succeeds under this scenario is worse than no scenario at
    // all — it teaches the reviewer the revert path is fine when it never ran.
    it('defaults.set is refused too', async () => {
      const c = shim('refused');
      expect(await c.defaults.set({ model: 'opus' })).toEqual({ ok: false });
      expect((await c.defaults.get()).model).not.toBe('opus');
    });

    it('defaults.set persists when allowed', async () => {
      const c = shim();
      await c.defaults.set({ model: 'opus' });
      expect((await c.defaults.get()).model).toBe('opus');
    });

    // Browser-only mode has no Electron, but detachAvailable gates the "Launch in
    // New Window" toggle in BOTH new-session forms (SessionStrip.tsx:191,
    // ResumeBrowser.tsx:242) — omitting it deletes a control under redesign.
    it('detach.openDetached exists so the new-window toggle renders', () => {
      expect(typeof shim().detach.openDetached).toBe('function');
    });

    it('native.supported is true so the runtime selector renders', () => {
      expect(shim().native.supported).toBe(true);
    });

    // preload.ts names this `delete`, not `remove`. The contract test catches a
    // wrong name; this one catches a wrong behaviour.
    it('tags.delete removes the tag', async () => {
      const c = shim();
      const before = (await c.tags.list()).length;
      await c.tags.delete('tag_bug');
      const after = await c.tags.list();
      expect(after.length).toBe(before - 1);
      expect(after.find((t: any) => t.id === 'tag_bug')).toBeUndefined();
    });

    it('tags.create returns a well-formed record', async () => {
      const tag = await shim().tags.create('newtag', 'tag-teal');
      expect(tag.id.startsWith('tag_')).toBe(true);
      expect(tag).toMatchObject({ label: 'newtag', color: 'tag-teal', archived: false });
      expect(typeof tag.createdAt).toBe('string');
    });

    it('models.memoryCheck returns a verdict from the real union', async () => {
      const res = await shim().models.memoryCheck('qwen2.5-coder:14b');
      expect(['ok', 'tight', 'too-large']).toContain(res.verdict);
    });

    // theme-context.tsx does `validateTheme(JSON.parse(raw))` and swallows the
    // failure with a console.warn — so a corrupt vendored pack would just quietly
    // never appear in the picker. Catch it here instead.
    it('serves a vendored community theme that parses and validates', async () => {
      const c = shim();
      const slugs = await c.theme.list();
      expect(slugs).toContain('halftone-dimension');

      const raw = await c.theme.readFile('halftone-dimension');
      const parsed = JSON.parse(raw);
      expect(parsed.slug).toBe('halftone-dimension');
      expect(parsed.source).toBe('community');
      expect(validateTheme(parsed)).toBeTruthy();
    });

    it('an unknown theme slug returns parseable JSON rather than undefined', async () => {
      const raw = await shim().theme.readFile('nope');
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('ships more than one community theme so the picker has real choices', async () => {
      const slugs = await shim().theme.list();
      expect(slugs).toEqual(expect.arrayContaining(['halftone-dimension', 'meadow-mist']));
      expect(slugs.length).toBeGreaterThanOrEqual(2);
    });

    // The gap this closes: a pack references its assets relatively
    // ("assets/pattern.svg"), theme-asset-resolver turns that into a
    // theme-asset:// URI, and a browser tab has no such scheme — so every
    // pattern, mascot and wallpaper rendered broken. The mock rewrites them to
    // Vite URLs first. If this regresses the themes still "work", just without
    // their artwork, which is exactly the kind of silent degradation the
    // workbench is supposed to make impossible.
    it.each(['halftone-dimension', 'meadow-mist'])(
      '%s has every asset reference rewritten to a servable URL',
      async (slug) => {
        const raw = await shim().theme.readFile(slug);
        expect(() => JSON.parse(raw)).not.toThrow();

        // No bare relative reference may survive: `"assets/x.svg"` or
        // `url(assets/x.svg)` would both resolve to theme-asset:// at render time.
        const leftovers = raw.match(/["(]assets\//g) ?? [];
        expect(leftovers).toEqual([]);
      },
    );

    // Vite inlines assets under its 4KB limit as `data:` URIs and serves larger
    // ones as paths, so a rewritten manifest legitimately contains BOTH shapes —
    // which is why theme-asset-resolver has to pass through both. Asserting on a
    // filename would be wrong: pattern.svg is inlined, so its name is gone.
    // The real invariant is "the resolver will leave every one of these alone".
    it.each(['halftone-dimension', 'meadow-mist'])(
      '%s asset values are all shapes resolveAssetPath passes through',
      async (slug) => {
        const parsed = JSON.parse(await shim().theme.readFile(slug));
        const values: string[] = [];
        const walk = (v: unknown) => {
          if (typeof v === 'string') values.push(v);
          else if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(parsed);

        // Anything that still looks like a bare relative asset path would become
        // a theme-asset:// URI and render as a broken image.
        const unresolved = values.filter((v) => /^assets\//.test(v));
        expect(unresolved).toEqual([]);

        // And at least one asset actually resolved, or this passes vacuously on a
        // manifest that references no assets at all.
        const resolved = values.filter(
          (v) => v.startsWith('data:') || (v.startsWith('/') && /\.(svg|jpg|webp|png)$/.test(v)),
        );
        expect(resolved.length).toBeGreaterThan(0);
      },
    );
  });
});

describe('proxy semantics', () => {
  const shim = () => createMockShim(createStore('default')) as any;

  describe('mock shim Proxy semantics', () => {
    it('persists independent context defaults and rejects refused writes', async () => {
      const store = createStore('default');
      const c = createMockShim(store);
      await c.native.setContextPreferences({ openrouter: 'long' });
      await expect(c.native.setContextPreferences({ chatgpt: 'long' })).resolves.toEqual({ openrouter: 'long', chatgpt: 'long' });
      const copy = await c.native.getContextPreferences();
      copy.chatgpt = 'standard';
      expect(await c.native.getContextPreferences()).toEqual({ openrouter: 'long', chatgpt: 'long' });
      store.refuseWrites = true;
      await expect(c.native.setContextPreferences({ chatgpt: 'standard' })).rejects.toThrow('refusing writes');
      expect(await c.native.getContextPreferences()).toEqual({ openrouter: 'long', chatgpt: 'long' });
    });
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
      // 2026-08-25; `theme.marketplace.detail` is still an unimplemented sibling.
      await expect(c.theme.marketplace.detail()).resolves.toEqual([]);
      await expect(c.a.b.c.d()).resolves.toEqual([]);
      // `skills.getShareLink` got a real impl (ShareSheet's mount-time call,
      // 2026-09-26) — it now returns a real string, not the catch-all's `[]`.
      await expect(c.skills.getShareLink('civic-report')).resolves.toBe('https://youcoded.app/skill/civic-report');
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
      // WHY `as any`: the shim serves channels (theme.*) that Window['claude'] does not type.
      const shim = createMockShim(createStore('default')) as any;
      expect(await shim.theme.list()).toContain('golden-sunbreak');
    });
  });
});

// The workbench's fake transcript must produce what the real reader produces:
// pages of transcript events that the preview replays through the chat
// reducer, including a real tool group — the shape a reviewer
// most needs to see, and the one the old flat preview got wrong.
//
// Same family as tests/workbench-event-contract.test.ts, where the
// fake dispatched an event the product never sent: a fake that disagrees with
// the product is worse than no fake, because it is what everyone reviews.
describe('transcript fixture', () => {
  const ID = 'wb-past-0';
  const KEY = `preview:${ID}`;

  async function allPages(): Promise<TranscriptPageResult[]> {
    const shim = createMockShim(createStore('default')) as any;
    const pages: TranscriptPageResult[] = [];
    let before: number | undefined;
    for (let n = 0; n < 20; n++) {
      const res = await shim.chatsearch.read({ provider: 'claude', id: ID, ...(before === undefined ? {} : { before }) });
      expect(res.ok).toBe(true);
      pages.push(res);
      if (!res.hasMore) break;
      before = res.cursor.offset;
    }
    return pages;
  }

  // Exactly what SessionPreviewPane does with each page.
  function replay(pages: TranscriptPageResult[]) {
    let state: ChatState = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: KEY });
    for (const p of pages) {
      state = chatReducer(state, { type: 'HISTORY_PAGE_LOADED', sessionId: KEY, events: p.events, cursor: p.cursor, hasMore: p.hasMore });
    }
    return state.get(KEY)!;
  }

  describe('the workbench transcript fixture', () => {
    it('pages back to the start without repeating anything', async () => {
      const pages = await allPages();
      expect(pages.length).toBeGreaterThan(1);
      const uuids = pages.flatMap((p) => p.events.map((e: TranscriptEvent) => e.uuid));
      expect(new Set(uuids).size).toBe(uuids.length);
      expect(pages.every((p) => p.events.every((e: TranscriptEvent) => e.sessionId === KEY))).toBe(true);
    });

    it('replays into a chat with a real tool group inside an assistant turn', async () => {
      const s = replay(await allPages());
      expect(s.toolGroups.size).toBeGreaterThan(0);
      expect([...s.toolCalls.values()].every((t) => t.status === 'complete')).toBe(true);
      expect(s.timeline.filter((e) => e.kind === 'user').length).toBe(24);
    });

    it('reads as a conversation, not as counters', async () => {
      const texts = (await allPages()).flatMap((p) => p.events)
        .filter((e) => e.type === 'user-message' || e.type === 'assistant-text')
        .map((e) => String(e.data.text));
      expect(texts.some((t) => /step \d+|question number \d+/i.test(t))).toBe(false);
      expect(texts.every((t) => t.trim().length > 0)).toBe(true);
    });
  });
});

// The promo video's three dev-only fakes. None of this ships: mock-shim.ts is
// the workbench's fake backend. Each `describe` pins one URL/global switch.
describe('promo fakes', () => {
  // WHY: each shim() stubs `location`; in one shared file a stub left behind
  // would leak into the next section's URL-read switches.
  afterEach(() => { vi.unstubAllGlobals(); });

  // Same construction as the proxy-semantics section above, but the module is
  // re-imported per test because the URL switches are read at module scope.
  async function shim(search = '') {
    vi.resetModules();
    vi.stubGlobal('location', { search });
    const { createStore } = await import('../src/renderer/dev/workbench/mock-store');
    const { createMockShim } = await import('../src/renderer/dev/workbench/mock-shim');
    return createMockShim(createStore('site')) as any;
  }

  async function rows(base64: string): Promise<string[][]> {
    const wb = new Workbook();
    // Fix: Node's Buffer.from(...) is typed Buffer<ArrayBuffer>, which exceljs's
    // declared xlsx.load(Buffer) signature rejects under tsconfig.tests.json's
    // stricter Node types (same mismatch XlsxView.tsx works around with `.buffer as any`).
    await wb.xlsx.load(Buffer.from(base64, 'base64') as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    const out: string[][] = [];
    ws.eachRow((r) => out.push((r.values as unknown[]).slice(1).map((v) => String(v ?? ''))));
    return out;
  }

  describe('spreadsheet bytes', () => {
    beforeEach(() => { delete (globalThis as any).__workbenchSheet; });

    it('serves an .xlsx for the site session and the "before" sheet is unsorted with no total', async () => {
      const c = await shim('?scenario=site');
      const r = await c.artifacts.readBinary('/home/you/Documents/Q3-sales.xlsx');
      expect(r.ok).toBe(true);
      expect(r.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const rs = await rows(r.base64);
      expect(rs[0]).toEqual(['Region', 'Rep', 'Amount', 'Month']);
      const amounts = rs.slice(1).map((x) => Number(x[2]));
      expect(amounts.length).toBe(15);
      expect([...amounts].sort((a, b) => b - a)).not.toEqual(amounts);
      expect(rs.some((x) => x[0] === 'Total')).toBe(false);
    });

    it('serves the "after" sheet when __workbenchSheet is "after": sorted by amount, with a Total row', async () => {
      (globalThis as any).__workbenchSheet = 'after';
      const c = await shim('?scenario=site');
      const r = await c.artifacts.readBinary('/home/you/Documents/Q3-sales.xlsx');
      const rs = await rows(r.base64);
      const body = rs.slice(1, -1);
      const amounts = body.map((x) => Number(x[2]));
      expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
      expect(rs.at(-1)?.[0]).toBe('Total');
      expect(Number(rs.at(-1)?.[2])).toBe(amounts.reduce((a, b) => a + b, 0));
    });
  });

  describe('remote access fake', () => {
    it('is untouched without ?remote= (catch-all answers [])', async () => {
      const c = await shim('');
      expect(await c.remote.getConfig()).toEqual([]);
    });
    it('?remote=setup renders the QR state: enabled, password set, Tailscale url, no clients', async () => {
      const c = await shim('?remote=setup');
      const cfg = await c.remote.getConfig();
      expect(cfg).toMatchObject({ enabled: true, hasPassword: true, clientCount: 0 });
      const ts = await c.remote.detectTailscale();
      expect(ts).toMatchObject({ installed: true, connected: true });
      expect(ts.url).toMatch(/^https?:\/\//);
      expect(await c.remote.getClientList()).toEqual([]);
    });
    it('?remote=connected lists one phone', async () => {
      const c = await shim('?remote=connected');
      const cls = await c.remote.getClientList();
      expect(cls).toHaveLength(1);
      expect(cls[0]).toMatchObject({ id: expect.any(String), ip: expect.any(String), connectedAt: expect.any(Number) });
      expect((await c.remote.getConfig()).clientCount).toBe(1);
      expect(await c.remote.getClientCount()).toBe(1);
    });
    it('getStatus carries clientCount as a number, the shape the desktop answer and the socket give (audit W18)', async () => {
      const c = await shim('?remote=connected');
      const st = await c.remote.getStatus();
      expect(st).toMatchObject({ state: expect.any(String), port: expect.any(Number), clientCount: 1 });
    });
  });

  describe('takeover (lease) fake', () => {
    it('reports no holder without ?lease=', async () => {
      const c = await shim('?scenario=site');
      expect(await c.syncSpaces.leaseQuery('any')).toEqual({ held: false });
    });
    it('?lease=held:Pixel%209 reports another device and lets the takeover succeed', async () => {
      const c = await shim('?scenario=site&lease=held%3APixel%209');
      expect(await c.syncSpaces.leaseQuery('wb-past-1')).toEqual({ held: true, device: 'Pixel 9', self: false, source: 'workbench' });
      expect(await c.syncSpaces.leaseTakeover('wb-past-1')).toEqual({ outcome: 'ready' });
      expect(await c.syncSpaces.leaseForce('wb-past-1')).toEqual({ ok: true });
    });
  });

  describe('admission race fake', () => {
    it('a raced claim denies session creation without adding a session', async () => {
      const c = await shim('?lease=raced%3ALaptop');
      const before = await c.session.list();
      expect(await c.syncSpaces.leaseQuery('past')).toEqual({ held: false });
      expect(await c.session.create({ resumeSessionId: 'past' })).toEqual({ status: 'lease-denied', device: 'Laptop' });
      expect(await c.session.list()).toHaveLength(before.length);
    });

    it.each(['timeout', 'undeliverable'])('keeps %s separate from a confirmed handoff', async (outcome) => {
      const c = await shim(`?lease=${outcome}%3ALaptop`);
      expect(await c.syncSpaces.leaseTakeover('past')).toEqual({ outcome });
      expect(await c.session.create({ resumeSessionId: 'past' })).toEqual({ status: 'lease-denied', device: 'Laptop' });
      await c.syncSpaces.leaseForce('past');
      expect(await c.session.create({ resumeSessionId: 'past' })).toHaveProperty('id');
    });
  });

  describe('model favourites fake', () => {
    // ModelPicker keeps favourites in localStorage (no IPC); the shim seeds four
    // models from four companies when the key is absent, and never overwrites.
    const fakeStorage = (initial: Record<string, string> = {}) => {
      const m = new Map(Object.entries(initial));
      return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, map: m };
    };

    it('seeds Claude, DeepSeek, Grok and GPT favourites on a fresh origin, all resolving to catalog rows', async () => {
      const ls = fakeStorage();
      vi.stubGlobal('localStorage', ls);
      const c = await shim('?scenario=site&student=1');
      const favs: string[] = JSON.parse(ls.map.get('youcoded-model-favorites')!);
      const catalog: { id: string; providerId: string }[] = await c.providers.catalog();
      const keys = new Set(catalog.map((m) => `${m.providerId}:${m.id}`));
      for (const f of favs) expect(keys.has(f)).toBe(true);
      const labels = catalog.filter((m) => favs.includes(`${m.providerId}:${m.id}`)).map((m) => m.id);
      expect(labels).toEqual(expect.arrayContaining(['anthropic/claude-sonnet-4-6', 'deepseek/deepseek-v3.2', 'x-ai/grok-4', 'openai/gpt-5']));
      vi.unstubAllGlobals();
    });

    it('never overwrites favourites the reviewer already has', async () => {
      const ls = fakeStorage({ 'youcoded-model-favorites': '["local:llama3.1:8b"]' });
      vi.stubGlobal('localStorage', ls);
      await shim('?scenario=site');
      expect(ls.map.get('youcoded-model-favorites')).toBe('["local:llama3.1:8b"]');
      vi.unstubAllGlobals();
    });

    it('prices nothing: no catalog row carries a price, cost or free tag', async () => {
      const c = await shim('?scenario=site');
      for (const row of await c.providers.catalog()) {
        expect(JSON.stringify(row).toLowerCase()).not.toMatch(/price|cost|free/);
      }
    });
  });

  describe('marketplace install sticks (dev-only)', () => {
    it('Install adds Remember to the installed list, the packages map and the chip row; uninstall reverses all three', async () => {
      const c = await shim('?scenario=site&student=1');
      const before = await c.skills.list();
      expect(before.some((s: any) => s.id === 'remember')).toBe(false);
      expect((await c.skills.getChips()).some((x: any) => x.label === 'Remember')).toBe(false);

      await c.skills.install('remember');
      const after = await c.skills.list();
      expect(after.some((s: any) => s.id === 'remember' && s.displayName === 'Remember')).toBe(true);
      expect((await c.marketplace.getPackages()).remember?.status).toBe('installed');
      expect((await c.skills.getChips()).filter((x: any) => x.label === 'Remember')).toHaveLength(1);
      // Idempotent: a second install never doubles anything.
      await c.skills.install('remember');
      expect((await c.skills.getChips()).filter((x: any) => x.label === 'Remember')).toHaveLength(1);

      await c.skills.uninstall('remember');
      expect((await c.skills.list()).some((s: any) => s.id === 'remember')).toBe(false);
      expect((await c.marketplace.getPackages()).remember).toBeUndefined();
      expect((await c.skills.getChips()).some((x: any) => x.label === 'Remember')).toBe(false);
    });

    it('leaves the catalog (and its ratings) untouched by an install', async () => {
      const c = await shim('?scenario=site');
      const a = JSON.stringify(await c.skills.listMarketplace());
      await c.skills.install('remember');
      expect(JSON.stringify(await c.skills.listMarketplace())).toBe(a);
    });
  });

  describe('student project (student=1)', () => {
    it('lists Econ 201 first with files, two conversations and a context note; off, the developer projects are unchanged', async () => {
      const c = await shim('?scenario=site&student=1');
      const { projects } = await c.artifacts.listProjectsIndex({ withCounts: true });
      expect(projects[0].name).toBe('Econ 201');
      expect(projects[0].description).toMatch(/Microeconomics/);
      expect(projects[0].conversationCount).toBe(2);
      const { files } = await c.artifacts.listAllFiles(projects[0].id);
      const names = files.map((f: any) => f.path);
      expect(names).toEqual(expect.arrayContaining(['Q3-sales.xlsx', 'syllabus.md']));
      expect(names.some((n: string) => n.startsWith('lecture notes/'))).toBe(true);
      const { conversations } = await c.project.listConversations(projects[0].path);
      expect(conversations.map((x: any) => x.name).sort()).toEqual(['econ midterm brief', 'econ study guide']);
      const { groups } = await c.project.listContext(projects[0].path);
      const text = JSON.stringify(groups);
      expect(text).toContain('Second-year student. Keep explanations short.');
      expect(text).not.toMatch(/CLAUDE\.md|react-renderer/);
      // The drawer of any student session lists the spreadsheet.
      const { artifacts } = await c.artifacts.listSession('wb-new-1');
      expect(artifacts.map((a: any) => a.path)).toContain('Q3-sales.xlsx');

      const plain = await shim('?scenario=site');
      expect((await plain.artifacts.listProjectsIndex()).projects[0].name).toBe('youcoded');
      expect((await plain.artifacts.listSession('wb-new-1')).artifacts.map((a: any) => a.path)).not.toContain('Q3-sales.xlsx');
    });
  });

  describe('inline conversation-card resume', () => {
    it('initializes a chatsearch reference just like a browser-list resume', async () => {
      const c = await shim('?lease=held%3ALaptop');
      const hook = vi.fn();
      c.on.hookEvent(hook);
      await c.syncSpaces.leaseTakeover(CS_RESUMABLE);
      const created = await c.session.create({ name: 'Resuming...', resumeSessionId: CS_RESUMABLE });
      expect(created.name).toBe('Permission ask timeout');
      await vi.waitFor(() => expect(hook).toHaveBeenCalledWith(expect.objectContaining({ type: 'SessionStart', sessionId: created.id })));
    });
  });

  describe('resumed history (phone takeover)', () => {
    it('answers the first page of a resumed "econ midterm brief" with the briefing as finished history', async () => {
      const c = await shim('?scenario=site&student=1&lease=held%3ADesktop');
      expect(await c.syncSpaces.leaseQuery('wb-past-0')).toMatchObject({ held: true, device: 'Desktop' });
      const page = await c.detach.requestTranscriptPage({ sessionId: 'wb-new-1', beforeCursor: null, claudeSessionId: 'wb-past-0', projectSlug: 'Econ 201' });
      expect(page.hasMore).toBe(false);
      expect(page.events[0]).toMatchObject({ type: 'user-message', sessionId: 'wb-new-1', data: { text: "brief me on tomorrow's econ midterm" } });
      expect(page.events.some((e: any) => e.type === 'assistant-text' && /brief/i.test(e.data.text))).toBe(true);
      expect(page.events.at(-1).type).toBe('turn-complete');
      // App's first ask carries no locator (App.tsx loads a first page for every
      // session it knows); a session created by a resume still answers it.
      await c.syncSpaces.leaseTakeover('wb-past-0');
      const created = await c.session.create({ name: 'Resuming...', cwd: '/home/you/School/Econ 201', resumeSessionId: 'wb-past-0' });
      const bare = await c.detach.requestTranscriptPage({ sessionId: created.id, beforeCursor: null });
      expect(bare.events.length).toBe(page.events.length);
    });
    it('is an honest empty page for any other session, and outside student mode', async () => {
      const c = await shim('?scenario=site&student=1');
      expect(await c.detach.requestTranscriptPage({ sessionId: 'x', beforeCursor: null, claudeSessionId: 'wb-past-1' })).toEqual({ events: [], cursor: null, hasMore: false });
      const plain = await shim('?scenario=site');
      expect((await plain.detach.requestTranscriptPage({ sessionId: 'x', beforeCursor: null, claudeSessionId: 'wb-past-0' })).events).toEqual([]);
    });
  });

  describe('resuming a Resume row in the workbench', () => {
    it('names the new session after the row and sends the first hook event that lifts "Initializing session…"', async () => {
      const c = await shim('?scenario=site&student=1');
      const hooks: any[] = [];
      c.on.hookEvent((e: any) => hooks.push(e));
      const created = await c.session.create({ name: 'Resuming...', cwd: '/home/you/School/Econ 201', resumeSessionId: 'wb-past-0' });
      expect(created.name).toBe('econ midterm brief');
      await new Promise((r) => setTimeout(r, 120));
      expect(hooks).toEqual([expect.objectContaining({ type: 'SessionStart', sessionId: created.id })]);
      // A plain create is untouched: no hook, the given name.
      const plain = await c.session.create({ name: 'fresh', cwd: '/home/you' });
      await new Promise((r) => setTimeout(r, 120));
      expect(plain.name).toBe('fresh');
      expect(hooks).toHaveLength(1);
    });
  });
});
