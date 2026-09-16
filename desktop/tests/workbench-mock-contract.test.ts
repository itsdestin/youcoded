// @vitest-environment jsdom
//
// jsdom (rather than this suite's default `node`) because the last block below
// RUNS the workbench's voice fake, which schedules its scripted words with
// `window.setTimeout`. Every other test here is a static scan and does not care.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HAND_WRITTEN, createVoiceMock } from '../src/renderer/dev/workbench/mock-shim';
import { MOCK_ONLY } from '../src/renderer/dev/workbench/mock-only';
import type { VoiceEvent } from '../src/shared/voice-types';

const preload = readFileSync(join(__dirname, '../src/main/preload.ts'), 'utf8');
// remote-shim is the OTHER real implementation of window.claude — a handful of
// channels (on.chatHydrate) exist only there, because Electron clients get the
// same data from the transcript watcher. "Mirrors something real" has to mean
// either file, or the mock would be forced to declare a real channel MOCK_ONLY.
const remoteShim = readFileSync(join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8');
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

/** `'on.chatHydrate'` -> is there a `chatHydrate` inside remote-shim's `on` block?
 *
 *  WHY namespace-scoped and not a bare leaf match (which is what this was until
 *  2026-08-11): a leaf regex reports `permissions.list` as REAL because some
 *  other namespace happens to have a `list:`. That false positive made the
 *  MOCK_ONLY staleness check below fail the moment MOCK_ONLY got its first
 *  entries — the check would have kept firing for any future `*.list` or
 *  `*.remove` channel too. Scoping is strictly stronger; `on.chatHydrate`, the
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
  // Sanity: if the scan itself breaks (preload reformatted, object moved), every
  // other assertion in this file silently passes. Pin known-real channels.
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

  // Same sanity guard for the shim scan: if it silently resolved nothing, the
  // MOCK_ONLY staleness check below would pass vacuously.
  it('the remote-shim scan actually resolves known channels', () => {
    expect(existsInRemoteShim('on.chatHydrate')).toBe(true);
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
    expect(shimOnly).toEqual(['on.chatHydrate']);
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
