// @vitest-environment jsdom
// mock-shim.ts — the UI Workbench's fake backend — in the parts that need a
// browser window: scenarios read off the URL (engine states) and the voice fake's
// window timers (mock contract). Everything else is in mock-shim.test.ts (node).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { createStore } from '../src/renderer/dev/workbench/mock-store';
import { createMockShim, setLatency, HAND_WRITTEN, createVoiceMock } from '../src/renderer/dev/workbench/mock-shim';
import { SCENARIO_IDS, type ScenarioId } from '../src/renderer/dev/workbench/scenarios';
import { MOCK_ONLY } from '../src/renderer/dev/workbench/mock-only';
import { fakeHomeAssistantReset } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import type { VoiceEvent } from '../src/shared/voice-types';
import { readSource } from './helpers/guard-scope';

setLatency(0);

// The local-engine states the WORKBENCH must be able to show.
//
// WHY THIS SECTION EXISTS. Destin signs UI off in the workbench, so a state the
// fake cannot produce is a state nobody ever looks at. Nothing noticed when one
// quietly disappeared: removing the advice line from the fake's quants,
// removing the reason under `refused`, and putting `onStatusChanged` back to a
// no-op stub all left the whole suite green — and each of those blanks out one
// of the five things T23 drew.
//
// These assert the FAKE, deliberately. The real backend has its own guards; the
// hazard here is the mock silently drifting away from it.
describe('site pages', () => {
  function pagesFor(scenario: 'site' | 'default' = 'site') {
    window.history.replaceState({}, '', `/?scenario=${scenario}`);
    return createMockShim(createStore(scenario)).pages as Required<NonNullable<Window['claude']['pages']>>;
  }
  afterEach(() => { fakeHomeAssistantReset(); vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

  it('uses everyday conversation shortcuts for public website visitors only', async () => {
    window.history.replaceState({}, '', '/?scenario=site');
    const site = createMockShim(createStore('site'));
    expect((await site.skills.getChips()).map((c: any) => c.label)).toEqual(['Journal', 'Inbox', 'Briefing', 'Draft Text']);
    window.history.replaceState({}, '', '/?scenario=default');
    const normal = createMockShim(createStore('default'));
    expect((await normal.skills.getChips()).map((c: any) => c.label)).toContain('Git Status');
  });

  it('lists only Office and the pinned Home and Finance using the existing pages', async () => {
    const pages = pagesFor();
    expect((await pages.list()).map(({ id, name, pinned }) => ({ id, name, pinned }))).toEqual([
      { id: 'builtin:office', name: 'Office', pinned: false },
      { id: 'page-home', name: 'Home', pinned: true },
      { id: 'page-money', name: 'Finance', pinned: true },
    ]);
    const normal = pagesFor('default');
    for (const id of ['page-home', 'page-money']) {
      const publicPage = await pages.get(id), original = await normal.get(id);
      expect(publicPage.ok && original.ok && publicPage.page.html === original.page.html).toBe(true);
    }
  });

  it('carries the same custom house through default and site page metadata', async () => {
    const expected = { version: 1, paths: ['M3 10 L12 3 L21 10', 'M5 9 L5 21 L10 21 L10 15 L14 15 L14 21 L19 21 L19 9'] };
    for (const scenario of ['default', 'site'] as const) {
      const pages = pagesFor(scenario);
      const summary = (await pages.list()).find(page => page.id === 'page-home');
      expect(summary?.icon).toBe('page');
      expect(summary?.customIcon).toEqual(expected);
      const document = await pages.get('page-home');
      expect(document.ok && document.page.customIcon).toEqual(expected);
    }
  });

  it('starts connected to a fictional house and operates fake controls without network access', async () => {
    vi.useFakeTimers();
    const outbound = vi.fn(() => { throw new Error('Network must not be used'); });
    vi.stubGlobal('fetch', outbound);
    const pages = pagesFor();
    const home = await pages.get('page-home');
    expect(home.ok).toBe(true);
    if (!home.ok) return;
    expect(home.page.connections?.[0]).toMatchObject({ approved: true, savedKey: true, address: 'home.demo.invalid:8123' });
    const read = async () => {
      const answer = pages.fetch('page-home', { url: 'http://home.demo.invalid:8123/api/template', method: 'POST', body: JSON.stringify({ template: 'namespace(rooms=[])' }) });
      await vi.advanceTimersByTimeAsync(150);
      const result = await answer;
      expect(result.ok).toBe(true);
      return result.ok ? JSON.parse(result.body) : [];
    };
    const rooms = await read();
    expect(rooms.find((r: any) => r.id === 'destins_room').name).toBe('Study');
    expect(rooms.flatMap((r: any) => r.items).some((t: any) => t.id.startsWith('camera.'))).toBe(false);
    expect(JSON.stringify(rooms.map((r: any) => [r.name, r.items.map((t: any) => t.name), r.scenes?.map((s: any) => s.name)]))).not.toMatch(/Destin|Grandma/i);
    const toggle = pages.fetch('page-home', { url: 'http://home.demo.invalid:8123/api/services/light/turn_on', method: 'POST', body: JSON.stringify({ entity_id: 'light.kitchen_pendants' }) });
    await vi.advanceTimersByTimeAsync(150);
    expect((await toggle).ok).toBe(true);
    expect((await read()).flatMap((r: any) => r.items).find((t: any) => t.id === 'light.kitchen_pendants').state).toBe('on');
    for (const op of ['connect', 'reconnect', 'sync', 'status'] as const) expect((await pages.plaid('page-money', { op } as any)).ok).toBe(false);
    expect((await pages.fetch('page-home', { url: 'https://example.com' })).ok).toBe(false);
    expect((await pages.fetch('page-home', { url: 'http://home.demo.invalid:8123/api/camera_proxy/camera.garage_pi' })).ok).toBe(false);
    expect((await pages.videoStart({ page: 'page-home', frame: 'f', connection: 'ha', target: 'camera.garage_pi', offer: 'v=0' })).ok).toBe(false);
    const heard: any[] = [];
    const off = pages.onSocketEvent((e) => heard.push(e));
    const call = { page: 'page-home', frame: 'f' };
    const opened = await pages.socketOpen({ ...call, url: 'http://home.demo.invalid:8123/api/websocket' });
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      await pages.socketSend({ ...call, socket: opened.socket, text: JSON.stringify({ id: 1, type: 'config/area_registry/list' }) });
      await pages.socketSend({ ...call, socket: opened.socket, text: JSON.stringify({ id: 2, type: 'subscribe_entities' }) });
      await vi.advanceTimersByTimeAsync(40);
      const messages = heard.flatMap((e) => e.texts ?? []).map((s: string) => JSON.parse(s));
      expect(messages.find((m: any) => m.id === 1).result[0].name).toBe('Study');
      expect(JSON.stringify(messages)).not.toMatch(/Destin|Grandma|camera\./);
      await pages.socketClose({ ...call, socket: opened.socket });
    }
    off();
    expect(outbound).not.toHaveBeenCalled();
  });

  it('keeps Finance edits in memory and resets without changing default fixtures', async () => {
    const pages = pagesFor();
    const finance = await pages.get('page-money');
    expect(finance.ok).toBe(true);
    if (!finance.ok) return;
    const data = finance.page.data as any;
    expect(data.accounts[0]).toMatchObject({ institution: 'Demo Community Bank', name: 'Everyday checking' });
    expect(JSON.stringify(data)).not.toMatch(/Capital One|American Express|Robinhood|Synchrony|Wells Fargo|Earnest|MOHELA|Destin/);
    await pages.setData('page-money', { ...data, settings: { ...data.settings, warnPct: 45 } });
    const edited = await pages.get('page-money');
    expect(edited.ok && (edited.page.data as any).settings.warnPct).toBe(45);
    const fresh = await pagesFor().get('page-money');
    expect(fresh.ok && (fresh.page.data as any).settings.warnPct).toBe(30);
    const normal = pagesFor('default');
    const money = await normal.get('page-money'), home = await normal.get('page-home');
    expect(money.ok && money.page.name).toBe('Money');
    expect(money.ok && (money.page.data as any).accounts[0].institution).toBe('Capital One');
    expect(home.ok && home.page.connections?.[0].approved).toBe(false);
    expect((await normal.list()).filter((p) => p.pinned).map((p) => p.id)).toEqual(['page-money', 'page-analytics', 'page-paint']);
  });
});

describe('engine states', () => {
  /** The scenario is read off the URL when the shim is built, so the URL is set
   *  first — the same way the workbench itself is driven. */
  function shimFor(query: string) {
    window.history.replaceState({}, '', query || '/');
    const asked = new URLSearchParams(query.replace(/^[^?]*/, '')).get('scenario') ?? 'default';
    // The workbench itself takes whatever the URL says; a name that is not a real
    // scenario here would silently seed `default` and make a test pass for the
    // wrong reason.
    const scenario = SCENARIO_IDS.find((id) => id === asked);
    if (!scenario) throw new Error(`not a workbench scenario: ${asked}`);
    return createMockShim(createStore(scenario as ScenarioId)) as any;
  }

  afterEach(() => { vi.useRealTimers(); window.history.replaceState({}, '', '/'); });

  describe('the workbench can show every local-engine state T23 draws', () => {
    it('a model that FAILED TO LOAD, so the red card in its settings is reviewable', async () => {
      const settings = await shimFor('/').models.settings('Qwen3.5-9B-Q8_0');
      expect(settings.lastLoadError).toBeTruthy();
      // A real llama-server line, not invented prose: the dialog quotes whatever
      // it is handed, so reviewing that card against a paraphrase reviews nothing.
      expect(settings.lastLoadError).toContain('not recognized in preset');
    });

    it('a size whose context memory is only a CEILING, so "up to" is reviewable', async () => {
      const rows = await shimFor('/').models.quants('unsloth/Qwen3.5-4B-GGUF');
      expect(rows.some((r: any) => r.fit.breakdown.contextBytesIsUpperBound === true)).toBe(true);
    });

    it('the advice line on every verdict that is not "fits" (R8)', async () => {
      const rows = await shimFor('/').models.quants('unsloth/Qwen3.5-4B-GGUF');
      for (const r of rows) {
        if (r.fit.fit === 'fits') expect(r.fit.breakdown.advice).toBeUndefined();
        else expect(r.fit.breakdown.advice).toBe("Lower this model's context length in its Settings to shrink this.");
      }
    });

    it('a save that is PENDING and then clears, which is what the dialog’s poll exists for', async () => {
      vi.useFakeTimers();
      const models = shimFor('/').models;
      const saved = await models.setSettings('Qwen3.5-9B-Q8_0', { keepLoaded: true });
      expect(saved.pendingApply).toBe(true);
      await vi.advanceTimersByTimeAsync(4100);
      expect((await models.settings('Qwen3.5-9B-Q8_0')).pendingApply).toBeUndefined();
    });

    it('an engine RUNNING WITHOUT each model’s settings, with the machine’s own reason', async () => {
      const status = await shimFor('/?scenario=refused').engine.status();
      // Only a running engine can be in this state at all.
      expect(status.state).toBe('running');
      expect(status.modelSettingsInForce).toBe(false);
      expect(status.modelSettingsError).toContain('EACCES');
    });

    it('…and the OTHER shape of that message, where no reason came back', async () => {
      // Two shapes that look nothing alike — an amber box quoting the machine, and
      // a grey block with two buttons and no quote. Signing off the first says
      // nothing about the second, so both have to be reachable.
      const status = await shimFor('/?scenario=refused&reason=none').engine.status();
      expect(status.modelSettingsInForce).toBe(false);
      expect(status.modelSettingsError).toBeNull();
    });

    it('the settings are in force everywhere else, and unanswered on a stopped engine', async () => {
      expect((await shimFor('/?scenario=stress').engine.status()).modelSettingsInForce).toBe(true);
      // `undefined`, never `false`: a stopped engine has no run to report on.
      expect((await shimFor('/').engine.status()).modelSettingsInForce).toBeUndefined();
    });

    it('a saved engine setting that has not landed yet — and a REAL status push that clears it', async () => {
      vi.useFakeTimers();
      const engine = shimFor('/').engine;
      const seen: any[] = [];
      const off = engine.onStatusChanged((s: any) => seen.push(s));
      // A no-op registrar (what this was before) leaves the card showing the
      // pending line for ever: the card learns the change landed ONLY from a push.
      expect(typeof off).toBe('function');
      const after = await engine.setConfig({ speed: { speculative: false } });
      expect(after.configApplyPending).toBe(true);
      await vi.advanceTimersByTimeAsync(4100);
      expect(seen).toHaveLength(1);
      expect(seen[0].configApplyPending).toBe(false);
      off();
    });

    it('an apply that FAILS, which is the only place its real message can be shown', async () => {
      vi.useFakeTimers();
      const engine = shimFor('/?scenario=refused').engine;
      expect((await engine.status()).configApplyError).toBeNull();
      await engine.setConfig({ speed: { compressCache: false } });
      await vi.advanceTimersByTimeAsync(4100);
      expect((await engine.status()).configApplyError).toContain('EACCES');
    });
  });
});

// jsdom (rather than this suite's default `node`) because the voice-fake block below
// RUNS the workbench's voice fake, which schedules its scripted words with
// `window.setTimeout`. Every other test in this section is a static scan.
// WHY (small-fixes-1): the practice backend's openExternal called window.open, so a practice
// screen pressing "Continue in GitHub" opened a real github.com sign-in page inside the
// screenshot browser, which hid the app's tab and hung the screens after it. The practice app
// must never open an outside page; it only remembers the address.
describe('outside pages', () => {
  afterEach(() => { vi.restoreAllMocks(); delete (globalThis as any).__workbenchOpenedUrls; });

  it('openExternal opens nothing and remembers the address', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const shim = createMockShim(createStore('default')) as any;
    await shim.shell.openExternal('https://github.com/itsdestin/youcoded/issues/new');
    expect(open).not.toHaveBeenCalled();
    expect((globalThis as any).__workbenchOpenedUrls).toEqual(['https://github.com/itsdestin/youcoded/issues/new']);
  });
});

describe('mock contract', () => {
  // WHY the channel checks below still read preload.ts and remote-shim.ts as text
  // (Plan B source-grep sweep, 2026-09-16, row "channel parity stays"): they compare
  // the mock's RUN-TIME lists (HAND_WRITTEN, MOCK_ONLY) with what the two real
  // bridges declare — a cross-file check against values built at run time, which no
  // ast-grep rule or type can express. readSource strips Windows line endings first.
  const preload = readSource(join(__dirname, '../src/main/preload.ts'));
  // remote-shim is the OTHER real implementation of window.claude — a handful of
  // channels can exist only there (a remote-only push). "Mirrors something real" has to mean
  // either file, or the mock would be forced to declare a real channel MOCK_ONLY.
  const remoteShim = readSource(join(__dirname, '../src/renderer/remote-shim.ts'));
  const mockOnly = new Set(MOCK_ONLY.map((m) => m.channel));

  // WHY namespace-scoped and not a bare `\blist\s*:` over the whole file: `list:`
  // exists under session, tags, providers, theme and more, so a file-wide regex
  // matches a channel that lives in a DIFFERENT namespace than the one the mock
  // claims. The test would read green while proving nothing — worse than absent,
  // because it is cited as the thing keeping the mock honest.
  //
  // preload.ts's exposed object puts namespaces at indent 2 (`  session: {`) and
  // their members at indent 4, so scoping is a brace scan rather than a guess.
  function namespaceBlock(ns: string): string | null {
    const start = preload.search(new RegExp(`^  ${ns}: \\{`, 'm'));
    if (start < 0) return null;
    const end = preload.indexOf('\n  },', start);
    return end < 0 ? preload.slice(start) : preload.slice(start, end);
  }

  /** `'session.list'` -> is there a `list` inside preload's `session` block?
   *  A dotless path like `'getPlatform'` is a top-level bridge member (indent 2). */
  function existsInPreload(path: string): boolean {
    const parts = path.split('.');
    if (parts.length === 1) {
      return new RegExp(`^  ${parts[0]}\\s*[:(]`, 'm').test(preload);
    }
    const block = namespaceBlock(parts[0]);
    return !!block && new RegExp(`^    ${parts[1]}\\s*[:(]`, 'm').test(block);
  }

  // remote-shim nests its namespaces one level deeper than preload (indent 4, with
  // members at indent 6), so it needs its own brace scan rather than reusing
  // namespaceBlock's indent-2 pattern.
  function remoteShimNamespaceBlock(ns: string): string | null {
    const start = remoteShim.search(new RegExp(`^    ${ns}: \\{`, 'm'));
    if (start < 0) return null;
    const end = remoteShim.indexOf('\n    },', start);
    return end < 0 ? remoteShim.slice(start) : remoteShim.slice(start, end);
  }

  /** `'on.something'` -> is there a `something` inside remote-shim's `on` block?
   *
   *  WHY namespace-scoped and not a bare leaf match (which is what this was until
   *  2026-08-11): a leaf regex reports `permissions.list` as REAL because some
   *  other namespace happens to have a `list:`. That false positive made the
   *  MOCK_ONLY staleness check below fail the moment MOCK_ONLY got its first
   *  entries — the check would have kept firing for any future `*.list` or
   *  `*.remove` channel too. Scoping is strictly stronger; `on.something`, the
   *  one channel that legitimately relies on this fallback, still resolves. */
  function existsInRemoteShim(path: string): boolean {
    const parts = path.split('.');
    if (parts.length === 1) {
      return new RegExp(`\\b${parts[0]}\\s*:`).test(remoteShim);
    }
    const block = remoteShimNamespaceBlock(parts[0]);
    return !!block && new RegExp(`^      ${parts[1]}\\s*[:(]`, 'm').test(block);
  }

  function existsSomewhereReal(path: string): boolean {
    return existsInPreload(path) || existsInRemoteShim(path);
  }

  describe('workbench mock contract', () => {
    // What this protects: the namespace scoping every parity case below relies on.
    // It pins product facts about preload.ts — session.list, the top-level
    // getPlatform and theme.readFile are exposed; memoryCheck lives under
    // `models`, not `session` — and that a channel in the wrong namespace does not
    // resolve. If preload is reformatted so the scan finds nothing, the parity
    // cases would pass vacuously; this fails instead.
    it('the preload scan actually resolves known channels', () => {
      expect(existsInPreload('session.list')).toBe(true);
      expect(existsInPreload('getPlatform')).toBe(true);
      expect(existsInPreload('theme.readFile')).toBe(true);
      expect(existsInPreload('session.thisDoesNotExist')).toBe(false);
      // The bug the scoping exists to catch: `memoryCheck` is real, but it lives
      // in `models`, not `session`. A file-wide regex would call this true.
      expect(existsInPreload('session.memoryCheck')).toBe(false);
      expect(existsInPreload('models.memoryCheck')).toBe(true);
    });

    // What this protects: remote-shim's namespace scoping, which the fallback and
    // MOCK_ONLY staleness cases below rely on. It pins product facts about
    // remote-shim.ts — session.open (both bridges), providers.list and
    // permissions.list are exposed; there is no notifications namespace — so a
    // scan that resolved nothing, or matched a leaf in the wrong namespace, fails
    // here instead of letting those cases pass vacuously.
    it('the remote-shim scan actually resolves known channels', () => {
      expect(existsInRemoteShim('session.open')).toBe(true);
      expect(existsInRemoteShim('providers.list')).toBe(true);
      expect(existsInRemoteShim('on.thisDoesNotExist')).toBe(false);
      // The false positive that scoping exists to kill. This probe used to be
      // `permissions.list` / `permissions.remove`, which stopped proving anything
      // the moment permissions gained a real remote-shim namespace (M5 2a) — a
      // probe has to name something that genuinely does NOT exist. `notifications`
      // has no namespace in the shim, while `list:` and `remove:` are real leaves
      // elsewhere in the file, so an unscoped leaf match would resolve these.
      expect(existsInRemoteShim('notifications.list')).toBe(false);
      expect(existsInRemoteShim('notifications.remove')).toBe(false);
      // ...and permissions, which DID gain one, must now resolve.
      expect(existsInRemoteShim('permissions.list')).toBe(true);
    });

    // The rule that keeps UI-first development honest: a hand-written channel
    // either mirrors something real, or is registered as not-yet-built.
    it('every hand-written channel is real or registered MOCK_ONLY', () => {
      const orphans = HAND_WRITTEN.filter((p) => !mockOnly.has(p) && !existsSomewhereReal(p));
      expect(orphans).toEqual([]);
    });

    // The preload scan is the strict one, so record which channels rely on the
    // looser remote-shim fallback. If this list grows unexpectedly, something is
    // passing on a leaf match that the namespace-scoped scan would have caught.
    it('only the known channels fall back to remote-shim', () => {
      const shimOnly = HAND_WRITTEN.filter((p) => !existsInPreload(p) && existsInRemoteShim(p));
      expect(shimOnly).toEqual([]);
    });

    // A stale registry is worse than none — it would keep claiming a feature is
    // unbuilt after it shipped.
    it('no MOCK_ONLY entry has since gained a real channel', () => {
      expect(MOCK_ONLY.filter((m) => existsSomewhereReal(m.channel))).toEqual([]);
    });

    it('every MOCK_ONLY entry names the feature it belongs to', () => {
      expect(MOCK_ONLY.filter((m) => !m.feature.trim())).toEqual([]);
    });

    // DERIVED from preload.ts rather than hand-listed, because a hand-list is
    // exactly what failed: the mock's top-level members were enumerated from
    // useIpc.ts, which omits getIncognito — and `window.claude?.getIncognito is
    // not a function` took the app down at boot. A new top-level callable in
    // preload now fails this test instead of the workbench.
    it('implements every top-level callable preload exposes', () => {
      const exposed = preload.slice(preload.indexOf("exposeInMainWorld('claude'"));
      // Filter in JS, not with a lookahead: `(?!\{)` after `\s*` backtracks the
      // whitespace to zero-width and then passes, so namespaces match too.
      const topLevel = [...exposed.matchAll(/^ {2}([a-zA-Z_]\w*):(.*)$/gm)]
        .filter(([, , rest]) => !rest.trim().startsWith('{'))
        .map(([, name]) => name);

      // Sanity: if this scan returns nothing the assertion below is vacuous.
      expect(topLevel).toContain('getIncognito');
      expect(topLevel.length).toBeGreaterThanOrEqual(10);

      const written = new Set(HAND_WRITTEN);
      expect(topLevel.filter((m) => !written.has(m))).toEqual([]);
    });
  });

  // The workbench fake is the surface the voice UI is actually designed against,
  // so it has to obey the same event contract as the real host (voice-types.ts):
  // `cancel` emits nothing, `stop` emits exactly one `final`. The fake used to
  // answer a cancel with an empty `final` — which reads as "the mic closed and
  // heard nothing", i.e. a finished utterance — so a composer that trusts the
  // contract would have cleared text on cancel that the real app keeps.
  describe('the workbench voice fake', () => {
    /** Start the fake, let it "hear" a few seconds of its scripted sentence, and
     *  hand back the recorder so the caller can clear it and watch what one more
     *  call emits. */
    async function listening() {
      const voice = createVoiceMock(null);
      const seen: VoiceEvent[] = [];
      voice.onEvent((e) => seen.push(e));
      await voice.start();
      await vi.advanceTimersByTimeAsync(3000);
      // Sanity: without this, every assertion below would pass just as well on a
      // fake that never started listening at all.
      expect(seen.some((e) => e.type === 'partial')).toBe(true);
      seen.length = 0;
      return { voice, seen };
    }

    // WHY these two exist: reviewing T1 (2026-09-05) both of the behaviours below were
    // MUTATED — the split reverted to the old hard-coded "grey the last two words", and
    // the heartbeat emit deleted — and the whole suite stayed green. A guard that cannot
    // fail on the exact regression it was written for is not a guard. The two-word split
    // is what made the reviewed behaviour and the shipped behaviour two different things,
    // which is the reason this task existed at all.
    it("the fake greys by sentence, not by a fixed number of words", async () => {
      vi.useFakeTimers();
      try {
        const voice = createVoiceMock(null);
        const seen: VoiceEvent[] = [];
        voice.onEvent((e) => seen.push(e));
        await voice.start();
        // Long enough for the script to pass its question mark.
        await vi.advanceTimersByTimeAsync(8000);
        const partials = seen.filter((e): e is Extract<VoiceEvent, { type: 'partial' }> => e.type === 'partial');
        expect(partials.length).toBeGreaterThan(3);
        // Every solid half ends at a sentence mark (or is empty, before the first one).
        for (const p of partials) {
          if (p.committed) expect(p.committed.trimEnd()).toMatch(/[.?!]$/);
        }
        // And the grey half is NOT always two words — that is the old rule.
        expect(partials.some((p) => p.tail.split(' ').filter(Boolean).length !== 2)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('the fake pushes a heartbeat with every partial', async () => {
      vi.useFakeTimers();
      try {
        const voice = createVoiceMock(null);
        const seen: VoiceEvent[] = [];
        voice.onEvent((e) => seen.push(e));
        await voice.start();
        await vi.advanceTimersByTimeAsync(4000);
        const partials = seen.filter((e) => e.type === 'partial').length;
        const beats = seen.filter((e) => e.type === 'heartbeat').length;
        expect(partials).toBeGreaterThan(0);
        // The composer's watchdog arms when heartbeats STOP, so a fake that never
        // sends them would make the watchdog fire during every workbench review.
        expect(beats).toBe(partials);
      } finally {
        vi.useRealTimers();
      }
    });

    // The silence stop fires on its own once the script runs out. A `stop()` after
    // that used to emit a SECOND `final` — and a composer that trusts the contract
    // ("never zero and never two") would paste the whole utterance twice. Reachable
    // in a review pane by holding Space longer than the ~13 s script.
    it('a stop after the fake has already closed itself emits no second final', async () => {
      vi.useFakeTimers();
      try {
        const voice = createVoiceMock(null);
        const seen: VoiceEvent[] = [];
        voice.onEvent((e) => seen.push(e));
        await voice.start();
        // Past the end of the script AND its two quiet seconds.
        await vi.advanceTimersByTimeAsync(30000);
        expect(seen.filter((e) => e.type === 'final')).toHaveLength(1);
        await voice.stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(seen.filter((e) => e.type === 'final')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("the fake's cancel emits no final", async () => {
      vi.useFakeTimers();
      try {
        const { voice, seen } = await listening();
        await voice.cancel();
        await vi.advanceTimersByTimeAsync(5000);
        expect(seen).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("the fake's stop emits exactly one final", async () => {
      vi.useFakeTimers();
      try {
        const { voice, seen } = await listening();
        await voice.stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(seen.filter((e) => e.type === 'final')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('the fake offers the two desktop-only members the composer gates on', async () => {
      const voice = createVoiceMock(null);
      // The composer decides "does this computer capture its own audio?" by
      // testing for these; a fake without them sends every review pane down the
      // Android path, which opens no microphone and composes no readiness.
      expect(typeof voice.sendAudio).toBe('function');
      expect(typeof voice.micAccess).toBe('function');
      await expect(voice.micAccess!()).resolves.toBe('granted');
    });

    it('the fake download passes through unpacking before ready', async () => {
      vi.useFakeTimers();
      try {
        const voice = createVoiceMock('needs-download');
        const states: string[] = [];
        voice.onEvent((e) => { if (e.type === 'readiness') states.push(e.readiness.state); });
        await voice.download();
        await vi.advanceTimersByTimeAsync(20_000);
        // The unpack is the longest single wait of the first run; if the fake
        // skipped it, that card would never be reviewed by anyone.
        expect(states).toContain('unpacking');
        expect(states.indexOf('unpacking')).toBeLessThan(states.indexOf('ready'));
        expect(states[states.length - 1]).toBe('ready');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// The Home page's "first answer" hold (2026-10-05 review F1/F2): only a page that will ask the house holds the shoot tool, and it says how long.
describe('the Home page first-answer hold while shooting', () => {
  const w = window as unknown as { __shootInflight?: number; __shootHoldUntil?: number };
  afterEach(() => { delete w.__shootInflight; delete w.__shootHoldUntil; vi.useRealTimers(); window.history.replaceState({}, '', '/'); });
  const shim = (query: string) => { window.history.replaceState({}, '', query); return (createMockShim(createStore('default')) as any).pages; };

  it('holds, and publishes a deadline the shoot tool waits for, once the page has an approved device connection', async () => {
    w.__shootInflight = 0;
    await shim('/?pagesHome=connected').get('page-home');
    expect(w.__shootInflight).toBe(1);
    expect(w.__shootHoldUntil).toBeGreaterThan(performance.now());
  });

  it('takes no hold on the approval screen, where no request is ever made', async () => {
    w.__shootInflight = 0;
    await shim('/').get('page-home');
    expect(w.__shootInflight).toBe(0);
    expect(w.__shootHoldUntil).toBeUndefined();
  });
});
