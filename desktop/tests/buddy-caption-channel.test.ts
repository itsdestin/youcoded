import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BuddyWindowManager, type BuddyWindowManagerDeps, type BuddyWorkAreaSource } from '../src/main/buddy-window-manager';
import { buildCaption, parseCaption, type BuddyRole } from '../src/shared/buddy-caption';
import { MASCOT_SIZE, CHAT_SIZE, BAR_SIZE } from '../src/main/buddy-bar-geometry';
import { WorkAreaResolver } from '../src/main/buddy-work-area';

/**
 * The caption channel — how the buddy moves on native-Wayland Linux.
 *
 * WHAT IS BEING PROTECTED, in plain terms: on a Wayland Linux desktop an app is
 * not allowed to move its own windows, and the request fails silently. So the
 * app renames the window instead ("YC:mascot@480,900") and a helper running
 * inside the desktop reads the name and moves it. This suite pins two things:
 *
 *  1. Every single way the buddy can be moved goes through the ONE method that
 *     makes that choice — proved mechanically, by reading the source, because a
 *     behaviour test can only cover the paths it thinks to drive.
 *  2. That method chooses correctly: rename on Wayland-with-helper, and the
 *     ordinary move everywhere else, so Windows, macOS and Linux/X11 behave
 *     exactly as they do today.
 */

const { DISPLAY } = vi.hoisted(() => ({
  DISPLAY: {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    // What Electron reports. On Wayland this is a lie by 52-ish pixels, which is
    // what the work-area source exists to correct.
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  },
}));

vi.mock('electron', () => ({
  screen: {
    getPrimaryDisplay: () => DISPLAY,
    getDisplayMatching: () => DISPLAY,
  },
  BrowserWindow: class {},
}));

const SIZE: Record<BuddyRole, { width: number; height: number }> = {
  mascot: MASCOT_SIZE,
  chat: CHAT_SIZE,
  bar: BAR_SIZE,
};

type FakeWin = ReturnType<typeof fakeWin>;

/** A stand-in BrowserWindow that remembers where it was put, so the
 *  non-Wayland path (which really does ask the window where it is) can be
 *  exercised honestly. */
function fakeWin(role: BuddyRole, x: number, y: number) {
  const at = { x, y };
  let visible = false;
  // Real handlers, so a test can fire the platform events the manager listens
  // for — 'move' in particular, which is how a window-manager-initiated move
  // (Meta+drag on KDE X11) reaches persistence off the caption path.
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  return {
    role,
    at,
    setPosition: vi.fn((nx: number, ny: number) => { at.x = nx; at.y = ny; }),
    setTitle: vi.fn(),
    getBounds: vi.fn(() => ({ x: at.x, y: at.y, width: SIZE[role].width, height: SIZE[role].height })),
    getPosition: vi.fn(() => [at.x, at.y]),
    isDestroyed: () => false,
    isVisible: () => visible,
    show: vi.fn(() => { visible = true; }),
    showInactive: vi.fn(() => { visible = true; }),
    hide: vi.fn(() => { visible = false; }),
    focus: vi.fn(),
    moveTop: vi.fn(),
    destroy: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    on: vi.fn((event: string, fn: (...a: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    }),
    emit: (event: string) => { for (const fn of handlers.get(event) ?? []) fn(); },
    moveTo: (nx: number, ny: number) => { at.x = nx; at.y = ny; },
    webContents: { send: vi.fn(), on: vi.fn(), once: vi.fn(), id: 7 },
  };
}

interface Harness {
  manager: BuddyWindowManager;
  created: Array<{ variant: BuddyRole; x: number; y: number; title?: string }>;
  wins: Partial<Record<BuddyRole, FakeWin>>;
  saved: { mascot: { x: number; y: number } | null };
  /** Every setPosition call made by any buddy window. */
  positionCalls: () => number;
  /** Every setTitle call made by any buddy window. */
  titleCalls: () => number;
  captionsFor: (role: BuddyRole) => string[];
}

function harness(opts: {
  caption?: boolean;
  workArea?: BuddyWorkAreaSource;
  dock?: 'left' | 'right' | 'top' | 'bottom' | null;
  savedPos?: { x: number; y: number } | null;
} = {}): Harness {
  const created: Harness['created'] = [];
  const wins: Partial<Record<BuddyRole, FakeWin>> = {};
  const saved: Harness['saved'] = { mascot: null };
  let dock = opts.dock ?? null;

  const deps: BuddyWindowManagerDeps = {
    createBuddyWindow: (variant, o) => {
      created.push({ variant, x: o.x, y: o.y, title: o.title });
      const w = fakeWin(variant, o.x, o.y);
      wins[variant] = w;
      return w as unknown as Electron.BrowserWindow;
    },
    getPersistedPosition: () => opts.savedPos ?? null,
    setPersistedPosition: (_k, pos) => { saved.mascot = pos; },
    getPersistedDock: () => dock,
    setPersistedDock: (edge) => { dock = edge; },
    registry: { subscribe: vi.fn(), unsubscribe: vi.fn() } as never,
    mainWindow: () => null,
    onStatusChanged: vi.fn(),
    workArea: opts.workArea,
    captionChannelLive: opts.caption ? () => true : undefined,
  };

  const all = () => Object.values(wins) as FakeWin[];
  return {
    manager: new BuddyWindowManager(deps),
    created,
    wins,
    saved,
    positionCalls: () => all().reduce((n, w) => n + w.setPosition.mock.calls.length, 0),
    titleCalls: () => all().reduce((n, w) => n + w.setTitle.mock.calls.length, 0),
    captionsFor: (role) => (wins[role]?.setTitle.mock.calls ?? []).map((c) => c[0] as string),
  };
}

/**
 * Drive the buddy through every way he can be moved. Deliberately one long
 * sequence rather than nine isolated cases: the manager is a state machine, and
 * several of these moves only happen from a state the previous one leaves it in
 * (the button bar cannot be repositioned before it has been created, the
 * shove-to-put-away only fires while the chat is open, and so on).
 */
function exerciseEveryMove(h: Harness): void {
  vi.useFakeTimers();
  try {
    h.manager.show();                    // creates the mascot; docked restore places him
    h.manager.toggleChat();              // creates the chat AND the button bar; glides the group
    vi.advanceTimersByTime(300);         // run the glide animation to its end
    h.manager.moveMascot(700, 500);      // ordinary drag: mascot + chat + bar all move
    h.manager.moveMascot(2, 500);        // shove to the left edge with the chat open: put away
    h.manager.moveMascot(600, 400);      // free drag with the chat closed
    h.manager.moveMascot(1, 400);        // drag against the edge: peek
    h.manager.dragEnded();               // release: snap + settle glide
    vi.advanceTimersByTime(300);
    h.manager.toggleChat();              // re-open: re-anchors the chat, repositions the bar
    vi.advanceTimersByTime(300);
  } finally {
    vi.useRealTimers();
  }
}

describe('the caption channel', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('every write and every window creation goes through one place', () => {
    // THE mechanical guarantee. A behaviour test can only cover the paths it
    // thought to drive; this covers the file. If a future change adds a tenth
    // way to move the buddy and calls setPosition directly, the Wayland buddy
    // silently stops moving on that path — and this fails instead.
    // Normalised: a Windows checkout is CRLF, and the line split below would keep
    // a trailing '\r' on every line.
    const SRC = readFileSync(join(__dirname, '../src/main/buddy-window-manager.ts'), 'utf8').replace(/\r\n/g, '\n');
    const lines = SRC.split('\n');

    it('no window-moving API is called outside place()', () => {
      // setBounds and setContentBounds are the OTHER standard Electron ways to
      // move a window — natural to reach for when you also want to resize, or
      // when copying a pattern from elsewhere in the repo. Scanning only for
      // setPosition would let either of them bypass the caption channel
      // entirely, and on Wayland there is no readback (design §3), so nothing
      // in the app could ever notice the move silently failed.
      const hits = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /\.(setPosition|setBounds|setContentBounds)\(/.test(l) && !l.trimStart().startsWith('//'));
      expect(hits.map((h) => h.l.trim())).toEqual(['else win.setPosition(x, y);']);
      // ...and that one line sits inside place(), not somewhere that merely
      // looks like it.
      const placeStart = lines.findIndex((l) => l.includes('private place(role: BuddyRole'));
      expect(placeStart).toBeGreaterThan(-1);
      expect(hits[0].i).toBeGreaterThan(placeStart);
    });

    it('setTitle is called in exactly one place, inside place()', () => {
      const hits = lines.filter((l) => /\.setTitle\(/.test(l) && !l.trimStart().startsWith('//'));
      expect(hits.map((l) => l.trim())).toEqual(['if (this.captionLive()) win.setTitle(buildCaption(role, x, y));']);
    });

    it('every one of the nine write sites and three creation sites is still there', () => {
      // The scans above prove nothing moves the buddy EXCEPT through place().
      // They cannot notice a write path being DELETED — and a deleted one is
      // invisible to the behaviour tests too, because other paths keep the same
      // totals non-zero (the bar, for instance, is also renamed by glideGroup
      // and by showBar's else-branch). Counting the call sites makes a deletion
      // loud. Design §3 fixes these numbers: nine setPosition writes, three
      // constructor placements.
      const calls = (re: RegExp): number =>
        lines.filter((l) => re.test(l) && !l.trimStart().startsWith('//')).length;
      expect(calls(/this\.place\(/)).toBe(9);
      expect(calls(/this\.create\(/)).toBe(3);
    });

    it('the three windows are built in exactly one place, inside create()', () => {
      const hits = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /this\.deps\.createBuddyWindow\(/.test(l));
      expect(hits).toHaveLength(1);
      const createStart = lines.findIndex((l) => l.includes('private create(role: BuddyRole'));
      expect(createStart).toBeGreaterThan(-1);
      expect(hits[0].i).toBeGreaterThan(createStart);
    });
  });

  describe('on Windows, macOS and Linux/X11 — nothing changes', () => {
    it('moves windows the ordinary way and never renames one', () => {
      const h = harness({ dock: 'bottom' });
      exerciseEveryMove(h);
      expect(h.positionCalls()).toBeGreaterThan(0);
      expect(h.titleCalls()).toBe(0);
    });

    it('builds all three windows with no caption, so their names are untouched', () => {
      const h = harness({ dock: 'bottom' });
      exerciseEveryMove(h);
      expect(h.created.map((c) => c.variant).sort()).toEqual(['bar', 'chat', 'mascot']);
      for (const c of h.created) expect(c.title).toBeUndefined();
    });

    it('still asks the window where it is, so an OS-adjusted position is respected', () => {
      const h = harness();
      h.manager.show();
      const mascot = h.wins.mascot!;
      // Pretend the window manager put the window somewhere slightly different
      // from where we asked — which really happens on X11.
      mascot.at.x = 999;
      mascot.at.y = 111;
      h.manager.moveMascot(700, 500);
      expect(mascot.getBounds).toHaveBeenCalled();
    });
  });

  describe('on native-Wayland Linux with the helper running', () => {
    it('renames windows instead of moving them, on every single path', () => {
      const h = harness({ caption: true, dock: 'bottom' });
      exerciseEveryMove(h);
      // The one that matters: not a single silent, ignored move request.
      expect(h.positionCalls()).toBe(0);
      expect(h.titleCalls()).toBeGreaterThan(0);
    });

    it('renames all three windows, each under its own name', () => {
      const h = harness({ caption: true, dock: 'bottom' });
      exerciseEveryMove(h);
      for (const role of ['mascot', 'chat', 'bar'] as const) {
        const captions = h.captionsFor(role);
        expect(captions.length).toBeGreaterThan(0);
        for (const caption of captions) {
          expect(parseCaption(caption)?.role).toBe(role);
        }
      }
    });

    it('names each window at birth, not a moment later', () => {
      // If the name arrived late the helper would already have decided not to
      // watch that window, and the buddy would appear and refuse to move.
      const h = harness({ caption: true });
      exerciseEveryMove(h);
      expect(h.created).toHaveLength(3);
      for (const c of h.created) {
        const parsed = parseCaption(c.title ?? '');
        expect(parsed).not.toBeNull();
        expect(parsed!.role).toBe(c.variant);
        expect(parsed!.x).toBe(c.x);
        expect(parsed!.y).toBe(c.y);
      }
    });

    it('remembers where the buddy is without asking the window, which would lie', () => {
      const h = harness({ caption: true });
      h.manager.show();
      const mascot = h.wins.mascot!;
      // What Wayland really does: the window reports the position it was born
      // at, forever, no matter how many times it has actually moved.
      mascot.getBounds.mockReturnValue({ x: 0, y: 0, ...MASCOT_SIZE });
      h.manager.moveMascot(640, 480);
      const last = h.captionsFor('mascot').at(-1)!;
      expect(parseCaption(last)).toMatchObject({ x: 640, y: 480 });
      // The next move must continue from 640,480 — not from the window's lie.
      h.manager.moveMascot(660, 480);
      expect(parseCaption(h.captionsFor('mascot').at(-1)!)).toMatchObject({ x: 660, y: 480 });
    });

    it('saves the buddy’s position even though the OS never reports a move', () => {
      // Today this is silently broken on Linux: the "window moved" event never
      // fires for a move the desktop made, so the position was never saved.
      vi.useFakeTimers();
      try {
        const h = harness({ caption: true });
        h.manager.show();
        h.manager.moveMascot(300, 200);
        vi.advanceTimersByTime(400);
        expect(h.saved.mascot).toEqual({ x: 300, y: 200 });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('the usable screen area', () => {
    /** A stand-in for the real lookup, with a hand-held settle. */
    function fakeArea(rect: { x: number; y: number; width: number; height: number }, startsReady: boolean) {
      let settled = startsReady;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      return {
        get ready() { return settled; },
        refresh: () => (settled ? Promise.resolve() : gate.then(() => { settled = true; })),
        areaFor: () => ({ rect, resolved: true }),
        settle: () => { release(); },
      };
    }

    it('places the buddy against the desktop’s answer, not Electron’s', () => {
      // Electron says the screen is 1080 tall; the desktop has reserved 52px at
      // the bottom for the taskbar. The buddy must sit above the taskbar.
      const area = fakeArea({ x: 0, y: 0, width: 1920, height: 1028 }, true);
      const h = harness({ workArea: area });
      h.manager.show();
      expect(h.created[0].y).toBe(1028 - MASCOT_SIZE.height - 24);
    });

    it('does not build a single window until that answer has arrived', async () => {
      // R4-F5. This is the guard that stops the very first buddy a user ever
      // sees standing on top of the taskbar, covering the clock — with nothing
      // in the app able to notice or correct it for the rest of the session.
      const area = fakeArea({ x: 0, y: 0, width: 1920, height: 1028 }, false);
      const h = harness({ workArea: area });
      h.manager.show();
      expect(h.created).toHaveLength(0);
      h.manager.show(); // a second ask must not queue a second buddy either
      expect(h.created).toHaveLength(0);

      area.settle();
      await vi.waitFor(() => expect(h.created).toHaveLength(1));
      expect(h.created[0].y).toBe(1028 - MASCOT_SIZE.height - 24);
    });

    it('does not bring the buddy back if he is switched off during the wait', async () => {
      const area = fakeArea({ x: 0, y: 0, width: 1920, height: 1028 }, false);
      const h = harness({ workArea: area });
      h.manager.show();
      h.manager.hide();
      area.settle();
      // Let every queued continuation run — this is a flush, not a wait: if the
      // buddy were going to be built, it would have been built by now.
      await new Promise((r) => setImmediate(r));
      expect(h.created).toHaveLength(0);
    });

    it('keeps the buddy inside that rectangle while he is dragged', () => {
      const area = fakeArea({ x: 0, y: 0, width: 1920, height: 1028 }, true);
      const h = harness({ caption: true, workArea: area });
      h.manager.show();
      h.manager.moveMascot(500, 5000); // far below the bottom of the screen
      const parsed = parseCaption(h.captionsFor('mascot').at(-1)!)!;
      expect(parsed.y).toBe(1028 - MASCOT_SIZE.height);
    });

    it('is skipped entirely when no source is supplied (every other platform)', () => {
      const h = harness();
      h.manager.show();
      // Electron's own number, synchronously, exactly as today.
      expect(h.created[0].y).toBe(1080 - MASCOT_SIZE.height - 24);
    });

    it('the real WorkAreaResolver fits the shape this manager asks for', () => {
      // Compile-time proof that the two halves of this feature agree. If B1's
      // resolver ever changes shape, this stops compiling instead of failing at
      // runtime on Destin's desktop.
      const resolver: BuddyWorkAreaSource = new WorkAreaResolver();
      expect(typeof resolver.refresh).toBe('function');
    });
  });
});

describe('a bad coordinate cannot park the buddy in the corner', () => {
  it('place() refuses a non-finite coordinate instead of writing 0,0', () => {
    // main.ts forwards the renderer's drag payload unvalidated, and
    // clampToWorkArea propagates NaN through Math.min/max rather than absorbing
    // it. 0 is the CORNER of the screen, not a neutral value — and place()
    // writes this.pos, so substituting one would corrupt the app's own idea of
    // where the buddy is, permanently, with no error anywhere.
    const h = harness({ caption: true });
    h.manager.show();
    h.manager.moveMascot(700, 500);
    h.manager.moveMascot(Number.NaN, 500);
    h.manager.moveMascot(700, Number.POSITIVE_INFINITY);
    h.manager.moveMascot(Number.NaN, Number.NaN);
    const captions = h.captionsFor('mascot');
    expect(captions.length).toBeGreaterThan(0);
    // Every caption the buddy was ever given is a legal one, and none of them
    // is the substituted corner. If place() had written 0,0 instead of
    // refusing, this.pos would be corrupt from here on and rectOf would report
    // the corner for the rest of the session.
    for (const c of captions) expect(parseCaption(c), c).not.toBeNull();
    expect(captions.some((c) => /NaN|Infinity/.test(c))).toBe(false);
    expect(captions.filter((c) => c === 'YC:mascot@0,0')).toHaveLength(0);
  });

  it('the writer can never emit a caption either reader would refuse', () => {
    // The helper's own comment claims the six-digit bound is enforced by the
    // writer. Until it was, buildCaption could emit YC:mascot@1234567,0 — which
    // BOTH readers reject, and a rejected caption is indistinguishable from no
    // caption, so the buddy freezes at his last good position with nothing
    // logged. Clamping makes the divergence impossible by construction.
    const extremes = [0, -1, 999999, -999999, 1000000, -1000000, 1234567, 1e21, -1e21, 0.4, -0.6];
    for (const role of ['mascot', 'chat', 'bar'] as const) {
      for (const x of extremes) {
        for (const y of extremes) {
          const caption = buildCaption(role, x, y);
          expect(parseCaption(caption), caption).not.toBeNull();
          // ...and the helper's own regex, copied from the shipped script.
          expect(/^YC:(mascot|chat|bar)@(-?[0-9]{1,6}),(-?[0-9]{1,6})$/.test(caption), caption).toBe(true);
        }
      }
    }
  });
});

describe('persistence on the platforms where the move event still fires', () => {
  it('saves a move the app did not initiate when the caption channel is off', () => {
    // KDE X11 lets Meta+drag move any window, and these windows are not
    // movable:false. Under the old code that move was saved, because
    // persistence read the real bounds from the move event. place() only knows
    // what the app ASKED for, so dropping the listener outright would have made
    // an X11 user's Meta-drag stop being remembered — on a platform where the
    // buddy works today.
    vi.useFakeTimers();
    try {
      const h = harness({ caption: false });
      h.manager.show();
      const win = h.wins.mascot;
      expect(win).toBeDefined();
      win!.moveTo(321, 654);
      win!.emit('move');
      vi.advanceTimersByTime(500);   // persistence is debounced
      expect(h.saved.mascot).toEqual({ x: 321, y: 654 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not register the move listener on the caption path, where it never fires', () => {
    const h = harness({ caption: true });
    h.manager.show();
    const registered = h.wins.mascot!.on.mock.calls.map((c) => c[0] as string);
    expect(registered).not.toContain('move');
  });
});
