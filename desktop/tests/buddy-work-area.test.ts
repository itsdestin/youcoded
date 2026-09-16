import { describe, it, expect, vi } from 'vitest';
import type { Display } from 'electron';
import {
  parseAvailableScreenRect,
  matchScreens,
  containedIn,
  WorkAreaResolver,
  type WorkAreaDeps,
} from '../src/main/buddy-work-area';
import type { KdeScreen, KdeSession, KdeCallResult } from '../src/main/kde-dbus';
import type { Rect } from '../src/shared/buddy-geometry';

/**
 * WHAT THESE TESTS PROVE, AND WHAT THEY DO NOT (design §9).
 *
 * Every multi-screen case below is SYNTHETIC: this file authors both the
 * Electron display inventory and the KDE screen inventory, so it has made the
 * two number sources agree by construction. That is exactly the thing that is
 * in doubt on real hardware. What is proven here is that the mapping, the
 * intersection and the containment check behave correctly GIVEN agreement —
 * plus the parse and failure semantics, which are pure and have no hardware in
 * them at all.
 *
 * Not proven, and only a real two-screen run can settle it (Destin deferred it,
 * 2026-09-04): whether Electron and KWin round a non-primary screen's ORIGIN
 * identically; what coordinate space availableScreenRect answers in on a
 * second screen; what an unknown screen name returns on a multi-screen system.
 * The containment check exists precisely so those unknowns degrade to "the
 * buddy sits 52 px low on the right monitor" instead of "the buddy is pinned to
 * the wrong monitor and cannot be dragged back".
 */

const LITERAL_OK = '[Argument: (iiii) 0, 0, 1707, 1015]\n';
// Measured verbatim, 2026-09-04: this arrives on STDOUT at exit 0.
const STDOUT_ERROR = "qdbus: I don't know how to display an argument of type '(iiii)', run with --literal.\n";

describe('parseAvailableScreenRect', () => {
  it('parses the --literal success line', () => {
    expect(parseAvailableScreenRect(LITERAL_OK)).toEqual({ x: 0, y: 0, width: 1707, height: 1015 });
  });

  it('parses a negative origin (a screen placed left of the primary)', () => {
    expect(parseAvailableScreenRect('[Argument: (iiii) -1920, -100, 1920, 1040]')).toEqual({
      x: -1920, y: -100, width: 1920, height: 1040,
    });
  });

  it('rejects the "I don\'t know how to display" line that arrives on stdout at exit 0', () => {
    expect(parseAvailableScreenRect(STDOUT_ERROR)).toBeNull();
  });

  it('rejects empty stdout', () => {
    expect(parseAvailableScreenRect('')).toBeNull();
    expect(parseAvailableScreenRect('   \n')).toBeNull();
  });

  it('rejects a malformed or truncated struct rather than producing a partial rect', () => {
    expect(parseAvailableScreenRect('[Argument: (iiii) 0, 0, 1707]')).toBeNull();
    expect(parseAvailableScreenRect('0, 0, 1707, 1015')).toBeNull();
    expect(parseAvailableScreenRect('[Argument: (iiii) a, b, c, d]')).toBeNull();
  });

  it('rejects a zero-area rect — a malformed answer, not an answer', () => {
    expect(parseAvailableScreenRect('[Argument: (iiii) 0, 0, 0, 0]')).toBeNull();
    expect(parseAvailableScreenRect('[Argument: (iiii) 0, 0, 1707, 0]')).toBeNull();
  });
});

function kdeScreen(name: string, bounds: Rect, enabled = true, scale = 1): KdeScreen {
  return { name, enabled, bounds, scale };
}

const LAPTOP: Rect = { x: 0, y: 0, width: 1707, height: 1067 };
const TV: Rect = { x: 1707, y: 0, width: 1920, height: 1080 };

describe('matchScreens', () => {
  it('matches an Electron display to the KDE screen with the same bounds', () => {
    const map = matchScreens([{ id: 1, bounds: LAPTOP }], [kdeScreen('eDP-1', LAPTOP)]);
    expect(map.get(1)?.map((s) => s.name)).toEqual(['eDP-1']);
  });

  it('skips screens whose Enabled is not 1, so a stale disabled output cannot shadow the primary', () => {
    const map = matchScreens(
      [{ id: 1, bounds: LAPTOP }],
      [kdeScreen('DP-3', LAPTOP, false), kdeScreen('eDP-1', LAPTOP)],
    );
    expect(map.get(1)?.map((s) => s.name)).toEqual(['eDP-1']);
  });

  it('leaves a display unmatched when every KDE screen is disabled', () => {
    const map = matchScreens([{ id: 1, bounds: LAPTOP }], [kdeScreen('eDP-1', LAPTOP, false)]);
    expect(map.has(1)).toBe(false);
  });

  it('matches within 2 px — Electron and KWin round fractional scaling differently', () => {
    const nudged = { x: 1, y: -1, width: 1706, height: 1069 };
    const map = matchScreens([{ id: 1, bounds: LAPTOP }], [kdeScreen('eDP-1', nudged)]);
    expect(map.get(1)?.map((s) => s.name)).toEqual(['eDP-1']);
  });

  it('does not match a 3 px disagreement', () => {
    const off = { x: 3, y: 0, width: 1707, height: 1067 };
    expect(matchScreens([{ id: 1, bounds: LAPTOP }], [kdeScreen('eDP-1', off)]).has(1)).toBe(false);
  });

  it('returns both candidates when two KDE screens share a geometry (Plasma mirroring)', () => {
    const map = matchScreens(
      [{ id: 1, bounds: LAPTOP }],
      [kdeScreen('eDP-1', LAPTOP), kdeScreen('HDMI-A-1', LAPTOP)],
    );
    expect(map.get(1)?.map((s) => s.name)).toEqual(['eDP-1', 'HDMI-A-1']);
  });

  it('omits an Electron display that matches nothing KDE reports', () => {
    const map = matchScreens(
      [{ id: 1, bounds: LAPTOP }, { id: 2, bounds: TV }],
      [kdeScreen('eDP-1', LAPTOP)],
    );
    expect(map.has(1)).toBe(true);
    expect(map.has(2)).toBe(false);
  });

  it('never references a KDE screen that no Electron display matches (the reverse case)', () => {
    const map = matchScreens([{ id: 1, bounds: LAPTOP }], [kdeScreen('eDP-1', LAPTOP), kdeScreen('DP-2', TV)]);
    const referenced = [...map.values()].flat().map((s) => s.name);
    expect(referenced).toEqual(['eDP-1']);
  });

  it('maps three screens, including one at a negative offset, to the right names', () => {
    const left: Rect = { x: -1920, y: 0, width: 1920, height: 1080 };
    const map = matchScreens(
      [{ id: 1, bounds: LAPTOP }, { id: 2, bounds: TV }, { id: 3, bounds: left }],
      // Deliberately listed in a different order than Electron reports them.
      [kdeScreen('DP-4', left, true, 1), kdeScreen('HDMI-A-1', TV, true, 1), kdeScreen('eDP-1', LAPTOP, true, 1.5)],
    );
    expect(map.get(1)?.map((s) => s.name)).toEqual(['eDP-1']);
    expect(map.get(2)?.map((s) => s.name)).toEqual(['HDMI-A-1']);
    expect(map.get(3)?.map((s) => s.name)).toEqual(['DP-4']);
  });
});

describe('containedIn', () => {
  it('accepts a work area inside its own screen, panel reserved', () => {
    expect(containedIn({ x: 0, y: 0, width: 1707, height: 1015 }, LAPTOP)).toBe(true);
  });

  it('accepts a work area identical to the screen (no panel, or auto-hidden)', () => {
    expect(containedIn(LAPTOP, LAPTOP)).toBe(true);
  });

  it('rejects another monitor\'s rectangle — the mis-match that would pin the buddy off-screen', () => {
    expect(containedIn({ x: 1707, y: 0, width: 1920, height: 1040 }, LAPTOP)).toBe(false);
  });

  it('rejects a rectangle that starts inside but runs past the edge', () => {
    expect(containedIn({ x: 0, y: 0, width: 1920, height: 1015 }, LAPTOP)).toBe(false);
    expect(containedIn({ x: -1, y: 0, width: 100, height: 100 }, LAPTOP)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The resolver's lifecycle, with every outside call injected.
// ---------------------------------------------------------------------------

function display(id: number, bounds: Rect, workArea: Rect = bounds): Display {
  // Only the four fields the resolver reads; cast because Electron's Display
  // carries a dozen more that no code path here touches.
  return { id, bounds, workArea } as unknown as Display;
}

function session(screens: KdeScreen[]): KdeSession {
  return { kwinMajor: 6, wayland: true, screens };
}

function makeResolver(overrides: Partial<WorkAreaDeps> & { screens?: KdeScreen[] } = {}) {
  const { screens, ...deps } = overrides;
  const base: WorkAreaDeps = {
    listDisplays: async () => [{ id: 1, bounds: LAPTOP }],
    readSession: async () => session(screens ?? [kdeScreen('eDP-1', LAPTOP, true, 1.5)]),
    callScreenRect: async () => ({ ok: true, stdout: LITERAL_OK }) as KdeCallResult,
    wait: async () => {},
    ...deps,
  };
  return new WorkAreaResolver(base);
}

describe('WorkAreaResolver', () => {
  it('is not ready until a refresh has settled', async () => {
    const resolver = makeResolver();
    expect(resolver.ready).toBe(false);
    await resolver.refresh();
    expect(resolver.ready).toBe(true);
  });

  it('serves the DBus work area, not Electron\'s full-screen rectangle', async () => {
    const resolver = makeResolver();
    await resolver.refresh();
    expect(resolver.areaFor(display(1, LAPTOP))).toEqual({
      rect: { x: 0, y: 0, width: 1707, height: 1015 },
      resolved: true,
    });
  });

  it('asks plasmashell for the KDE screen NAME, which Electron cannot supply', async () => {
    const callScreenRect = vi.fn(async () => ({ ok: true, stdout: LITERAL_OK }) as KdeCallResult);
    await makeResolver({ callScreenRect }).refresh();
    expect(callScreenRect).toHaveBeenCalledWith('eDP-1');
  });

  it('falls back unresolved when the call exits non-zero', async () => {
    const resolver = makeResolver({
      callScreenRect: async () => ({ ok: false, reason: 'qdbus: Cannot find \'/StrutManager\'' }),
    });
    await resolver.refresh();
    expect(resolver.areaFor(display(1, LAPTOP))).toEqual({ rect: LAPTOP, resolved: false });
  });

  it('falls back unresolved when the call exits 0 but writes its error to stdout', async () => {
    // The trap this whole module exists for: exit 0, stdout is a sentence.
    const resolver = makeResolver({
      callScreenRect: async () => ({ ok: true, stdout: STDOUT_ERROR }),
    });
    await resolver.refresh();
    const area = resolver.areaFor(display(1, LAPTOP));
    expect(area.resolved).toBe(false);
    expect(area.rect).toEqual(LAPTOP);
    // Never a zero rect — that would clamp the buddy to a single point.
    expect(area.rect.width).toBeGreaterThan(0);
    expect(area.rect.height).toBeGreaterThan(0);
  });

  it('falls back unresolved on empty stdout', async () => {
    const resolver = makeResolver({ callScreenRect: async () => ({ ok: true, stdout: '' }) });
    await resolver.refresh();
    expect(resolver.areaFor(display(1, LAPTOP)).resolved).toBe(false);
  });

  it('falls back unresolved when KWin itself does not answer', async () => {
    const resolver = makeResolver({ readSession: async () => null });
    await resolver.refresh();
    expect(resolver.areaFor(display(1, LAPTOP))).toEqual({ rect: LAPTOP, resolved: false });
  });

  it('falls back unresolved for a display KDE does not report', async () => {
    const resolver = makeResolver({
      listDisplays: async () => [{ id: 1, bounds: LAPTOP }, { id: 2, bounds: TV }],
      screens: [kdeScreen('eDP-1', LAPTOP)],
    });
    await resolver.refresh();
    expect(resolver.areaFor(display(1, LAPTOP)).resolved).toBe(true);
    expect(resolver.areaFor(display(2, TV))).toEqual({ rect: TV, resolved: false });
  });

  it('DISCARDS a rect that is not inside the display it was resolved for', async () => {
    // The severe case: display 1 is the laptop, but the answer describes the TV.
    // Accepting it would clamp every drag frame to another monitor's x-range and
    // leave the buddy pinned there, undraggable.
    const resolver = makeResolver({
      callScreenRect: async () => ({ ok: true, stdout: '[Argument: (iiii) 1707, 0, 1920, 1040]' }),
    });
    await resolver.refresh();
    expect(resolver.areaFor(display(1, LAPTOP))).toEqual({ rect: LAPTOP, resolved: false });
  });

  it('intersects the candidates when two mirrored screens share a geometry', async () => {
    const rects: Record<string, string> = {
      // One reserves a 52 px bottom panel, the other a 40 px top panel.
      'eDP-1': '[Argument: (iiii) 0, 0, 1707, 1015]',
      'HDMI-A-1': '[Argument: (iiii) 0, 40, 1707, 1027]',
    };
    const resolver = makeResolver({
      screens: [kdeScreen('eDP-1', LAPTOP), kdeScreen('HDMI-A-1', LAPTOP)],
      callScreenRect: async (name) => ({ ok: true, stdout: rects[name] }),
    });
    await resolver.refresh();
    // Never larger than either candidate, so the mascot cannot land on a panel
    // that either output reserves.
    expect(resolver.areaFor(display(1, LAPTOP))).toEqual({
      rect: { x: 0, y: 40, width: 1707, height: 975 },
      resolved: true,
    });
  });

  it('does not half-resolve a mirrored pair when one candidate fails', async () => {
    const resolver = makeResolver({
      screens: [kdeScreen('eDP-1', LAPTOP), kdeScreen('HDMI-A-1', LAPTOP)],
      callScreenRect: async (name) =>
        name === 'eDP-1'
          ? { ok: true, stdout: LITERAL_OK }
          : { ok: false, reason: 'Error: org.freedesktop.DBus.Error.ServiceUnknown' },
    });
    await resolver.refresh();
    expect(resolver.areaFor(display(1, LAPTOP)).resolved).toBe(false);
  });

  it('retries with backoff while it has never resolved anything', async () => {
    const waits: number[] = [];
    const callScreenRect = vi.fn(async () => ({ ok: false, reason: 'boom' }) as KdeCallResult);
    await makeResolver({ wait: async (ms) => { waits.push(ms); }, callScreenRect }).refresh();
    // Three attempts, two waits between them.
    expect(callScreenRect).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([150, 450]);
  });

  // THE MESSAGE qdbus6 ACTUALLY EMITS when a bus name is unclaimed. Measured
  // 2026-09-04 against a deliberately absent service: stderr, exit 2.
  //
  //   $ qdbus6 org.kde.definitelynotarealservice /Foo org.foo.Bar
  //   Service 'org.kde.definitelynotarealservice' does not exist.
  //
  // This constant exists because the first version of this suite asserted
  // against 'Error: org.freedesktop.DBus.Error.ServiceUnknown' — written from
  // the DBus spec, emitted by qdbus6 never. The test passed, the branch was
  // dead, and on a real plasmashell-less desktop the resolver would have paid
  // 600 ms of backoff at the start of every drag. Do not replace this with a
  // prettier string; it is a transcript.
  const QDBUS_SERVICE_MISSING = "Service 'org.kde.plasmashell' does not exist.";

  it('stops retrying once plasmashell has been shown to be absent from this session', async () => {
    // org.kde.plasmashell has no DBus activation file (it is a systemd user
    // unit), so a KWin-only desktop will never answer — paying 600 ms of
    // backoff at the start of every drag would be a felt cost for nothing.
    const wait = vi.fn(async () => {});
    const callScreenRect = vi.fn(async () =>
      ({ ok: false, reason: QDBUS_SERVICE_MISSING }) as KdeCallResult);
    const resolver = makeResolver({ wait, callScreenRect });
    await resolver.refresh();
    callScreenRect.mockClear();
    wait.mockClear();
    await resolver.refresh();
    expect(callScreenRect).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('still recognises the freedesktop wording, which dbus-send and older qdbus do emit', async () => {
    const wait = vi.fn(async () => {});
    const callScreenRect = vi.fn(async () =>
      ({ ok: false, reason: 'Error: org.freedesktop.DBus.Error.ServiceUnknown' }) as KdeCallResult);
    const resolver = makeResolver({ wait, callScreenRect });
    await resolver.refresh();
    callScreenRect.mockClear();
    await resolver.refresh();
    expect(callScreenRect).toHaveBeenCalledTimes(1);
  });

  it('does not latch "no plasmashell" when the only failure never reached a DBus call', async () => {
    // A display KDE reports nothing for is a MATCH failure, not a call failure.
    // Counting it would let one unmatched screen close the latch on a session
    // that does have plasmashell — and then a real answer would never be sought
    // with retries again.
    const wait = vi.fn(async () => {});
    const resolver = makeResolver({
      // KDE knows only the laptop; Electron reports a second display too.
      listDisplays: async () => [display(1, LAPTOP), display(2, { x: 1707, y: 0, width: 1920, height: 1080 })],
      callScreenRect: vi.fn(async () => ({ ok: false, reason: QDBUS_SERVICE_MISSING }) as KdeCallResult),
      wait,
    });
    await resolver.refresh();
    // One display failed at the call, one never got there — so "every failure
    // was a missing service" is false and the latch stays open.
    expect(wait).toHaveBeenCalled();
  });

  it('settles even when a dependency throws, rather than wedging ready=false forever', async () => {
    // screen.getAllDisplays() throws before app-ready, and §0.6 asks for this to
    // be awaited at the earliest startup step. If a throw left the resolver
    // un-ready, the buddy would never be constructed and nothing would say why.
    const resolver = makeResolver({
      listDisplays: async () => {
        throw new Error('screen module not ready');
      },
    });
    await expect(resolver.refresh()).resolves.toBeUndefined();
    expect(resolver.ready).toBe(true);
    expect(resolver.areaFor(display(1, LAPTOP)).resolved).toBe(false);
  });

  it('re-runs once when a display change lands during an in-flight pass', async () => {
    // Coalescing alone would answer the second request from the first pass's
    // snapshot, so a monitor plugged in mid-resolve would stay unresolved until
    // some later gesture.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const listDisplays = vi.fn(async () => {
      if (++calls === 1) await gate;
      return [display(1, LAPTOP)];
    });
    const resolver = makeResolver({ listDisplays });
    const first = resolver.refresh();
    const second = resolver.refresh();   // arrives while the first is blocked
    release();
    await Promise.all([first, second]);
    expect(listDisplays).toHaveBeenCalledTimes(2);
  });

  it('degrades to the Electron fallback when two mirrored candidates do not overlap', async () => {
    // An intersection is never larger than any candidate; if there is none, the
    // answer is discarded rather than guessed at.
    const resolver = makeResolver({
      readSession: async () => ({
        kwinMajor: 6,
        wayland: true,
        screens: [
          { name: 'eDP-1', enabled: true, bounds: LAPTOP, scale: 1.5 },
          { name: 'HDMI-A-1', enabled: true, bounds: LAPTOP, scale: 1.5 },
        ],
      }),
      callScreenRect: async (name: string) =>
        name === 'eDP-1'
          ? { ok: true as const, stdout: '[Argument: (iiii) 0, 0, 400, 300]' }
          : { ok: true as const, stdout: '[Argument: (iiii) 900, 700, 400, 300]' },
    });
    await resolver.refresh();
    expect(resolver.areaFor(display(1, LAPTOP)).resolved).toBe(false);
  });

  it('lets a later success replace an earlier fallback', async () => {
    // plasmashell was restarting at launch; the next refresh (a display event,
    // or the start of a drag) picks up the real rectangle.
    let up = false;
    const resolver = makeResolver({
      callScreenRect: async () =>
        up ? { ok: true, stdout: LITERAL_OK } : { ok: false, reason: 'Error: org.freedesktop.DBus.Error.ServiceUnknown' },
    });
    await resolver.refresh();
    expect(resolver.areaFor(display(1, LAPTOP)).resolved).toBe(false);
    up = true;
    await resolver.refresh();
    expect(resolver.areaFor(display(1, LAPTOP))).toEqual({
      rect: { x: 0, y: 0, width: 1707, height: 1015 },
      resolved: true,
    });
  });

  it('keeps the last successfully resolved rect rather than overwriting it with a fallback', async () => {
    let up = true;
    const resolver = makeResolver({
      callScreenRect: async () => (up ? { ok: true, stdout: LITERAL_OK } : { ok: false, reason: 'boom' }),
    });
    await resolver.refresh();
    up = false;
    await resolver.refresh();
    expect(resolver.areaFor(display(1, LAPTOP))).toEqual({
      rect: { x: 0, y: 0, width: 1707, height: 1015 },
      resolved: true,
    });
  });

  it('drops a cached rect once the display it belonged to has changed shape', async () => {
    const resolver = makeResolver();
    await resolver.refresh();
    // Same display id, but the screen is now smaller than the rect we cached —
    // a stale answer about a screen that no longer looks like that.
    const shrunk: Rect = { x: 0, y: 0, width: 1280, height: 800 };
    expect(resolver.areaFor(display(1, shrunk))).toEqual({ rect: shrunk, resolved: false });
  });

  it('coalesces concurrent refreshes into one pass', async () => {
    const callScreenRect = vi.fn(async () => ({ ok: true, stdout: LITERAL_OK }) as KdeCallResult);
    const resolver = makeResolver({ callScreenRect });
    await Promise.all([resolver.refresh(), resolver.refresh(), resolver.refresh()]);
    // Two, not one, and not three: requests arriving during a pass are answered
    // from that pass's display snapshot, so one trailing re-run is scheduled no
    // matter how many arrive. Without it, a monitor plugged in mid-resolve would
    // stay unresolved until some later gesture; with a re-run per request, KWin's
    // measured three-events-in-200 ms burst would cost three passes.
    expect(callScreenRect).toHaveBeenCalledTimes(2);
  });

  it('serves both call shapes the window manager uses — matched display and primary display', async () => {
    const resolver = makeResolver({
      listDisplays: async () => [{ id: 1, bounds: LAPTOP }, { id: 2, bounds: TV }],
      screens: [kdeScreen('eDP-1', LAPTOP), kdeScreen('HDMI-A-1', TV)],
      callScreenRect: async (name) => ({
        ok: true,
        stdout: name === 'eDP-1' ? LITERAL_OK : '[Argument: (iiii) 1707, 0, 1920, 1040]',
      }),
    });
    await resolver.refresh();
    expect(resolver.areaFor(display(1, LAPTOP)).rect).toEqual({ x: 0, y: 0, width: 1707, height: 1015 });
    expect(resolver.areaFor(display(2, TV)).rect).toEqual({ x: 1707, y: 0, width: 1920, height: 1040 });
  });
});
